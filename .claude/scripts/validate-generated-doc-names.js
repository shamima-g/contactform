#!/usr/bin/env node
/**
 * Repo-wide validator for AI-generated-document filenames.
 *
 * Walks generated-docs/ and web/e2e/, matches each file against the
 * conventions in .claude/shared/generated-doc-conventions.json.
 *
 * Classification (see schema.matching.description):
 *   OK        — filename matches a convention's filenamePattern in its dirGlob.
 *   DRIFT     — filename matches a convention's badPattern but NOT its filenamePattern.
 *   UNGOVERNED — neither; not a governed doc type.
 *
 * Usage:
 *   node .claude/scripts/validate-generated-doc-names.js           # --check (default)
 *   node .claude/scripts/validate-generated-doc-names.js --verbose
 *   node .claude/scripts/validate-generated-doc-names.js --format=json
 *
 * Exit codes:
 *   0 — no drift.
 *   1 — one or more files are DRIFT.
 *   2 — schema file missing or malformed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('./lib/project-root');

const args = new Set(process.argv.slice(2));
const verbose = args.has('--verbose');
const jsonOutput = [...args].some(a => a === '--format=json');

const projectRoot = process.env.CLAUDE_PROJECT_DIR || getProjectRoot();

function normalize(p) { return p.replace(/\\/g, '/'); }

function dirGlobToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  const trimmed = escaped.replace(/\/$/, '');
  return new RegExp('^' + trimmed + '/?$');
}

// --- Load schema -----------------------------------------------------------
const schemaPath = path.join(projectRoot, '.claude', 'shared', 'generated-doc-conventions.json');
let schema;
try {
  schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
} catch (err) {
  process.stderr.write(`Cannot read schema at ${schemaPath}: ${err.message}\n`);
  process.exit(2);
}

const conventions = schema.conventions || [];
if (conventions.length === 0) {
  process.stderr.write(`Schema has no conventions to check.\n`);
  process.exit(2);
}

// --- Walk governed subtrees ------------------------------------------------
const GOVERNED_ROOTS = ['generated-docs', 'web/e2e'];

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

const files = [];
for (const root of GOVERNED_ROOTS) {
  const abs = path.join(projectRoot, root);
  if (!fs.existsSync(abs)) continue;
  for (const f of walk(abs)) files.push(f);
}

// --- Classify each file ----------------------------------------------------
const results = [];
for (const abs of files) {
  const rel = normalize(path.relative(projectRoot, abs));
  const parentDir = normalize(path.dirname(rel)) + '/';
  const basename = path.basename(rel);

  let matchedConvention = null;
  let driftMatches = [];

  for (const c of conventions) {
    if (!dirGlobToRegex(c.dirGlob).test(parentDir)) continue;
    if (new RegExp(c.filenamePattern).test(basename)) {
      matchedConvention = c;
      break;
    }
    if (c.badPattern && new RegExp(c.badPattern).test(basename)) {
      driftMatches.push(c);
    }
  }

  if (matchedConvention) {
    results.push({ path: rel, status: 'ok', convention: matchedConvention.id });
  } else if (driftMatches.length > 0) {
    results.push({
      path: rel,
      status: 'drift',
      expectedConventions: driftMatches.map(c => ({
        id: c.id,
        filenamePattern: c.filenamePattern,
        example: c.example,
        counterexample: c.counterexample,
        rationale: c.rationale,
      })),
    });
  } else {
    results.push({ path: rel, status: 'ungoverned' });
  }
}

// --- Report ----------------------------------------------------------------
const drift = results.filter(r => r.status === 'drift');
const ok = results.filter(r => r.status === 'ok');
const ungoverned = results.filter(r => r.status === 'ungoverned');

if (jsonOutput) {
  process.stdout.write(JSON.stringify({
    status: drift.length === 0 ? 'ok' : 'drift',
    counts: { ok: ok.length, drift: drift.length, ungoverned: ungoverned.length },
    drift,
    ok: verbose ? ok : undefined,
    ungoverned: verbose ? ungoverned : undefined,
  }, null, 2) + '\n');
  process.exit(drift.length === 0 ? 0 : 1);
}

if (drift.length === 0) {
  process.stdout.write(`Clean: ${ok.length} governed file(s) match their conventions.`);
  if (ungoverned.length) process.stdout.write(` (${ungoverned.length} ungoverned.)`);
  process.stdout.write('\n');
  if (verbose) {
    if (ok.length) {
      process.stdout.write('\nGoverned files:\n');
      for (const r of ok) process.stdout.write(`  [${r.convention}] ${r.path}\n`);
    }
    if (ungoverned.length) {
      process.stdout.write('\nUngoverned files (no dirGlob + pattern match; not a governed doc type):\n');
      for (const r of ungoverned) process.stdout.write(`  ${r.path}\n`);
    }
  }
  process.exit(0);
}

process.stdout.write(`Drift detected: ${drift.length} file(s) violate filename conventions.\n`);
process.stdout.write(`  Clean: ${ok.length}   Drift: ${drift.length}   Ungoverned: ${ungoverned.length}\n\n`);
for (const r of drift) {
  process.stdout.write(`  ${r.path}\n`);
  for (const c of r.expectedConventions) {
    process.stdout.write(`    [${c.id}] expected: ${c.filenamePattern}\n`);
    process.stdout.write(`      good: ${c.example}\n`);
    process.stdout.write(`      bad:  ${c.counterexample}\n`);
  }
  process.stdout.write('\n');
}
process.stdout.write('See .claude/shared/naming-conventions.md for the full rule table.\n');
process.exit(1);
