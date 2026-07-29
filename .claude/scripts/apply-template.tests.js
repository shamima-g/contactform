#!/usr/bin/env node
/**
 * Tests for apply-template.js
 *
 * Pins the safety contract of the /upgrade delivery step:
 *   - machinery AND guardrails are applied (guardrails reported separately);
 *   - retired machinery is PRUNED — including across a template restructure, and including
 *     stale dev-only test files — while a project's own files and gitignored local state
 *     survive;
 *   - web/ is reconciled ADDITIVELY (add-missing + additive package.json), never
 *     overwriting an existing web/ file and never touching web/src|e2e|public;
 *   - the mixed files (CLAUDE.md) and off-allowlist paths are never touched;
 *   - dev-only test files/fixtures are never copied INTO a project.
 *
 * No test framework — Node's built-in runner:
 *   node --test .claude/scripts/apply-template.tests.js
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { execFileSync } = require('node:child_process');
const {
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
  gitTracked,
  isExcluded,
  isEnvSecret,
  isUnder,
  isPruneExempt,
  isTemplateDevRepo,
  buildReport,
  parseArgs,
  writeVersionStamp,
  readVersionStamp,
  reexecFetchedApplier,
  REEXEC_ENV,
} = require('./apply-template.js');

const REPO_ROOT = path.resolve(__dirname, '../..');

const createdTmpDirs = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-tmpl-test-'));
  createdTmpDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of createdTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});
function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'ignore' });

// A real repo tracking everything passed in — the faithful setup, since /upgrade always runs
// inside one and the prune sweeps only delete files the project TRACKS.
//
// `init` + `add` and no commit, deliberately. Everything here reads trackedness through
// `gitTracked` -> `git ls-files`, which reports the INDEX, and `git add` is what fills the
// index — a commit would add nothing to observe. (Nothing in this suite reads a ref or a
// tree: the base→target tests pass `baseFiles` as a literal Set.) Committing would also mean
// three `git config` calls per repo just to satisfy git's identity check, so this is four
// fewer processes at each of ~25 call sites, on the platform where spawning is dearest.
// If a future test needs a real commit, give it its own helper rather than slowing every
// other fixture down.
function gitInit(dir) {
  git(dir, 'init', '-q');
}

function gitProject(files) {
  const p = tmp();
  gitInit(p);
  for (const [rel, content] of Object.entries(files)) write(p, rel, content);
  git(p, 'add', '-A');
  return p;
}

// A TEMPLATE dir that is a real git repo. applyTemplate derives the target's file set from
// `gitTracked(templateRoot)`, and that is null for a plain temp dir — which silently turns
// the base→target diff into a no-op. Any test of that diff must use this, or it passes
// without exercising the thing it names.
const gitTemplate = gitProject;

// The project's tracked set. The script's own helper, not a re-spelling of its `git ls-files -z
// -c core.quotePath=false` incantation: those flags are the safety-critical part (a quoting
// mismatch is silent data loss — see gitPathSet), so the fixtures must not be able to drift from
// the production reading of trackedness.
const trackedOf = gitTracked;
function writePkg(root, rel, obj) {
  write(root, rel, `${JSON.stringify(obj, null, 2)}\n`);
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, rel));

describe('applyPaths (machinery / guardrails)', () => {
  test('adds missing, overwrites existing, skips identical', () => {
    const t = tmp(), p = tmp();
    write(t, '.claude/commands/upgrade.md', 'cmd\n');
    write(t, '.claude/agents/dev.md', 'v2\n');
    write(p, '.claude/agents/dev.md', 'v1\n');
    write(t, 'CHANGELOG.md', 'same\n');
    write(p, 'CHANGELOG.md', 'same\n');

    const res = applyPaths(t, p, MACHINERY_PATHS);
    assert.deepStrictEqual(res.added, ['.claude/commands/upgrade.md']);
    assert.deepStrictEqual(res.updated, ['.claude/agents/dev.md']);
    assert.strictEqual(read(p, '.claude/agents/dev.md'), 'v2\n');
  });

  // The dev repo ships its own release/test workflows; the release repo strips them. Without
  // this, dogfooding against the dev repo copies them in and removeRetiredPaths deletes them
  // again in the same run — reported as "retired" for a file the project never had.
  test('never applies a DEV_ONLY_PATHS file, even when the template source ships it', () => {
    const t = tmp(), p = tmp();
    write(t, '.github/workflows/quality-gates.yml', 'current\n');
    write(t, '.github/workflows/template-tests.yml', 'dev-repo only\n'); // in DEV_ONLY_PATHS
    const res = applyPaths(t, p, GUARDRAIL_PATHS);
    assert.deepStrictEqual(res.added, ['.github/workflows/quality-gates.yml']);
    assert.ok(!exists(p, '.github/workflows/template-tests.yml'));
  });

  test('excludes dev-only test files and fixtures', () => {
    const t = tmp(), p = tmp();
    write(t, '.claude/scripts/real.js', 'ok\n');
    write(t, '.claude/scripts/real.tests.js', 'test\n');
    write(t, '.claude/scripts/__fixtures__/x.json', '{}\n');
    const res = applyPaths(t, p, MACHINERY_PATHS);
    assert.deepStrictEqual(res.added, ['.claude/scripts/real.js']);
    assert.ok(!exists(p, '.claude/scripts/real.tests.js'));
  });
});

describe('mirrorDeleteRetired (owned-tree sweep)', () => {
  // `.claude/scripts/`, not `agents/` or `commands/`: those are prune-exempt because a project
  // authors its own files there. This is the sweep's core behaviour in a dir it does own.
  test('deletes a project file the template no longer has (retired)', () => {
    const t = tmp();
    write(t, '.claude/scripts/keep.js', 'kept\n');
    const p = gitProject({
      '.claude/scripts/keep.js': 'kept\n',
      '.claude/scripts/retired.js': 'gone in template\n',
    });

    const removed = mirrorDeleteRetired(t, p, OWNED_TREES, null, trackedOf(p));
    assert.deepStrictEqual(removed, ['.claude/scripts/retired.js']);
    assert.ok(!exists(p, '.claude/scripts/retired.js'));
    assert.ok(exists(p, '.claude/scripts/keep.js'), 'still-present file kept');
  });

  // THE REGRESSION TEST for the reported bug. `.template-docs/**` was reorganised into
  // `.template-docs/users/**`; the delete list named only the new dir, so every doc the
  // restructure retired survived in upgraded projects. Sweeping the TREE fixes it.
  test('prunes a whole retired subtree after a template RESTRUCTURE', () => {
    const t = tmp();
    write(t, '.template-docs/users/Getting-Started.md', 'new home\n');
    write(t, '.template-docs/users/Help/README.md', 'new home\n');
    const p = gitProject({
      '.template-docs/users/Getting-Started.md': 'new home\n', // already at the new path
      '.template-docs/Getting-Started.md': 'old flat layout\n',
      '.template-docs/CONTRIBUTING.md': 'maintainer doc, never shipped now\n',
      '.template-docs/Help/Session-Logging.md': 'retired\n',
      '.template-docs/guides/TESTING.md': 'retired\n',
      '.template-docs/examples/example-1.md': 'retired\n',
      '.template-docs/Getting started/01-start.md': 'retired, and a space in the dir name\n',
    });

    const removed = mirrorDeleteRetired(t, p, OWNED_TREES, null, trackedOf(p));

    assert.ok(exists(p, '.template-docs/users/Getting-Started.md'), 'current doc kept');
    for (const stale of [
      '.template-docs/Getting-Started.md',
      '.template-docs/CONTRIBUTING.md',
      '.template-docs/Help/Session-Logging.md',
      '.template-docs/guides/TESTING.md',
      '.template-docs/examples/example-1.md',
      '.template-docs/Getting started/01-start.md',
    ]) {
      assert.ok(!exists(p, stale), `${stale} pruned`);
      assert.ok(removed.includes(stale), `${stale} reported`);
    }
  });

  test('prunes retired files at the ROOT of an owned tree and in retired sub-dirs', () => {
    const t = tmp();
    write(t, '.claude/README.md', 'current\n');
    const p = gitProject({
      '.claude/README.md': 'current\n',
      '.claude/LOGGING_QUICK_START.md': 'retired loose file at the tree root\n',
      '.claude/logging/capture-context.ps1': 'retired sub-dir\n',
      '.claude/logging/README.md': 'retired sub-dir\n',
    });

    const removed = mirrorDeleteRetired(t, p, OWNED_TREES, null, trackedOf(p));

    assert.ok(exists(p, '.claude/README.md'));
    assert.deepStrictEqual(removed, [
      '.claude/LOGGING_QUICK_START.md',
      '.claude/logging/README.md',
      '.claude/logging/capture-context.ps1',
    ]);
  });

  // `.claude/README.md` tells users to commit `agents/`, `commands/` and friends, and Claude
  // Code's own `/agents` writes there. "The template doesn't ship it" therefore means "the
  // user wrote it", not "it's stale" — the sweep judges by location and cannot tell those
  // apart, so it stands down and leaves those dirs to the provenance-based base diff.
  test('never prunes a project’s own commands, agents or skills', () => {
    const t = tmp();
    write(t, '.claude/commands/start.md', 'template command\n');
    write(t, '.claude/agents/developer.md', 'template agent\n');
    const p = gitProject({
      '.claude/commands/start.md': 'template command\n',
      '.claude/commands/deploy.md': 'the user’s own command\n',
      '.claude/agents/our-reviewer.md': 'the user’s own agent\n',
      '.claude/skills/house-style/SKILL.md': 'the user’s own skill\n',
      '.claude/output-styles/house.md': 'Claude Code config the template never ships\n',
      '.claude/scripts/retired.js': 'genuinely retired template machinery\n',
    });

    const removed = mirrorDeleteRetired(t, p, OWNED_TREES, null, trackedOf(p));

    assert.deepStrictEqual(removed, ['.claude/scripts/retired.js'], 'only real machinery is swept');
    for (const rel of [
      '.claude/commands/deploy.md',
      '.claude/agents/our-reviewer.md',
      '.claude/skills/house-style/SKILL.md',
      '.claude/output-styles/house.md',
    ]) {
      assert.ok(exists(p, rel), `${rel} survives`);
    }
  });

  // The cost of the exemption above, stated as a test: retirements in those dirs now ride on
  // the base→target diff, which is provenance-based and so can tell them from the user's own.
  test('a retired template command is still caught, by the base diff', () => {
    const p = gitProject({ '.claude/commands/old.md': 'retired\n', '.claude/commands/mine.md': 'the user’s\n' });
    const base = new Set(['.claude/commands/old.md']); // the template shipped it; the target does not

    const removed = retiredSinceBase(base, new Set(), p, trackedOf(p));

    assert.deepStrictEqual(removed, ['.claude/commands/old.md']);
    assert.ok(exists(p, '.claude/commands/mine.md'), 'never shipped, so never retired');
  });

  // On Windows/macOS a case-only rename in the template renames nothing in the project: the
  // copy lands on the existing directory entry, which keeps its old casing. Without a
  // case-folded comparison the sweep then deletes the file the upgrade just brought current,
  // and pruneEmptyDirs removes the folder behind it — a template rename silently destroying a
  // user's file. Deterministic on either kind of filesystem: the two names live in separate
  // roots, so nothing collides.
  test('keeps a file the template renamed by CASE only, rather than deleting it', () => {
    const t = tmp();
    write(t, '.claude/agents/dev.md', 'renamed to lowercase\n');
    const p = gitProject({ '.claude/agents/Dev.md': 'same agent, old casing\n' });

    const removed = mirrorDeleteRetired(t, p, OWNED_TREES, null, trackedOf(p));

    assert.deepStrictEqual(removed, []);
    assert.ok(exists(p, '.claude/agents/Dev.md'), 'the agent survives the rename');
  });

  // isExcluded hides these from the COPY path by design. Applying it to the project side too
  // made them permanently invisible, so a stale `*.tests.js` / `__fixtures__/` could never be
  // removed. The sweep must see raw files — and must still keep them when the template ships
  // them (the dev repo dogfooding its own copy).
  test('prunes stale dev-only test files/fixtures the template does not ship', () => {
    const t = tmp();
    write(t, '.claude/scripts/real.js', 'ok\n');
    write(t, '.github/scripts/audit-gate.js', 'ok\n'); // the tree exists, just not the test file
    const p = gitProject({
      '.claude/scripts/real.js': 'ok\n',
      '.claude/scripts/gone.tests.js': 'stale dev-only test\n',
      '.claude/scripts/__fixtures__/legacy/state.json': '{}\n',
      '.github/scripts/audit-gate.test.js': 'stale dev-only test\n',
    });
    const removed = mirrorDeleteRetired(t, p, OWNED_TREES, null, trackedOf(p));

    assert.ok(exists(p, '.claude/scripts/real.js'));
    assert.deepStrictEqual(removed, [
      '.claude/scripts/__fixtures__/legacy/state.json',
      '.claude/scripts/gone.tests.js',
      '.github/scripts/audit-gate.test.js',
    ]);
  });

  test('KEEPS test files/fixtures when the template itself ships them (dev repo as source)', () => {
    const t = tmp();
    write(t, '.claude/scripts/real.js', 'ok\n');
    write(t, '.claude/scripts/real.tests.js', 'shipped by the dev repo\n');
    write(t, '.claude/scripts/__fixtures__/legacy/state.json', '{}\n');
    const p = gitProject({
      '.claude/scripts/real.js': 'ok\n',
      '.claude/scripts/real.tests.js': 'shipped by the dev repo\n',
      '.claude/scripts/__fixtures__/legacy/state.json': '{}\n',
    });

    const removed = mirrorDeleteRetired(t, p, OWNED_TREES, null, trackedOf(p));

    assert.deepStrictEqual(removed, [], 'a file the template ships is never "retired"');
    assert.ok(exists(p, '.claude/scripts/real.tests.js'));
    assert.ok(exists(p, '.claude/scripts/__fixtures__/legacy/state.json'));
  });

  test('never prunes prune-exempt dirs or guardrail dirs (a project may add its own)', () => {
    const t = tmp();
    write(t, '.claude/README.md', 'current\n');
    const p = gitProject({
      '.claude/README.md': 'current\n',
      '.claude/hooks/my-custom-hook.js': 'mine\n',
      '.claude/logs/2026-04-29-session.md': 'my session log\n',
      '.github/workflows/my-deploy.yml': 'mine\n', // .github/workflows isn't an owned tree
    });
    const projectTracked = trackedOf(p);

    mirrorDeleteRetired(t, p, OWNED_TREES, null, projectTracked);

    assert.ok(exists(p, '.claude/hooks/my-custom-hook.js'), 'custom hook preserved');
    assert.ok(exists(p, '.claude/logs/2026-04-29-session.md'), 'session log preserved');
    assert.ok(exists(p, '.github/workflows/my-deploy.yml'), 'custom workflow preserved');
  });

  test('never prunes gitignored local state living inside an owned tree', () => {
    const t = tmp();
    write(t, '.claude/README.md', 'current\n');
    const p = gitProject({ '.claude/README.md': 'current\n' });
    // Untracked/gitignored: the user's local prefs and an agent cache. Not template content.
    write(p, '.claude/settings.local.json', '{"mine":true}\n');
    write(p, '.claude/preferences.json', '{"safePaths":{}}\n');
    write(p, '.claude/scripts/.cache-abc123', 'transient\n');
    const projectTracked = new Set(['.claude/README.md']); // what git actually tracks

    const removed = mirrorDeleteRetired(t, p, OWNED_TREES, null, projectTracked);

    assert.deepStrictEqual(removed, [], 'nothing untracked is treated as retired template content');
    assert.ok(exists(p, '.claude/settings.local.json'), 'local settings preserved');
    assert.ok(exists(p, '.claude/preferences.json'), 'local preferences preserved');
    assert.ok(exists(p, '.claude/scripts/.cache-abc123'), 'transient cache preserved');
  });
});

describe('pruneEmptyDirs (the folders git can’t report)', () => {
  test('collapses a retired sub-tree all the way up; keeps dirs that still hold something', () => {
    const p = tmp();
    write(p, '.template-docs/guides/TESTING.md', 'retired\n');
    write(p, '.claude/logging/lib/deep/x.ps1', 'retired\n');
    write(p, '.claude/agents/retired.md', 'retired\n');
    write(p, '.claude/agents/dev.md', 'kept\n'); // keeps .claude/agents alive
    const removed = ['.template-docs/guides/TESTING.md', '.claude/logging/lib/deep/x.ps1', '.claude/agents/retired.md'];
    for (const rel of removed) fs.rmSync(path.join(p, rel));

    const emptied = pruneEmptyDirs(p, removed);

    assert.ok(!exists(p, '.template-docs/guides'), 'emptied dir removed');
    assert.ok(!exists(p, '.claude/logging'), 'collapsed deepest-first, right up to the top');
    assert.ok(exists(p, '.claude/agents'), 'dir still holding a file is kept');
    assert.ok(exists(p, '.claude'), 'a tree root that still has content is kept');
    assert.ok(emptied.includes('.claude/logging/lib/deep') && emptied.includes('.claude/logging'), 'reports each level');
  });

  test('never removes a dir holding the project’s own files', () => {
    const p = tmp();
    write(p, 'scripts/parse-logs.ps1', 'retired\n');
    write(p, 'scripts/my-deploy.sh', 'mine\n');
    fs.rmSync(path.join(p, 'scripts/parse-logs.ps1'));

    assert.deepStrictEqual(pruneEmptyDirs(p, ['scripts/parse-logs.ps1']), []);
    assert.ok(exists(p, 'scripts/my-deploy.sh'), "the project's own file is untouched");
  });
});

describe('retiredSinceBase (base→target diff — reaches the guardrail dirs)', () => {
  const target = new Set(['.github/workflows/quality-gates.yml', '.claude/hooks/keep.ps1']);

  test('deletes a guardrail file the base shipped and the target dropped', () => {
    const p = gitProject({
      '.github/workflows/quality-gates.yml': 'current\n',
      '.github/workflows/pr-checks.yml': 'renamed away — would double-run every gate\n',
      '.claude/hooks/keep.ps1': 'current\n',
      '.claude/hooks/retired.ps1': 'dropped by the template\n',
    });
    const base = new Set([...target, '.github/workflows/pr-checks.yml', '.claude/hooks/retired.ps1']);
    const projectTracked = trackedOf(p);

    const removed = retiredSinceBase(base, target, p, projectTracked);

    assert.deepStrictEqual(removed, ['.claude/hooks/retired.ps1', '.github/workflows/pr-checks.yml']);
    assert.ok(exists(p, '.github/workflows/quality-gates.yml'), 'current workflow kept');
    assert.ok(exists(p, '.claude/hooks/keep.ps1'), 'current hook kept');
  });

  // The same case-only-rename hazard mirrorDeleteRetired guards against, and the base diff has
  // to guard against it too — otherwise it simply undoes that guard for any project that has a
  // base, and reaches the exempt dirs the tree sweep never touches. On Windows/macOS the
  // project keeps the OLD casing after applyPaths copies the renamed file onto it, so the base
  // path is still the live file: deleting it destroys what the upgrade just brought current.
  test('keeps a file the template renamed by CASE only, rather than deleting it', () => {
    const p = gitProject({ '.claude/agents/Dev.md': 'brought current, still old casing\n' });
    const base = new Set(['.claude/agents/Dev.md']);
    const renamedTarget = new Set(['.claude/agents/dev.md']); // same file, lowercased upstream

    const removed = retiredSinceBase(base, renamedTarget, p, trackedOf(p));

    assert.deepStrictEqual(removed, []);
    assert.ok(exists(p, '.claude/agents/Dev.md'), 'the agent survives the rename');
  });

  test('never deletes outside the machinery prefixes — a dropped starter file may be the user’s page now', () => {
    const p = gitProject({
      'web/src/app/page.tsx': 'MY OWN PAGE\n',
      'documentation/spec.md': 'mine\n',
      'CLAUDE.md': 'mine + template\n',
    });
    const base = new Set(['web/src/app/page.tsx', 'documentation/spec.md', 'CLAUDE.md']);
    const projectTracked = trackedOf(p);

    assert.deepStrictEqual(retiredSinceBase(base, new Set(), p, projectTracked), []);
    assert.ok(exists(p, 'web/src/app/page.tsx'), 'app code never touched by the base diff');
    assert.ok(exists(p, 'documentation/spec.md'), 'specs never touched');
    assert.ok(exists(p, 'CLAUDE.md'), 'mixed root file never touched');
  });

  // `rmSync` without `recursive` throws EISDIR on a directory, which would abort the upgrade
  // after machinery had already been copied onto the branch. A base path can arrive here as a
  // directory: `ls-tree -r` emits submodule gitlinks as plain paths, and a project can have
  // turned a former template file into a folder.
  test('steps over a base path that is now a directory instead of throwing', () => {
    const p = gitProject({ '.claude/hooks/keep.ps1': 'current\n' });
    fs.mkdirSync(path.join(p, '.claude/was-a-file/nested'), { recursive: true });
    write(p, '.claude/was-a-file/nested/mine.md', 'the user’s own file\n');
    const base = new Set([...target, '.claude/was-a-file']);

    const removed = retiredSinceBase(base, target, p, new Set([...trackedOf(p), '.claude/was-a-file']));

    assert.deepStrictEqual(removed, [], 'a directory is not the retired file');
    assert.ok(exists(p, '.claude/was-a-file/nested/mine.md'), 'never takes the subtree with it');
  });

  test('no-op without a base (no version marker, deleted tag, offline)', () => {
    const p = gitProject({ '.github/workflows/pr-checks.yml': 'stale\n' });
    assert.deepStrictEqual(retiredSinceBase(null, target, p, null), [], 'null base → no deletions');
    assert.ok(exists(p, '.github/workflows/pr-checks.yml'));
  });

  test('skips paths the project does not track', () => {
    const p = gitProject({ '.claude/hooks/keep.ps1': 'current\n' });
    write(p, '.github/workflows/local-experiment.yml', 'untracked, mine\n');
    const base = new Set([...target, '.github/workflows/local-experiment.yml']);

    const removed = retiredSinceBase(base, target, p, new Set(['.claude/hooks/keep.ps1']));

    assert.deepStrictEqual(removed, []);
    assert.ok(exists(p, '.github/workflows/local-experiment.yml'), 'untracked file preserved');
  });
});

describe('mergeGitignoreAdditions (the file the tracked-only safety model rests on)', () => {
  test('adds template patterns the project lacks; never touches what is already there', () => {
    const t = tmp(), p = tmp();
    write(t, '.gitignore', '# Local state\n/.claude/settings.local.json\n/.claude/preferences.json\n/.claude/logs/\n');
    write(p, '.gitignore', '# Ours\nnode_modules/\n/.claude/settings.local.json\n');

    const res = mergeGitignoreAdditions(t, p);

    assert.strictEqual(res.changed, true);
    assert.deepStrictEqual(res.added, ['/.claude/preferences.json', '/.claude/logs/']);
    const out = read(p, '.gitignore');
    assert.ok(out.startsWith('# Ours\nnode_modules/\n/.claude/settings.local.json\n'), 'existing content untouched');
    assert.ok(out.includes('/.claude/preferences.json'));
    assert.ok(!out.includes('# Local state'), 'template section headings are not copied');
  });

  test('no-op when the project already has every pattern (so an upgrade adds no noise)', () => {
    const t = tmp(), p = tmp();
    write(t, '.gitignore', '/.claude/logs/\n');
    write(p, '.gitignore', '# mine\n/.claude/logs/\nnode_modules/\n');

    const res = mergeGitignoreAdditions(t, p);

    assert.strictEqual(res.changed, false);
    assert.deepStrictEqual(res.added, []);
    assert.strictEqual(read(p, '.gitignore'), '# mine\n/.claude/logs/\nnode_modules/\n', 'byte-identical');
  });

  test('creates the file when the project has none, and tolerates a missing final newline', () => {
    const t = tmp(), p = tmp(), p2 = tmp();
    write(t, '.gitignore', '/.claude/logs/\n');

    assert.deepStrictEqual(mergeGitignoreAdditions(t, p).added, ['/.claude/logs/']);
    assert.ok(read(p, '.gitignore').includes('/.claude/logs/'));

    write(p2, '.gitignore', 'node_modules/'); // no trailing newline
    mergeGitignoreAdditions(t, p2);
    assert.ok(read(p2, '.gitignore').startsWith('node_modules/\n'), 'never glues onto the last line');
  });

  test('no-op when the template has no .gitignore', () => {
    const t = tmp(), p = tmp();
    write(p, '.gitignore', 'mine\n');
    assert.deepStrictEqual(mergeGitignoreAdditions(t, p), { changed: false, added: [] });
    assert.strictEqual(read(p, '.gitignore'), 'mine\n');
  });
});

describe('mergePackageAdditions', () => {
  test('adds missing deps/scripts/engines; reports them', () => {
    const t = tmp(), p = tmp();
    writePkg(t, 'web/package.json', {
      dependencies: { zod: '^3.25.23', react: '^19.0.0' },
      devDependencies: { '@axe-core/playwright': '^4.11.3' },
      scripts: { 'typecheck:src': 'tsc', test: 'vitest run' },
      engines: { node: '>=22' },
    });
    writePkg(p, 'web/package.json', {
      dependencies: { react: '^19.0.0' },
      scripts: { test: 'vitest run' },
    });
    const res = mergePackageAdditions(path.join(t, 'web/package.json'), path.join(p, 'web/package.json'));
    const out = JSON.parse(read(p, 'web/package.json'));
    assert.strictEqual(res.changed, true);
    assert.deepStrictEqual(res.added.dependencies, ['zod@^3.25.23']);
    assert.deepStrictEqual(res.added.devDependencies, ['@axe-core/playwright@^4.11.3']);
    assert.deepStrictEqual(res.added.scripts, ['typecheck:src']);
    assert.deepStrictEqual(res.added.fields, ['engines']);
    assert.strictEqual(out.dependencies.zod, '^3.25.23');
  });

  test('NEVER removes a dropped dep or changes a pinned version', () => {
    const t = tmp(), p = tmp();
    writePkg(t, 'web/package.json', { dependencies: { react: '^19.2.0' }, devDependencies: {} });
    writePkg(p, 'web/package.json', {
      dependencies: { react: '^19.0.0' },
      devDependencies: { 'vitest-axe': '^0.1.0' },
    });
    const res = mergePackageAdditions(path.join(t, 'web/package.json'), path.join(p, 'web/package.json'));
    const out = JSON.parse(read(p, 'web/package.json'));
    assert.strictEqual(out.dependencies.react, '^19.0.0', 'pinned version untouched');
    assert.strictEqual(out.devDependencies['vitest-axe'], '^0.1.0', 'dropped dep kept');
    assert.strictEqual(res.changed, false);
  });

  test('engines: adds when the project has none; preserves the project value when present', () => {
    const t = tmp(), p = tmp();
    writePkg(t, 'web/package.json', { engines: { node: '>=22' } });
    writePkg(p, 'web/package.json', { engines: { node: '>=20' } });
    const res = mergePackageAdditions(path.join(t, 'web/package.json'), path.join(p, 'web/package.json'));
    const out = JSON.parse(read(p, 'web/package.json'));
    assert.strictEqual(out.engines.node, '>=20', 'existing engines never overwritten');
    assert.deepStrictEqual(res.added.fields, [], 'engines not reported as added when present');
    assert.strictEqual(res.changed, false, 'no write when nothing was added');
  });

  test('adds a missing override (the template ships security fixes as overrides)', () => {
    const t = tmp(), p = tmp();
    writePkg(t, 'web/package.json', { overrides: { tmp: '^0.2.5', sharp: '^0.35.0' } });
    writePkg(p, 'web/package.json', { overrides: { tmp: '^0.2.5' } });
    const res = mergePackageAdditions(path.join(t, 'web/package.json'), path.join(p, 'web/package.json'));
    const out = JSON.parse(read(p, 'web/package.json'));
    assert.strictEqual(res.changed, true);
    assert.deepStrictEqual(res.added.overrides, ['sharp@^0.35.0'], 'only the missing override reported');
    assert.strictEqual(out.overrides.sharp, '^0.35.0', 'missing override added');
    assert.strictEqual(out.overrides.tmp, '^0.2.5', 'existing override untouched');
  });

  test('creates overrides when the project has none', () => {
    const t = tmp(), p = tmp();
    writePkg(t, 'web/package.json', { overrides: { uuid: '^11.1.1' } });
    writePkg(p, 'web/package.json', { dependencies: {} });
    const res = mergePackageAdditions(path.join(t, 'web/package.json'), path.join(p, 'web/package.json'));
    const out = JSON.parse(read(p, 'web/package.json'));
    assert.deepStrictEqual(res.added.overrides, ['uuid@^11.1.1']);
    assert.strictEqual(out.overrides.uuid, '^11.1.1');
  });

  test('NEVER changes an override version the project already pinned', () => {
    const t = tmp(), p = tmp();
    writePkg(t, 'web/package.json', { overrides: { postcss: '^8.5.15' } });
    writePkg(p, 'web/package.json', { overrides: { postcss: '^8.4.0' } });
    const res = mergePackageAdditions(path.join(t, 'web/package.json'), path.join(p, 'web/package.json'));
    const out = JSON.parse(read(p, 'web/package.json'));
    assert.strictEqual(out.overrides.postcss, '^8.4.0', 'project pin preserved');
    assert.strictEqual(res.changed, false);
  });

  test('renders a nested-object override value as the bare key (no `@version`)', () => {
    const t = tmp(), p = tmp();
    writePkg(t, 'web/package.json', { overrides: { foo: { bar: '2.0.0' } } });
    writePkg(p, 'web/package.json', { overrides: {} });
    const res = mergePackageAdditions(path.join(t, 'web/package.json'), path.join(p, 'web/package.json'));
    const out = JSON.parse(read(p, 'web/package.json'));
    assert.deepStrictEqual(res.added.overrides, ['foo'], 'object value reported as the bare key');
    assert.deepStrictEqual(out.overrides.foo, { bar: '2.0.0' }, 'nested override copied verbatim');
  });

  test('tolerates a leading UTF-8 BOM in package.json instead of aborting', () => {
    const t = tmp(), p = tmp();
    const bom = String.fromCharCode(0xfeff);
    write(t, 'web/package.json', `${bom}${JSON.stringify({ dependencies: { zod: '^3' } }, null, 2)}\n`);
    write(p, 'web/package.json', `${bom}${JSON.stringify({ dependencies: {} }, null, 2)}\n`);
    const res = mergePackageAdditions(path.join(t, 'web/package.json'), path.join(p, 'web/package.json'));
    assert.deepStrictEqual(res.added.dependencies, ['zod@^3'], 'merge runs despite the BOM');
    assert.strictEqual(JSON.parse(read(p, 'web/package.json')).dependencies.zod, '^3');
  });
});

describe('refreshLockfile', () => {
  test('runs npm in web/ and reports success (exec injected — no real npm)', () => {
    const p = tmp();
    write(p, 'web/package.json', '{}\n');
    write(p, 'web/package-lock.json', '{}\n');
    let calledWith = null;
    const res = refreshLockfile(p, (webDir) => {
      calledWith = webDir;
    });
    assert.deepStrictEqual(res, { ran: true, ok: true });
    assert.strictEqual(calledWith, path.join(p, 'web'), 'refresh runs in the project web/ dir');
  });

  test('no-op when there is no lockfile to keep in sync', () => {
    const p = tmp();
    write(p, 'web/package.json', '{}\n'); // package.json but no lock
    let called = false;
    const res = refreshLockfile(p, () => {
      called = true;
    });
    assert.strictEqual(res.ran, false, 'nothing to refresh');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(called, false, 'npm never invoked without a lock');
  });

  test('reports failure (ran but not ok) when npm throws, instead of crashing', () => {
    const p = tmp();
    write(p, 'web/package.json', '{}\n');
    write(p, 'web/package-lock.json', '{}\n');
    const res = refreshLockfile(p, () => {
      throw new Error('npm ETARGET no matching version');
    });
    assert.strictEqual(res.ran, true);
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /ETARGET/, 'error surfaced for the fail-closed path');
  });
});

describe('reconcileWeb', () => {
  test('adds missing web config; never overwrites existing (reports it); never touches app', () => {
    const t = tmp(), p = tmp();
    write(t, 'web/playwright.config.ts', 'export default {};\n'); // missing in project → add
    write(t, 'web/next.config.ts', 'export default { TEMPLATE: true };\n'); // exists+differs → review
    write(p, 'web/next.config.ts', 'export default { MY_REWRITES: true };\n');
    write(t, 'web/src/app/page.tsx', 'TEMPLATE STARTER\n'); // app → never
    write(t, 'web/e2e/x.spec.ts', 'spec\n'); // specs → never
    write(t, 'web/public/logo.svg', '<svg/>\n'); // assets → never
    writePkg(t, 'web/package.json', { dependencies: { zod: '^3' } });
    writePkg(p, 'web/package.json', { dependencies: {} });

    const res = reconcileWeb(t, p);

    assert.deepStrictEqual(res.added, ['web/playwright.config.ts']);
    assert.deepStrictEqual(res.review, ['web/next.config.ts']);
    assert.strictEqual(read(p, 'web/next.config.ts'), 'export default { MY_REWRITES: true };\n', 'customised config preserved');
    assert.ok(!exists(p, 'web/src/app/page.tsx'), 'app never written');
    assert.ok(!exists(p, 'web/e2e/x.spec.ts'), 'specs never written');
    assert.ok(!exists(p, 'web/public/logo.svg'), 'assets never written');
    assert.deepStrictEqual(res.pkg.added.dependencies, ['zod@^3']);
  });

  test('never copies env secrets — only .env.example', () => {
    const t = tmp(), p = tmp();
    write(t, 'web/.env.example', 'API_URL=\n');
    write(t, 'web/.env.local', 'SECRET=shhh\n');
    write(t, 'web/.env', 'SECRET=shhh\n');
    const res = reconcileWeb(t, p);
    assert.ok(res.added.includes('web/.env.example'), '.env.example added');
    assert.ok(!res.added.includes('web/.env.local'), '.env.local never copied');
    assert.ok(!exists(p, 'web/.env.local'), '.env.local not written');
    assert.ok(!exists(p, 'web/.env'), '.env not written');
  });

  // A real upgrade overwrote a project's Dockerfile and reverted the build-stage placeholder it
  // needed to build at all (see ROOT_ADDITIVE_FILES). Root additive files get the web/-config
  // contract instead: add when absent, report when it differs, never overwrite.
  test('root additive files (Dockerfile) are added when missing, reported when customised', () => {
    const t = tmp(), p = tmp();
    write(t, 'Dockerfile', 'FROM node:22\n');
    const fresh = reconcileWeb(t, p);
    assert.deepStrictEqual(fresh.added, ['Dockerfile'], 'added when the project has none');

    const p2 = tmp();
    write(p2, 'Dockerfile', 'FROM node:22\nARG NEXTAUTH_SECRET=placeholder\n');
    const customised = reconcileWeb(t, p2);
    assert.deepStrictEqual(customised.review, ['Dockerfile'], 'reported for /upgrade to merge');
    assert.deepStrictEqual(customised.added, [], 'not counted as added');
    assert.strictEqual(
      read(p2, 'Dockerfile'),
      'FROM node:22\nARG NEXTAUTH_SECRET=placeholder\n',
      "the project's required build fix survives the upgrade",
    );
  });

  test('ROOT_ADDITIVE_FILES is never also applied (that would overwrite it again)', () => {
    const applied = [...MACHINERY_PATHS, ...GUARDRAIL_PATHS];
    for (const rel of ROOT_ADDITIVE_FILES) {
      assert.ok(!isUnder(rel, applied), `${rel} is reconciled additively AND applied — the apply wins`);
    }
  });
});

describe('applyTemplate (integration)', () => {
  test('applies machinery + guardrails + web, prunes retired, leaves mixed/app alone', () => {
    const t = tmp();
    write(t, '.claude/commands/upgrade.md', 'cmd\n'); // machinery add
    write(t, '.claude/settings.json', '{"v":2}\n'); // guardrail
    write(t, 'web/vitest.config.ts', 'cfg\n'); // web add
    write(t, 'CLAUDE.md', 'TEMPLATE\n'); // mixed → never
    writePkg(t, 'web/package.json', { dependencies: { zod: '^3' } });
    const p = gitProject({
      '.claude/settings.json': '{"v":1}\n',
      '.claude/scripts/retired.js': 'gone\n', // retired (not in template, and a swept dir)
      'web/package.json': `${JSON.stringify({ dependencies: {} }, null, 2)}\n`,
    });

    const r = applyTemplate(t, p);

    assert.deepStrictEqual(r.machinery.added, ['.claude/commands/upgrade.md']);
    assert.deepStrictEqual(r.guardrails.updated, ['.claude/settings.json']);
    assert.deepStrictEqual(r.retired, ['.claude/scripts/retired.js']);
    assert.deepStrictEqual(r.web.added, ['web/vitest.config.ts']);
    assert.strictEqual(r.pruneRan, true, 'sweep ran');
    assert.strictEqual(read(p, '.claude/settings.json'), '{"v":2}\n', 'guardrail applied');
    assert.ok(!exists(p, '.claude/scripts/retired.js'), 'retired pruned');
    assert.ok(!exists(p, 'CLAUDE.md'), 'mixed CLAUDE.md never written by applier');
    assert.strictEqual(read(p, 'web/package.json').includes('zod'), true, 'package.json additively merged');
  });

  // Deliberately uses a workflow that is NOT in RETIRED_PATHS: with `pr-checks.yml` the
  // assertion passes off the named backstop alone, whether or not the base diff ran at all.
  test('runs the base→target diff when given the base file set', () => {
    const t = gitTemplate({
      '.claude/settings.json': '{"v":2}\n',
      '.github/workflows/quality-gates.yml': 'current\n',
    });
    const p = gitProject({
      '.claude/settings.json': '{"v":1}\n',
      '.github/workflows/quality-gates.yml': 'old\n',
      '.github/workflows/nightly-audit.yml': 'retired at the base version\n',
      '.claude/hooks/retired-hook.ps1': 'retired at the base version\n',
    });

    const r = applyTemplate(t, p, {
      baseFiles: new Set([
        '.claude/settings.json',
        '.github/workflows/quality-gates.yml',
        '.github/workflows/nightly-audit.yml',
        '.claude/hooks/retired-hook.ps1',
      ]),
    });

    assert.strictEqual(r.baseDiffRan, true, 'the diff actually ran');
    assert.ok(r.retired.includes('.github/workflows/nightly-audit.yml'), 'guardrail retirement caught via the base diff');
    assert.ok(r.retired.includes('.claude/hooks/retired-hook.ps1'), 'prune-exempt dir reached by the base diff');
    assert.ok(!exists(p, '.github/workflows/nightly-audit.yml'));
    assert.ok(exists(p, '.github/workflows/quality-gates.yml'), 'current workflow kept');
  });

  test('skips the base→target diff (and says so) when the template source is not a git repo', () => {
    const t = tmp(); // plain dir: no tracked set, so there is no target side to diff against
    write(t, '.claude/settings.json', '{"v":2}\n');
    const p = gitProject({
      '.claude/settings.json': '{"v":1}\n',
      '.claude/hooks/retired-hook.ps1': 'would only be caught by the base diff\n',
    });

    const r = applyTemplate(t, p, { baseFiles: new Set(['.claude/settings.json', '.claude/hooks/retired-hook.ps1']) });

    assert.strictEqual(r.baseDiffRan, false, 'reported as not run, so the report cannot claim it');
    assert.ok(exists(p, '.claude/hooks/retired-hook.ps1'), 'nothing deleted on a guess');
  });

  // An empty Set is truthy, so a base ref that reads back with no files would otherwise report
  // baseDiffRan — and the report would tell the user the guardrail retirements were handled
  // when the diff examined nothing.
  test('does not claim the base→target diff ran when the base set is empty', () => {
    const t = gitTemplate({ '.claude/settings.json': '{"v":2}\n' });
    const p = gitProject({ '.claude/settings.json': '{"v":1}\n' });

    assert.strictEqual(applyTemplate(t, p, { baseFiles: new Set() }).baseDiffRan, false);
  });

  test('reports each retired file once even when both sweeps catch it', () => {
    const t = gitTemplate({ '.claude/settings.json': '{"v":2}\n' });
    const p = gitProject({
      '.claude/settings.json': '{"v":1}\n',
      '.claude/scripts/retired.js': 'gone\n', // in a SWEPT dir AND gone since base — both catch it
    });

    const r = applyTemplate(t, p, { baseFiles: new Set(['.claude/settings.json', '.claude/scripts/retired.js']) });

    assert.strictEqual(r.baseDiffRan, true, 'both sweeps really did run');
    assert.deepStrictEqual(r.retired, ['.claude/scripts/retired.js'], 'deduped');
  });

  // Both shapes of a mis-pointed --template, and the same stake either way: the sweep would
  // otherwise find nothing "kept" and delete the project's entire machinery. An
  // existence-only check passes the second case, which is why it isn't one.
  for (const [label, prepTemplate] of [
    ['a non-template root', () => {}], // exists, but no .claude/ at all (wrong path)
    ['an EMPTY .claude/ (aborted fetch)', (t) => fs.mkdirSync(path.join(t, '.claude'))],
  ]) {
    test(`fails closed on ${label} instead of mass-deleting the project machinery`, () => {
      const t = tmp(), p = tmp();
      prepTemplate(t);
      write(p, '.claude/settings.json', '{"mine":true}\n');
      write(p, '.claude/agents/dev.md', 'mine\n');
      write(p, '.claude/commands/build.md', 'mine\n');
      write(p, '.template-docs/users/guide.md', 'mine\n');

      assert.throws(() => applyTemplate(t, p), /not a template/);
      for (const rel of [
        '.claude/settings.json',
        '.claude/agents/dev.md',
        '.claude/commands/build.md',
        '.template-docs/users/guide.md',
      ]) {
        assert.ok(exists(p, rel), `${rel} untouched`);
      }
    });
  }

  // Per-tree fail-closed: a template missing a whole owned tree is a truncated template far
  // more often than a template that retired every file in it.
  test('never wipes a whole owned tree just because the template lacks it', () => {
    const t = gitTemplate({ '.claude/settings.json': '{"v":2}\n' }); // no .template-docs/ at all
    const p = gitProject({
      '.claude/settings.json': '{"v":1}\n',
      '.template-docs/users/Getting-Started.md': 'help doc\n',
      '.template-docs/users/Help/README.md': 'help doc\n',
    });

    const r = applyTemplate(t, p);

    assert.deepStrictEqual(r.retired, [], 'the missing tree is treated as truncated, not retired');
    assert.ok(exists(p, '.template-docs/users/Help/README.md'), 'help docs kept');
    assert.ok(exists(p, '.template-docs'), 'and the folder is not swept away either');
  });

  // DEV_ONLY_PATHS names files the DEV repo owns and deletes them by exact name with no tracked
  // check — and applyPaths refuses to re-add them. Losing `.release-ignore` turns off
  // workflow-guard.ps1's dev-repo detection and strips the publish pipeline's exclusion list,
  // so a mis-pointed --project must not get that far.
  test('refuses to treat the template dev repo as a project to upgrade', () => {
    const t = gitTemplate({ '.claude/settings.json': '{"v":2}\n' });
    const p = gitProject({
      '.claude/settings.json': '{"v":1}\n',
      '.release-ignore': 'publish exclusions\n',
      'CLAUDE.user.md': 'the shipped rules\n',
      '.github/workflows/publish-template.yml': 'the publish pipeline itself\n',
    });

    assert.throws(() => applyTemplate(t, p), /template dev repo/);
    assert.ok(exists(p, '.release-ignore'), 'the dev-repo sentinel survives');
    assert.ok(exists(p, '.github/workflows/publish-template.yml'), 'the publish pipeline survives');
    assert.strictEqual(read(p, '.claude/settings.json'), '{"v":1}\n', 'refused before any write');
  });

  // The other half of that guard, and the reason it needs BOTH files. Legacy projects really do
  // carry `.release-ignore` alone (the old CI template-sync copied it in), and they are the ones
  // that most need it deleted. Simplifying this to workflow-guard.ps1's single-file check would
  // refuse to upgrade exactly those projects.
  test('still upgrades a project that carries `.release-ignore` alone, and removes it', () => {
    const t = gitTemplate({ '.claude/settings.json': '{"v":2}\n' });
    const p = gitProject({ '.claude/settings.json': '{"v":1}\n', '.release-ignore': 'left by the old CI sync\n' });

    assert.strictEqual(isTemplateDevRepo(p), false, 'one file alone is not the dev repo');
    const r = applyTemplate(t, p);

    assert.ok(r.retired.includes('.release-ignore'), 'the stray sentinel is cleaned up');
    assert.ok(!exists(p, '.release-ignore'), 'and really deleted, so the TDD guard works again');
    assert.strictEqual(read(p, '.claude/settings.json'), '{"v":2}\n', 'the upgrade itself went ahead');
  });

  test('fails closed on a non-git project: prunes nothing it cannot verify, says so', () => {
    const t = tmp(), p = tmp(); // p is a plain dir — no git, so no tracked set to trust
    write(t, '.claude/settings.json', '{"v":2}\n');
    write(p, '.claude/agents/looks-retired.md', 'cannot tell if this is mine\n');
    write(p, '.claude/hooks/looks-retired.ps1', 'nor this — and the base diff must not guess\n');

    const r = applyTemplate(t, p, { baseFiles: new Set(['.claude/hooks/looks-retired.ps1']) });

    assert.deepStrictEqual(r.retired, [], 'nothing deleted without a tracked set to verify against');
    assert.strictEqual(r.pruneRan, false, 'the skip is reported, not silent');
    assert.ok(exists(p, '.claude/agents/looks-retired.md'), 'owned-tree sweep skipped');
    assert.ok(exists(p, '.claude/hooks/looks-retired.ps1'), 'base→target diff skipped too');
  });
});

// /upgrade Step 3 runs the PROJECT's copy of the applier, which is the old version — so
// without the hand-over every applier fix lands one release late.
describe('reexecFetchedApplier (so applier fixes do not arrive a release late)', () => {
  const APPLIER_REL = '.claude/scripts/apply-template.js';
  // A stand-in for the fetched applier: records how it was invoked, exits with a chosen code.
  const fakeApplier = (clone, exitCode) => {
    write(
      clone,
      APPLIER_REL,
      `const fs=require('fs');fs.writeFileSync(${JSON.stringify(path.join(clone, 'argv.json'))},` +
        `JSON.stringify({argv:process.argv.slice(2),reexec:process.env[${JSON.stringify(REEXEC_ENV)}]}));` +
        `process.exit(${exitCode});\n`,
    );
  };

  test('runs the fetched applier, forwarding the args plus --template, and returns its code', () => {
    const clone = tmp();
    fakeApplier(clone, 0);

    const code = reexecFetchedApplier(clone, ['--ref', 'v1.2.0', '--base', 'v1.1.0', '--keep-clone']);

    assert.strictEqual(code, 0);
    const seen = JSON.parse(read(clone, 'argv.json'));
    assert.deepStrictEqual(seen.argv, ['--ref', 'v1.2.0', '--base', 'v1.1.0', '--keep-clone', '--template', clone]);
    assert.strictEqual(seen.reexec, '1', 'child is marked so it cannot hand over again');
  });

  test('propagates a failing exit code instead of reporting success', () => {
    const clone = tmp();
    fakeApplier(clone, 2);
    assert.strictEqual(reexecFetchedApplier(clone, ['--ref', 'v1.2.0']), 2);
  });

  test('does not hand over when already the child (the loop guard)', () => {
    const clone = tmp();
    fakeApplier(clone, 0);
    const prev = process.env[REEXEC_ENV];
    process.env[REEXEC_ENV] = '1';
    try {
      assert.strictEqual(reexecFetchedApplier(clone, ['--ref', 'v1.2.0']), null);
      assert.ok(!exists(clone, 'argv.json'), 'no child was spawned');
    } finally {
      if (prev === undefined) delete process.env[REEXEC_ENV];
      else process.env[REEXEC_ENV] = prev;
    }
  });

  test('does not spawn when the fetched applier is identical — the common case is free', () => {
    const clone = tmp();
    write(clone, APPLIER_REL, fs.readFileSync(path.join(__dirname, 'apply-template.js'), 'utf8'));
    assert.strictEqual(reexecFetchedApplier(clone, ['--ref', 'v1.2.0']), null);
  });

  test('does not hand over to a clone that has no applier', () => {
    assert.strictEqual(reexecFetchedApplier(tmp(), ['--ref', 'v1.2.0']), null);
  });
});

describe('isExcluded / the version marker', () => {
  test('isExcluded matches test files + fixtures only', () => {
    assert.ok(isExcluded('.claude/scripts/foo.tests.js'));
    assert.ok(isExcluded('.claude/scripts/__fixtures__/x.json'));
    assert.ok(!isExcluded('.claude/commands/upgrade.md'));
  });
  test('writeVersionStamp records ref + time, and readVersionStamp reads it back', () => {
    const p = tmp();
    writeVersionStamp(p, 'v1.2.0', '2026-07-10T00:00:00.000Z');
    const s = JSON.parse(read(p, 'template-version.json'));
    assert.strictEqual(s.templateRef, 'v1.2.0');
    assert.strictEqual(s.appliedAt, '2026-07-10T00:00:00.000Z');
    assert.strictEqual(readVersionStamp(p), 'v1.2.0', 'main() defaults --base to this');
  });
  // The default must degrade to "no base", never abort: an unreadable marker costs the guardrail
  // retirements, but throwing here would fail the whole upgrade over a stray byte.
  test('readVersionStamp returns null for a missing, malformed or empty marker', () => {
    assert.strictEqual(readVersionStamp(tmp()), null, 'no marker at all');
    const bad = tmp();
    write(bad, 'template-version.json', '{ not json\n');
    assert.strictEqual(readVersionStamp(bad), null, 'malformed');
    const blank = tmp();
    write(blank, 'template-version.json', '{"templateRef":""}\n');
    assert.strictEqual(readVersionStamp(blank), null, 'present but empty');
  });
});

// The hand-over makes the applier's CLI a compatibility surface: /upgrade Step 3 runs the
// PROJECT's (old) copy, which re-execs the fetched one with the arguments IT was given. So a new
// applier is always invoked with an older release's flags — and parseArgs ignores unknown ones,
// so a renamed flag stops being honoured silently. This test is the gate for that.
describe('parseArgs (a released flag keeps working forever)', () => {
  test('still honours every flag any released applier may have been invoked with', () => {
    const args = parseArgs([
      '--ref', 'v2.0.0',
      '--base', 'v1.0.0',
      '--repo', 'https://example.test/t.git',
      '--report', 'out.md',
      '--template', '/tmp/clone',
      '--project', '/tmp/proj',
      '--keep-clone',
      '--skip-lockfile',
    ]);
    assert.deepStrictEqual(args, {
      ref: 'v2.0.0',
      base: 'v1.0.0',
      repo: 'https://example.test/t.git',
      report: 'out.md',
      template: '/tmp/clone',
      project: '/tmp/proj',
      keepClone: true,
      skipLockfile: true,
      help: false,
    });
  });
});

describe('isEnvSecret', () => {
  test('allows any *.example; blocks real .env files', () => {
    assert.strictEqual(isEnvSecret('web/.env.example'), false);
    assert.strictEqual(isEnvSecret('web/.env.production.example'), false, 'future example variants ship');
    assert.strictEqual(isEnvSecret('web/.env'), true);
    assert.strictEqual(isEnvSecret('web/.env.local'), true);
    assert.strictEqual(isEnvSecret('web/.env.production'), true);
    assert.strictEqual(isEnvSecret('web/next.config.ts'), false);
  });
});

describe('allowlist invariants', () => {
  test('every machinery/guardrail path sits inside an owned tree or a base-diff prefix', () => {
    // Otherwise nothing can ever retire it, and a stale copy outlives the template forever.
    // Root files are the exception: RETIRED_PATHS names those explicitly (see its comment).
    const ROOT_FILES = ['CHANGELOG.md', '.dockerignore'];
    for (const rel of [...MACHINERY_PATHS, ...GUARDRAIL_PATHS]) {
      if (ROOT_FILES.includes(rel)) continue;
      const covered = isUnder(rel, OWNED_TREES) || BASE_DIFF_PREFIXES.some((prefix) => rel.startsWith(prefix));
      assert.ok(covered, `${rel} is applied but no sweep can ever retire it`);
    }
  });

  test('MACHINERY_PATHS and GUARDRAIL_PATHS do not overlap (each file applied once, reported once)', () => {
    const overlap = MACHINERY_PATHS.filter((rel) => GUARDRAIL_PATHS.includes(rel));
    assert.deepStrictEqual(overlap, []);
  });

  // The report and --help both tell the user which retirements a missing base leaves behind, off
  // this one list. A dir that is neither exempt from the tree sweep nor a guardrail dir IS swept,
  // so naming it here would claim a gap that doesn't exist.
  test('every BASE_DIFF_ONLY_DIRS entry really is a dir only the base diff can prune', () => {
    for (const dir of BASE_DIFF_ONLY_DIRS) {
      assert.ok(
        isPruneExempt(dir) || isUnder(dir, GUARDRAIL_PATHS),
        `${dir} is swept by the owned-tree pass, so the report must not list it as un-diffed`,
      );
    }
  });

  // Two lists, two policies (retired vs. dev-repo-only, which is also never APPLIED), one
  // deletion sweep — so the sweep must be exactly their union, and a path must not sit in both.
  test('RETIRED_PATHS and DEV_ONLY_PATHS stay distinct (different policies, one deletion sweep)', () => {
    assert.deepStrictEqual(RETIRED_PATHS.filter((rel) => DEV_ONLY_PATHS.includes(rel)), []);
    assert.deepStrictEqual(DELETE_BY_NAME_PATHS, [...RETIRED_PATHS, ...DEV_ONLY_PATHS]);
  });

  test('every prune-exempt dir is inside an owned tree (otherwise the exemption is a no-op)', () => {
    for (const dir of PRUNE_EXEMPT_DIRS) {
      // Strictly INSIDE, not equal to: exempting a whole owned tree would disable its sweep.
      assert.ok(
        OWNED_TREES.some((tree) => dir.startsWith(`${tree}/`)),
        `${dir} is exempted from a sweep that never reaches it — misleading`,
      );
    }
    assert.ok(isPruneExempt('.claude/hooks/workflow-guard.ps1'), 'files inside an exempt dir are exempt');
    assert.ok(!isPruneExempt('.claude/hooks-extra/x.ps1'), 'exemption is dir-scoped, not a name prefix');
  });

  test('no owned tree contains another (a nested tree would sweep twice and double-report)', () => {
    for (const a of OWNED_TREES) {
      for (const b of OWNED_TREES) {
        if (a !== b) assert.ok(!b.startsWith(`${a}/`), `${b} is nested inside ${a}`);
      }
    }
  });
});

// The guard that keeps THIS class of bug from returning in another folder. It runs against
// the real repo, so adding template machinery outside the sweeps' reach fails here rather
// than silently stranding stale copies in every upgraded project.
describe('sweep coverage against the real template tree', () => {
  // Areas the owned-tree sweep deliberately cannot reach, each for a stated reason. Anything
  // the template ships under .claude/, .template-docs/ or .github/ that is neither in an
  // owned tree nor listed here is a coverage gap: wire it up rather than widen this list.
  // Derived from PRUNE_EXEMPT_DIRS rather than restated, so exempting a dir can't silently
  // leave this list claiming coverage the sweep no longer has.
  const TREE_SWEEP_GAPS = [
    ...PRUNE_EXEMPT_DIRS.map((dir) => `${dir}/`),
    '.github/workflows/', // guardrail — a project may add its own workflow
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/release.yml',
  ];

  // Shipped template files not brought current by an apply list, each for a stated reason.
  const NOT_APPLIED = [
    '.claude/preferences.json', // per-project state, written by init-preferences.js
    '.template-docs/template-maintainers/', // dev-repo only; stripped by .release-ignore
  ];

  const shipped = () => [...trackedOf(REPO_ROOT)];
  const inOwnedTree = (rel) => isUnder(rel, OWNED_TREES);
  // Being inside an owned tree is not enough to be SWEPT — an exempt dir sits inside one and
  // is deliberately left to the base→target diff.
  const sweptByTree = (rel) => inOwnedTree(rel) && !isPruneExempt(rel);
  const matches = (rel, list) => list.some((entry) => (entry.endsWith('/') ? rel.startsWith(entry) : rel === entry));

  test('every shipped machinery file is reachable by a retirement sweep', () => {
    const areas = ['.claude/', '.template-docs/', '.github/'];
    const gaps = shipped()
      .filter((rel) => areas.some((a) => rel.startsWith(a)))
      .filter((rel) => !sweptByTree(rel) && !matches(rel, TREE_SWEEP_GAPS) && !DELETE_BY_NAME_PATHS.includes(rel));
    assert.deepStrictEqual(
      gaps,
      [],
      'these ship but no sweep can retire them — add the dir to OWNED_TREES, or to TREE_SWEEP_GAPS with a reason',
    );
  });

  test('every shipped file inside an owned tree is applied, so a sweep can never strand it', () => {
    // A file the sweep would prune but no apply list restores is a file users silently lose.
    const applied = [...MACHINERY_PATHS, ...GUARDRAIL_PATHS];
    const missing = shipped()
      .filter((rel) => inOwnedTree(rel) && !isExcluded(rel))
      .filter((rel) => !isUnder(rel, applied))
      .filter((rel) => !matches(rel, NOT_APPLIED));
    assert.deepStrictEqual(missing, [], 'add these to MACHINERY_PATHS / GUARDRAIL_PATHS, or to NOT_APPLIED with a reason');
  });

  // Only RETIRED_PATHS, not DELETE_BY_NAME_PATHS: the dev-repo-only files this repo legitimately
  // ships are the whole point of the DEV_ONLY_PATHS split, and applyPaths never re-adds them.
  test('RETIRED_PATHS never names a file the template still ships', () => {
    assert.deepStrictEqual(
      shipped().filter((rel) => RETIRED_PATHS.includes(rel)),
      [],
      'a retired path that still ships would be deleted and re-added on every upgrade',
    );
  });
});

describe('removeRetiredPaths (retired cross-cutting files)', () => {
  test('deletes retired files if present; reports them; leaves others; no-op when absent', () => {
    const p = tmp();
    write(p, '.github/workflows/sync-template.yml', 'old sync\n');
    write(p, '.templatesyncignore', 'old\n');
    write(p, '.github/workflows/quality-gates.yml', 'keep\n');

    const removed = removeRetiredPaths(p, DELETE_BY_NAME_PATHS);
    assert.deepStrictEqual(removed, ['.github/workflows/sync-template.yml', '.templatesyncignore']);
    assert.ok(!exists(p, '.github/workflows/sync-template.yml'), 'retired sync workflow deleted');
    assert.ok(!exists(p, '.templatesyncignore'), 'retired ignore file deleted');
    assert.ok(exists(p, '.github/workflows/quality-gates.yml'), 'unrelated workflow untouched');

    assert.deepStrictEqual(removeRetiredPaths(tmp(), DELETE_BY_NAME_PATHS), [], 'no-op when nothing retired');
  });

  // Same EISDIR hazard as the base diff: deleting by exact name, a project may have a DIRECTORY
  // at one of these paths (`scripts/parse-logs.ps1/` is unlikely, but nothing stops it, and an
  // uncaught throw here aborts a half-applied upgrade).
  test('steps over a retired path that is a directory instead of throwing', () => {
    const p = tmp();
    fs.mkdirSync(path.join(p, '.release-ignore'), { recursive: true });
    write(p, '.release-ignore/notes.md', 'mine\n');

    assert.deepStrictEqual(removeRetiredPaths(p, DELETE_BY_NAME_PATHS), []);
    assert.ok(exists(p, '.release-ignore/notes.md'), 'subtree intact');
  });

  // These reached user projects via the removed CI template-sync (it copied the whole dev
  // repo). Each one actively misbehaves in a user project — see the DEV_ONLY_PATHS comment.
  test('removes the dev-repo-only files that disable the guard or break CI', () => {
    const p = tmp();
    write(p, '.release-ignore', 'dev-repo sentinel — turns the TDD workflow guard off\n');
    write(p, '.github/workflows/pr-checks.yml', 'renamed to quality-gates.yml — double-runs\n');
    write(p, '.github/workflows/publish-template.yml', 'dev only\n');
    write(p, '.github/workflows/template-tests.yml', 'dev only — runs unshipped suites\n');
    write(p, 'scripts/parse-logs.ps1', 'retired session logging\n');

    const removed = removeRetiredPaths(p, DELETE_BY_NAME_PATHS);

    for (const rel of [
      '.release-ignore',
      '.github/workflows/pr-checks.yml',
      '.github/workflows/publish-template.yml',
      '.github/workflows/template-tests.yml',
      'scripts/parse-logs.ps1',
    ]) {
      assert.ok(removed.includes(rel), `${rel} reported`);
      assert.ok(!exists(p, rel), `${rel} deleted`);
    }
  });

  // This list deletes by exact name with no tracked check, so a filename a project might
  // plausibly author is a collision risk. The template ships a Dockerfile and invites
  // containerising, which makes docker-build.yml a name users really do write — and this repo's
  // own release tooling classes its docker-build.yml as dev-only, so adding it here is a live
  // temptation. Deleting a user's image-publish pipeline would be silent.
  test('leaves a plausibly user-authored workflow name alone', () => {
    const p = tmp();
    write(p, '.github/workflows/docker-build.yml', "the user's own image publish pipeline\n");

    assert.deepStrictEqual(removeRetiredPaths(p, DELETE_BY_NAME_PATHS), []);
    assert.ok(exists(p, '.github/workflows/docker-build.yml'));
  });
});

describe("buildReport (/upgrade's work list, and the source for the summary the user approves)", () => {
  // The required fields, in one place: every test here is about ONE of the optional ones, and a
  // per-test copy of this skeleton buried that and meant editing six tests to add a field.
  const reportArgs = (over = {}) => ({
    ref: 'v1.2.0',
    machinery: { added: [], updated: [] },
    guardrails: { added: [], updated: [] },
    retired: [],
    web: { added: [], review: [], pkg: { changed: false, added: {} } },
    ...over,
  });
  const pkgAdded = (added) => ({ added: [], review: [], pkg: { changed: true, added } });

  test('renders ref, sections, retired files, pkg additions, and the guardrail heading', () => {
    const report = buildReport(
      reportArgs({
        ref: 'v1.2.3',
        machinery: { added: ['.claude/commands/new.md'], updated: ['.claude/agents/dev.md'] },
        guardrails: { added: ['.claude/settings.json'], updated: [] },
        retired: ['.github/workflows/sync-template.yml'],
        web: {
          added: ['web/vitest.config.ts'],
          review: ['web/next.config.ts'],
          pkg: { changed: true, added: { dependencies: ['zod@^3'], devDependencies: [], scripts: [], fields: ['engines'] } },
        },
      }),
    );
    assert.match(report, /Brought template machinery up to date with `v1\.2\.3`/);
    assert.match(report, /\.claude\/commands\/new\.md/);
    assert.match(report, /sync-template\.yml/, 'retired file listed');
    assert.match(report, /dependencies: `zod@\^3`/, 'package.json additions listed');
    assert.match(report, /Guardrail files/, 'guardrail heading present');
    assert.match(report, /\.claude\/settings\.json/, 'guardrail file listed');
  });

  test('says which retirement sweeps ran, so a short list reads as "nothing to remove"', () => {
    assert.match(
      buildReport(reportArgs({ base: { ref: 'v1.0.0', available: true } })),
      /between `v1\.0\.0` and `v1\.2\.0`/,
    );
    assert.match(
      buildReport(reportArgs({ base: { ref: 'v1.0.0', available: false } })),
      /base version \(`v1\.0\.0`\) couldn't be read/,
      'unreadable base flagged',
    );
    assert.match(buildReport(reportArgs({ pruneRan: false })), /sweep skipped/, 'skip surfaced');
    // Markerless project: no base at all, so the sweep really was partial. Upgrading.md promises
    // the summary says so — silence here would read as a complete clean-up.
    assert.match(buildReport(reportArgs()), /no version marker to compare against/, 'markerless partial sweep flagged');
  });

  // The partial-sweep sentence reads its dir list off BASE_DIFF_ONLY_DIRS so the report can't
  // drift from the sweep. The prose match above would still pass if that interpolation were
  // dropped or hand-typed, which is how the two copies of this list drifted apart before.
  test('names every base-diff-only dir when the sweep was partial', () => {
    const report = buildReport(reportArgs());
    for (const dir of BASE_DIFF_ONLY_DIRS) {
      assert.ok(report.includes(`\`${dir}/\``), `${dir} named as not diffed`);
    }
  });

  // A deleted hook or workflow executes and governs permissions exactly as much as a changed
  // one, and the base→target diff is the first sweep that can delete them.
  test('surfaces retired GUARDRAIL files under the guardrail heading, not only as machinery', () => {
    const report = buildReport(
      reportArgs({ retired: ['.claude/hooks/retired-hook.ps1', '.github/workflows/pr-checks.yml', '.claude/scripts/old.js'] }),
    );
    const guardrailSection = report.slice(report.indexOf('## Guardrail files'));
    assert.match(guardrailSection, /REMOVED as retired/);
    assert.match(guardrailSection, /`\.claude\/hooks\/retired-hook\.ps1`/);
    assert.match(guardrailSection, /`\.github\/workflows\/pr-checks\.yml`/);
    assert.ok(!guardrailSection.includes('.claude/scripts/old.js'), 'plain machinery stays out of it');
  });

  test('lists the .gitignore entries it added, and that nothing existing moved', () => {
    const report = buildReport(reportArgs({ gitignore: { changed: true, added: ['/.claude/logs/'] } }));
    assert.match(report, /`\.gitignore` entries added \(1\)/);
    assert.match(report, /`\/\.claude\/logs\/`/);
    assert.match(report, /nothing already there was changed or reordered/);
  });

  test('lists override additions and confirms the lockfile was refreshed', () => {
    const report = buildReport(
      reportArgs({
        ref: 'v2.0.0',
        web: pkgAdded({ dependencies: [], devDependencies: [], scripts: [], overrides: ['sharp@^0.35.0'], fields: [] }),
        lockfile: { ran: true, ok: true },
      }),
    );
    assert.match(report, /overrides: `sharp@\^0\.35\.0`/, 'override additions listed');
    assert.match(report, /package-lock\.json` was refreshed/, 'confirms the auto-refresh');
  });

  test('warns loudly when the lockfile refresh failed (the fail-closed message)', () => {
    const report = buildReport(
      reportArgs({
        ref: 'v2.0.0',
        web: pkgAdded({ dependencies: ['zod@^3'], devDependencies: [], scripts: [], overrides: [], fields: [] }),
        lockfile: { ran: true, ok: false, error: 'offline' },
      }),
    );
    assert.match(report, /could NOT be refreshed automatically/, 'flags the desync');
    assert.match(report, /npm install/, 'tells the user the manual fix');
  });
});

describe('applyTemplate (tracked filter, real git repo)', () => {
  test('applies only git-tracked template files; skips untracked; handles non-ASCII names', () => {
    const t = tmp(), p = tmp();
    gitInit(t);

    write(t, '.claude/agents/dev.md', 'tracked\n');
    write(t, '.claude/agents/文档.md', 'cjk\n'); // >0x80 → git ls-files octal-quotes it without -z
    write(t, '.claude/agents/untracked.md', 'never added\n');
    git(t, 'add', '.claude/agents/dev.md', '.claude/agents/文档.md');

    const r = applyTemplate(t, p);

    assert.ok(exists(p, '.claude/agents/dev.md'), 'tracked file applied');
    assert.ok(exists(p, '.claude/agents/文档.md'), 'non-ASCII tracked file applied (ls-files -z / quotePath)');
    assert.ok(!exists(p, '.claude/agents/untracked.md'), 'untracked template file not applied');
    assert.ok(r.machinery.added.includes('.claude/agents/文档.md'), 'non-ASCII file reported as added');
  });
});
