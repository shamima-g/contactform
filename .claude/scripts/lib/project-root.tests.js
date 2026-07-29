#!/usr/bin/env node
/**
 * Tests for lib/project-root.js — the CWD-independent repo-root resolver.
 *
 * The walk-up cases build a throwaway directory tree under a tmp root and assert
 * which ancestor getProjectRoot() stops at; they're fully isolated because the
 * marker is always found inside the tmp tree before the walk escapes to the OS
 * temp dir. The default-arg case asserts the real anchor: getProjectRoot()
 * resolves to this repo's root (the dir three levels up from this file, which
 * holds .claude).
 *
 * Usage:
 *   node .claude/scripts/lib/project-root.tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { getProjectRoot } = require('./project-root');
const { test, assert, assertEqual, summary } = require('./test-harness');

const tmp = (name, fn) => test(name, fn, { tmpDir: 'project-root-' });

// =============================================================================
// DEFAULT ANCHOR (no argument → this file's location)
// =============================================================================

console.log('\nDefault anchor:');

test('getProjectRoot() returns the repo root that contains .claude', () => {
  // This test file sits at <root>/.claude/scripts/lib, the same dir as
  // project-root.js, so three levels up is the repo root by construction.
  const expected = path.resolve(__dirname, '..', '..', '..');
  const root = getProjectRoot();
  assertEqual(root, expected, 'repo root');
  assert(path.isAbsolute(root), 'absolute path');
  assert(fs.existsSync(path.join(root, '.claude')), '.claude exists at the returned root');
});

// =============================================================================
// WALK-UP TO THE NEAREST MARKER
// =============================================================================

console.log('\nWalk-up resolution:');

tmp('walks up to the nearest ancestor containing .claude', (root) => {
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  const start = path.join(root, 'a', 'b', 'c');
  fs.mkdirSync(start, { recursive: true });
  assertEqual(getProjectRoot(start), path.resolve(root), 'found via .claude');
});

tmp('recognises .git as a fallback marker', (root) => {
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const start = path.join(root, 'x', 'y');
  fs.mkdirSync(start, { recursive: true });
  assertEqual(getProjectRoot(start), path.resolve(root), 'found via .git');
});

tmp('recognises .git when it is a file (git worktree layout)', (root) => {
  // Worktrees and submodules use a .git FILE, not a directory; existsSync
  // matches both, so the worktree root still resolves correctly.
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
  const start = path.join(root, 'pkg');
  fs.mkdirSync(start, { recursive: true });
  assertEqual(getProjectRoot(start), path.resolve(root), 'worktree .git file found');
});

tmp('stops at the nearest marker, not a farther one (nested-repo safety)', (root) => {
  // Outer marker at <root>/.git, inner marker at <root>/inner/.claude.
  // Starting below inner must resolve to inner — never overshoot to the outer.
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'inner', '.claude'), { recursive: true });
  const start = path.join(root, 'inner', 'sub', 'deep');
  fs.mkdirSync(start, { recursive: true });
  assertEqual(getProjectRoot(start), path.resolve(root, 'inner'), 'nearest marker wins');
});

tmp('returns the start dir itself when it holds the marker', (root) => {
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  assertEqual(getProjectRoot(root), path.resolve(root), 'marker at start dir');
});

summary();
