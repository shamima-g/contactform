#!/usr/bin/env node
/**
 * collect-dashboard-data.js
 *
 * Reads epic-branch workflow state across all branches and emits a JSON payload
 * for the dashboard renderer.
 *
 *   In-flight epics  → enumerated via "git branch --list epic/...", state.json
 *                       read from each branch tip via "git show <branch>:<path>".
 *   Merged epics     → subdirectories of generated-docs/epics/ on the `main`
 *                       branch (read via "git ls-tree"/"git show main:<path>",
 *                       NOT the checked-out working tree) whose state.json is at a
 *                       merged phase (COMPLETE-ON-BRANCH or COMPLETE — the dir only
 *                       reaches main by being merged). Reading main directly keeps
 *                       the merged list correct when /dashboard runs on an epic branch.
 *   Project facts    → read from `generated-docs/project.md` (inherited onto
 *                       every branch, so the working-tree copy is authoritative).
 *
 * Usage:
 *   node .claude/scripts/collect-dashboard-data.js                 # JSON to stdout
 *   node .claude/scripts/collect-dashboard-data.js --format=text   # Compact text for /status
 *   node .claude/scripts/collect-dashboard-data.js --root <dir>    # Operate on <dir>
 *
 * Legacy projects (no project.md, but a `workflow-state.json` exists) return
 * `{ status: "legacy_detected" }` — the dashboard surfaces a "run /migrate-legacy"
 * message instead of rendering empty.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { tryGit } = require('./lib/git');
const { projectStatus } = require('./lib/project-status');
// EPICS_DIR_REL / resolveStatePath are owned by resolve-state-path.js (single
// source of truth for the epic-branch state layout + slug validation) — reuse
// them rather than re-deriving slugs/paths here.
const { EPIC_BRANCH_PREFIX, EPICS_DIR_REL, GENERATED_DOCS_REL, PROJECT_MD_REL, resolveStatePath } = require('./resolve-state-path');
const { getProjectRoot } = require('./lib/project-root');
// EPIC_PHASES is the canonical phase enum (also consumed by generate-dashboard-html.js).
const { EPIC_PHASES } = require('./lib/epic-state');

const EPIC_PLAN_REL = 'generated-docs/epic-plan.md';
const MAIN_BRANCH = 'main';
// The filename the manual-test approval generates. reviewPageFor builds the
// reopen href from GENERATED_DOCS_REL + EPICS_DIR_REL + this, and the existence
// check re-uses that same href string, so the link and the file it gates on can
// never drift apart. (The dashboard HTML is written to the GENERATED_DOCS_REL
// root, so links inside the page resolve relative to it.)
const MANUAL_TEST_PAGE = 'manual-tests.html';
// Story-summary shape for epics with no readable stories — shared so the three
// sites that need it (summariseStories' early return, plus the invalid-slug /
// missing-state entries below) can't drift apart.
const EMPTY_STORIES = Object.freeze({ total: 0, complete: 0, inProgress: null, halted: null });

// Phases where the epic is actively being worked (drives the "building" banner
// state). Derived from the canonical EPIC_PHASES enum minus the non-working
// phases — READY-TO-BUILD (planned but parked, waiting to be built), MANUAL-TEST
// (waits on the user), and COMPLETE (terminal) — each handled by its own banner
// branch, so this can't drift if a phase is ever added to or renamed in EPIC_PHASES.
const NON_WORKING_PHASES = new Set(['READY-TO-BUILD', 'MANUAL-TEST', 'COMPLETE']);
const WORKING_PHASES = Object.freeze(new Set(EPIC_PHASES.filter((p) => !NON_WORKING_PHASES.has(p))));

// The two phases at which an epic's work is finished: COMPLETE-ON-BRANCH (done on
// its branch — merged or ready to merge) and COMPLETE (the after-merge stamp on
// `main`). This just names the finished phases; the merged-epic loop below is
// where they mark an epic done.
const TERMINAL_PHASES = Object.freeze(new Set(['COMPLETE-ON-BRANCH', 'COMPLETE']));
const isTerminalPhase = (phase) => TERMINAL_PHASES.has(phase);

function parseArgs(argv) {
  const args = { root: getProjectRoot(), format: 'json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = path.resolve(argv[++i]);
    else if (a.startsWith('--format=')) args.format = a.split('=')[1];
    else if (a === '--format') args.format = argv[++i];
  }
  return args;
}

function listEpicBranches(root) {
  const out = tryGit(root, 'branch', '--list', `${EPIC_BRANCH_PREFIX}*`, '--format=%(refname:short)');
  if (!out) return [];
  return out.split(/\r?\n/).filter(Boolean);
}

// Reads + parses a state.json from a committed ref (branch tip), never the
// working tree — so the result doesn't depend on which branch is checked out.
function readStateJsonAtRef(root, ref, rel) {
  const raw = tryGit(root, 'show', `${ref}:${rel}`);
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
}

// Reads + parses a state.json from the working tree. Used only for the
// checked-out epic, where the uncommitted file is the freshest truth (the
// in-progress story + just-completed stories live here before the next commit).
function readStateJsonWorkingTree(root, rel) {
  try { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); }
  catch { return null; }
}

// The currently checked-out branch, or null when detached / not a repo. Lets the
// in-flight loop prefer the working tree for the active epic.
function currentBranch(root) {
  const out = tryGit(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  return out && out !== 'HEAD' ? out : null;
}

// Directory names under generated-docs/epics on `main` (the committed tree, not
// the checked-out working tree). Empty if the path doesn't exist on main.
function listMainEpicSlugs(root) {
  const out = tryGit(root, 'ls-tree', '-d', '--name-only', `${MAIN_BRANCH}:${EPICS_DIR_REL}`);
  if (!out) return [];
  return out.split(/\r?\n/).filter(Boolean);
}

// Split a markdown table row into trimmed cells. Honours escaped pipes (`\|`)
// inside cells, and tolerates a missing leading/trailing border pipe (a dropped
// trailing `|` must not silently swallow the last column).
function splitTableRow(line) {
  const parts = line.trim()
    .split(/(?<!\\)\|/)                 // split on unescaped pipes only
    .map((c) => c.replace(/\\\|/g, '|').trim());
  if (parts.length && parts[0] === '') parts.shift();          // leading border pipe
  if (parts.length && parts[parts.length - 1] === '') parts.pop(); // trailing border pipe
  return parts;
}

// A trailing parenthesised backtick group — the slug in an "Epic" cell of the
// form "Name (`slug`)". Captured once, reused to read the slug and to strip it
// off when deriving the display name.
const PAREN_SLUG = /\(\s*`([^`]+)`\s*\)\s*$/;

// All backtick-quoted tokens in a cell, unquoted and trimmed.
const backticks = (cell) => (String(cell).match(/`([^`]+)`/g) || []).map((t) => t.replace(/`/g, '').trim());

// Extract the epic slug from an "Epic" cell of the form "Name (`slug`)". Prefer
// the slug inside the trailing parenthesised backtick group; fall back to the
// LAST backtick group (never the first — the name itself may contain `code`).
function slugFromEpicCell(cell) {
  const paren = cell.match(PAREN_SLUG);
  if (paren) return paren[1].trim();
  const all = backticks(cell);
  return all.length ? all[all.length - 1] : null;
}

// Parse the "## Epics" table of epic-plan.md → ordered [{ slug, name, goal, dependsOn }].
// Plan-only data (status is derived separately in collect()). v1 format — see the
// "epic-plan.md format" block in commands/start.md.
//
// Robust to the variations an LLM-written table actually exhibits: columns are
// located by HEADER NAME (not position), so a leading "#" column or reordered
// columns parse correctly; the header and separator rows are skipped by structure
// (a row with no backtick slug isn't an epic), not by matching words in the data;
// and a "Builds on" dependency named in plain text (no backticks) is resolved
// against the plan's own epic names so it isn't silently dropped.
function parseEpicPlan(raw) {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Epics\b/i.test(l));
  if (start === -1) return [];

  // Collect the section's table rows, dropping separator rows (|---|---|).
  const isSeparator = (cells) => cells.length > 0 && cells.every((c) => c === '' || /^:?-{2,}:?$/.test(c));
  const rows = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break; // next section
    if (!lines[i].trim().startsWith('|')) continue;
    const cells = splitTableRow(lines[i]);
    if (cells.length >= 2 && !isSeparator(cells)) rows.push(cells);
  }
  if (!rows.length) return [];

  // Locate columns by header name. rows[0] is the header in a well-formed table;
  // if its words aren't recognised, fall back to the documented order. Either way
  // the header itself is skipped below by the "no slug → not an epic" guard.
  const header = rows[0];
  const find = (re) => header.findIndex((h) => re.test(h));
  let epicCol = find(/\bepics?\b/i);
  let goalCol = find(/deliver|goal/i);
  let depsCol = find(/build|depend/i);
  if (epicCol < 0) epicCol = header.length >= 4 ? 1 : 0; // documented: # | Epic | Delivers | Builds on
  if (goalCol < 0) goalCol = epicCol + 1;
  if (depsCol < 0) depsCol = epicCol + 2;

  const epics = [];
  for (const cells of rows) {
    const epicCell = cells[epicCol] || '';
    const slug = slugFromEpicCell(epicCell);
    if (!slug) continue; // header / malformed / non-epic row
    const name = epicCell.replace(PAREN_SLUG, '').trim() || slug;
    epics.push({ slug, name, goal: cells[goalCol] || '', _depsCell: cells[depsCol] || '' });
  }

  // Resolve dependencies: backtick slugs first; if a non-empty "Builds on" cell
  // yields none (a dependency written as a plain name, no backticks), match each
  // entry against the plan's own epic names. An entry that matches no known epic
  // (typo / abbreviation / unlisted) is KEPT VERBATIM rather than dropped — dropping
  // it would empty dependsOn and mis-mark a genuinely blocked epic as ready. An
  // unresolved name can't be in doneSlugs, so the epic correctly stays "blocked" and
  // the unresolved name surfaces in waitingOn.
  const slugByName = new Map(epics.map((e) => [e.name.toLowerCase(), e.slug]));
  for (const e of epics) {
    let deps = backticks(e._depsCell);
    if (!deps.length && e._depsCell && !/^[-—–\s]*$/.test(e._depsCell)) {
      deps = e._depsCell
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => slugByName.get(s.toLowerCase()) || s);
    }
    e.dependsOn = deps;
    delete e._depsCell;
  }
  return epics;
}

// The epic plan is authoritative on `main` (edited only there); fall back to the
// working-tree copy (carried onto every branch from main).
function readEpicPlan(root) {
  let raw = tryGit(root, 'show', `${MAIN_BRANCH}:${EPIC_PLAN_REL}`);
  if (!raw) {
    const abs = path.join(root, EPIC_PLAN_REL);
    if (fs.existsSync(abs)) raw = fs.readFileSync(abs, 'utf8');
  }
  return raw ? parseEpicPlan(raw) : null;
}

function readProjectFacts(root) {
  const abs = path.join(root, PROJECT_MD_REL);
  if (!fs.existsSync(abs)) return null;
  const raw = fs.readFileSync(abs, 'utf8');
  // Project name from first H1; slug from the field table; everything else is
  // human prose Claude reads — the dashboard only needs the headline label.
  const h1 = raw.match(/^#\s+(.+?)\s*$/m);
  const slug = raw.match(/Project\s+slug\s*\|\s*`([^`]+)`/i);
  return {
    name: h1 ? h1[1].trim() : null,
    slug: slug ? slug[1].trim() : null
  };
}

function summariseStories(stories) {
  if (!stories || typeof stories !== 'object') return EMPTY_STORIES;
  const entries = Object.entries(stories);
  const total = entries.length;
  const complete = entries.filter(([, s]) => s && s.status === 'complete').length;
  const inProgressEntry = entries.find(([, s]) => s && s.status === 'in-progress');
  const haltedEntry = entries.find(([, s]) => s && s.status === 'halted');
  return {
    total,
    complete,
    // Story keys are opaque strings ("<N>"); keep the raw key rather than
    // parseInt-ing it, matching Get-CurrentStory in hooks/lib/workflow-state.ps1.
    inProgress: inProgressEntry ? inProgressEntry[0] : null,
    halted: haltedEntry ? haltedEntry[0] : null
  };
}

// First-H1 title of a story file ("# Story 4: Sign out" → "Sign out"). Returns
// null when the heading isn't the expected shape, so the renderer falls back to
// a plain "Story <N>" label.
function parseStoryTitle(raw) {
  const m = String(raw).match(/^#\s+Story\s+\d+\s*[:.–—-]\s*(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

// index → title map for an epic's stories, read from the working tree (only
// used for the active epic). Missing dir / unreadable files degrade to {}.
function readStoryTitles(root, slug) {
  const dir = path.join(root, EPICS_DIR_REL, slug, 'stories');
  const titles = {};
  let files;
  try { files = fs.readdirSync(dir); } catch { return titles; }
  for (const f of files) {
    const m = f.match(/^story-(\d+)-.*\.md$/);
    if (!m) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const title = parseStoryTitle(raw);
    if (title) titles[m[1]] = title;
  }
  return titles;
}

// index → title map read from a committed ref (git) instead of the working tree.
// Used for epics whose story files aren't reliably in the checked-out branch:
// merged epics (their files live on `main`) and parked ready-to-build epics. This
// mirrors readStoryTitles but sources the files from "<ref>:<stories-dir>", so the
// per-story rows render correctly no matter which branch is checked out. Missing
// dir / unreadable files degrade to {}.
function readStoryTitlesAtRef(root, ref, slug) {
  const dir = `${EPICS_DIR_REL}/${slug}/stories`;
  const listing = tryGit(root, 'ls-tree', '--name-only', `${ref}:${dir}`);
  if (!listing) return {};
  const titles = {};
  for (const name of listing.split(/\r?\n/).filter(Boolean)) {
    const m = name.match(/^story-(\d+)-.*\.md$/);
    if (!m) continue;
    const raw = tryGit(root, 'show', `${ref}:${dir}/${name}`);
    if (!raw) continue;
    const title = parseStoryTitle(raw);
    if (title) titles[m[1]] = title;
  }
  return titles;
}

// Per-story rows for an epic — state-driven (state.stories is the source of truth
// for which stories exist + their status), enriched with titles. Used for the
// active epic (titles from the working tree) and for merged / parked epics
// (titles from a committed ref via readStoryTitlesAtRef).
function buildStoryList(stories, titles = {}) {
  if (!stories || typeof stories !== 'object') return [];
  return Object.entries(stories)
    .map(([index, s]) => ({
      index,
      title: titles[index] ?? null,
      status: s?.status ?? 'pending',
      e2eStatus: s?.e2eStatus ?? null
    }))
    .sort((a, b) => Number(a.index) - Number(b.index));
}

// The single "what's happening / what's needed from you" state, picked by
// priority across all epics. Pure so it can be unit-tested. The renderer maps
// `kind` to wording + prominence (a calm one-liner for building/idle; a bold
// card for halt/manual-test/ready/complete).
function deriveNow({ inFlight = [], plan = [], hasPlan = false } = {}) {
  const titleFor = (epic, index) =>
    (epic.storyList || []).find((s) => String(s.index) === String(index))?.title ?? null;
  const buildingFor = (epic) => {
    const storyIndex = epic.stories?.inProgress ?? null;
    return {
      kind: 'building',
      epicSlug: epic.slug,
      epicName: epic.name,
      phase: epic.phase,
      storyIndex,
      storyTitle: titleFor(epic, storyIndex),
      storiesComplete: epic.stories?.complete ?? 0,
      storiesTotal: epic.stories?.total ?? 0
    };
  };

  // 1. Halt — an epic-level halt object, or a story marked "halted". Either way
  //    the workflow can't proceed without a decision from the user.
  const halted = inFlight.find((e) => e.halt) || inFlight.find((e) => e.stories?.halted != null);
  if (halted) {
    const storyIndex = halted.stories?.halted ?? halted.stories?.inProgress ?? null;
    return {
      kind: 'halt',
      epicSlug: halted.slug,
      epicName: halted.name,
      phase: halted.phase,
      storyIndex,
      storyTitle: titleFor(halted, storyIndex),
      reason: halted.halt?.reason ?? null
    };
  }

  // 2. The checked-out epic, if it's actively being worked, is what the user is
  //    doing right now — it wins over another epic merely sitting in MANUAL-TEST.
  //    (Without this, a non-active MANUAL-TEST epic shadows the active build.)
  const activeBuilding = inFlight.find((e) => e.isActive && WORKING_PHASES.has(e.phase));
  if (activeBuilding) return buildingFor(activeBuilding);

  // 3. Manual test — an epic is built and waiting for the user to try it.
  const mt = inFlight.find((e) => e.phase === 'MANUAL-TEST');
  if (mt) {
    return { kind: 'manual-test', epicSlug: mt.slug, epicName: mt.name, phase: mt.phase };
  }

  // 4. Building — any other in-flight epic in a working phase.
  const building = inFlight.find((e) => WORKING_PHASES.has(e.phase));
  if (building) return buildingFor(building);

  // 5. Ready to build — an epic whose stories are planned and committed, parked
  //    by /plan and waiting to be built. Distinct from a not-yet-started plan
  //    draft (below): its branch and stories already exist.
  const parked = inFlight.find((e) => e.phase === 'READY-TO-BUILD');
  if (parked) {
    return {
      kind: 'ready-to-build',
      epicSlug: parked.slug,
      epicName: parked.name,
      phase: parked.phase,
      storiesTotal: parked.stories?.total ?? 0
    };
  }

  // 6. With a plan and no LIVE work in flight: ready-to-start, or all-done.
  if (hasPlan) {
    // Broken in-flight branches (invalid-slug / missing-state, phase === null) are surfaced
    // in the table but must not count as active work — otherwise one stray branch suppresses
    // the legitimate "ready to start" banner. Only an epic with a real phase is live.
    const liveInFlight = inFlight.filter((e) => e.phase != null);
    const ready = plan.filter((e) => e.status === 'ready');
    if (!liveInFlight.length && ready.length) {
      return { kind: 'ready', epicSlug: ready[0].slug, epicName: ready[0].name, readyCount: ready.length };
    }
    if (plan.length && plan.every((e) => e.status === 'done')) {
      return { kind: 'complete' };
    }
  }

  // 7. Nothing to report.
  return { kind: 'idle' };
}

// Maps a "waiting on you" now-state to the review page it should link to, as a
// path relative to generated-docs/ (where dashboard.html is written) — or null
// when the state has no page to reopen. Pure; attachReviewPage() gates the result
// on the file existing so the dashboard never renders a dead link.
//
// Only MANUAL-TEST is linked: it's the one approval with a real phase behind it,
// so the state model can tell "waiting on your review" from "still working". The
// stories approval lives inside PLAN and the epic-plan approval runs on `main`
// before any epic branch exists — neither has a live-state signal to gate on, so
// linking them would resurface a stale page (see .claude/shared/approval-pattern.md).
function reviewPageFor(now) {
  if (now && now.kind === 'manual-test' && now.epicSlug) {
    // Derived from the layout constants (never hardcoded), so this href is the
    // single encoding of the page's location. Both roots come from the same
    // GENERATED_DOCS_REL, so the "epics/" segment stays correct if the layout moves.
    const epicsHref = path.posix.relative(GENERATED_DOCS_REL, EPICS_DIR_REL);
    return path.posix.join(epicsHref, now.epicSlug, MANUAL_TEST_PAGE);
  }
  return null;
}

// Decorate `now` with the review page to link — but only when that page is
// actually on disk, so the dashboard never renders a dead link. The existence
// check resolves the SAME href reviewPageFor produced against the generated-docs
// root, so the link and the file it's gated on cannot point at different paths.
// Extracted from collect() so this guarantee is testable against a real filesystem.
function attachReviewPage(now, root) {
  const reviewPage = reviewPageFor(now);
  if (reviewPage && fs.existsSync(path.join(root, GENERATED_DOCS_REL, reviewPage))) {
    now.reviewPage = reviewPage;
  }
  return now;
}

// Headline counts for the overview card. epicsTotal comes from the plan when one
// exists (it's the full intended set); otherwise from what we can see on disk.
// Story totals sum only epics with readable stories (in-flight + merged) — not-
// yet-started plan epics have no story counts.
function computeOverview({ inFlight = [], merged = [], plan = [], hasPlan = false } = {}) {
  const sum = (list, pick) => list.reduce((n, e) => n + (pick(e) || 0), 0);
  const known = [...inFlight, ...merged];
  // Epics built/merged outside the plan still count toward the total — otherwise a
  // completed off-plan epic makes epicsComplete (all merged) exceed epicsTotal
  // (plan.length only), rendering nonsense like "4/3 epics complete".
  const planSlugs = new Set(plan.map((e) => e.slug));
  const offPlanCount = new Set(known.filter((e) => !planSlugs.has(e.slug)).map((e) => e.slug)).size;
  return {
    epicsComplete: merged.length,
    epicsTotal: hasPlan ? plan.length + offPlanCount : known.length,
    storiesDone: sum(known, (e) => e.stories?.complete),
    storiesTotal: sum(known, (e) => e.stories?.total)
  };
}

function collect(root) {
  // Legacy detection — surface a migration prompt if project.md is gone but legacy state remains.
  const status = projectStatus(root);
  if (status === 'legacy_detected') {
    return {
      status,
      message: 'Legacy workflow state detected. Run /migrate-legacy to convert to the epic-branch workflow.'
    };
  }
  if (status === 'no_project') {
    return {
      status,
      message: 'Setting things up — your project will appear here as the workflow runs. New here? Run /start to begin.'
    };
  }

  const project = readProjectFacts(root);
  const active = currentBranch(root);
  const inFlight = [];
  const merged = [];

  // In-flight epics — one per epic/* branch. resolveStatePath validates the slug
  // (kebab-case) and yields the canonical state.json path for the branch tip.
  for (const branch of listEpicBranches(root)) {
    const resolved = resolveStatePath({ root, branch });
    const slug = resolved.slug ?? branch.slice(EPIC_BRANCH_PREFIX.length);
    const isActive = branch === active;
    if (resolved.status !== 'ok' || resolved.kind !== 'epic') {
      // Branch name isn't a valid epic/<kebab-slug> — surface it, don't drop it.
      inFlight.push({ slug, branch, isActive, status: 'invalid-slug', name: null, phase: null, stories: EMPTY_STORIES, halt: null, dependsOn: [] });
      continue;
    }
    // The checked-out epic is read from the working tree (freshest — the
    // in-progress story lives there uncommitted); every other epic is read from
    // its committed branch tip, since we can't see another branch's working tree.
    const state = isActive
      ? (readStateJsonWorkingTree(root, resolved.path) ?? readStateJsonAtRef(root, branch, resolved.path))
      : readStateJsonAtRef(root, branch, resolved.path);
    if (!state) {
      // Branch exists but state.json missing — surface as a half-initialised epic.
      inFlight.push({ slug, branch, isActive, status: 'missing-state', name: null, phase: null, stories: EMPTY_STORIES, halt: null, dependsOn: [] });
      continue;
    }
    const entry = {
      slug,
      branch,
      isActive,
      status: 'ok',
      name: state.epic?.name ?? null,
      phase: state.phase ?? null,
      stories: summariseStories(state.stories),
      halt: state.halt ?? null,
      dependsOn: state.epic?.dependsOn ?? [],
      lastUpdated: state.lastUpdated ?? null
    };
    // Full per-story detail (with titles) so the table can expand it inline. The
    // active epic reads titles from the working tree (freshest); a non-active epic
    // parked at READY-TO-BUILD reads them from its branch tip so its planned
    // stories still show. Other non-active in-flight epics stay summary-only.
    if (isActive) entry.storyList = buildStoryList(state.stories, readStoryTitles(root, slug));
    else if (entry.phase === 'READY-TO-BUILD') entry.storyList = buildStoryList(state.stories, readStoryTitlesAtRef(root, branch, slug));
    inFlight.push(entry);
  }

  // Directory names under generated-docs/epics on `main` — scanned once, then walked a
  // single time below so each slug's state.json is read (a `git show`) exactly once.
  const mainEpicSlugs = listMainEpicSlugs(root);

  // Classify every epic dir on `main` that isn't already a live branch, reading its
  // state.json once. A slug that also has an epic branch is in `inFlight` already — that
  // live build state supersedes the copy on `main` — so skip it. Of the rest:
  //   • READY-TO-BUILD ⇒ a parked epic (planned ahead by /plan): its whole plan is landed
  //     on `main` with NO epic branch yet — /start cuts the build branch fresh from `main`
  //     at build time, so the plan can't go stale. Surfaced through `inFlight` (branch: null)
  //     so every consumer renders it uniformly (deriveNow's parked check, the plan-status
  //     "ready-to-build" derivation, and both renderers key off phase, not the branch).
  //   • a *terminal* phase ⇒ merged. A state.json only lands on `main` by being merged (an
  //     unstarted epic has just a brief.md, no state.json) or parked (handled above). Count
  //     either finished phase, not only COMPLETE: an epic is already merged at
  //     COMPLETE-ON-BRANCH, and COMPLETE is a separate later commit — requiring it would
  //     show a just-merged epic (and anything waiting on it) as unstarted until that commit,
  //     or forever if it was merged outside the workflow.
  const branchSlugs = new Set(inFlight.map((e) => e.slug));
  for (const slug of mainEpicSlugs) {
    if (branchSlugs.has(slug)) continue;
    const state = readStateJsonAtRef(root, MAIN_BRANCH, `${EPICS_DIR_REL}/${slug}/state.json`);
    if (!state) continue;
    if (state.phase === 'READY-TO-BUILD') {
      inFlight.push({
        slug,
        branch: null,
        isActive: false,
        status: 'ok',
        name: state.epic?.name ?? null,
        phase: 'READY-TO-BUILD',
        stories: summariseStories(state.stories),
        // Planned stories (titles from `main`) so the row can expand to preview them.
        storyList: buildStoryList(state.stories, readStoryTitlesAtRef(root, MAIN_BRANCH, slug)),
        halt: null,
        dependsOn: state.epic?.dependsOn ?? [],
        lastUpdated: state.lastUpdated ?? null
      });
    } else if (isTerminalPhase(state.phase)) {
      merged.push({
        slug,
        name: state.epic?.name ?? null,
        completedAt: state.lastUpdated ?? null,
        stories: summariseStories(state.stories),
        // Completed stories (titles from `main`) so the row can expand to show them.
        storyList: buildStoryList(state.stories, readStoryTitlesAtRef(root, MAIN_BRANCH, slug))
      });
    }
  }

  // inFlightPhase (slug → phase) is built after the pass above so it includes the parked
  // epics just added to `inFlight`; it drives the ready-to-build vs in-flight distinction
  // in the plan derivation below.
  const inFlightPhase = new Map(inFlight.map((e) => [e.slug, e.phase]));

  merged.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));

  // Epic plan + readiness (when generated-docs/epic-plan.md exists). Status is
  // DERIVED here, never stored in the plan: done = merged; in-flight = epic branch
  // exists; otherwise a draft — "ready" when every dependency is done, else
  // "blocked" (waitingOn lists the unfinished deps). Single source of truth for
  // readiness — /start, /plan, /status, and the dashboard all consume it. (inFlightPhase
  // was built above for the merged-epic filter; reuse it.)
  const doneSlugs = new Set(merged.map((e) => e.slug));
  const planEpics = readEpicPlan(root);
  const plan = (planEpics || []).map((e) => {
    let status;
    let waitingOn = [];
    if (doneSlugs.has(e.slug)) status = 'done';
    else if (inFlightPhase.has(e.slug)) {
      // A parked epic (planned via /plan, not yet building) reads as ready-to-build,
      // distinct from one actively in flight. Any other phase ⇒ in-flight.
      status = inFlightPhase.get(e.slug) === 'READY-TO-BUILD' ? 'ready-to-build' : 'in-flight';
    } else {
      waitingOn = (e.dependsOn || []).filter((d) => !doneSlugs.has(d));
      status = waitingOn.length ? 'blocked' : 'ready';
    }
    return { slug: e.slug, name: e.name, goal: e.goal, dependsOn: e.dependsOn || [], status, waitingOn };
  });

  const hasPlan = plan.length > 0;
  // Merged epics the plan doesn't list (a hotfix epic, or one later dropped from the plan).
  // Computed once here so the HTML table, the /status text view, and the overview totals all
  // agree on what "off-plan merged" means instead of each re-deriving the filter.
  const planSlugSet = new Set(plan.map((e) => e.slug));
  const offPlanMerged = merged.filter((e) => !planSlugSet.has(e.slug));

  // Reopen affordance: when an epic is parked in MANUAL-TEST, link its check-off
  // page from the banner so a user who closed the tab can get it back from the
  // dashboard (gated on the file being on disk — see attachReviewPage).
  const now = attachReviewPage(deriveNow({ inFlight, plan, hasPlan }), root);

  return {
    status: 'ok',
    project: project ?? { name: null, slug: null },
    hasPlan,
    plan,
    inFlight,
    merged,
    offPlanMerged,
    overview: computeOverview({ inFlight, merged, plan, hasPlan }),
    now,
    generatedAt: new Date().toISOString()
  };
}

function renderText(data) {
  if (data.status !== 'ok') return `${data.status}: ${data.message}`;
  const lines = [];
  lines.push(`Project: ${data.project.name ?? '(no name)'}`);
  lines.push('');

  // Plan view (when epic-plan.md exists): the whole plan in order, with readiness.
  if (data.hasPlan) {
    // Index once — the loops below look up by slug repeatedly.
    const planBySlug = new Map(data.plan.map((p) => [p.slug, p]));
    const inFlightBySlug = new Map(data.inFlight.map((e) => [e.slug, e]));
    const storiesFor = (slug) => {
      const e = inFlightBySlug.get(slug);
      if (!e) return '';
      return ` · story ${e.stories.complete}/${e.stories.total}${e.halt ? ' · HALTED' : ''}`;
    };
    const labelFor = (slug) => planBySlug.get(slug)?.name || slug;
    lines.push('Epic plan:');
    for (const e of data.plan) {
      const name = e.name || e.slug;
      if (e.status === 'done') lines.push(`  ✓ ${name} — done`);
      else if (e.status === 'in-flight') lines.push(`  ▸ ${name} — in flight${storiesFor(e.slug)}`);
      else if (e.status === 'ready-to-build') lines.push(`  ◆ ${name} — planned · ready to build${storiesFor(e.slug)}`);
      else if (e.status === 'ready') lines.push(`  ● ${name} — ready to start`);
      else lines.push(`  ⊘ ${name} — waiting on ${e.waitingOn.map(labelFor).join(', ')}`);
    }
    // Surface in-flight branches the plan doesn't cover (off-plan epics, or
    // invalid-slug / missing-state branches) so a halted or broken epic can't
    // hide behind the plan view — the HTML dashboard always lists these.
    const offPlan = data.inFlight.filter((e) => !planBySlug.has(e.slug));
    if (offPlan.length) {
      lines.push('');
      lines.push('In flight (not in plan):');
      for (const e of offPlan) {
        const note = e.status !== 'ok' ? ` · ${e.status}` : '';
        lines.push(`  ▸ epic/${e.slug} — ${e.phase ?? 'unknown'}${storiesFor(e.slug)}${note}`);
      }
    }
    // Merged epics the plan doesn't list (off-plan completed — a hotfix epic, or one later
    // dropped from the plan). They're counted in the overview totals, so list them here too
    // rather than letting a completed epic vanish from the plan view. (Selection computed
    // once in the data layer as data.offPlanMerged.)
    const offPlanMerged = data.offPlanMerged || [];
    if (offPlanMerged.length) {
      lines.push('');
      lines.push('Completed (not in plan):');
      for (const e of offPlanMerged) {
        lines.push(`  ✓ ${e.name || e.slug} — done · ${e.stories.total} stories`);
      }
    }
    return lines.join('\n');
  }

  if (data.inFlight.length) {
    lines.push('In flight:');
    for (const e of data.inFlight) {
      const s = e.stories;
      const halted = e.halt ? ' · HALTED' : '';
      lines.push(`  ▸ epic/${e.slug.padEnd(28)} ${(e.phase ?? 'unknown').padEnd(20)} story ${s.complete}/${s.total}${halted}`);
    }
  } else {
    lines.push('In flight: (none)');
  }
  lines.push('');
  if (data.merged.length) {
    lines.push('Merged:');
    for (const e of data.merged.slice(0, 10)) {
      lines.push(`  ✓ ${e.slug.padEnd(28)} ${(e.completedAt ?? '').slice(0, 10)} · ${e.stories.total} stories`);
    }
    if (data.merged.length > 10) lines.push(`  ...and ${data.merged.length - 10} more`);
  } else {
    lines.push('Merged: (none yet)');
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = collect(args.root);
  if (args.format === 'text') {
    process.stdout.write(renderText(data) + '\n');
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  }
}

if (require.main === module) main();

module.exports = {
  collect,
  renderText,
  parseEpicPlan,
  summariseStories,
  parseStoryTitle,
  buildStoryList,
  deriveNow,
  reviewPageFor,
  attachReviewPage,
  computeOverview,
  isTerminalPhase
};
