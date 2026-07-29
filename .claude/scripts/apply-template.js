#!/usr/bin/env node

/**
 * Apply template updates (the /upgrade delivery step)
 *
 * Applies template-owned machinery and guardrails, prunes what the template retired, merges
 * `.gitignore` and reconciles `web/` + the root files additively, and regenerates
 * `web/package-lock.json` when it changed `package.json`. Never touches the project's app
 * (`web/src|e2e|public`), specs or output; the mixed files (`CLAUDE.md`, existing `web/` config,
 * `Dockerfile`) are reported for /upgrade to merge, never overwritten.
 *
 * ONE auto-approved call, because editing `.claude/` prompts for approval per file even in
 * auto-accept mode. Writes only the allowlisted paths below, and fails closed throughout.
 *
 * Retirement runs as three sweeps, each covering what the others can't: the owned-TREE sweep
 * (OWNED_TREES), the base→target diff (retiredSinceBase, the only one reaching the guardrail
 * dirs), and a named backstop (DELETE_BY_NAME_PATHS).
 *
 * `--help` for usage and flags. TEMPLATE_DEVELOPMENT.md § Template update boundary for the update
 * boundary, and CONTRIBUTING.md § How Consumers Upgrade for which list a new path belongs in.
 *
 * Exit codes: 0 = ran (see report); 2 = bad usage / fetch failure.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, execSync } = require('node:child_process');

// A constant so the normal /upgrade flow (which passes only --ref) always fetches the official
// repo; the publish pipeline rewrites this to the release repo for the shipped copy.
const DEFAULT_SOURCE_REPO = 'https://github.com/stadium-software/stadium-8.git';

// Template-owned machinery dirs — applied (copied/overwritten) on every upgrade.
const MACHINERY_DIRS = [
  '.claude/agents',
  '.claude/commands',
  '.claude/policies',
  '.claude/prompts',
  '.claude/shared',
  '.claude/skills',
  '.claude/templates',
  '.claude/scripts',
  '.template-docs/users',
  '.github/scripts',
];

// Template-owned files outside a machinery dir. Applied like the dirs above.
const MACHINERY_LOOSE_FILES = [
  '.claude/README.md',
  '.claude/WORKFLOWS.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/release.yml',
  'CHANGELOG.md',
];

const MACHINERY_PATHS = [...MACHINERY_DIRS, ...MACHINERY_LOOSE_FILES];

// Fully template-owned TREES: a file the PROJECT TRACKS inside one that the target template no
// longer ships is retired. Whole trees, not leaf dirs — a leaf list can't survive a template
// restructure, which strands every file the restructure retired.
const OWNED_TREES = ['.claude', '.template-docs', '.github/scripts'];

// Carved out of the owned-tree sweep: inside these, "not in the template" doesn't mean
// "retired" — a project adds its own files here, or they aren't template content at all. Cost in
// a MARKERLESS project: a retired command or agent lingers, which beats deleting the user's own.
const PRUNE_EXEMPT_DIRS = [
  '.claude/hooks',
  '.claude/commands',
  '.claude/agents',
  '.claude/skills',
  '.claude/output-styles',
  '.claude/plugins',
  '.claude/logs',
];

// The dirs ONLY the base→target diff can prune, so with no readable base a retirement inside one
// is left behind. Named once because the report and `--help` both have to state that cost.
const BASE_DIFF_ONLY_DIRS = [
  '.claude/hooks',
  '.claude/commands',
  '.claude/agents',
  '.claude/skills',
  '.github/workflows',
];

// Template-owned files that EXECUTE or govern permissions. Applied like all machinery, but
// reported under their own heading so /upgrade can name them in the summary the user approves.
// The `Dockerfile` is deliberately not here — see ROOT_ADDITIVE_FILES.
const GUARDRAIL_PATHS = [
  '.claude/settings.json',
  '.claude/hooks',
  '.github/workflows',
  '.dockerignore',
];

// Template-owned ROOT files a project may legitimately have had to customise. Reconciled
// ADDITIVELY like existing `web/` config: overwriting a project's `Dockerfile` silently reverts
// the edits its own build needs (e.g. a build-stage placeholder for a validated secret).
const ROOT_ADDITIVE_FILES = ['Dockerfile'];

// Files the template permanently RETIRED — the backstop for retirements neither sweep reaches:
// root files, and guardrail-dir files in a project too old to have a version marker.
const RETIRED_PATHS = [
  '.github/workflows/sync-template.yml',
  '.templatesyncignore',
  '.github/workflows/pr-checks.yml',
  'scripts/parse-logs.ps1', // retired built-in session logging
];

// Files the template DEV REPO legitimately ships, which must never appear in a user project
// (`.release-ignore` silently switches off the TDD workflow guard; the workflows fail on every
// push). Separate from RETIRED_PATHS because these are also never APPLIED — otherwise a
// dogfooding run with the dev repo as `--template` copies them in and deletes them again.
const DEV_ONLY_PATHS = [
  '.release-ignore',
  '.github/workflows/publish-template.yml',
  '.github/workflows/template-tests.yml',
];

// The named-backstop sweep: deleted if present, tracked or not. Deliberately NOT here:
// `.github/workflows/docker-build.yml` — deleting by exact name with no tracked check makes a
// filename a containerising user would plausibly author too risky to take.
const DELETE_BY_NAME_PATHS = [...RETIRED_PATHS, ...DEV_ONLY_PATHS];

// Where the base→target diff may delete. Machinery prefixes only: never `web/`,
// `documentation/` or `generated-docs/`, and no root files (RETIRED_PATHS names those).
const BASE_DIFF_PREFIXES = ['.claude/', '.github/', '.template-docs/'];

// web/ entries the reconciler never walks: the app, build output, and the specially-handled pair.
const WEB_SKIP_TOP = new Set([
  'src', 'e2e', 'public', 'node_modules', '.next', '.turbo', 'coverage', '.vercel',
  'package.json', 'package-lock.json',
]);

// Never copy env files except committed `*.example` templates — everything else starting with
// `.env` is treated as a secret and skipped, even from a working-tree source.
function isEnvSecret(rel) {
  const base = path.basename(rel);
  return base.startsWith('.env') && !base.endsWith('.example');
}

const PKG_SECTIONS = ['dependencies', 'devDependencies', 'scripts'];

// Never applied/pruned even inside an allowlisted dir: dev-only test files/fixtures.
const EXCLUDE = [/\.tests?\.js$/, /(^|[\\/])__fixtures__([\\/]|$)/, /(^|[\\/])__tests__([\\/]|$)/];

function isExcluded(rel) {
  return EXCLUDE.some((re) => re.test(rel));
}

// List files under `root/rel` recursively, as `/`-joined paths relative to `root`, so tracked-set
// membership and the report read identically on Windows.
//
// `filtered` (the default) drops dev-only test files/fixtures and env secrets; every copy path
// uses it. The prune sweep passes `filtered: false` and must — filtering both sides makes a stale
// `*.tests.js` in a user project invisible, so it could never be removed.
function listFiles(root, rel, filtered = true) {
  const out = [];
  listInto(root, rel, filtered, out);
  return out;
}

// Threads ONE accumulator rather than returning an array per level: the obvious
// `out.push(...listFiles(...))` spreads as ARGUMENTS and throws RangeError once a single level
// yields ~130k entries — reachable, since the sweeps walk whole trees including gitignored ones.
function listInto(root, rel, filtered, out) {
  const abs = path.join(root, rel);
  // ONE stat, not existsSync + statSync — this runs for every entry in a whole-tree walk.
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return;
  }
  if (stat.isFile()) {
    const skip = filtered && (isExcluded(rel) || isEnvSecret(rel));
    if (!skip) out.push(rel);
    return;
  }
  for (const entry of fs.readdirSync(abs)) listInto(root, `${rel}/${entry}`, filtered, out);
}

// Delete one retired file, tolerating "already gone". Never a directory: `rmSync` without
// `recursive` throws EISDIR mid-apply, and `recursive: true` would take the user's own untracked
// files inside it. A path that is now a directory isn't the retired file any more.
function removeFile(abs) {
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return false; // Not there — nothing to retire.
  }
  if (!stat.isFile()) return false;
  fs.rmSync(abs, { force: true });
  return true;
}

function sameContent(a, b) {
  if (!fs.existsSync(a) || !fs.existsSync(b)) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

function copyInto(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// Tolerates a leading UTF-8 BOM: Windows editors and PowerShell `Out-File` write one, and
// JSON.parse would throw on an otherwise-valid package.json.
function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

// Read repo-relative paths out of git. -z + core.quotePath=false so paths with spaces or
// non-ASCII bytes match listFiles' real names, not git's octal-escaped form — a mismatch makes
// the prune sweep delete a still-current file. Returns null on any failure, so callers fail closed.
function gitPathSet(root, args) {
  try {
    const out = execFileSync('git', ['-c', 'core.quotePath=false', '-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set(out.split('\0').filter(Boolean));
  } catch {
    return null;
  }
}

// The files git tracks — so a `--template <working-dir>` source behaves like a fetched clone
// (tracked files only). Also used on the PROJECT side, to tell template content from local state.
function gitTracked(root) {
  return gitPathSet(root, ['ls-files', '-z']);
}

// List template files under `rel`, restricted to tracked files when we have that set.
function templateFiles(templateRoot, rel, tracked, filtered = true) {
  const files = listFiles(templateRoot, rel, filtered);
  return tracked ? files.filter((f) => tracked.has(f)) : files;
}

// The files a given ref ships — read from git, so the base→target diff can ask about a ref that
// isn't checked out, without a second clone.
function gitFilesAtRef(repoRoot, ref) {
  return gitPathSet(repoRoot, ['ls-tree', '-r', '--name-only', '-z', ref]);
}

// Fetch one tag into an existing shallow clone — a single commit, no checkout. Throws if the ref
// can't be fetched (deleted tag, offline, a branch); callers treat that as "no base available".
function fetchRef(repoRoot, ref) {
  execFileSync(
    'git',
    ['-C', repoRoot, 'fetch', '--depth', '1', '--quiet', 'origin', `refs/tags/${ref}:refs/tags/${ref}`],
    { stdio: 'pipe' },
  );
}

// Copy template files under the given paths into the project (add or overwrite).
// DEV_ONLY_PATHS wins over the apply lists — see that list.
function applyPaths(templateRoot, projectRoot, paths, tracked) {
  const added = [];
  const updated = [];
  for (const rel of paths) {
    for (const file of templateFiles(templateRoot, rel, tracked)) {
      if (DEV_ONLY_PATHS.includes(file)) continue;
      const src = path.join(templateRoot, file);
      const dest = path.join(projectRoot, file);
      const exists = fs.existsSync(dest);
      if (exists && sameContent(src, dest)) continue;
      copyInto(src, dest);
      (exists ? updated : added).push(file);
    }
  }
  return { added: added.sort(), updated: updated.sort() };
}

// Pointing the applier at the template dev repo is uniquely destructive: DEV_ONLY_PATHS deletes
// files the dev repo legitimately OWNS, and applyPaths refuses to put them back.
//
// BOTH files are required, not belt-and-braces: a legacy user project can carry `.release-ignore`
// alone (which is why it's in DEV_ONLY_PATHS), and those most need the clean-up. `CLAUDE.user.md`
// beside it is what makes the pair unambiguous — no user project has that one.
function isTemplateDevRepo(root) {
  return (
    fs.existsSync(path.join(root, '.release-ignore')) && fs.existsSync(path.join(root, 'CLAUDE.user.md'))
  );
}

// Is `rel` one of `roots`, or inside one? Shared, so the exempt and guardrail lists can't drift
// into different semantics. (BASE_DIFF_PREFIXES is not one of these — it's a prefix list.)
function isUnder(rel, roots) {
  return roots.some((root) => rel === root || rel.startsWith(`${root}/`));
}

function isPruneExempt(rel) {
  return isUnder(rel, PRUNE_EXEMPT_DIRS);
}

// "Does the template ship this path?" — the shared test both retirement sweeps need, and the one
// thing standing between a template rename and deleting a user's file.
//
// Case-INSENSITIVE as well as exact: on Windows/macOS a case-only rename in the template
// (`Dev.md` → `dev.md`) doesn't rename the project's file, which then reads back with its old
// casing, isn't in the shipped set, and gets deleted. Being wrong the other way is stale clutter.
function shipsPath(files) {
  const folded = new Set([...files].map((f) => f.toLowerCase()));
  return (rel) => files.has(rel) || folded.has(rel.toLowerCase());
}

// Prune retired template files: anything inside a template-owned tree the target no longer ships.
// Two filters keep it safe — PROJECT-TRACKED ONLY (gitignored local state inside an owned tree
// must survive, so a null set deletes nothing rather than guess) and PRUNE_EXEMPT_DIRS. Both sides
// are listed unfiltered; see listFiles for why that's required.
function mirrorDeleteRetired(templateRoot, projectRoot, trees, tracked, projectTracked) {
  if (!projectTracked) return [];
  const removed = [];
  for (const rel of trees) {
    // Fail closed PER TREE: a template missing a whole owned tree is far likelier truncated
    // (partial clone, mis-pointed --template) than to have retired every file in it. A genuine
    // whole-tree retirement still lands via the base→target diff or a RETIRED_PATHS entry.
    if (!fs.existsSync(path.join(templateRoot, rel))) continue;
    const ships = shipsPath(new Set(templateFiles(templateRoot, rel, tracked, false)));
    // A DISK walk, not the git index, on both sides: the index names paths that may no longer be
    // on disk, and `templateFiles` is shared with the copy paths, where that means a
    // `copyFileSync` throwing ENOENT mid-apply with machinery already on the branch.
    for (const file of listFiles(projectRoot, rel, false)) {
      if (ships(file) || isPruneExempt(file)) continue;
      if (!projectTracked.has(file)) continue;
      if (removeFile(path.join(projectRoot, file))) removed.push(file);
    }
  }
  return removed.sort();
}

// Prune what the template retired between the project's base version and the target. The only
// sweep that reaches a guardrail dir: those are exempt from the owned-tree sweep because a project
// may add its own files there, but "the base shipped this exact path and the target doesn't" is
// unambiguous provenance where LOCATION isn't — which makes retirements there self-cleaning.
//
// Any of the three arguments being null makes this a no-op rather than a guess.
function retiredSinceBase(baseFiles, targetFiles, projectRoot, projectTracked) {
  if (!baseFiles || !targetFiles || !projectTracked) return [];
  const ships = shipsPath(targetFiles);
  const removed = [];
  for (const file of baseFiles) {
    // Scope first: the prefix test rejects outright, and is cheaper than the folded lookup.
    if (!BASE_DIFF_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
    if (ships(file) || !projectTracked.has(file)) continue;
    if (removeFile(path.join(projectRoot, file))) removed.push(file);
  }
  return removed.sort();
}

// Remove directories the prune emptied — git doesn't track dirs, so it never reports these, but
// the user still sees the empty folders. Only ever removes a genuinely empty dir (rmdirSync
// refuses otherwise) and never the project root. Deepest-first, so a subtree collapses all the way
// up. `removedFiles` are always `/`-joined, so posix path maths is right on every platform.
function pruneEmptyDirs(projectRoot, removedFiles) {
  const candidates = new Set();
  for (const rel of removedFiles) {
    for (let dir = path.posix.dirname(rel); dir && dir !== '.'; dir = path.posix.dirname(dir)) {
      candidates.add(dir);
    }
  }
  const removed = [];
  for (const dir of [...candidates].sort((a, b) => b.split('/').length - a.split('/').length)) {
    try {
      fs.rmdirSync(path.join(projectRoot, dir));
      removed.push(dir);
    } catch {
      // Not empty (or already gone) — leave it. Both are the correct outcome.
    }
  }
  return removed.sort();
}

// The cross-cutting cleanup mirrorDeleteRetired can't do (guardrail dirs, root files).
function removeRetiredPaths(projectRoot, paths) {
  const removed = [];
  for (const rel of paths) {
    if (removeFile(path.join(projectRoot, rel))) removed.push(rel);
  }
  return removed.sort();
}

// Additive: add missing deps/scripts/overrides/engines, never change a value the project already
// has. Writes only if something was added.
function mergePackageAdditions(templatePkgPath, targetPkgPath) {
  const added = { dependencies: [], devDependencies: [], scripts: [], overrides: [], fields: [] };
  if (!fs.existsSync(templatePkgPath) || !fs.existsSync(targetPkgPath)) {
    return { changed: false, added };
  }
  const tmpl = readJson(templatePkgPath);
  const target = readJson(targetPkgPath);
  for (const section of PKG_SECTIONS) {
    const from = tmpl[section];
    if (!from || typeof from !== 'object') continue;
    if (!target[section] || typeof target[section] !== 'object') target[section] = {};
    for (const key of Object.keys(from)) {
      if (!(key in target[section])) {
        target[section][key] = from[key];
        added[section].push(section === 'scripts' ? key : `${key}@${from[key]}`);
      }
    }
  }
  // Overrides carry the template's npm-audit security fixes. Not in PKG_SECTIONS because a value
  // can be a nested object rather than a version string, so the rendering above wouldn't apply.
  if (tmpl.overrides && typeof tmpl.overrides === 'object') {
    if (!target.overrides || typeof target.overrides !== 'object') target.overrides = {};
    for (const key of Object.keys(tmpl.overrides)) {
      if (!(key in target.overrides)) {
        const val = tmpl.overrides[key];
        target.overrides[key] = val;
        added.overrides.push(typeof val === 'string' ? `${key}@${val}` : key);
      }
    }
  }
  if (tmpl.engines && !target.engines) {
    target.engines = tmpl.engines;
    added.fields.push('engines');
  }
  const changed = Object.values(added).some((list) => list.length > 0);
  if (changed) fs.writeFileSync(targetPkgPath, `${JSON.stringify(target, null, 2)}\n`);
  return { changed, added };
}

// Bring package-lock.json back in sync after mergePackageAdditions changed package.json: every CI
// gate starts with `npm ci`, which fails hard on a mismatched pair, and a printed reminder gets
// skipped. --package-lock-only rewrites the lock without building node_modules; --ignore-scripts
// skips the project's own install hooks. `exec` is injectable so tests never invoke npm. A no-op
// when there's no lock to keep in sync.
function defaultNpmLockRefresh(webDir) {
  // Via the shell, so `npm` resolves to npm.cmd on Windows. Fixed constant — no interpolation.
  execSync('npm install --package-lock-only --ignore-scripts --no-audit --no-fund', {
    cwd: webDir,
    stdio: 'pipe',
  });
}

function refreshLockfile(projectRoot, exec = defaultNpmLockRefresh) {
  const webDir = path.join(projectRoot, 'web');
  const pkgPath = path.join(webDir, 'package.json');
  const lockPath = path.join(webDir, 'package-lock.json');
  if (!fs.existsSync(pkgPath) || !fs.existsSync(lockPath)) {
    return { ran: false, ok: true, reason: 'no web/package-lock.json to refresh' };
  }
  try {
    exec(webDir);
    return { ran: true, ok: true };
  } catch (err) {
    return { ran: true, ok: false, error: err.message };
  }
}

// Template web/ config/tooling files, for add-if-missing.
function listWebConfig(root, tracked) {
  const webAbs = path.join(root, 'web');
  if (!fs.existsSync(webAbs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(webAbs)) {
    if (WEB_SKIP_TOP.has(entry)) continue;
    // One at a time, not spread — same argument-count ceiling listInto exists to avoid.
    for (const file of templateFiles(root, `web/${entry}`, tracked)) out.push(file);
  }
  return out;
}

// Add-if-missing / report-if-changed — never overwrites; a file that changed upstream goes to
// `review` for /upgrade to merge.
function addOrReview(templateRoot, projectRoot, files) {
  const added = [];
  const review = [];
  for (const file of files) {
    const src = path.join(templateRoot, file);
    const dest = path.join(projectRoot, file);
    if (!fs.existsSync(dest)) {
      copyInto(src, dest);
      added.push(file);
    } else if (!sameContent(src, dest)) {
      review.push(file);
    }
  }
  return { added, review };
}

// The additive half of an upgrade: web/ config, ROOT_ADDITIVE_FILES, and package.json additions.
function reconcileWeb(templateRoot, projectRoot, tracked) {
  const rootFiles = ROOT_ADDITIVE_FILES.flatMap((rel) => templateFiles(templateRoot, rel, tracked));
  const { added, review } = addOrReview(templateRoot, projectRoot, [
    ...listWebConfig(templateRoot, tracked),
    ...rootFiles,
  ]);
  const pkg = mergePackageAdditions(path.join(templateRoot, 'web/package.json'), path.join(projectRoot, 'web/package.json'));
  return { added: added.sort(), review: review.sort(), pkg };
}

// Pure reconcile step — no network, so tests exercise it offline; the network steps live in main().
// `opts.baseFiles` is the file set the project's BASE version shipped, for the retirement diff.
// The returned `baseDiffRan` says whether that diff actually happened — supplying baseFiles isn't
// enough, it also needs a git template source and a git project.
function applyTemplate(templateRoot, projectRoot, opts = {}) {
  // Before any write, so a mis-pointed --project can't strip the repo's release infrastructure.
  if (isTemplateDevRepo(projectRoot)) {
    throw new Error(
      `${projectRoot} is the template dev repo, not a project to upgrade — refusing to reconcile ` +
        '(this would delete .release-ignore and the dev-only workflows, and they would not be restored).',
    );
  }
  // Fail closed the other way: a mis-pointed `--template` yields an empty template file set, and
  // mirrorDeleteRetired would then delete ALL the project's machinery. Content, not existence — an
  // empty `.claude/` dir is exactly the aborted-fetch shape this catches.
  if (listFiles(templateRoot, '.claude', false).length === 0) {
    throw new Error(
      `not a template: ${templateRoot} has no .claude/ content — refusing to reconcile (this would delete your machinery).`,
    );
  }
  const tracked = gitTracked(templateRoot);
  const machinery = applyPaths(templateRoot, projectRoot, MACHINERY_PATHS, tracked);
  const guardrails = applyPaths(templateRoot, projectRoot, GUARDRAIL_PATHS, tracked);
  // A new ignore rule can't untrack what git already tracks, so this protects the NEXT upgrade —
  // and stops /upgrade's `git add -A` committing state the template has since started ignoring.
  const gitignore = mergeGitignoreAdditions(templateRoot, projectRoot);

  // Both tracked-filtered sweeps fail closed on a null set themselves. `pruneRan` reports it, so a
  // short "retired" list doesn't read as "nothing to remove". DELETE_BY_NAME_PATHS still runs — it
  // names exact paths a project never owns, so it needs no tracked set to be safe.
  const projectTracked = gitTracked(projectRoot);
  const pruneRan = Boolean(projectTracked);
  // Reported so buildReport can't claim a diff that never happened.
  const baseDiffRan = Boolean(opts.baseFiles && opts.baseFiles.size && tracked && projectTracked);
  // Dedupe: the sweeps overlap by design, so the same file can be reported twice.
  const retired = [
    ...new Set([
      ...mirrorDeleteRetired(templateRoot, projectRoot, OWNED_TREES, tracked, projectTracked),
      ...retiredSinceBase(opts.baseFiles, tracked, projectRoot, projectTracked),
      ...removeRetiredPaths(projectRoot, DELETE_BY_NAME_PATHS),
    ]),
  ].sort();
  const web = reconcileWeb(templateRoot, projectRoot, tracked);
  pruneEmptyDirs(projectRoot, retired);
  return { machinery, guardrails, gitignore, retired, web, pruneRan, baseDiffRan };
}

// Bring `.gitignore` up to date ADDITIVELY — a mixed file, like web/package.json. More than a
// tidy-up: the retirement sweeps spare local state by asking what git TRACKS, so a `.gitignore`
// predating a rule is what turns `.claude/settings.local.json` into a tracked file the NEXT
// upgrade is entitled to delete. Appended at the end, which is order-sensitive and so makes the
// template's rule win.
function mergeGitignoreAdditions(templateRoot, projectRoot) {
  const src = path.join(templateRoot, '.gitignore');
  const dest = path.join(projectRoot, '.gitignore');
  if (!fs.existsSync(src)) return { changed: false, added: [] };

  // Bare patterns only: blanks and comments carry no rule, and the project may use its own headings.
  const patterns = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const existing = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
  const have = new Set(patterns(existing));
  const added = [];
  for (const pattern of patterns(fs.readFileSync(src, 'utf8'))) {
    if (have.has(pattern)) continue;
    have.add(pattern); // The template may list the same pattern under two headings.
    added.push(pattern);
  }
  if (!added.length) return { changed: false, added: [] };

  const body = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
  fs.writeFileSync(dest, `${body}\n# Added by the template update\n${added.join('\n')}\n`);
  return { changed: true, added };
}

// The marker lives at the PROJECT ROOT, not generated-docs/, so it survives a fresh clone and a
// hand-done file-copy upgrade — not only a scripted /upgrade.
function writeVersionStamp(projectRoot, ref, isoTime) {
  const stamp = { templateRef: ref, appliedAt: isoTime, source: 'apply-template.js' };
  fs.writeFileSync(path.join(projectRoot, 'template-version.json'), `${JSON.stringify(stamp, null, 2)}\n`);
}

// The base version the project is on. main() defaults --base to this, so the only sweep that
// reaches `.claude/hooks/` and `.github/workflows/` can't be lost to a forgotten flag — a silent
// failure, since the run still succeeds. Null for "no base"; never throws, so a corrupt marker
// degrades the sweep instead of aborting the upgrade.
function readVersionStamp(projectRoot) {
  try {
    const { templateRef } = readJson(path.join(projectRoot, 'template-version.json'));
    return typeof templateRef === 'string' && templateRef ? templateRef : null;
  } catch {
    return null;
  }
}

// Resolve the file set the BASE version shipped. Tries the ref as it stands, fetches it otherwise;
// null when it can't be resolved. `mayFetch` is true only for a clone THIS script created — a
// `git fetch` into a caller's `--template <dir>` writes a tag into their repo and marks a full
// clone shallow, which a read-only reconcile has no business doing.
function resolveBaseFiles(templateRoot, baseRef, mayFetch) {
  // `.size`, not truthiness: an empty Set is truthy, and `ls-tree` exits 0 with no output for a
  // ref it can't really read — which would claim a base→target diff that examined nothing.
  const direct = gitFilesAtRef(templateRoot, baseRef);
  if (direct && direct.size) return direct;
  if (!mayFetch) return null;
  try {
    fetchRef(templateRoot, baseRef);
  } catch {
    return null;
  }
  return gitFilesAtRef(templateRoot, baseRef);
}

// Set on the child when a run is handed to the freshly fetched applier: stops it re-execing again
// (it would loop), and tells it the clone it was handed is one WE fetched, so it may fetch into it.
const REEXEC_ENV = 'STADIUM_APPLIER_REEXEC';

// Hand this run over to the applier from the version being installed. /upgrade Step 3 runs the
// PROJECT's copy — the OLD version — so without this every fix to the applier itself arrives one
// release late. Only against a clone THIS script fetched, and only when the two files differ.
//
// The clone's lifecycle stays with the PARENT (the child gets `--template`, so it neither prints
// `TEMPLATE_DIR=` nor removes the temp dir). This makes the CLI a compatibility surface: the new
// applier runs with the OLD one's arguments, so flags may be added but not removed or renamed.
function reexecFetchedApplier(cloneRoot, argv) {
  if (process.env[REEXEC_ENV]) return null;
  const fetched = path.join(cloneRoot, '.claude', 'scripts', 'apply-template.js');
  if (!fs.existsSync(fetched) || sameContent(fetched, __filename)) return null;
  try {
    execFileSync(process.execPath, [fetched, ...argv, '--template', cloneRoot], {
      stdio: 'inherit',
      env: { ...process.env, [REEXEC_ENV]: '1' },
    });
    return 0;
  } catch (err) {
    // The child already printed its diagnosis. A signal (no numeric status) is still a failure.
    return typeof err.status === 'number' ? err.status : 2;
  }
}

function fetchTemplate(repo, ref) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stadium8-template-'));
  try {
    execFileSync('git', ['clone', '--depth', '1', '--branch', ref, repo, tmp], { stdio: 'pipe' });
  } catch (err) {
    // Don't leak the empty/partial temp dir when the clone fails (bad ref, offline).
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  return tmp;
}

function bullets(items) {
  return items.length ? items.map((i) => `- \`${i}\``).join('\n') : '_(none)_';
}

function buildReport({
  machinery,
  guardrails,
  retired,
  web,
  ref,
  lockfile,
  gitignore = { changed: false, added: [] },
  base = null,
  pruneRan = true,
}) {
  const changed = (r) => [...r.added, ...r.updated];
  const section = (label, items) => [`**${label} (${items.length}):**`, bullets(items), ''];
  const L = ['# Template update applied', ''];
  L.push(
    `Brought template machinery up to date with \`${ref}\`. Only template-owned files were`,
    'touched — your app code (`web/src`, `web/e2e`, `web/public`), specs, and output were not.',
    '',
    `## Machinery (${changed(machinery).length} applied, ${retired.length} retired)`,
    '',
    ...section('Added', machinery.added),
    ...section('Updated', machinery.updated),
    ...section('Removed / retired', retired),
  );
  // Say which sweeps ran, so a short "retired" list reads as "nothing to remove" rather than "the
  // sweep didn't happen". A missing base and an unreadable one leave the same gap, so one sentence
  // covers both; the dirs are read off the constant so exempting another can't overclaim coverage.
  if (!pruneRan) {
    L.push(
      '> ⚠️ Retired-file sweep skipped: the project is not a git repo, so only the explicitly',
      '> named retired files were removed.',
      '',
    );
  } else if (base && base.available) {
    L.push(`_Retired files pruned, including anything the template dropped between \`${base.ref}\` and \`${ref}\`._`, '');
  } else {
    const why = base
      ? `The base version (\`${base.ref}\`) couldn't be read`
      : 'This project has no version marker to compare against';
    L.push(
      `_Retired files were pruned from the template-owned trees. ${why}, so retirements inside`,
      `${BASE_DIFF_ONLY_DIRS.map((d) => `\`${d}/\``).join(', ')} were not diffed — only known ones removed._`,
      '',
    );
  }
  if (gitignore.changed) {
    L.push(
      ...section('`.gitignore` entries added', gitignore.added),
      '_Added at the end; nothing already there was changed or reordered._',
      '',
    );
  }
  L.push(
    '## web/ and root config',
    '',
    ...section('Config/tooling added', web.added),
  );
  if (web.pkg.changed) {
    const a = web.pkg.added;
    L.push('**package.json additions:**');
    // Off PKG_SECTIONS plus the two handled specially, so a new section can't go unreported.
    for (const s of [...PKG_SECTIONS, 'overrides', 'fields']) {
      if (a[s] && a[s].length) L.push(`- ${s}: ${a[s].map((d) => `\`${d}\``).join(', ')}`);
    }
    L.push('');
    // Report which happened, so /upgrade knows whether the lock is in the branch already.
    if (lockfile && lockfile.ran && lockfile.ok) {
      L.push('_`web/package-lock.json` was refreshed to match — both files are in this branch to review._', '');
    } else if (lockfile && lockfile.ran && !lockfile.ok) {
      L.push(
        '> ⚠️ **The lockfile could NOT be refreshed automatically** — `web/package.json` changed but',
        "> `web/package-lock.json` did not, so CI's `npm ci` will fail until they match. While online,",
        '> run `(cd web && npm install)`, then commit the updated `web/package-lock.json`.',
        '',
      );
    } else {
      // Not attempted (an older caller, or --skip-lockfile): the manual pass is REQUIRED.
      L.push(
        '_Required: run `(cd web && npm install)` and commit `web/package-lock.json` — otherwise CI `npm ci` fails._',
        '',
      );
    }
  } else {
    L.push('_No package.json additions._', '');
  }
  L.push(
    ...section('Changed upstream but left untouched — /upgrade should merge if you customised them', web.review),
    '## Guardrail files — name these in the upgrade summary',
    '',
  );
  // A DELETED hook or workflow governs permissions as much as a changed one, and the base→target
  // diff is the first sweep that can delete them — so they belong here, not only under machinery.
  const retiredGuardrails = retired.filter((rel) => isUnder(rel, GUARDRAIL_PATHS));
  const guardrailBlocks = [];
  if (changed(guardrails).length) {
    guardrailBlocks.push(
      'Applied like all machinery. They execute or govern permissions, so say so in the summary:\n\n' +
        bullets(changed(guardrails)),
    );
  }
  if (retiredGuardrails.length) {
    guardrailBlocks.push(
      'REMOVED as retired — name these deletions in the summary too:\n\n' +
        bullets(retiredGuardrails),
    );
  }
  L.push(guardrailBlocks.length ? guardrailBlocks.join('\n\n') : '_No guardrail changes._', '');
  return `${L.join('\n')}\n`;
}

function parseArgs(argv) {
  const args = { ref: null, base: null, repo: DEFAULT_SOURCE_REPO, report: null, template: null, project: '.', keepClone: false, skipLockfile: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--ref') args.ref = argv[++i];
    else if (a === '--base') args.base = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--report') args.report = argv[++i];
    else if (a === '--template') args.template = argv[++i];
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--keep-clone') args.keepClone = true;
    else if (a === '--skip-lockfile') args.skipLockfile = true;
  }
  return args;
}

function showHelp() {
  process.stdout.write(
    [
      'Apply template updates (the /upgrade delivery step)',
      '',
      'Usage:',
      '  node apply-template.js --ref <tag-or-branch> [--base <tag>] [--report <file>] [--skip-lockfile]',
      '  node apply-template.js --template <dir> --project <dir> [--base <tag>] [--report <file>] [--skip-lockfile]',
      '',
      'Applies machinery + guardrails, prunes retired machinery, and reconciles web/',
      'additively. Never touches your app (web/src|e2e|public), specs, or the mixed files',
      '(CLAUDE.md / existing web/ config / the root Dockerfile), which /upgrade merges. When it',
      'changes package.json it regenerates web/package-lock.json to match (npm install',
      '--package-lock-only); --skip-lockfile opts out for offline runs.',
      '',
      "--base is the version the project currently has. It defaults to the project's own",
      'template-version.json templateRef, so you rarely need to pass it. It lets the update also',
      'remove files the template retired inside the dirs that are otherwise never pruned because a',
      'project may add its own files there:',
      ...BASE_DIFF_ONLY_DIRS.map((d) => `  ${d}/`),
      'Without a base (an unstamped project, a deleted tag, offline) those retirements are left alone.',
      '',
    ].join('\n'),
  );
}

function main(argv, nowIso) {
  const args = parseArgs(argv);
  if (args.help) {
    showHelp();
    return 0;
  }
  let templateRoot = args.template;
  let cleanup = null;
  let keptForReuse = false;
  const ref = args.ref || 'local';
  if (!templateRoot) {
    if (!args.ref) {
      process.stderr.write('Error: pass --ref <tag> (to fetch) or --template <dir> (pre-fetched).\n');
      return 2;
    }
    try {
      templateRoot = fetchTemplate(args.repo, args.ref);
      cleanup = templateRoot;
    } catch (err) {
      process.stderr.write(
        `Error: could not fetch the template (${args.repo} @ ${args.ref}).\n` +
          'Check your network and that the ref exists, then retry.\n' +
          `Details: ${err.message}\n`,
      );
      return 2;
    }
  }
  try {
    if (!fs.existsSync(templateRoot) || !fs.existsSync(args.project)) {
      process.stderr.write(`Error: template (${templateRoot}) or project (${args.project}) not found.\n`);
      return 2;
    }
    // The `TEMPLATE_DIR=` line on stderr is the contract /upgrade Step 3 parses, so it has one author.
    const keepCloneForUpgrade = () => {
      process.stderr.write(`TEMPLATE_DIR=${templateRoot}\n`);
      keptForReuse = true;
    };
    // Only on the clone path — never re-exec a caller's --template dir.
    if (cleanup) {
      const handedOver = reexecFetchedApplier(templateRoot, argv);
      if (handedOver !== null) {
        if (handedOver === 0 && args.keepClone) keepCloneForUpgrade();
        return handedOver;
      }
    }
    // Before reconciling, so the retirement diff runs in the same pass; a base that can't be read
    // costs only the guardrail-dir retirements, and the report says so. After a hand-over the child
    // has no `cleanup` of its own, but its clone IS one we fetched — REEXEC_ENV is how it knows.
    const ownsClone = Boolean(cleanup) || Boolean(process.env[REEXEC_ENV]);
    // --base wins; otherwise read it off the project's own marker (see readVersionStamp).
    const baseRef = args.base || readVersionStamp(args.project);
    const baseFiles = baseRef ? resolveBaseFiles(templateRoot, baseRef, ownsClone) : null;
    const result = applyTemplate(templateRoot, args.project, { baseFiles });
    // "available" means the diff actually RAN, not just that the base resolved.
    const base = baseRef ? { ref: baseRef, available: result.baseDiffRan } : null;
    if (args.ref) writeVersionStamp(args.project, ref, nowIso);
    // --skip-lockfile opts out for offline runs that can't reach the registry; the report then
    // flags the manual pass as required.
    let lockfile;
    if (result.web.pkg.changed && !args.skipLockfile) {
      lockfile = refreshLockfile(args.project);
    }
    const report = buildReport({ ...result, ref, lockfile, base });
    if (args.report) {
      fs.mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true });
      fs.writeFileSync(args.report, report);
      process.stdout.write(`Report written to ${args.report}\n`);
    } else {
      process.stdout.write(report);
    }
    // Exit non-zero so /upgrade halts instead of merging a branch whose `npm ci` must fail.
    if (lockfile && lockfile.ran && !lockfile.ok) {
      process.stderr.write(
        'Error: web/package.json changed but the lockfile could not be refreshed ' +
          `(${lockfile.error}).\n` +
          "CI's `npm ci` will fail until they match. While online, run `(cd web && npm install)`,\n" +
          'commit web/package-lock.json, then re-run the upgrade.\n',
      );
      return 2;
    }
    if (cleanup && args.keepClone) keepCloneForUpgrade();
    return 0;
  } catch (err) {
    // Fail closed: report the cause rather than a raw stack trace. Some files may already be
    // applied — /upgrade runs on a throwaway branch, so a half-applied tree never reaches `main`.
    process.stderr.write(
      `Error: the update did not complete (${err.message}).\n` +
        'Some files may have been partially applied — review the branch diff and discard\n' +
        'it if needed, then fix the cause and re-run.\n',
    );
    return 2;
  } finally {
    // Unless we handed the path to /upgrade, so a --keep-clone failure doesn't orphan the temp dir.
    if (cleanup && !keptForReuse) fs.rmSync(cleanup, { recursive: true, force: true });
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2), new Date().toISOString()));
}

module.exports = {
  MACHINERY_PATHS,
  OWNED_TREES,
  PRUNE_EXEMPT_DIRS,
  BASE_DIFF_ONLY_DIRS,
  BASE_DIFF_PREFIXES,
  GUARDRAIL_PATHS,
  ROOT_ADDITIVE_FILES,
  RETIRED_PATHS,
  DEV_ONLY_PATHS,
  DELETE_BY_NAME_PATHS,
  WEB_SKIP_TOP,
  EXCLUDE,
  isExcluded,
  isEnvSecret,
  isUnder,
  isPruneExempt,
  isTemplateDevRepo,
  listFiles,
  gitTracked,
  applyPaths,
  mirrorDeleteRetired,
  retiredSinceBase,
  removeRetiredPaths,
  pruneEmptyDirs,
  mergePackageAdditions,
  mergeGitignoreAdditions,
  refreshLockfile,
  reconcileWeb,
  applyTemplate,
  writeVersionStamp,
  readVersionStamp,
  buildReport,
  parseArgs,
  reexecFetchedApplier,
  REEXEC_ENV,
};
