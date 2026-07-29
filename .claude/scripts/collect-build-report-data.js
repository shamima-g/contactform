#!/usr/bin/env node
/**
 * collect-build-report-data.js
 *
 * Produces a "how did this build actually go?" retrospective payload for the
 * /build-report HTML page. Everything here is DERIVED from artifacts the workflow
 * already writes — nothing is invented, so the report reads identically every run:
 *
 *   Timeline + effort  ← git commit timestamps (author date), clustered into
 *                        working sessions by an idle-gap threshold. "Active build
 *                        time" is the summed span of those sessions — a floor, not
 *                        a stopwatch (a lone commit contributes ~0), stated as such
 *                        in the report so it can't be read as billing precision.
 *   Per-epic effort    ← commits attributed to an epic by their conventional-commit
 *                        scope (`feat(<slug>/story-N)`, `docs(<slug>)`, …), plus the
 *                        epic's own state.json (stories, manual-test outcome).
 *   Stumbling blocks   ← generated-docs/template-feedback.md — the workflow's own
 *                        curated log of tooling friction — one entry per `## ` head.
 *   Rework signal      ← git `fix(...)` / manual-test-fix commits + each story's
 *                        e2eStatus === "passed-after-fix" in state.json.
 *   Code & app stats   ← tracked files under web/src + web/e2e (LOC by layer,
 *                        components, routes, test blocks) and web/package.json
 *                        diffed against its first committed version (deps added).
 *   Churn              ← git --numstat over web/ (lockfile excluded), attributed
 *                        per commit so rework cost is measurable in lines.
 *   Performance        ← ratios derived from the above: first-pass E2E yield,
 *                        rework share, velocity per story, test-to-code ratio.
 *   Cost & effort      ← generated-docs/reports/build-cost-data.json — the
 *                        exact transcript-derived tokens/cost/user-inputs/waits the
 *                        /build-report-cost skill writes. Summarised here (null when
 *                        absent); this script never parses transcripts itself.
 *   Gate history       ← generated-docs/quality-gate-runs.jsonl, appended by
 *                        quality-gates.js on every run (null when absent).
 *   Data quality       ← a manifest of which sources above were found, plus every
 *                        assumption/estimate — rendered verbatim in the report.
 *   Narrative          ← each epic's journal.md, surfaced verbatim for the reader.
 *
 * Usage:
 *   node .claude/scripts/collect-build-report-data.js                 # JSON to stdout
 *   node .claude/scripts/collect-build-report-data.js --format=text   # compact text
 *   node .claude/scripts/collect-build-report-data.js --root <dir>    # operate on <dir>
 *   node .claude/scripts/collect-build-report-data.js --gap <minutes> # session idle gap (default 45)
 *
 * Empty/fresh projects (no project.md) return { status: "no_project" }; a project
 * with legacy state returns { status: "legacy_detected" } — the report surfaces the
 * same guidance the dashboard does rather than rendering a blank page.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { tryGit } = require('./lib/git');
const { projectStatus } = require('./lib/project-status');
const { EPICS_DIR_REL, PROJECT_MD_REL } = require('./resolve-state-path');
const { getProjectRoot } = require('./lib/project-root');
const { parseEpicPlan, isTerminalPhase } = require('./collect-dashboard-data'); // shared "## Epics" table parser + terminal-phase test (require.main-guarded — no side effects)

const EPIC_PLAN_REL = 'generated-docs/epic-plan.md';
const TEMPLATE_FEEDBACK_REL = 'generated-docs/template-feedback.md';
const INSIGHTS_DATA_REL = 'generated-docs/reports/build-cost-data.json'; // written by the /build-report-cost skill
const GATE_RUNS_REL = 'generated-docs/quality-gate-runs.jsonl'; // appended by quality-gates.js on every run
const REPORT_META_REL = 'generated-docs/report-meta.json'; // { team } — asked once by /build-report
const DEFAULT_GAP_MIN = 45; // commits more than this far apart start a new work session

function parseArgs(argv) {
  const args = { root: getProjectRoot(), format: 'json', gapMin: DEFAULT_GAP_MIN };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = path.resolve(argv[++i]);
    else if (a.startsWith('--format=')) args.format = a.split('=')[1];
    else if (a === '--format') args.format = argv[++i];
    else if (a === '--gap') { const g = Number(argv[++i]); args.gapMin = Number.isFinite(g) && g >= 0 ? g : DEFAULT_GAP_MIN; }
  }
  return args;
}

function readFileIf(root, rel) {
  const abs = path.join(root, rel);
  try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}

// ── Git history → commits + churn (one traversal) ────────────────────────────
// A single `git log --all --no-merges --numstat` walk feeds BOTH the commit list
// (parseCommits) and the per-commit churn map (parseNumstat), so the whole history is
// walked once, not twice. Author date (%aI) is when the work happened; %H/%s identify
// it. Unit + record separators (0x1f/0x1e) survive any punctuation a commit subject may
// contain, and %x1e leads each record so --numstat's lines attach to the right commit.
function readGitLog(root) {
  return tryGit(root, 'log', '--all', '--no-merges', '--numstat',
    '--pretty=format:%x1e%H\x1f%aI\x1f%s');
}

function parseCommits(raw) {
  if (!raw) return [];
  const seen = new Set();
  const commits = [];
  for (const rec of raw.split('\x1e')) {
    // First line of each record is the commit header; the rest are --numstat rows,
    // consumed separately by parseNumstat.
    const header = rec.split('\n', 1)[0].replace(/\r$/, '');
    if (!header) continue;
    const [hash, date, subject] = header.split('\x1f');
    if (!hash || !date) continue;
    if (seen.has(hash)) continue;           // --all can list a commit under several refs
    seen.add(hash);
    // Stash bookkeeping commits (`WIP on …`, `index on …`) are not real work moments.
    if (/^(WIP|index) on /.test(subject || '')) continue;
    commits.push({ hash: hash.slice(0, 8), date, subject: subject || '' });
  }
  // Sort by the parsed instant, not the raw ISO string: %aI carries each author's
  // timezone offset, so a lexical compare misorders commits across a DST shift or
  // machines in different zones (and clusterSessions would then read a negative gap).
  commits.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  return commits;
}

const minutesBetween = (aIso, bIso) =>
  Math.round((Date.parse(bIso) - Date.parse(aIso)) / 60000);

// Cluster commits into sessions: a gap larger than gapMin starts a new session.
// Session duration is the span of its own commits (a single-commit session is 0),
// so "active minutes" is a deliberate FLOOR on real effort, never an over-count.
function clusterSessions(commits, gapMin) {
  if (!commits.length) return [];
  const sessions = [];
  let cur = null;
  for (const c of commits) {
    if (cur && minutesBetween(cur.commits[cur.commits.length - 1].date, c.date) <= gapMin) {
      cur.commits.push(c);
    } else {
      cur = { commits: [c] };
      sessions.push(cur);
    }
  }
  return sessions.map((s) => {
    const first = s.commits[0].date;
    const last = s.commits[s.commits.length - 1].date;
    return {
      start: first,
      end: last,
      day: first.slice(0, 10),
      durationMin: Math.max(0, minutesBetween(first, last)),
      commitCount: s.commits.length,
      commits: s.commits
    };
  });
}

// ── Epic slugs + per-epic state ──────────────────────────────────────────────
// Every epic dir on disk (merged epics live under generated-docs/epics on the
// working tree once main is checked out; in-flight ones are there too).
function listEpicSlugs(root) {
  const dir = path.join(root, EPICS_DIR_REL);
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function readState(root, slug) {
  const raw = readFileIf(root, `${EPICS_DIR_REL}/${slug}/state.json`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function readJournal(root, slug) {
  return readFileIf(root, `${EPICS_DIR_REL}/${slug}/journal.md`);
}

// ── Code & app stats ─────────────────────────────────────────────────────────
// Tracked files only (git ls-files) so scratch/untracked files never skew counts.
const SRC_EXT_RE = /\.(ts|tsx|js|jsx|css)$/;

function classifySrcFile(rel) {
  const p = rel.replace(/\\/g, '/');
  if (!SRC_EXT_RE.test(p)) return null;
  if (p.startsWith('web/e2e/')) return 'e2e';
  if (!p.startsWith('web/src/')) return null;
  if (/(^|\/)__tests__\//.test(p) || /\.(test|spec)\.[jt]sx?$/.test(p)) return 'unitTests';
  return 'source';
}

// Count executable test blocks. `test.fixme(` / `test.skip(` deliberately do NOT
// match the test/it pattern (the dot breaks `\s*\(`), so they're counted apart.
function countTestBlocks(src) {
  return {
    test: (src.match(/\b(?:test|it)(?:\.each\s*\([^)]*\))?\s*\(/g) || []).length,
    fixme: (src.match(/\btest\.fixme\s*\(/g) || []).length
  };
}

function codebaseStats(root) {
  const stats = {
    loc: { source: 0, unitTests: 0, e2e: 0, total: 0 },
    files: { source: 0, unitTests: 0, e2e: 0 },
    components: 0,
    routes: 0,
    tests: { unitFiles: 0, unitBlocks: 0, e2eSpecs: 0, e2eBlocks: 0, e2eFixmes: 0 }
  };
  const raw = tryGit(root, 'ls-files', '-z', 'web/src', 'web/e2e');
  if (!raw) return stats;
  for (const rel of raw.split('\0')) {
    if (!rel) continue;
    const kind = classifySrcFile(rel);
    if (!kind) continue;
    const content = readFileIf(root, rel);
    if (content == null) continue; // tracked but deleted in the working tree
    stats.loc[kind] += content ? content.replace(/\n$/, '').split('\n').length : 0;
    stats.files[kind]++;
    const p = rel.replace(/\\/g, '/');
    if (kind === 'source') {
      if (/^web\/src\/components\/.+\.tsx$/.test(p)) stats.components++;
      if (/^web\/src\/app\/.*page\.tsx$/.test(p)) stats.routes++;
    } else if (kind === 'unitTests') {
      stats.tests.unitFiles++;
      stats.tests.unitBlocks += countTestBlocks(content).test;
    } else {
      const t = countTestBlocks(content);
      stats.tests.e2eSpecs++;
      stats.tests.e2eBlocks += t.test;
      stats.tests.e2eFixmes += t.fixme;
    }
  }
  stats.loc.total = stats.loc.source + stats.loc.unitTests + stats.loc.e2e;
  return stats;
}

// Dependencies the build ADDED: current web/package.json vs its first committed
// version (the template baseline). Removals aren't interesting for this report.
function diffDeps(baseJson, curJson) {
  const keys = (o, f) => Object.keys((o && o[f]) || {});
  const base = new Set([...keys(baseJson, 'dependencies'), ...keys(baseJson, 'devDependencies')]);
  return {
    runtime: keys(curJson, 'dependencies').filter((k) => !base.has(k)).sort(),
    dev: keys(curJson, 'devDependencies').filter((k) => !base.has(k)).sort()
  };
}

function depsAdded(root) {
  const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  const cur = parse(readFileIf(root, 'web/package.json'));
  if (!cur) return { runtime: [], dev: [] };
  const firstHash = (tryGit(root, 'log', '--all', '--reverse', '--format=%H', '--', 'web/package.json') || '')
    .split('\n')[0].trim();
  const base = firstHash ? parse(tryGit(root, 'show', `${firstHash}:web/package.json`)) : null;
  return diffDeps(base || {}, cur);
}

// ── Churn: lines added/deleted per commit ────────────────────────────────────
// Counted over web/ only (the app itself) and excluding the lockfile, whose
// generated thousands-of-line diffs would swamp the hand-written signal.
function churnCounted(p) {
  return /^web\//.test(p) && !/^web\/package-lock\.json$/.test(p);
}

function parseNumstat(raw) {
  const byCommit = new Map();
  if (!raw) return byCommit;
  for (const rec of raw.split('\x1e')) {
    const lines = rec.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const hash = lines[0].slice(0, 8);
    let add = 0, del = 0;
    for (const l of lines.slice(1)) {
      const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m || m[1] === '-') continue; // binary
      if (!churnCounted(m[3])) continue;
      add += Number(m[1]);
      del += Number(m[2]);
    }
    byCommit.set(hash, { add, del }); // --all may repeat a commit; same value, harmless
  }
  return byCommit;
}

// Attribute a commit subject to an epic slug. Conventional-commit scope first
// (`feat(slug/story-N)`, `docs(slug)`), then — for generic scopes like
// `docs(plan): stories for epic <slug>` — a name match anywhere in the subject.
// Slugs are tried longest-first so a slug that is a prefix of another can't
// mis-claim it.
// Whole-word slug matcher, memoised so the fallback loop below doesn't recompile a
// regex per commit×slug. A raw substring test would let a short slug claim any commit
// that merely mentions it inside another word (`data` in "metadata", `ui` in "guidance").
const slugWordRe = new Map();
function slugBoundary(s) {
  let re = slugWordRe.get(s);
  if (!re) { re = new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`); slugWordRe.set(s, re); }
  return re;
}

function attributeCommit(subject, slugsByLength) {
  const scope = subject.match(/^[a-zA-Z]+\(([^)]+)\)/);
  if (scope) {
    const head = scope[1].split('/')[0].trim();
    if (slugsByLength.includes(head)) return head;
  }
  for (const s of slugsByLength) {
    if (slugBoundary(s).test(subject)) return s;
  }
  return null;
}

// Rework signal in a commit subject. `correct` is matched only as the fix verb/noun
// (correct/corrects/corrected/correcting/correction[s]); the `\b` after the optional suffix
// excludes "correctly"/"correctness", which describe a feature working, not rework.
const FIX_RE = /^(fix|revert)\b|manual-test fix|epic-end.*fix|\bcorrect(?:s|ed|ing|ions?)?\b|\bharden/i;

function summariseManualTest(state) {
  // state.json carries the manual-test result in a few shapes across epics:
  // an array of per-check results, a short manualTestOutcome word, and/or a long
  // manualTestResults/manualTestNote prose string. We return a SHORT label for the
  // headline pill plus the full prose as `note` for the epic body.
  const e = state?.epic || {};
  // A NON-EMPTY array of per-check results. An empty array is the init-time default
  // (manual test not run yet), NOT a 0-of-0 pass — treat it as "no structured results"
  // so the label falls back to prose or to "not tested yet", never reporting an
  // untested epic as passed. Each element is guarded too (a null entry mustn't crash).
  const arr = Array.isArray(e.manualTestResults) && e.manualTestResults.length ? e.manualTestResults : null;
  const prose = e.manualTestNote || (typeof e.manualTestResults === 'string' ? e.manualTestResults : null) || null;
  let passed = null, total = null;
  if (arr) { total = arr.length; passed = arr.filter((r) => r && r.passed).length; }
  // No structured results? Best-effort a "13/15 passed" figure out of the prose.
  if (passed == null && prose) {
    const m = prose.match(/(\d+)\s*\/\s*(\d+)(?:\s+(?:checks?|tests?))?\s+passed/i);
    if (m && Number(m[2]) >= Number(m[1])) { passed = Number(m[1]); total = Number(m[2]); }
  }

  // Short label: prefer an explicit short outcome; else derive. Collapse any verbose
  // outcome string (some epics stored the whole write-up there) to one word.
  const failLike = (s) => /\bfail|mixed/i.test(s) && !/no .*defect|no code defect/i.test(s);
  let label = e.manualTestOutcome || null;
  if (!label) {
    if (arr) label = passed === total ? 'passed' : 'mixed';
    else if (prose) label = failLike(prose) ? 'mixed' : 'passed';
  }
  if (label && label.length > 24) label = failLike(label) ? 'mixed' : 'passed';

  return { outcome: label, note: prose, passed, total };
}

function countStories(state) {
  const stories = state?.stories && typeof state.stories === 'object' ? Object.values(state.stories) : [];
  // Every predicate guards `s &&` first: a null story entry in a malformed/partially
  // written state.json must be skipped, not crash the whole report.
  return {
    total: stories.length,
    complete: stories.filter((s) => s && s.status === 'complete').length,
    passedAfterFix: stories.filter((s) => s && s.e2eStatus === 'passed-after-fix').length,
    // First-pass yield inputs: stories whose E2E ran at all, and those that
    // passed without needing the fix cycle.
    withE2e: stories.filter((s) => s && (s.e2eStatus === 'passed' || s.e2eStatus === 'passed-after-fix')).length,
    firstPass: stories.filter((s) => s && s.e2eStatus === 'passed').length
  };
}

// ── Build-flow: per-story timing for the swimlane panel ──────────────────────
// Each story carries orchestrator-written startedAt/completedAt (minute-granular).
// The wrap-up segment is the epic-end work after the last story (review, batched
// E2E, manual test): last story end → the epic's last attributed commit on that
// same calendar day. Older state files without story timestamps yield
// { stories: [] } and the panel degrades gracefully.
function storyFlow(state, mine) {
  const stories = Object.entries(state?.stories && typeof state.stories === 'object' ? state.stories : {})
    .filter(([, s]) => s.startedAt && s.completedAt && Date.parse(s.startedAt) <= Date.parse(s.completedAt))
    .map(([n, s]) => {
      const c = s.commit ? mine.find((m) => m.hash.startsWith(s.commit)) : null;
      const title = c ? (c.subject.match(/:\s*(.+)$/)?.[1] ?? c.subject) : null;
      return { n: Number(n), title, startedAt: s.startedAt, completedAt: s.completedAt, commit: s.commit || null, e2eStatus: s.e2eStatus || null };
    })
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  if (!stories.length) return { stories: [], wrapUp: null };
  const last = stories[stories.length - 1];
  const sameDay = (a, b) => String(a).slice(0, 10) === String(b).slice(0, 10); // day as recorded, like fmtDate
  const after = mine.filter((c) => Date.parse(c.date) > Date.parse(last.completedAt) && sameDay(c.date, last.completedAt));
  const wrapUp = after.length ? { endedAt: after[after.length - 1].date, commits: after.length } : null;
  return { stories, wrapUp };
}

// Parallelism headline over every story interval in the project: total story
// minutes vs the union of the story time windows (wall-clock), peak stories in
// flight, and the share of wall-clock with ≥ 2 stories running. Null when no
// story has timestamps.
function buildFlowStats(intervals) {
  const valid = intervals.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e >= s);
  if (!valid.length) return null;
  const sorted = valid.slice().sort((a, b) => a[0] - b[0]);
  let union = 0, curS = null, curE = null;
  for (const [s, e] of sorted) {
    if (curE === null || s > curE) { if (curE !== null) union += curE - curS; curS = s; curE = e; }
    else curE = Math.max(curE, e);
  }
  if (curE !== null) union += curE - curS;
  // Sweep: ends before starts at the same instant, so touching ≠ overlapping.
  const ev = [];
  for (const [s, e] of valid) ev.push([s, 1], [e, -1]);
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let n = 0, peak = 0, prev = null, overlap2 = 0;
  for (const [t, d] of ev) {
    if (prev !== null && n >= 2 && t > prev) overlap2 += t - prev;
    n += d; peak = Math.max(peak, n); prev = t;
  }
  const storyMinutes = Math.round(valid.reduce((a, [s, e]) => a + (e - s), 0) / 60000);
  const wallClockMinutes = Math.round(union / 60000);
  return {
    storyMinutes,
    wallClockMinutes,
    parallelism: wallClockMinutes ? +(storyMinutes / wallClockMinutes).toFixed(2) : null,
    peakInFlight: peak,
    overlapPct: union ? Math.round((overlap2 / union) * 100) : null
  };
}

function epicPhaseStatus(state) {
  const phase = state?.phase ?? null;
  // COMPLETE-ON-BRANCH is terminal work: the epic is fully built and manually
  // tested, awaiting only the merge to main — count it as delivered, like COMPLETE.
  if (isTerminalPhase(phase)) return 'complete';
  // READY-TO-BUILD is a parked, planned-ahead epic (via /plan): planning is done
  // but no build has started, so it's 'planned', not actively 'in-flight'. (Null
  // phase — a brief with no state — is also just planned.)
  if (phase == null || phase === 'READY-TO-BUILD') return 'planned';
  return 'in-flight';
}

// ── template-feedback.md → stumbling blocks ─────────────────────────────────
// Each `## ` section is one friction entry. Body shapes vary (Source/Issue/Fix
// bullets, or Where/What happens/Impact prose), so we keep the raw body for the
// reader and best-effort a one-line "source" + summary for the card headline.
function parseTemplateFeedback(raw) {
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      if (cur) blocks.push(cur);
      cur = { title: h2[1].trim(), body: [] };
      continue;
    }
    if (line.match(/^#\s+/)) { continue; } // skip the file H1
    if (cur) cur.body.push(line);
  }
  if (cur) blocks.push(cur);

  const fieldValue = (body, labels) => {
    for (const l of body) {
      for (const label of labels) {
        const re = new RegExp(`^[-*]?\\s*\\*\\*${label}[:.]?\\*\\*\\s*(.+)$`, 'i');
        const m = l.match(re);
        if (m) return m[1].trim();
      }
    }
    return null;
  };

  return blocks.map((b) => {
    const body = b.body.join('\n').trim();
    const source = fieldValue(b.body, ['Source', 'Where']);
    const summary = fieldValue(b.body, ['Issue', 'What happens']) ||
      // fall back to the first non-empty prose line
      (b.body.map((l) => l.replace(/^[-*]\s*/, '').trim()).find((l) => l && !l.startsWith('**')) || '');
    return { title: b.title, source, summary, body };
  });
}

// ── Coverage: planned vs built ───────────────────────────────────────────────
function readPlanSlugs(root) {
  const raw = tryGit(root, 'show', `main:${EPIC_PLAN_REL}`) ?? readFileIf(root, EPIC_PLAN_REL);
  // Reuse the dashboard's "## Epics" table parser so the two reports never disagree
  // on the plan for the same epic-plan.md. Empty set when there's no plan.
  return new Set((raw ? parseEpicPlan(raw) : []).map((e) => e.slug));
}

function readProjectName(root) {
  const raw = readFileIf(root, PROJECT_MD_REL);
  if (!raw) return null;
  const h1 = raw.match(/^#\s+(.+?)\s*$/m);
  return h1 ? h1[1].trim() : null;
}

// ── Cost & user involvement (from the /build-report-cost data file) ──────────
// The /build-report-cost skill parses the Claude Code transcripts and writes exact
// token/cost/user-involvement figures to a JSON file. We summarise it here so the
// build report can show cost alongside the git-derived metrics without owning a
// second transcript parser. Null when the file hasn't been generated.
function readInsightsSummary(root) {
  const raw = readFileIf(root, INSIGHTS_DATA_REL);
  if (!raw) return null;
  let d;
  try { d = JSON.parse(raw); } catch { return null; }
  if (!d || !d.grand) return null;
  const agentsSpawned = Array.isArray(d.agents)
    ? d.agents.filter((a) => a.instances != null).reduce((s, a) => s + a.instances, 0)
    : null;
  const questionsAsked = Array.isArray(d.buckets)
    ? d.buckets.reduce((s, b) => s + (b.questionsAsked || 0), 0)
    : null;
  return {
    generatedAt: d.generatedAt || null,
    usdToZar: d.usdToZar || null,
    rateProvided: !!d.rateProvided,
    costUsd: d.grand.costUsd ?? null,
    totalTokens: d.grand.totalTokens ?? null,
    outputTokens: d.grand.output ?? null,
    apiCalls: d.grand.calls ?? null,
    cacheHit: d.grand.cacheHit ?? null,
    agentsSpawned,
    questionsAsked,
    userInputs: d.userInputsTotal || null,       // { typed, commands, manualTest, interruptions }
    waits: d.waitsTotal || null,                 // { approvalMs, approvalCount, generalMs, generalCount, stallMs, stallCount }
    stallThresholdMin: d.stallThresholdMin || null,
    postDelivery: d.postDelivery
      ? { sessions: (d.postDelivery.sessions || []).length, costUsd: d.postDelivery.tokens?.costUsd ?? 0 }
      : null,
    // Per-bucket cost for the "cost by phase/epic" bars (label + USD only).
    bucketCosts: Array.isArray(d.buckets)
      ? d.buckets.map((b) => ({ label: b.label, costUsd: b.tokens?.costUsd ?? 0 }))
      : []
  };
}

// ── Quality-gate run history (from quality-gates.js's append-only log) ────────
// One JSONL line per gate run: { timestamp, branch, checks, gates, overallStatus,
// failedGates }. Summarised into per-gate pass/fail totals plus a rerun count
// (runs that immediately follow a failed run — the retry loop signal).
function readGateRuns(root) {
  const raw = readFileIf(root, GATE_RUNS_REL);
  if (!raw) return null;
  const runs = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { runs.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
  }
  if (!runs.length) return null;
  const byGate = {};
  let failedRuns = 0;
  let rerunsAfterFailure = 0;
  runs.forEach((r, i) => {
    if (r.overallStatus === 'fail') failedRuns++;
    if (i > 0 && runs[i - 1].overallStatus === 'fail') rerunsAfterFailure++;
    for (const [gate, status] of Object.entries(r.gates || {})) {
      if (status === 'skip' || status === 'pending') continue;
      const g = (byGate[gate] ||= { runs: 0, fails: 0 });
      g.runs++;
      if (status === 'fail') g.fails++;
    }
  });
  return {
    totalRuns: runs.length,
    failedRuns,
    rerunsAfterFailure,
    byGate,
    firstRun: runs[0].timestamp || null,
    lastRun: runs[runs.length - 1].timestamp || null
  };
}

function readReportMeta(root) {
  const raw = readFileIf(root, REPORT_META_REL);
  if (!raw) return null;
  try {
    const m = JSON.parse(raw);
    return m && typeof m === 'object' ? { team: m.team || null } : null;
  } catch { return null; }
}

function collect(root, gapMin = DEFAULT_GAP_MIN) {
  const status = projectStatus(root);
  if (status === 'legacy_detected') {
    return { status, message: 'Legacy workflow state detected. Run /migrate-legacy to convert to the epic-branch workflow.' };
  }
  if (status === 'no_project') {
    return { status, message: 'No project yet — run /start to begin. Your build report will fill in as the workflow runs.' };
  }

  const gitLog = readGitLog(root);
  const commits = parseCommits(gitLog);
  const sessions = clusterSessions(commits, gapMin);
  const activeMinutes = sessions.reduce((n, s) => n + s.durationMin, 0);

  const slugs = listEpicSlugs(root);
  const slugsByLength = [...slugs].sort((a, b) => b.length - a.length);
  const churnByCommit = parseNumstat(gitLog);
  const churnOf = (cs) => cs.reduce((a, c) => {
    const ch = churnByCommit.get(c.hash);
    if (ch) { a.add += ch.add; a.del += ch.del; }
    return a;
  }, { add: 0, del: 0 });

  // Attribute every commit to an epic (or null) once, up front.
  const commitEpic = new Map();
  for (const c of commits) commitEpic.set(c.hash, attributeCommit(c.subject, slugsByLength));

  const epics = slugs.map((slug) => {
    const state = readState(root, slug);
    const mine = commits.filter((c) => commitEpic.get(c.hash) === slug);
    const fixCommits = mine.filter((c) => FIX_RE.test(c.subject));
    // Sessions this epic appears in (interleaved epics share sessions — flagged).
    const epicSessions = sessions.filter((s) => s.commits.some((c) => commitEpic.get(c.hash) === slug));
    const stories = countStories(state);
    const churn = churnOf(mine);
    return {
      slug,
      name: state?.epic?.name || slug,
      status: epicPhaseStatus(state),
      createdAt: state?.epic?.createdAt || (mine[0]?.date ?? null),
      firstCommit: mine[0] ? { date: mine[0].date, subject: mine[0].subject } : null,
      lastCommit: mine.length ? { date: mine[mine.length - 1].date, subject: mine[mine.length - 1].subject } : null,
      spanMin: mine.length ? Math.max(0, minutesBetween(mine[0].date, mine[mine.length - 1].date)) : 0,
      sessionMinutes: epicSessions.reduce((n, s) => n + s.durationMin, 0),
      sharedSessions: epicSessions.some((s) => s.commits.some((c) => commitEpic.get(c.hash) && commitEpic.get(c.hash) !== slug)),
      commitCount: mine.length,
      fixCommitCount: fixCommits.length,
      linesAdded: churn.add,
      linesDeleted: churn.del,
      stories,
      flow: storyFlow(state, mine),
      manualTest: summariseManualTest(state),
      unverifiedAssumptions: Array.isArray(state?.epic?.unverifiedAssumptions) ? state.epic.unverifiedAssumptions.length : 0,
      journal: readJournal(root, slug)
    };
  });

  // Order epics the way they were built: by first attributed commit; epics with no
  // commits yet (planned-only, e.g. a brief with no state.json) fall to the end.
  epics.sort((a, b) => {
    const ad = a.firstCommit?.date, bd = b.firstCommit?.date;
    if (ad && bd) return Date.parse(ad) - Date.parse(bd);
    if (ad) return -1;
    if (bd) return 1;
    return a.slug.localeCompare(b.slug);
  });

  // Fix / rework commits across the whole project (timeline markers). Filtered once
  // and reused for the churn sum below (same predicate, no second scan).
  const fixCommitList = commits.filter((c) => FIX_RE.test(c.subject));
  const fixCommits = fixCommitList
    .map((c) => ({ date: c.date, subject: c.subject, epic: commitEpic.get(c.hash) }));

  const templateFeedbackRaw = readFileIf(root, TEMPLATE_FEEDBACK_REL);
  const stumblingBlocks = parseTemplateFeedback(templateFeedbackRaw);

  // Build-flow headline: parallelism across every timestamped story interval.
  const buildFlow = buildFlowStats(epics.flatMap((e) =>
    e.flow.stories.map((s) => [Date.parse(s.startedAt), Date.parse(s.completedAt)])));

  const builtEpics = epics.filter((e) => e.status === 'complete').length;
  const planSlugs = readPlanSlugs(root);
  const plannedEpics = planSlugs.size || null;
  // Off-plan epics (built outside the plan, e.g. a hotfix) count toward the denominator
  // too, so "epics delivered X/Y" can never exceed 100% — mirrors the dashboard's
  // epicsTotal (collect-dashboard-data.js computeOverview).
  const offPlanEpics = plannedEpics ? epics.filter((e) => !planSlugs.has(e.slug)).length : 0;
  const storiesBuilt = epics.reduce((n, e) => n + e.stories.complete, 0);
  const passedAfterFix = epics.reduce((n, e) => n + e.stories.passedAfterFix, 0);

  // ── Workflow-performance ratios (all derived, nothing new measured) ────────
  const codebase = codebaseStats(root);
  codebase.depsAdded = depsAdded(root);

  const totalChurn = churnOf(commits);
  const fixChurn = churnOf(fixCommitList);
  const storiesWithE2e = epics.reduce((n, e) => n + e.stories.withE2e, 0);
  const firstPassStories = epics.reduce((n, e) => n + e.stories.firstPass, 0);
  const manualChecks = epics.reduce((a, e) => {
    if (e.manualTest.passed != null && e.manualTest.total != null) {
      a.passed += e.manualTest.passed; a.total += e.manualTest.total;
    }
    return a;
  }, { passed: 0, total: 0 });
  const pct = (num, den) => (den ? Math.round((100 * num) / den) : null);
  const testLoc = codebase.loc.unitTests + codebase.loc.e2e;

  const performance = {
    // Of the stories whose E2E ran, how many passed without a fix cycle.
    e2eFirstPass: { passed: firstPassStories, total: storiesWithE2e, pct: pct(firstPassStories, storiesWithE2e) },
    fixCommitSharePct: pct(fixCommits.length, commits.length),
    // Share of all churned lines (web/, no lockfile) that fix commits touched.
    reworkChurnPct: pct(fixChurn.add + fixChurn.del, totalChurn.add + totalChurn.del),
    minutesPerStory: storiesBuilt ? Math.round(activeMinutes / storiesBuilt) : null,
    commitsPerStory: storiesBuilt ? +(commits.length / storiesBuilt).toFixed(1) : null,
    sourceLocPerStory: storiesBuilt && codebase.loc.source ? Math.round(codebase.loc.source / storiesBuilt) : null,
    testToCodeRatio: codebase.loc.source ? +(testLoc / codebase.loc.source).toFixed(2) : null,
    manualChecks: manualChecks.total
      ? { passed: manualChecks.passed, total: manualChecks.total, pct: pct(manualChecks.passed, manualChecks.total) }
      : null,
    // Gate escapes: manual-verification checks a human failed AFTER the automated
    // gates had passed the same code — defects the gates didn't catch.
    gateEscapes: manualChecks.total ? manualChecks.total - manualChecks.passed : null,
    assumptionsOpen: epics.reduce((n, e) => n + e.unverifiedAssumptions, 0),
    churn: { added: totalChurn.add, deleted: totalChurn.del, fixAdded: fixChurn.add, fixDeleted: fixChurn.del }
  };

  const costEffort = readInsightsSummary(root);
  const gateRuns = readGateRuns(root);
  const meta = readReportMeta(root);
  const hasTemplateFeedback = templateFeedbackRaw != null;

  // What fed this report, what's missing, and what's estimated vs exact — rendered
  // verbatim as the report's "Data quality" section so the numbers can't be
  // over-read. `found: false` entries state what instrumentation would fill them.
  const dataQuality = {
    sources: [
      { name: 'Git history', found: commits.length > 0, note: commits.length ? `${commits.length} commits — timeline, effort floor, churn, per-epic attribution` : 'no commits found' },
      { name: 'Epic state files', found: slugs.length > 0, note: slugs.length ? `${slugs.length} epic(s) under generated-docs/epics/ — stories, manual-test outcomes` : 'no epics yet' },
      { name: 'Tooling-friction log', found: hasTemplateFeedback, note: hasTemplateFeedback ? 'generated-docs/template-feedback.md' : 'none logged (or file absent)' },
      { name: 'Transcript cost & involvement data', found: !!costEffort, note: costEffort ? `cost data generated ${(costEffort.generatedAt || '').slice(0, 16).replace('T', ' ')} UTC` : 'not generated — run /build-report (it refreshes it) or /build-report-cost' },
      { name: 'Quality-gate run history', found: !!gateRuns, note: gateRuns ? `${gateRuns.totalRuns} runs logged since ${(gateRuns.firstRun || '').slice(0, 10)}` : 'no quality-gate-runs.jsonl — history starts with the first gate run after this template version' },
      { name: 'Team name', found: !!(meta && meta.team), note: meta && meta.team ? meta.team : 'not set — /build-report asks once and saves it' }
    ],
    assumptions: [
      'Active build time is a floor, not a stopwatch: git commits are clustered into sessions and each session’s span is summed — a lone commit contributes ~0.',
      'Per-epic time is attributed by commit scope; epics built interleaved share session time (marked "shared time").',
      'Cost figures are estimates at API list prices; actual billing under a subscription differs.',
      'Waiting-on-user durations are measured between recorded events (a question → its answer; end of AI output → the next deliberate input); gaps over the stall threshold are excluded from waits and shown as stalls.',
      'Waiting-on-user time is how long the process sat idle awaiting input — it is NOT a measure of the user\'s working time, which is not recorded anywhere. No human-vs-AI effort split can be derived from this data.',
      'Time spent at permission prompts is NOT measurable — permission prompts are not recorded in transcripts and hide inside tool runtimes.',
      'User-input counts follow transcript hygiene: harness-injected user-role entries (tool results, notifications, IDE events) are excluded; only typed messages, commands, manual-test submissions, and interruptions count.',
      'Post-delivery reporting sessions (report/dashboard generation) are excluded from cost totals and shown separately.',
      'Build-flow story bars use the orchestrator-written per-story timestamps (minute-granular, ±1 min); the hatched lead-in/lead-out segments are derived (epic creation → first story; last story → the epic\'s last same-day commit), not measured phases.'
    ]
  };

  return {
    status: 'ok',
    project: { name: readProjectName(root) },
    meta: meta || { team: null },
    generatedAt: new Date().toISOString(),
    timeline: {
      firstCommit: commits[0] ? { date: commits[0].date, subject: commits[0].subject } : null,
      lastCommit: commits.length ? { date: commits[commits.length - 1].date, subject: commits[commits.length - 1].subject } : null,
      spanDays: commits.length ? Math.max(1, Math.ceil(minutesBetween(commits[0].date, commits[commits.length - 1].date) / 1440)) : 0,
      totalCommits: commits.length,
      sessions,
      sessionCount: sessions.length,
      activeMinutes,
      gapMin
    },
    epics,
    buildFlow,
    coverage: { plannedEpics, offPlanEpics, builtEpics, storiesBuilt },
    rework: { fixCommitCount: fixCommits.length, passedAfterFixStories: passedAfterFix, fixCommits },
    codebase,
    performance,
    costEffort,
    gateRuns,
    dataQuality,
    stumblingBlocks
  };
}

// ── Compact text (debug / fallback) ──────────────────────────────────────────
function fmtDuration(min) {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

function renderText(data) {
  if (data.status !== 'ok') return `${data.status}: ${data.message}`;
  const t = data.timeline;
  const lines = [];
  lines.push(`Build report: ${data.project.name ?? '(no name)'}`);
  lines.push('');
  lines.push(`Span:        ${t.spanDays} days (${(t.firstCommit?.date ?? '').slice(0, 10)} → ${(t.lastCommit?.date ?? '').slice(0, 10)})`);
  lines.push(`Active time: ~${fmtDuration(t.activeMinutes)} across ${t.sessionCount} sessions (${t.totalCommits} commits)`);
  lines.push(`Delivered:   ${data.coverage.builtEpics}${data.coverage.plannedEpics ? `/${data.coverage.plannedEpics + (data.coverage.offPlanEpics || 0)}` : ''} epics · ${data.coverage.storiesBuilt} stories`);
  lines.push(`Rework:      ${data.rework.fixCommitCount} fix commits · ${data.rework.passedAfterFixStories} stories passed only after a fix`);
  const p = data.performance;
  if (p) {
    const fp = p.e2eFirstPass;
    lines.push(`First pass:  ${fp.total ? `${fp.passed}/${fp.total} stories (${fp.pct}%) passed E2E without a fix` : 'no E2E outcomes recorded'}`);
    lines.push(`Churn:       +${p.churn.added}/−${p.churn.deleted} lines in web/ · ${p.reworkChurnPct ?? 0}% of it in fix commits`);
    const cb = data.codebase;
    lines.push(`Codebase:    ${cb.loc.source} src + ${cb.loc.unitTests} unit-test + ${cb.loc.e2e} e2e lines · ${cb.components} components · ${cb.routes} routes · test:code ${p.testToCodeRatio ?? '—'}`);
    if (p.minutesPerStory != null) lines.push(`Velocity:    ~${fmtDuration(p.minutesPerStory)} active / story · ${p.commitsPerStory} commits / story`);
  }
  lines.push('');
  lines.push('Per epic:');
  for (const e of data.epics) {
    const mt = e.manualTest.outcome ? ` · manual: ${e.manualTest.outcome}` : '';
    lines.push(`  ${e.status === 'complete' ? '✓' : '▸'} ${e.name} — ${e.stories.complete}/${e.stories.total} stories · ${fmtDuration(e.sessionMinutes)}${e.sharedSessions ? '*' : ''} · ${e.fixCommitCount} fixes${mt}`);
  }
  if (data.epics.some((e) => e.sharedSessions)) lines.push('  * session time shared with an interleaved epic');
  lines.push('');
  lines.push(`Stumbling blocks (from template-feedback.md): ${data.stumblingBlocks.length}`);
  for (const b of data.stumblingBlocks) lines.push(`  • ${b.title}`);
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = collect(args.root, args.gapMin);
  if (args.format === 'text') process.stdout.write(renderText(data) + '\n');
  else process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = {
  collect,
  renderText,
  clusterSessions,
  attributeCommit,
  FIX_RE,
  parseTemplateFeedback,
  summariseManualTest,
  fmtDuration,
  classifySrcFile,
  countTestBlocks,
  diffDeps,
  parseNumstat,
  countStories,
  storyFlow,
  buildFlowStats,
  readInsightsSummary,
  readGateRuns,
  readReportMeta
};
