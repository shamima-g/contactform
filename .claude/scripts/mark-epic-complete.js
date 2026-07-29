#!/usr/bin/env node
/**
 * mark-epic-complete.js
 *
 * Final-state transition for the epic-branch workflow: flips
 * generated-docs/epics/<slug>/state.json from COMPLETE-ON-BRANCH to COMPLETE
 * and stamps lastUpdated. Invoked from `/continue` Step B7.2.6 on main after
 * the epic PR has merged.
 *
 * The Edit tool's file-tracking does not survive branch switches reliably,
 * which is why this is a dedicated CLI rather than an inline Edit.
 *
 * Output: JSON `{ status, [path], [phase], [message] }` on stdout — same
 * contract as epic-state.js / resolve-state-path.js so the orchestrator can
 * check `status: ok` before proceeding (see agents/README.md, orchestrator-rules.md).
 *
 * Usage:
 *   node .claude/scripts/mark-epic-complete.js --slug <slug> [--root <dir>]
 */
'use strict';

const fs = require('fs');
const path = require('path');
// Reuse the epic-branch state layout, slug validation, AND arg-value guard from their single
// source of truth rather than re-hardcoding 'generated-docs/epics/<slug>/state.json',
// re-implementing the kebab-case check, or copy-pasting requireValue here.
const { EPICS_DIR_REL, isValidEpicSlug, requireValue } = require('./resolve-state-path');
const { getProjectRoot } = require('./lib/project-root');

function parseArgs(argv) {
  const args = { slug: null, root: getProjectRoot() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slug') args.slug = requireValue(argv, ++i, '--slug');
    else if (a === '--root') args.root = path.resolve(requireValue(argv, ++i, '--root'));
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
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

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(err.message); process.exit(2); }

  if (args.help || !args.slug) {
    console.log('Usage: node .claude/scripts/mark-epic-complete.js --slug <slug> [--root <dir>]');
    process.exit(args.help ? 0 : 2);
  }

  // Reject anything that isn't a kebab-case slug before it reaches path.join — a value like
  // "../../foo" would otherwise resolve outside generated-docs/epics. resolve-state-path
  // applies the same guard when deriving the slug from the branch name.
  if (!isValidEpicSlug(args.slug)) {
    return emitError(`Invalid epic slug "${args.slug}" — expected kebab-case (the slug in the epic/<slug> branch name).`);
  }

  const rel = path.join(EPICS_DIR_REL, args.slug, 'state.json');
  const file = path.join(args.root, EPICS_DIR_REL, args.slug, 'state.json');

  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return emitError(`No state.json at ${rel}. Check the --slug value and that the epic dir is on this branch.`);
    }
    return emitError(`Could not read/parse ${rel}: ${err.message}`);
  }

  // Idempotent: a re-run after a partial/recovered completion shouldn't error.
  if (state.phase === 'COMPLETE') {
    return emit({
      status: 'ok',
      slug: args.slug,
      phase: 'COMPLETE',
      path: rel.split(path.sep).join('/'),
      note: 'already complete',
    });
  }

  // Accept any phase from EPIC-END onward as a valid forward transition. The
  // ideal merged tip reads COMPLETE-ON-BRANCH, but if the branch's
  // EPIC-END -> MANUAL-TEST -> COMPLETE-ON-BRANCH state edits weren't committed
  // before the merge, the tip can legitimately read EPIC-END or MANUAL-TEST.
  // Finalising from there is still correct (the epic has merged); PLAN/BUILD
  // are too early and stay rejected.
  const READY_PHASES = ['EPIC-END', 'MANUAL-TEST', 'COMPLETE-ON-BRANCH'];
  if (!READY_PHASES.includes(state.phase)) {
    return emitError(
      `Refusing to mark complete: state.phase is "${state.phase}", expected one of ${READY_PHASES.join(', ')} (the epic must have reached at least EPIC-END).`,
      { phase: state.phase ?? null }
    );
  }

  state.phase = 'COMPLETE';
  state.lastUpdated = new Date().toISOString();
  // Atomic write: serialise to a temp file in the same directory, then rename over the
  // target. rename(2) is atomic on a single filesystem, so an interruption (crash, kill,
  // full disk) leaves the original state.json intact rather than a truncated/half-written
  // file — this runs on main right after the epic PR merges, so a torn write would corrupt
  // the merged-history state with no recovery copy.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file);
  emit({ status: 'ok', slug: args.slug, phase: 'COMPLETE', path: rel.split(path.sep).join('/') });
}

main();
