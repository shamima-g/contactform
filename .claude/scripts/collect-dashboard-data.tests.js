#!/usr/bin/env node
/**
 * Tests for collect-dashboard-data.js — focused on parseEpicPlan(), the parser
 * that turns the free-form `epic-plan.md` table written by an LLM into the
 * structured plan that drives the readiness view. Each case is a regression
 * guard for a way a plausibly-valid table used to mis-parse.
 *
 * Usage:
 *   node .claude/scripts/collect-dashboard-data.tests.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  parseEpicPlan,
  summariseStories,
  parseStoryTitle,
  buildStoryList,
  deriveNow,
  reviewPageFor,
  attachReviewPage,
  computeOverview,
  renderText,
  isTerminalPhase,
  collect
} = require('./collect-dashboard-data');
const { test, assertEqual, assertDeepEqual, summary } = require('./lib/test-harness');

const B = '`';
// Build an "## Epics" section from data rows (each a string already containing
// the border pipes the test wants to exercise).
const plan = (...rows) => [
  '# Epic Plan — Test',
  '',
  '## Epics',
  '',
  '| # | Epic | Delivers | Builds on |',
  '|---|---|---|---|',
  ...rows,
  '',
  '## Coverage',
  '',
  '| What you asked for | Epic |',
  '|---|---|',
  `| Login (R1) | Auth (${B}auth${B}) |`,
].join('\n');

test('canonical 4-column table parses slug, name, goal, deps', () => {
  const epics = parseEpicPlan(plan(
    `| 1 | Account Onboarding (${B}account-onboarding${B}) | Sign-up and login | — |`,
    `| 2 | Dashboard (${B}dashboard${B}) | Overview screen | Account Onboarding (${B}account-onboarding${B}) |`,
  ));
  assertEqual(epics.length, 2, 'two epics');
  assertEqual(epics[0].slug, 'account-onboarding', 'slug 0');
  assertEqual(epics[0].name, 'Account Onboarding', 'name 0');
  assertEqual(epics[0].goal, 'Sign-up and login', 'goal 0');
  assertDeepEqual(epics[0].dependsOn, [], 'root has no deps');
  assertDeepEqual(epics[1].dependsOn, ['account-onboarding'], 'dep resolved from backtick slug');
});

test('the Coverage section is not parsed as epics', () => {
  const epics = parseEpicPlan(plan(`| 1 | Auth (${B}auth${B}) | Login | — |`));
  assertEqual(epics.length, 1, 'only the Epics-section row');
  assertEqual(epics[0].slug, 'auth', 'auth row only');
});

test('regression: data row whose name has "Epic" and goal has "Delivers" is NOT dropped', () => {
  const epics = parseEpicPlan(plan(
    `| 1 | Epic Reports (${B}epic-reports${B}) | Delivers epic-level reporting | — |`,
    `| 2 | Billing (${B}billing${B}) | Invoices | Epic Reports (${B}epic-reports${B}) |`,
  ));
  assertEqual(epics.length, 2, 'header heuristic must not eat a real row');
  assertEqual(epics[0].slug, 'epic-reports', 'epic-reports present');
  assertDeepEqual(epics[1].dependsOn, ['epic-reports'], 'dep on the once-dropped epic resolves');
});

test('regression: rows missing the trailing border pipe still parse', () => {
  const epics = parseEpicPlan(plan(
    `| 1 | Auth (${B}auth${B}) | Login | —`,
    `| 2 | Dashboard (${B}dashboard${B}) | Overview | Auth (${B}auth${B})`,
  ));
  assertEqual(epics.length, 2, 'no trailing pipe must not drop rows');
  assertDeepEqual(epics[1].dependsOn, ['auth'], 'deps column survives a missing trailing pipe');
});

test('regression: escaped pipe inside a cell does not over-split the row', () => {
  const epics = parseEpicPlan(plan(
    `| 1 | Reports (${B}reports${B}) | Charts \\| tables | — |`,
    `| 2 | Catalog (${B}catalog${B}) | Listing | Reports (${B}reports${B}) |`,
  ));
  assertEqual(epics.length, 2, 'escaped pipe handled');
  assertEqual(epics[0].goal, 'Charts | tables', 'goal keeps the escaped pipe as a literal');
  assertDeepEqual(epics[1].dependsOn, ['reports'], 'deps column not shifted by the escaped pipe');
});

test('regression: dependency named in plain text (no backticks) is resolved, not dropped', () => {
  const epics = parseEpicPlan(plan(
    `| 1 | Auth (${B}auth${B}) | Login | — |`,
    `| 2 | Catalog (${B}catalog${B}) | Listing | Auth |`,
  ));
  assertDeepEqual(epics[1].dependsOn, ['auth'], 'plain-name dep matched to a known epic so it is not falsely "ready"');
});

test('regression: a backtick in the epic name does not become the slug', () => {
  const epics = parseEpicPlan(plan(
    `| 1 | User ${B}Profile${B} Mgmt (${B}user-profile${B}) | Manage profiles | — |`,
  ));
  assertEqual(epics[0].slug, 'user-profile', 'slug comes from the trailing (`slug`), not the first backtick group');
});

test('columns are located by header name even when reordered', () => {
  const raw = [
    '## Epics',
    '',
    '| Epic | Builds on | Delivers |',
    '|---|---|---|',
    `| Auth (${B}auth${B}) | — | Login |`,
    `| Catalog (${B}catalog${B}) | Auth (${B}auth${B}) | Listing |`,
  ].join('\n');
  const epics = parseEpicPlan(raw);
  assertEqual(epics[0].goal, 'Login', 'goal read from the Delivers column wherever it sits');
  assertDeepEqual(epics[1].dependsOn, ['auth'], 'deps read from the Builds-on column wherever it sits');
});

test('no "## Epics" section → empty plan', () => {
  assertEqual(parseEpicPlan('# Title\n\nSome prose, no table.').length, 0, 'no plan');
});

// ── summariseStories ─────────────────────────────────────────────────────────

test('summariseStories counts complete and finds the in-progress story', () => {
  const s = summariseStories({
    '1': { status: 'complete' },
    '2': { status: 'in-progress' },
    '3': { status: 'pending' }
  });
  assertEqual(s.total, 3, 'total');
  assertEqual(s.complete, 1, 'complete');
  assertEqual(s.inProgress, '2', 'in-progress key (raw string)');
  assertEqual(s.halted, null, 'no halted story');
});

test('summariseStories surfaces a halted story', () => {
  const s = summariseStories({ '1': { status: 'complete' }, '2': { status: 'halted' } });
  assertEqual(s.halted, '2', 'halted key');
  assertEqual(s.inProgress, null, 'no in-progress when halted');
});

test('summariseStories tolerates null / non-object', () => {
  assertEqual(summariseStories(null).total, 0, 'null → empty');
  assertEqual(summariseStories(undefined).halted, null, 'undefined → empty');
});

// ── parseStoryTitle ──────────────────────────────────────────────────────────

test('parseStoryTitle reads the title from the story H1', () => {
  assertEqual(parseStoryTitle('# Story 4: Sign out\n\n- slug: x'), 'Sign out', 'colon separator');
  assertEqual(parseStoryTitle('# Story 12 — Session security'), 'Session security', 'em-dash separator');
  assertEqual(parseStoryTitle('## Summary\n\ntext'), null, 'non-story heading → null');
  assertEqual(parseStoryTitle('no heading at all'), null, 'no heading → null');
});

// ── buildStoryList ───────────────────────────────────────────────────────────

test('buildStoryList sorts by numeric index and merges titles', () => {
  const list = buildStoryList(
    { '2': { status: 'in-progress', e2eStatus: 'deferred' }, '1': { status: 'complete', e2eStatus: 'passed' } },
    { '1': 'First', '2': 'Second' }
  );
  assertDeepEqual(list, [
    { index: '1', title: 'First', status: 'complete', e2eStatus: 'passed' },
    { index: '2', title: 'Second', status: 'in-progress', e2eStatus: 'deferred' }
  ], 'numeric sort + title merge');
});

test('buildStoryList falls back to null title when none is known', () => {
  const list = buildStoryList({ '1': { status: 'pending' } }, {});
  assertEqual(list[0].title, null, 'missing title → null (renderer shows "Story N")');
});

// ── deriveNow (banner state) ─────────────────────────────────────────────────

test('deriveNow: an epic-level halt outranks everything', () => {
  const now = deriveNow({
    inFlight: [
      { slug: 'a', name: 'A', phase: 'BUILD', isActive: true, halt: { reason: 'spec gap' }, stories: { inProgress: '2', halted: null } }
    ],
    plan: [], hasPlan: false
  });
  assertEqual(now.kind, 'halt', 'halt wins');
  assertEqual(now.reason, 'spec gap', 'reason carried through');
  assertEqual(now.storyIndex, '2', 'falls back to in-progress story for context');
});

test('deriveNow: a story marked halted (no halt object) still reads as halt', () => {
  const now = deriveNow({
    inFlight: [{ slug: 'a', name: 'A', phase: 'BUILD', halt: null, stories: { inProgress: null, halted: '3' } }],
    plan: [], hasPlan: false
  });
  assertEqual(now.kind, 'halt', 'story-level halt detected');
  assertEqual(now.storyIndex, '3', 'halted story index');
});

test('deriveNow: manual-test outranks a NON-active building epic', () => {
  const now = deriveNow({
    inFlight: [
      { slug: 'a', name: 'A', phase: 'BUILD', isActive: false, halt: null, stories: { inProgress: '1' } },
      { slug: 'b', name: 'B', phase: 'MANUAL-TEST', halt: null, stories: {} }
    ],
    plan: [], hasPlan: false
  });
  assertEqual(now.kind, 'manual-test', 'manual-test beats a non-active build');
  assertEqual(now.epicName, 'B', 'names the manual-test epic');
});

test('deriveNow: the ACTIVE building epic outranks another epic in manual-test', () => {
  // The user is checked out on 'a' and actively building it — that's "now", not an
  // unrelated epic sitting in MANUAL-TEST waiting for review.
  const now = deriveNow({
    inFlight: [
      { slug: 'a', name: 'A', phase: 'BUILD', isActive: true, halt: null, stories: { inProgress: '1' } },
      { slug: 'b', name: 'B', phase: 'MANUAL-TEST', halt: null, stories: {} }
    ],
    plan: [], hasPlan: false
  });
  assertEqual(now.kind, 'building', 'active build beats another epic in manual-test');
  assertEqual(now.epicName, 'A', 'names the active building epic');
});

test('deriveNow: building prefers the checked-out epic', () => {
  const now = deriveNow({
    inFlight: [
      { slug: 'x', name: 'X', phase: 'BUILD', isActive: false, halt: null, stories: { inProgress: '1', complete: 0, total: 3 } },
      { slug: 'y', name: 'Y', phase: 'BUILD', isActive: true, halt: null, stories: { inProgress: '2', complete: 1, total: 4 } }
    ],
    plan: [], hasPlan: false
  });
  assertEqual(now.kind, 'building', 'building state');
  assertEqual(now.epicSlug, 'y', 'active epic preferred over another in-flight one');
  assertEqual(now.storyIndex, '2', 'active epic in-progress story');
});

test('deriveNow: nothing in flight + a ready plan epic → ready', () => {
  const now = deriveNow({
    inFlight: [],
    plan: [{ slug: 'p', name: 'P', status: 'ready' }, { slug: 'q', name: 'Q', status: 'blocked' }],
    hasPlan: true
  });
  assertEqual(now.kind, 'ready', 'ready-to-start');
  assertEqual(now.epicName, 'P', 'names the first ready epic');
  assertEqual(now.readyCount, 1, 'one ready epic');
});

test('deriveNow: every plan epic done → complete', () => {
  const now = deriveNow({
    inFlight: [],
    plan: [{ slug: 'a', status: 'done' }, { slug: 'b', status: 'done' }],
    hasPlan: true
  });
  assertEqual(now.kind, 'complete', 'all done');
});

test('deriveNow: no plan, nothing in flight → idle', () => {
  assertEqual(deriveNow({ inFlight: [], plan: [], hasPlan: false }).kind, 'idle', 'idle fallback');
});

test('regression: a broken in-flight branch does not suppress the ready banner', () => {
  // An invalid-slug / missing-state branch has phase === null and must not count as live
  // work, so a ready plan epic still surfaces (was: idle "No active work").
  for (const broken of ['invalid-slug', 'missing-state']) {
    const now = deriveNow({
      inFlight: [{ slug: 'x', status: broken, phase: null, stories: { complete: 0, total: 0 } }],
      plan: [{ slug: 'p', name: 'P', status: 'ready' }],
      hasPlan: true
    });
    assertEqual(now.kind, 'ready', `ready despite a ${broken} branch`);
  }
});

test('deriveNow: a parked READY-TO-BUILD epic surfaces as ready-to-build', () => {
  const now = deriveNow({
    inFlight: [{ slug: 'b', name: 'B', phase: 'READY-TO-BUILD', isActive: false, halt: null, stories: { complete: 0, total: 4 } }],
    plan: [{ slug: 'a', name: 'A', status: 'ready' }],
    hasPlan: true
  });
  assertEqual(now.kind, 'ready-to-build', 'parked epic beats a not-yet-started ready draft');
  assertEqual(now.epicName, 'B', 'names the parked epic');
  assertEqual(now.storiesTotal, 4, 'carries the planned story count');
});

test('deriveNow: an active build outranks a parked epic', () => {
  const now = deriveNow({
    inFlight: [
      { slug: 'a', name: 'A', phase: 'BUILD', isActive: true, halt: null, stories: { inProgress: '1', complete: 0, total: 3 } },
      { slug: 'b', name: 'B', phase: 'READY-TO-BUILD', isActive: false, halt: null, stories: { complete: 0, total: 4 } }
    ],
    plan: [], hasPlan: false
  });
  assertEqual(now.kind, 'building', 'active build wins over a parked epic');
  assertEqual(now.epicName, 'A', 'names the building epic');
});

// ── reviewPageFor (banner reopen link) ───────────────────────────────────────

test('reviewPageFor links the manual-test check-off page relative to generated-docs/', () => {
  assertEqual(
    reviewPageFor({ kind: 'manual-test', epicSlug: 'checkout', epicName: 'Checkout' }),
    'epics/checkout/manual-tests.html',
    'path is relative to generated-docs/, where dashboard.html lives'
  );
});

test('reviewPageFor returns null for states with no live approval signal', () => {
  // PLAN (stories approval) and idle/ready/halt must NOT link a page — either there
  // is no page, or file-existence alone would resurface a stale one.
  assertEqual(reviewPageFor({ kind: 'building', phase: 'PLAN', epicSlug: 'x' }), null, 'stories approval (PLAN) is not linked');
  assertEqual(reviewPageFor({ kind: 'halt', epicSlug: 'x' }), null, 'halt is resolved in chat, not via a page');
  assertEqual(reviewPageFor({ kind: 'ready', epicSlug: 'x' }), null, 'ready has no review page');
  assertEqual(reviewPageFor({ kind: 'idle' }), null, 'idle has no review page');
});

test('reviewPageFor returns null when a manual-test state carries no slug', () => {
  assertEqual(reviewPageFor({ kind: 'manual-test' }), null, 'no slug → no link (guards the href build)');
});

// ── attachReviewPage (the "never a dead link" gate, against a real filesystem) ─

// Write the check-off page where reviewPageFor's href resolves to, relative to
// <root>/generated-docs — so the test proves the existence check and the href
// agree on one location (the drift the single-encoding refactor removes).
function writeManualTestPage(root, slug) {
  const dir = path.join(root, 'generated-docs', 'epics', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manual-tests.html'), '<!doctype html><title>test</title>');
}

test('attachReviewPage links the manual-test page when it exists on disk', (root) => {
  writeManualTestPage(root, 'checkout');
  const now = attachReviewPage({ kind: 'manual-test', epicSlug: 'checkout' }, root);
  assertEqual(now.reviewPage, 'epics/checkout/manual-tests.html',
    'href is set and resolves to the file just written — existence check and href agree');
}, { tmpDir: 'dash-review-present-' });

test('attachReviewPage renders no dead link when the page is absent', (root) => {
  // tmp root exists but no page was written
  const now = attachReviewPage({ kind: 'manual-test', epicSlug: 'checkout' }, root);
  assertEqual(now.reviewPage, undefined, 'missing file → no link');
}, { tmpDir: 'dash-review-absent-' });

test('attachReviewPage does not link for a state with no review page', (root) => {
  // The file is on disk, but a PLAN (stories-approval) state must still not link it.
  writeManualTestPage(root, 'checkout');
  const now = attachReviewPage({ kind: 'building', phase: 'PLAN', epicSlug: 'checkout' }, root);
  assertEqual(now.reviewPage, undefined, 'only manual-test states get a reopen link');
}, { tmpDir: 'dash-review-none-' });

// ── unresolved plan dependencies (regression) ────────────────────────────────

test('regression: an unmatched plain-text dependency is KEPT so the epic stays blocked', () => {
  const epics = parseEpicPlan(plan(
    `| 1 | Auth (${B}auth${B}) | Login | — |`,
    `| 2 | Catalog (${B}catalog${B}) | Listing | Authentication |`, // typo: no epic named "Authentication"
  ));
  assertDeepEqual(epics[1].dependsOn, ['Authentication'],
    'unresolved dep retained (not dropped) so status derives to blocked, not ready');
});

// ── off-plan merged epics are rendered (regression) ──────────────────────────

test('regression: an off-plan merged epic is listed in the plan-view text', () => {
  const out = renderText({
    status: 'ok',
    project: { name: 'Demo' },
    hasPlan: true,
    plan: [{ slug: 'p', name: 'Planned', status: 'done', waitingOn: [] }],
    inFlight: [],
    merged: [
      { slug: 'p', name: 'Planned', stories: { complete: 2, total: 2 } },
      { slug: 'hotfix', name: 'Hotfix', stories: { complete: 3, total: 3 } } // off-plan
    ],
    // Data layer computes this once; renderText/HTML consume it.
    offPlanMerged: [{ slug: 'hotfix', name: 'Hotfix', stories: { complete: 3, total: 3 } }]
  });
  assertEqual(/Completed \(not in plan\)/.test(out), true, 'has off-plan completed section');
  assertEqual(/Hotfix/.test(out), true, 'the off-plan merged epic is shown, not hidden');
});

test('renderText shows a parked (ready-to-build) plan epic distinctly', () => {
  const out = renderText({
    status: 'ok',
    project: { name: 'Demo' },
    hasPlan: true,
    plan: [
      { slug: 'a', name: 'Auth', status: 'done', waitingOn: [] },
      { slug: 'b', name: 'Billing', status: 'ready-to-build', waitingOn: [] }
    ],
    inFlight: [{ slug: 'b', stories: { complete: 0, total: 5 }, halt: null }],
    merged: [{ slug: 'a', name: 'Auth', stories: { complete: 3, total: 3 } }],
    offPlanMerged: []
  });
  assertEqual(/ready to build/.test(out), true, 'parked epic labelled ready to build');
  assertEqual(/in flight/.test(out), false, 'a parked epic is not shown as in flight');
});

// ── computeOverview ──────────────────────────────────────────────────────────

test('computeOverview sums epics and known stories', () => {
  const ov = computeOverview({
    inFlight: [{ stories: { complete: 2, total: 5 } }],
    merged: [{ stories: { complete: 3, total: 3 } }],
    plan: [{}, {}, {}, {}],
    hasPlan: true
  });
  assertDeepEqual(ov, { epicsComplete: 1, epicsTotal: 4, storiesDone: 5, storiesTotal: 8 }, 'overview totals');
});

test('computeOverview without a plan counts epics on disk', () => {
  const ov = computeOverview({
    inFlight: [{ stories: { complete: 1, total: 2 } }],
    merged: [{ stories: { complete: 4, total: 4 } }],
    plan: [], hasPlan: false
  });
  assertEqual(ov.epicsTotal, 2, 'in-flight + merged when no plan');
});

// ── isTerminalPhase (merged-epic "done" detection on the `main` ref) ──────────

// Regression guard for the "just-merged epic reads as ready" bug: right after a
// PR merge + branch delete, the epic's committed `main` state.json is still at
// COMPLETE-ON-BRANCH (the marker step flips it to COMPLETE in a later, separate
// commit). If only exact "COMPLETE" counted as done, a dashboard regenerated in
// that window mis-rendered the finished epic as a not-started "ready" draft and
// its dependents as "blocked". Both terminal phases must read as done.
test('isTerminalPhase: both terminal phases (COMPLETE-ON-BRANCH, COMPLETE) are done', () => {
  assertEqual(isTerminalPhase('COMPLETE-ON-BRANCH'), true, 'just-merged, pre-marker window is done');
  assertEqual(isTerminalPhase('COMPLETE'), true, 'marked-complete is done');
});

test('isTerminalPhase: non-terminal and unknown phases are NOT done', () => {
  for (const p of ['PLAN', 'BUILD', 'EPIC-END', 'MANUAL-TEST']) {
    assertEqual(isTerminalPhase(p), false, `${p} is not terminal`);
  }
  assertEqual(isTerminalPhase(null), false, 'null phase is not terminal');
  assertEqual(isTerminalPhase('complete'), false, 'phase match is case-sensitive');
});

// ── collect(): a /plan-parked epic lives on `main` with no branch ─────────────
//
// Option B: /plan parks the whole plan on `main` at READY-TO-BUILD without ever
// creating an epic/<slug> branch (the build branch is cut fresh from main at build
// time, so the plan can't go stale). collect() must surface such an epic as
// ready-to-build — not as a not-started draft, and not as merged.

// Minimal git repo with the given { relPath: content } committed on `main`. No epic
// branches are created, so any state.json here lives only on `main`.
function gitRepoOnMain(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-collect-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'plan');
  git('branch', '-M', 'main');
  return root;
}

const parkedState = (slug, name, total) => JSON.stringify({
  schemaVersion: 1,
  epic: { slug, name, createdAt: '2026-07-01T00:00:00Z', dependsOn: [], introducesSharedSurface: false, unverifiedAssumptions: [], manualTestResults: [] },
  phase: 'READY-TO-BUILD',
  stories: Object.fromEntries(Array.from({ length: total }, (_, i) => [String(i + 1), { status: 'pending', commit: null, e2eStatus: 'deferred', startedAt: null, completedAt: null }])),
  halt: null,
  lastUpdated: '2026-07-02T00:00:00Z'
});

// A merged (done) epic on `main`: every story complete, phase COMPLETE.
const mergedState = (slug, name, total) => JSON.stringify({
  schemaVersion: 1,
  epic: { slug, name, createdAt: '2026-07-01T00:00:00Z', dependsOn: [], introducesSharedSurface: false, unverifiedAssumptions: [], manualTestResults: [] },
  phase: 'COMPLETE',
  stories: Object.fromEntries(Array.from({ length: total }, (_, i) => [String(i + 1), { status: 'complete', commit: 'abc', e2eStatus: 'passed', startedAt: null, completedAt: null }])),
  halt: null,
  lastUpdated: '2026-07-03T00:00:00Z'
});

const planMd = (...rows) => [
  '# Epic Plan', '', '## Epics', '',
  '| # | Epic | Delivers | Builds on |',
  '|---|---|---|---|',
  ...rows, ''
].join('\n');

test('collect: a /plan-parked epic on main (no branch) surfaces as ready-to-build', () => {
  const root = gitRepoOnMain({
    'generated-docs/project.md': '# Demo\n\n| Field | Value |\n|---|---|\n| Project slug | `demo` |\n',
    'generated-docs/epic-plan.md': planMd(
      `| 1 | Auth (${B}auth${B}) | Login | — |`,
      `| 2 | Billing (${B}billing${B}) | Invoices | — |`
    ),
    'generated-docs/epics/billing/state.json': parkedState('billing', 'Billing', 3)
  });

  try {
    const data = collect(root);
    assertEqual(data.status, 'ok', 'collected');
    const billing = data.plan.find((e) => e.slug === 'billing');
    assertEqual(billing.status, 'ready-to-build', 'parked epic reads as ready-to-build, not a draft');
    assertEqual(data.plan.find((e) => e.slug === 'auth').status, 'ready', 'the still-unplanned draft stays ready');
    const inf = data.inFlight.find((e) => e.slug === 'billing');
    assertEqual(!!inf, true, 'parked epic is surfaced through inFlight');
    assertEqual(inf.branch, null, 'with branch null — it lives on main, not a side branch');
    assertEqual(inf.stories.total, 3, 'carrying its planned story count');
    assertEqual(data.merged.length, 0, 'a READY-TO-BUILD epic is NOT counted as merged');
    assertEqual(data.now.kind, 'ready-to-build', 'the now-state points at the parked epic');
    assertEqual(data.now.epicName, 'Billing', 'names the parked epic');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── collect(): merged and parked epics carry a per-story storyList ─────────────
//
// The dashboard now expands completed and ready-to-build epics to their stories,
// not just the active epic. collect() must attach a storyList (with titles read
// from the committed story files on `main`) to both — so the renderer has rows to
// show without the epic being checked out.
test('collect: merged and parked epics carry a storyList with titles', () => {
  const root = gitRepoOnMain({
    'generated-docs/project.md': '# Demo\n\n| Field | Value |\n|---|---|\n| Project slug | `demo` |\n',
    'generated-docs/epic-plan.md': planMd(
      `| 1 | Auth (${B}auth${B}) | Login | — |`,
      `| 2 | Billing (${B}billing${B}) | Invoices | — |`
    ),
    'generated-docs/epics/auth/state.json': mergedState('auth', 'Auth', 2),
    'generated-docs/epics/auth/stories/story-1-sign-in.md': '# Story 1: Sign in\n',
    'generated-docs/epics/auth/stories/story-2-sign-out.md': '# Story 2: Sign out\n',
    'generated-docs/epics/billing/state.json': parkedState('billing', 'Billing', 2),
    'generated-docs/epics/billing/stories/story-1-invoices.md': '# Story 1: Invoices\n',
    'generated-docs/epics/billing/stories/story-2-receipts.md': '# Story 2: Receipts\n'
  });

  try {
    const data = collect(root);

    const auth = data.merged.find((e) => e.slug === 'auth');
    assertEqual(!!auth, true, 'merged epic present');
    assertEqual(auth.storyList.length, 2, 'merged epic has a full story list');
    assertDeepEqual(auth.storyList.map((s) => s.title), ['Sign in', 'Sign out'], 'titles read from main');
    assertEqual(auth.storyList.every((s) => s.status === 'complete'), true, 'merged stories all complete');

    const billing = data.inFlight.find((e) => e.slug === 'billing');
    assertEqual(!!billing, true, 'parked epic surfaced through inFlight');
    assertEqual(billing.storyList.length, 2, 'parked epic has a full story list');
    assertDeepEqual(billing.storyList.map((s) => s.title), ['Invoices', 'Receipts'], 'parked titles read from main');
    assertEqual(billing.storyList.every((s) => s.status === 'pending'), true, 'parked stories still pending');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

summary();
