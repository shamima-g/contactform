#!/usr/bin/env node
/**
 * Tests for enforce-generated-doc-names.js — focused on the write-location
 * guard that blocks the canonical artifact dirs (generated-docs/, .claude/)
 * from being nested under web/ (the CWD-drift bug).
 *
 * Each case spawns the hook as a child process with synthetic stdin JSON and a
 * fixed CLAUDE_PROJECT_DIR (a tmp dir with no conventions schema), so every
 * non-guard path fails open at the schema load and the guard's behaviour is
 * isolated from the filename-convention logic.
 *
 * Usage:
 *   node .claude/hooks/enforce-generated-doc-names.tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { test, assert, assertEqual, summary } = require('../scripts/lib/test-harness');

const hookPath = path.join(__dirname, 'enforce-generated-doc-names.js');

/** Run the hook with the given tool input under projectRoot; return {exitCode, stderr}. */
function runHook({ toolName = 'Write', filePath }, projectRoot) {
  const input = JSON.stringify({ tool_name: toolName, tool_input: { file_path: filePath } });
  try {
    execFileSync('node', [hookPath], {
      input,
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
    });
    return { exitCode: 0, stderr: '' };
  } catch (err) {
    return { exitCode: err.status ?? 1, stderr: (err.stderr ?? '').toString() };
  }
}

const guard = (name, fn) => test(name, fn, { tmpDir: 'enforce-guard-' });

// =============================================================================
// BLOCKED — canonical dirs nested under web/
// =============================================================================

console.log('\nWrite-location guard — blocks:');

guard('blocks web/generated-docs/<file> (relative path)', (root) => {
  const r = runHook({ filePath: 'web/generated-docs/plan.md' }, root);
  assertEqual(r.exitCode, 2, 'exit 2 (block)');
  assert(r.stderr.includes('write-location guard'), 'cites the guard');
  assert(r.stderr.includes('generated-docs/plan.md'), 'suggests the repo-root path');
});

guard('blocks web/.claude/<file>', (root) => {
  const r = runHook({ filePath: 'web/.claude/settings.local.json' }, root);
  assertEqual(r.exitCode, 2, 'exit 2 (block)');
});

guard('blocks an absolute path that resolves under web/generated-docs/', (root) => {
  const abs = path.join(root, 'web', 'generated-docs', 'epics', 'x', 'state.json');
  const r = runHook({ filePath: abs }, root);
  assertEqual(r.exitCode, 2, 'exit 2 (block)');
});

// =============================================================================
// ALLOWED — correct locations and near-misses (no false positives)
// =============================================================================

console.log('\nWrite-location guard — allows:');

guard('allows generated-docs/<file> at the repo root', (root) => {
  // No conventions schema in the tmp root → fails open after the guard passes.
  assertEqual(runHook({ filePath: 'generated-docs/plan.md' }, root).exitCode, 0, 'not blocked');
});

guard('allows web/src/ files (mock factories live here, not blocked)', (root) => {
  assertEqual(runHook({ filePath: 'web/src/mocks/data/transaction.ts' }, root).exitCode, 0, 'not blocked');
});

guard('does not block a near-miss prefix like web/generated-docs-helper/', (root) => {
  // The regex is anchored on a trailing slash, so "generated-docs-helper" is safe.
  assertEqual(runHook({ filePath: 'web/generated-docs-helper/x.ts' }, root).exitCode, 0, 'not blocked');
});

guard('falls through for non-gated tools (Read)', (root) => {
  assertEqual(runHook({ toolName: 'Read', filePath: 'web/generated-docs/plan.md' }, root).exitCode, 0, 'not gated');
});

summary();
