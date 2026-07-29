#!/usr/bin/env node
/**
 * epic-state.js
 *
 * Tiny CLI for initialising a per-epic state.json. The only consumer is the
 * orchestrator (Claude) at branch-creation time — every other interaction with
 * state.json is a direct read/edit by Claude following documented rules.
 *
 *   --init --name "<Epic Name>" [--depends-on <slug>...]  initialise state.json
 *
 * Global flags:
 *   --root <dir>      operate on <dir> instead of CWD
 *   --branch <name>   override git branch detection (used by tests)
 *
 * Output: JSON `{ status, [state], [error] }` on stdout.
 *
 * For state inspection, read the file directly:
 *   cat generated-docs/epics/<slug>/state.json
 */
'use strict';

const fs = require('fs');
const path = require('path');

const epicState = require('./lib/epic-state');
const { resolveStatePath, requireValue } = require('./resolve-state-path');
const { getProjectRoot } = require('./lib/project-root');

function parseArgs(argv) {
  const args = { root: getProjectRoot(), branch: null, command: null, name: null, dependsOn: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--root': args.root = path.resolve(requireValue(argv, ++i, '--root')); break;
      case '--branch': args.branch = requireValue(argv, ++i, '--branch'); break;
      case '--init': args.command = 'init'; break;
      case '--name': args.name = requireValue(argv, ++i, '--name'); break;
      case '--depends-on': args.dependsOn.push(requireValue(argv, ++i, '--depends-on')); break;
      case '--help':
      case '-h': args.help = true; break;
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function emit(payload, exitCode = 0) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(exitCode);
}

function emitError(message, extras = {}) {
  emit({ status: 'error', message, ...extras }, 1);
}

function resolveOrFail({ root, branch }) {
  const resolution = resolveStatePath({ root, branch });
  if (resolution.status !== 'ok') emitError(resolution.error || 'state path resolution failed');
  if (resolution.kind !== 'epic') {
    emitError(
      `epic-state.js requires an epic/* branch. Current resolution: kind=${resolution.kind}, branch=${resolution.branch ?? 'null'}`,
      { resolution }
    );
  }
  return resolution;
}

function cmdInit(args, resolution) {
  if (!args.name) emitError('--init requires --name "<Epic Name>"');
  const state = epicState.defaultEpicState({
    slug: resolution.slug,
    name: args.name,
    dependsOn: args.dependsOn
  });
  fs.mkdirSync(path.dirname(resolution.absolutePath), { recursive: true });
  try {
    fs.writeFileSync(resolution.absolutePath, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') {
      emitError(`state.json already exists at ${resolution.path}. Refusing to overwrite.`);
    }
    throw err;
  }
  emit({ status: 'initialised', path: resolution.path, state });
}

function printHelp() {
  console.log('Usage: node .claude/scripts/epic-state.js --init --name "<name>" [--depends-on <slug>...]');
  console.log('       [--root <dir>] [--branch <name>]');
  console.log('');
  console.log('Initialises generated-docs/epics/<slug>/state.json on the current epic/* branch.');
  console.log('All other state operations (transitions, story updates, halts) are performed by');
  console.log('the orchestrator via the Edit tool. The phase enum and transition');
  console.log('graph are defined in .claude/scripts/lib/epic-state.js.');
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(err.message); process.exit(2); }
  if (args.help || !args.command) {
    printHelp();
    process.exit(args.help ? 0 : 2);
  }
  const resolution = resolveOrFail({ root: args.root, branch: args.branch });
  if (args.command === 'init') return cmdInit(args, resolution);
  emitError(`Unknown command: ${args.command}`);
}

main();
