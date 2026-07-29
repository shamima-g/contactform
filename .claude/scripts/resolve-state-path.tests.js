#!/usr/bin/env node
/**
 * Tests for resolve-state-path.js.
 *
 * Most tests use the `--branch` override so we don't need a real git repo per
 * case. One test exercises real `git symbolic-ref` to confirm the production
 * detection path still works end to end.
 *
 * Usage:
 *   node .claude/scripts/resolve-state-path.tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const harness = require('./lib/test-harness');
const { assert, assertEqual, summary } = harness;

const scriptPath = path.join(__dirname, 'resolve-state-path.js');
const lib = require('./resolve-state-path');

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function run(args) {
  try {
    const output = execFileSync('node', [scriptPath, ...args], {
      encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe']
    });
    return { ok: true, exitCode: 0, stdout: output };
  } catch (err) {
    return {
      ok: false, exitCode: err.status ?? 1,
      stderr: (err.stderr ?? '').toString(), stdout: (err.stdout ?? '').toString()
    };
  }
}

function runJson(args) {
  const r = run(args);
  if (!r.ok) return r;
  try { return { ok: true, data: JSON.parse(r.stdout) }; }
  catch (err) { return { ok: false, parseError: err.message, raw: r.stdout }; }
}

const test = (name, fn) => harness.test(name, fn, { tmpDir: 'resolve-state-' });

// =============================================================================
// EPIC BRANCH RESOLUTION
// =============================================================================

console.log('\nEpic branch resolution:');

test('on epic/<slug> branch returns epic path', (root) => {
  const result = runJson(['--root', root, '--branch', 'epic/dashboard-overview']);
  assert(result.ok, `failed: ${JSON.stringify(result)}`);
  assertEqual(result.data.kind, 'epic', 'kind');
  assertEqual(result.data.slug, 'dashboard-overview', 'slug');
  assertEqual(result.data.path, 'generated-docs/epics/dashboard-overview/state.json', 'path');
  assertEqual(result.data.exists, false, 'file should not exist yet');
});

test('on epic/<slug> branch with existing state.json reports exists:true', (root) => {
  writeFile(root, 'generated-docs/epics/payments-screen/state.json', '{"phase":"BUILD"}');
  const result = runJson(['--root', root, '--branch', 'epic/payments-screen']);
  assertEqual(result.data.exists, true, 'exists');
});

test('multi-segment slug (kebab-case with hyphens) is accepted', (root) => {
  const result = runJson(['--root', root, '--branch', 'epic/csv-export-shared-nav']);
  assertEqual(result.data.slug, 'csv-export-shared-nav', 'slug');
});

test('slug starting with a digit is accepted', (root) => {
  const result = runJson(['--root', root, '--branch', 'epic/2fa-rollout']);
  assertEqual(result.data.slug, '2fa-rollout', 'slug');
});

// =============================================================================
// NON-EPIC BRANCHES RETURN kind:none
// =============================================================================

console.log('\nNon-epic branches:');

test('on main returns kind:none (no legacy fallback)', (root) => {
  const result = runJson(['--root', root, '--branch', 'main']);
  assertEqual(result.data.kind, 'none', 'kind');
  assertEqual(result.data.path, null, 'path');
});

test('on a non-epic branch returns kind:none even when legacy state file exists', (root) => {
  // Legacy state from a pre-migration project — resolver does not surface it.
  // The /start command's legacy detection routes such projects to /migrate-legacy.
  writeFile(root, 'generated-docs/context/workflow-state.json', '{"currentPhase":"BUILD"}');
  const result = runJson(['--root', root, '--branch', 'fresh-workflow-spike']);
  assertEqual(result.data.kind, 'none', 'kind');
  assertEqual(result.data.path, null, 'path');
});

// =============================================================================
// INVALID INPUT
// =============================================================================

console.log('\nInvalid input:');

test('branch name "epic/" (empty slug) returns error', (root) => {
  const r = run(['--root', root, '--branch', 'epic/']);
  assertEqual(r.exitCode, 1, 'exit code');
  const data = JSON.parse(r.stdout);
  assertEqual(data.status, 'error', 'status');
  assert(data.error.includes('Invalid epic slug'), `error message: ${data.error}`);
});

test('branch name "epic/BadCase" (uppercase) returns error', (root) => {
  const r = run(['--root', root, '--branch', 'epic/BadCase']);
  assertEqual(r.exitCode, 1, 'exit code');
});

test('branch name "epic/with_underscore" returns error', (root) => {
  const r = run(['--root', root, '--branch', 'epic/with_underscore']);
  assertEqual(r.exitCode, 1, 'exit code');
});

test('unknown CLI argument exits with code 2', (root) => {
  const r = run(['--root', root, '--bogus']);
  assertEqual(r.exitCode, 2, 'exit code');
  assert(r.stderr.includes('Unknown argument'), 'error message');
});

// =============================================================================
// OUTPUT
// =============================================================================

console.log('\nOutput:');

test('default output is JSON with absolutePath populated', (root) => {
  const result = runJson(['--root', root, '--branch', 'epic/x']);
  assert(result.data.absolutePath, 'absolutePath set');
  assert(result.data.absolutePath.endsWith(path.join('generated-docs', 'epics', 'x', 'state.json')),
    `absolutePath shape: ${result.data.absolutePath}`);
});

test('--help exits 0 and prints usage', () => {
  const r = run(['--help']);
  assertEqual(r.exitCode, 0, 'exit code');
  assert(r.stdout.includes('Usage'), 'help text');
});

// =============================================================================
// GIT INTEGRATION
// =============================================================================

console.log('\nGit integration:');

test('detects current branch via git when --branch is omitted', (root) => {
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false'], { stdio: 'ignore' });
  writeFile(root, 'README.md', '# test\n');
  execFileSync('git', ['-C', root, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'init'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'epic/realgit-test'], { stdio: 'ignore' });

  const result = runJson(['--root', root]);
  assertEqual(result.data.kind, 'epic', 'kind');
  assertEqual(result.data.slug, 'realgit-test', 'slug');
});

test('outside any git repo returns kind:none', (root) => {
  const result = runJson(['--root', root]);
  assertEqual(result.data.kind, 'none', 'kind');
  assertEqual(result.data.branch, null, 'branch');
});

// =============================================================================
// LIBRARY API
// =============================================================================

console.log('\nLibrary API:');

test('isValidEpicSlug accepts kebab-case and rejects bad input', () => {
  assert(lib.isValidEpicSlug('dashboard'), 'simple');
  assert(lib.isValidEpicSlug('dashboard-overview'), 'kebab-case');
  assert(lib.isValidEpicSlug('2fa-rollout'), 'leading digit');
  assert(!lib.isValidEpicSlug(''), 'empty rejected');
  assert(!lib.isValidEpicSlug('BadCase'), 'uppercase rejected');
  assert(!lib.isValidEpicSlug('with_underscore'), 'underscore rejected');
  assert(!lib.isValidEpicSlug('-leading-hyphen'), 'leading hyphen rejected');
});

test('resolveStatePath as a library call with explicit branch', (root) => {
  const result = lib.resolveStatePath({ root, branch: 'epic/lib-test' });
  assertEqual(result.kind, 'epic', 'kind');
  assertEqual(result.slug, 'lib-test', 'slug');
});

// =============================================================================
// SUMMARY
// =============================================================================

summary();
