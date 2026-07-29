#!/usr/bin/env node
/**
 * migrate-legacy-state.js
 * One-shot migrator for workflow-state.json files written by the pre-4-phase
 * workflow (commits before 6d6da27, ~2026-05-15). Maps legacy phase vocabulary
 * to the INTAKE / PLAN / BUILD / COMPLETE model, drops removed sub-objects,
 * and copies feature-requirements.md → project-brief.md.
 *
 * Usage:
 *   node .claude/scripts/migrate-legacy-state.js                # dry-run, prints diff JSON
 *   node .claude/scripts/migrate-legacy-state.js --apply        # write changes (backup is saved)
 *   node .claude/scripts/migrate-legacy-state.js --restore      # swap the backup back in
 *   node .claude/scripts/migrate-legacy-state.js --root <dir>   # operate on <dir> instead of CWD
 *
 * Output: JSON `{ status, changes, warnings, [migrated] }`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const helpers = require('./lib/workflow-helpers');
const { requireValue } = require('./resolve-state-path');
const { getProjectRoot } = require('./lib/project-root');

const STATE_REL = helpers.STATE_FILE;
const BACKUP_REL = 'generated-docs/context/workflow-state.legacy-backup.json';
const FRS_REL = 'generated-docs/specs/feature-requirements.md';
const BRIEF_REL = helpers.BRIEF_PATH;
const STORIES_DIR_REL = helpers.STORIES_DIR;

const TOP_LEVEL_PHASE_MAP = {
  'INTAKE': 'INTAKE',
  'DESIGN': 'PLAN',
  'SCOPE': 'PLAN',
  'STORIES': 'BUILD',
  'REALIGN': 'BUILD',
  'TEST-DESIGN': 'BUILD',
  'WRITE-TESTS': 'BUILD',
  'IMPLEMENT': 'BUILD',
  'QA': 'BUILD',
  'PHASE-BOUNDARY': 'BUILD',
  'COMPLETE': 'COMPLETE',
  'NONE': 'INTAKE'
};

const STORY_PHASE_MAP = {
  'COMPLETE': 'COMPLETE',
  'PENDING': 'PENDING',
  'REALIGN': 'PENDING',
  'TEST-DESIGN': 'PENDING',
  'WRITE-TESTS': 'PENDING',
  'IMPLEMENT': 'PENDING',
  'QA': 'PENDING'
};

const EPIC_PHASE_MAP = {
  'STORIES': 'PENDING',
  'PENDING': 'PENDING',
  'COMPLETE': 'COMPLETE'
};

// A phase is "legacy" if it maps to a different value than itself. Derived from
// the maps so the two never drift apart. Use an OWN-property check, not `in` /
// truthiness: `'toString' in map` is true via the prototype chain and `map['toString']`
// is a function — a corrupt phase value like that would otherwise be "detected" as
// legacy and then dropped by JSON.stringify, losing currentPhase entirely.
function isLegacyPhase(map, phase) {
  return Object.prototype.hasOwnProperty.call(map, phase) && map[phase] !== phase;
}

function mapPhase(map, value, defaultValue, label, warnings) {
  if (Object.prototype.hasOwnProperty.call(map, value)) return map[value];
  warnings.push(`${label}: unknown phase '${value}', defaulting to ${defaultValue}`);
  return defaultValue;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function countACFromFile(storyFilePath) {
  let content;
  try { content = fs.readFileSync(storyFilePath, 'utf-8'); } catch { return null; }
  const section = helpers.extractACSection(content);
  if (!section) return null;
  const checked = (section.text.match(/^\s*[-*] \[[xX]\]/gm) || []).length;
  const unchecked = (section.text.match(/^\s*[-*] \[ \]/gm) || []).length;
  if (checked + unchecked === 0) return null;
  return { total: checked + unchecked, checked };
}

// Scan the stories tree and the test-files dirs once up front, building lookup
// indexes the per-story migration consults. Avoids N+1 dir scans when many
// completed stories need on-disk evidence.
function buildEvidenceIndex(root) {
  const storyFiles = {};   // storyFiles[epicNum][storyNum] = absolutePath
  const testCounts = {};   // testCounts[`${epicNum}-${storyNum}`] = count

  const storiesDir = path.join(root, STORIES_DIR_REL);
  let epicDirs = [];
  try {
    epicDirs = fs.readdirSync(storiesDir, { withFileTypes: true })
      .filter(e => e.isDirectory());
  } catch { /* stories dir absent — no story-file evidence */ }
  for (const dirent of epicDirs) {
    const m = dirent.name.match(/^epic-(\d+)(?:[-_]|$)/);
    if (!m) continue;
    const epicNum = m[1];
    storyFiles[epicNum] = {};
    for (const s of helpers.findStoryFiles(path.join(storiesDir, dirent.name))) {
      storyFiles[epicNum][String(s.num)] = s.path;
    }
  }

  // Scan web/src/__tests__ ONCE, recursively — it already includes the integration/
  // subdir. (Listing __tests__/integration separately as well double-counted every
  // integration test: it surfaced once as `foo.test.tsx` and again as
  // `integration/foo.test.tsx` under the recursive __tests__ scan.)
  const testsDir = path.join(root, 'web/src/__tests__');
  let entries;
  try { entries = fs.readdirSync(testsDir, { recursive: true }); }
  catch { entries = []; }
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    if (!(entry.endsWith('.test.tsx') || entry.endsWith('.test.ts'))) continue;
    const m = entry.match(/epic-(\d+).*story-(\d+)/);
    if (!m) continue;
    const key = `${m[1]}-${m[2]}`;
    testCounts[key] = (testCounts[key] || 0) + 1;
  }

  return { storyFiles, testCounts };
}

function detectLegacy(state, root) {
  const reasons = [];
  if (state) {
    if (state.currentPhase && isLegacyPhase(TOP_LEVEL_PHASE_MAP, state.currentPhase)) {
      reasons.push(`currentPhase is legacy: ${state.currentPhase}`);
    }
    if (state.epics) {
      for (const [num, epic] of Object.entries(state.epics)) {
        if (epic?.phase && isLegacyPhase(EPIC_PHASE_MAP, epic.phase)) {
          reasons.push(`epic ${num} phase is legacy: ${epic.phase}`);
        }
        if (epic?.stories) {
          for (const [snum, story] of Object.entries(epic.stories)) {
            if (story?.phase && isLegacyPhase(STORY_PHASE_MAP, story.phase)) {
              reasons.push(`epic ${num} story ${snum} phase is legacy: ${story.phase}`);
            }
          }
        }
      }
    }
    if (state.design) reasons.push('top-level `design` block (removed in 4-phase model)');
    if (state.designArtifacts) reasons.push('top-level `designArtifacts` block (removed in 4-phase model)');
    if (state.intake && 'frsExists' in state.intake) reasons.push('intake.frsExists (renamed to briefExists)');
  }
  const frsExists = fs.existsSync(path.join(root, FRS_REL));
  const briefExists = fs.existsSync(path.join(root, BRIEF_REL));
  if (frsExists && !briefExists) reasons.push('feature-requirements.md exists, project-brief.md does not');
  return reasons;
}

function synthesizeAcceptance(out, evidence, epicNum, storyNum, warnings) {
  if (out.acceptance) return;
  const storyFile = evidence.storyFiles[epicNum]?.[storyNum] || null;
  const ac = storyFile ? countACFromFile(storyFile) : null;
  if (ac) {
    out.acceptance = ac;
  } else {
    warnings.push(`Epic ${epicNum} story ${storyNum}: completed but no acceptance criteria found in story file (or no story file). Leaving acceptance unset.`);
  }
}

function synthesizeTestFiles(out, evidence, epicNum, storyNum, warnings) {
  if (typeof out.testFiles === 'number') return;
  const count = evidence.testCounts[`${epicNum}-${storyNum}`] || 0;
  if (count > 0) {
    out.testFiles = count;
  } else {
    warnings.push(`Epic ${epicNum} story ${storyNum}: completed but no test files found on disk.`);
  }
}

function synthesizeCompletionStatus(out, field, value, epicNum, storyNum, warnings) {
  // Presence check, not truthiness: a present-but-falsy value (e.g. e2eStatus: '') is real
  // data and must be preserved, not overwritten with a synthesized one. Mirrors the
  // typeof-based guard in synthesizeTestFiles. `!= null` keeps '' / 0 / false; synthesizes
  // only when the field is genuinely absent (null/undefined).
  if (out[field] != null) return;
  out[field] = value;
  warnings.push(`Epic ${epicNum} story ${storyNum}: synthesized ${field}='${value}' (story was COMPLETE in legacy state).`);
}

function migrateStory(story, epicNum, storyNum, evidence, warnings) {
  const out = { ...story };
  if (story.phase) {
    out.phase = mapPhase(STORY_PHASE_MAP, story.phase, 'PENDING', `Epic ${epicNum} story ${storyNum}`, warnings);
  }

  // Completed stories must carry the fields the new schema expects; synthesize
  // what's missing from on-disk evidence (or warn if evidence is absent).
  if (out.phase === 'COMPLETE') {
    synthesizeAcceptance(out, evidence, epicNum, storyNum, warnings);
    synthesizeTestFiles(out, evidence, epicNum, storyNum, warnings);
    synthesizeCompletionStatus(out, 'e2eStatus', 'passed', epicNum, storyNum, warnings);
    synthesizeCompletionStatus(out, 'manualVerification', 'passed', epicNum, storyNum, warnings);
  }

  return out;
}

function migrateEpic(epic, epicNum, evidence, warnings) {
  const out = { ...epic };
  if (epic.phase) {
    out.phase = mapPhase(EPIC_PHASE_MAP, epic.phase, 'PENDING', `Epic ${epicNum}`, warnings);
  }
  if (epic.stories) {
    out.stories = {};
    for (const [snum, story] of Object.entries(epic.stories)) {
      out.stories[snum] = migrateStory(story, epicNum, snum, evidence, warnings);
    }
  }
  return out;
}

function migrateState(state, root, warnings) {
  if (!state) return null;
  const out = { ...state };

  const originalTop = state.currentPhase || 'NONE';
  out.currentPhase = mapPhase(TOP_LEVEL_PHASE_MAP, originalTop, 'INTAKE', 'Top-level currentPhase', warnings);

  if (state.epics) {
    const evidence = buildEvidenceIndex(root);
    out.epics = {};
    for (const [num, epic] of Object.entries(state.epics)) {
      out.epics[num] = migrateEpic(epic, num, evidence, warnings);
    }
  }

  if (state.design) {
    warnings.push('Dropped `design` block (multi-agent design phase removed in 4-phase model).');
    delete out.design;
  }
  if (state.designArtifacts) {
    warnings.push('Dropped `designArtifacts` block (not tracked in 4-phase model).');
    delete out.designArtifacts;
  }

  if (state.intake) {
    // Always copy intake — `out = { ...state }` is shallow, so without this the no-rename
    // branch left out.intake aliasing state.intake (a later mutation of one would corrupt
    // the other).
    out.intake = { ...state.intake };
    if ('frsExists' in out.intake) {
      out.intake.briefExists = out.intake.frsExists;
      delete out.intake.frsExists;
    }
  }

  out.featureComplete = state.featureComplete === true;

  out.migratedFromLegacyAt = new Date().toISOString();
  out.migrationNote = `Migrated from pre-4-phase workflow. Original currentPhase=${originalTop}.`;

  return out;
}

function buildBriefFromFrs(frsPath, briefPath) {
  const frsContent = fs.readFileSync(frsPath, 'utf-8');
  const today = new Date().toISOString().split('T')[0];
  const header = `<!-- Migrated from feature-requirements.md on ${today} by migrate-legacy-state.js -->\n\n`;
  fs.mkdirSync(path.dirname(briefPath), { recursive: true });
  fs.writeFileSync(briefPath, header + frsContent);
}

function planMigration(root) {
  const stateFile = path.join(root, STATE_REL);
  const frsFile = path.join(root, FRS_REL);
  const briefFile = path.join(root, BRIEF_REL);

  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch { /* state absent or unparseable — treated as no state */ }
  const stateExists = state !== null;
  const frsExists = fs.existsSync(frsFile);
  const briefExists = fs.existsSync(briefFile);

  if (!stateExists && !frsExists) {
    return { status: 'no_legacy', message: 'No workflow-state.json or feature-requirements.md found.', changes: [], warnings: [] };
  }

  const reasons = detectLegacy(state, root);
  if (reasons.length === 0) {
    return { status: 'no_migration_needed', message: 'State is already on the 4-phase model.', changes: [], warnings: [] };
  }

  const warnings = [];
  const migrated = stateExists ? migrateState(state, root, warnings) : null;
  const changes = [];
  if (stateExists) {
    changes.push({ kind: 'state-rewrite', file: STATE_REL, reasons });
  }
  if (frsExists && !briefExists) {
    changes.push({ kind: 'spec-copy', from: FRS_REL, to: BRIEF_REL });
  } else if (frsExists && briefExists) {
    warnings.push('Both feature-requirements.md and project-brief.md exist; leaving project-brief.md unchanged.');
  }

  return { status: 'legacy_detected', changes, warnings, migrated };
}

function applyMigration(root) {
  const plan = planMigration(root);
  if (plan.status !== 'legacy_detected') return plan;

  const stateFile = path.join(root, STATE_REL);
  const backupFile = path.join(root, BACKUP_REL);

  // Atomic, all-or-nothing apply. If a state rewrite is planned but a backup from a prior
  // run already exists, do NOTHING — not even the spec copy — and report 'skipped'. A partial
  // apply here would desync apply/restore: rewriting state would leave the stale first backup
  // as the only restore point, and copying the brief while skipping the state rewrite would
  // leave --restore reverting a snapshot that no longer matches and deleting a brief it didn't
  // create. The user must --restore first to re-migrate.
  const hasStateRewrite = plan.changes.some((c) => c.kind === 'state-rewrite');
  if (hasStateRewrite && fs.existsSync(backupFile)) {
    plan.warnings.push(`Backup ${BACKUP_REL} already exists — skipping migration to avoid overwriting it without a fresh backup. Run --restore first to re-migrate.`);
    return { status: 'skipped', reason: 'backup_exists', changes: [], warnings: plan.warnings, migrated: plan.migrated };
  }

  const appliedChanges = [];
  for (const change of plan.changes) {
    if (change.kind === 'state-rewrite') {
      fs.copyFileSync(stateFile, backupFile);
      writeJson(stateFile, plan.migrated);
      appliedChanges.push(change);
    } else if (change.kind === 'spec-copy') {
      buildBriefFromFrs(path.join(root, change.from), path.join(root, change.to));
      appliedChanges.push(change);
    }
  }

  return { status: 'applied', changes: appliedChanges, warnings: plan.warnings, migrated: plan.migrated };
}

function restoreMigration(root) {
  const stateFile = path.join(root, STATE_REL);
  const backupFile = path.join(root, BACKUP_REL);
  const briefFile = path.join(root, BRIEF_REL);

  if (!fs.existsSync(backupFile)) {
    return { status: 'no_backup', message: `No backup at ${BACKUP_REL}. Cannot restore.`, changes: [], warnings: [] };
  }

  const changes = [];
  const warnings = [];

  fs.copyFileSync(backupFile, stateFile);
  fs.unlinkSync(backupFile);
  changes.push({ kind: 'state-restore', file: STATE_REL });

  // Only remove project-brief.md if it still carries the migration header —
  // a user-edited brief should not be silently deleted on restore.
  if (fs.existsSync(briefFile)) {
    const content = fs.readFileSync(briefFile, 'utf-8');
    if (content.startsWith('<!-- Migrated from feature-requirements.md')) {
      fs.unlinkSync(briefFile);
      changes.push({ kind: 'brief-remove', file: BRIEF_REL });
    } else {
      warnings.push(`${BRIEF_REL} does not carry the migration header; leaving in place.`);
    }
  }

  return { status: 'restored', changes, warnings };
}

function parseArgs(argv) {
  const opts = { mode: 'plan', root: getProjectRoot() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') opts.mode = 'apply';
    else if (arg === '--restore') opts.mode = 'restore';
    else if (arg === '--root') { opts.root = path.resolve(requireValue(argv, ++i, '--root')); }
    else if (arg === '--help' || arg === '-h') opts.mode = 'help';
  }
  return opts;
}

function printUsage() {
  console.log(`migrate-legacy-state.js — migrate pre-4-phase workflow-state.json to the 4-phase model.

Usage:
  node .claude/scripts/migrate-legacy-state.js                # dry-run, prints planned changes
  node .claude/scripts/migrate-legacy-state.js --apply        # write changes (creates workflow-state.legacy-backup.json)
  node .claude/scripts/migrate-legacy-state.js --restore      # swap the backup back in
  node .claude/scripts/migrate-legacy-state.js --root <dir>   # operate on <dir> instead of CWD

Phase mapping:
  INTAKE                                                       → INTAKE
  DESIGN, SCOPE                                                → PLAN
  STORIES, REALIGN, TEST-DESIGN, WRITE-TESTS, IMPLEMENT, QA    → BUILD
  PHASE-BOUNDARY                                               → BUILD
  COMPLETE                                                     → COMPLETE
`);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    // Keep stdout valid JSON — /migrate-legacy parses it — instead of leaking a stack trace.
    console.log(JSON.stringify({ status: 'error', message: err.message, changes: [], warnings: [] }, null, 2));
    process.exit(2);
  }
  if (opts.mode === 'help') { printUsage(); return; }

  let result;
  if (opts.mode === 'apply') result = applyMigration(opts.root);
  else if (opts.mode === 'restore') result = restoreMigration(opts.root);
  else result = planMigration(opts.root);

  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'no_backup') process.exit(1);
}

main();
