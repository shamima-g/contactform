#!/usr/bin/env node
/**
 * Tests for epic-state.js CLI.
 *
 * Only `--init` is tested — that's the sole CLI command. Mutations and
 * inspections are performed by the orchestrator (Claude) directly.
 *
 * Usage:
 *   node .claude/scripts/epic-state.tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const harness = require('./lib/test-harness');
const { assert, assertEqual, summary } = harness;

const scriptPath = path.join(__dirname, 'epic-state.js');

function run(args) {
  try {
    const stdout = execFileSync('node', [scriptPath, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, exitCode: 0, stdout };
  } catch (err) {
    return { ok: false, exitCode: err.status ?? 1, stderr: (err.stderr ?? '').toString(), stdout: (err.stdout ?? '').toString() };
  }
}

function runJson(args) {
  const r = run(args);
  try { return { ...r, data: r.stdout ? JSON.parse(r.stdout) : null }; }
  catch { return r; }
}

const test = (name, fn) => harness.test(name, fn, { tmpDir: 'epic-state-cli-' });

function readStateFile(root, slug) {
  return JSON.parse(fs.readFileSync(path.join(root, 'generated-docs', 'epics', slug, 'state.json'), 'utf8'));
}

console.log('\nInit:');

test('--init creates state.json with default shape', (root) => {
  const r = runJson(['--root', root, '--branch', 'epic/foo', '--init', '--name', 'Foo Epic']);
  assertEqual(r.exitCode, 0, `exit (stderr=${r.stderr})`);
  assertEqual(r.data.status, 'initialised', 'status');
  const state = readStateFile(root, 'foo');
  assertEqual(state.epic.slug, 'foo', 'slug');
  assertEqual(state.epic.name, 'Foo Epic', 'name');
  assertEqual(state.phase, 'PLAN', 'phase');
  assert(!('currentStory' in state), 'no currentStory field');
});

test('--init with --depends-on populates dependencies', (root) => {
  const r = runJson(['--root', root, '--branch', 'epic/b', '--init', '--name', 'B', '--depends-on', 'a', '--depends-on', 'x']);
  assertEqual(r.exitCode, 0, 'exit');
  const state = readStateFile(root, 'b');
  assert(state.epic.dependsOn.includes('a'), 'has a');
  assert(state.epic.dependsOn.includes('x'), 'has x');
});

test('--init refuses to overwrite existing state.json', (root) => {
  const file = path.join(root, 'generated-docs', 'epics', 'foo', 'state.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}');
  const r = runJson(['--root', root, '--branch', 'epic/foo', '--init', '--name', 'Foo']);
  assertEqual(r.exitCode, 1, 'exit');
  assert(r.data.message.includes('already exists'), 'error message');
});

test('--init requires --name', (root) => {
  const r = runJson(['--root', root, '--branch', 'epic/foo', '--init']);
  assertEqual(r.exitCode, 1, 'exit');
  assert(r.data.message.includes('--name'), 'message');
});

test('--init fails outside an epic/* branch', (root) => {
  const r = runJson(['--root', root, '--branch', 'main', '--init', '--name', 'Foo']);
  assertEqual(r.exitCode, 1, 'exit');
  assert(r.data.message.includes('epic/* branch'), 'message');
});

summary();
