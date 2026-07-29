#!/usr/bin/env node
/**
 * Tests for migrate-legacy-state.js.
 *
 * Uses the four real workflow-state.json files captured from the stadium-8
 * test repos as fixtures, plus synthetic edge-case fixtures created inline.
 *
 * Usage:
 *   node .claude/scripts/migrate-legacy-state.tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const harness = require('./lib/test-harness');
const { assert, assertEqual, summary } = harness;

const scriptPath = path.join(__dirname, 'migrate-legacy-state.js');
const fixturesDir = path.join(__dirname, '__fixtures__', 'legacy');

// =============================================================================
// HELPERS
// =============================================================================

function seedLegacyDirs(root) {
  fs.mkdirSync(path.join(root, 'generated-docs', 'context'), { recursive: true });
  fs.mkdirSync(path.join(root, 'generated-docs', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'generated-docs', 'stories'), { recursive: true });
}

function copyFixtureState(fixtureName, root) {
  fs.copyFileSync(
    path.join(fixturesDir, fixtureName),
    path.join(root, 'generated-docs', 'context', 'workflow-state.json')
  );
}

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function readState(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'generated-docs', 'context', 'workflow-state.json'), 'utf-8'));
}

function run(args) {
  try {
    const output = execFileSync('node', [scriptPath, ...args], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { ok: true, data: JSON.parse(output) };
  } catch (err) {
    return { ok: false, exitCode: err.status ?? 1, stderr: (err.stderr ?? '').toString(), stdout: (err.stdout ?? '').toString() };
  }
}

const test = (name, fn) => harness.test(name, (root) => { seedLegacyDirs(root); fn(root); }, { tmpDir: 'migrate-legacy-' });

// =============================================================================
// DETECTION TESTS
// =============================================================================

console.log('\nDetection:');

test('detects legacy currentPhase (DESIGN)', (root) => {
  copyFixtureState('run-24-intake-state.json', root);
  const result = run(['--root', root]);
  assert(result.ok, `dry-run failed: ${result.stderr}`);
  assertEqual(result.data.status, 'legacy_detected', 'status');
  assert(result.data.changes.some(c => c.kind === 'state-rewrite'), 'expected state-rewrite change');
});

test('detects legacy story phases (REALIGN/QA)', (root) => {
  copyFixtureState('run-12-state.json', root);
  const result = run(['--root', root]);
  assert(result.ok, `dry-run failed: ${result.stderr}`);
  assertEqual(result.data.status, 'legacy_detected', 'status');
});

test('detects FRS without brief', (root) => {
  writeFile(root, 'generated-docs/specs/feature-requirements.md', '# FRS\n\nSome requirements.\n');
  const result = run(['--root', root]);
  assert(result.ok, `dry-run failed: ${result.stderr}`);
  assertEqual(result.data.status, 'legacy_detected', 'status');
  assert(result.data.changes.some(c => c.kind === 'spec-copy'), 'expected spec-copy change');
});

test('reports no_legacy when nothing exists', (root) => {
  const result = run(['--root', root]);
  assert(result.ok, `dry-run failed: ${result.stderr}`);
  assertEqual(result.data.status, 'no_legacy', 'status');
});

test('reports no_migration_needed for already-migrated state', (root) => {
  writeFile(root, 'generated-docs/context/workflow-state.json', JSON.stringify({
    featureName: 'something', currentPhase: 'BUILD', phaseStatus: 'ready', epics: {}, featureComplete: false
  }));
  writeFile(root, 'generated-docs/specs/project-brief.md', '# Brief');
  const result = run(['--root', root]);
  assert(result.ok, `dry-run failed: ${result.stderr}`);
  assertEqual(result.data.status, 'no_migration_needed', 'status');
});

// =============================================================================
// FIXTURE-DRIVEN MIGRATION OUTPUT
// =============================================================================

console.log('\nFixture migrations:');

test('run-12: REALIGN currentPhase → BUILD, in-progress story → PENDING', (root) => {
  copyFixtureState('run-12-state.json', root);
  const result = run(['--root', root]);
  assert(result.ok, `dry-run failed: ${result.stderr}`);
  const migrated = result.data.migrated;
  assertEqual(migrated.currentPhase, 'BUILD', 'currentPhase');
  assertEqual(migrated.epics['2'].stories['4'].phase, 'PENDING', 'in-progress story phase');
  assertEqual(migrated.epics['1'].stories['1'].phase, 'COMPLETE', 'completed story phase');
});

test('run-12: completed stories get synthesized e2e/manual fields with warnings', (root) => {
  copyFixtureState('run-12-state.json', root);
  const result = run(['--root', root]);
  assert(result.ok, `dry-run failed: ${result.stderr}`);
  const story = result.data.migrated.epics['1'].stories['1'];
  assertEqual(story.e2eStatus, 'passed', 'e2eStatus synthesized');
  assertEqual(story.manualVerification, 'passed', 'manualVerification synthesized');
  assert(result.data.warnings.some(w => w.includes('Epic 1 story 1') && w.includes('e2eStatus')), 'expected e2eStatus warning');
});

test('run-23: QA currentPhase → BUILD, completed stories preserve fields', (root) => {
  copyFixtureState('run-23-state.json', root);
  const result = run(['--root', root]);
  assert(result.ok, `dry-run failed: ${result.stderr}`);
  const migrated = result.data.migrated;
  assertEqual(migrated.currentPhase, 'BUILD', 'currentPhase');
  assertEqual(migrated.epics['1'].stories['1'].e2eStatus, 'passed-after-fix', 'preserves existing e2eStatus');
  assertEqual(migrated.epics['1'].stories['1'].manualVerification, 'passed', 'preserves existing manualVerification');
  assertEqual(migrated.epics['1'].stories['3'].phase, 'PENDING', 'QA story → PENDING');
});

test('run-23: design and designArtifacts blocks are dropped with warnings', (root) => {
  copyFixtureState('run-23-state.json', root);
  const result = run(['--root', root]);
  assert(result.ok, `dry-run failed: ${result.stderr}`);
  assertEqual(result.data.migrated.design, undefined, 'design block dropped');
  assertEqual(result.data.migrated.designArtifacts, undefined, 'designArtifacts block dropped');
  assert(result.data.warnings.some(w => w.includes('design')), 'expected design warning');
  assert(result.data.warnings.some(w => w.includes('designArtifacts')), 'expected designArtifacts warning');
});

test('run-23: intake.frsExists renamed to briefExists', (root) => {
  copyFixtureState('run-23-state.json', root);
  const result = run(['--root', root]);
  assert(result.ok, `dry-run failed: ${result.stderr}`);
  assertEqual(result.data.migrated.intake.briefExists, true, 'briefExists set from frsExists');
  assertEqual(result.data.migrated.intake.frsExists, undefined, 'frsExists removed');
});

test('run-23: epic.phase STORIES → PENDING', (root) => {
  copyFixtureState('run-23-state.json', root);
  const result = run(['--root', root]);
  assert(result.ok, `dry-run failed: ${result.stderr}`);
  assertEqual(result.data.migrated.epics['1'].phase, 'PENDING', 'STORIES epic → PENDING');
});

test('run-24-intake: SCOPE currentPhase → PLAN', (root) => {
  copyFixtureState('run-24-intake-state.json', root);
  const result = run(['--root', root]);
  assert(result.ok, `dry-run failed: ${result.stderr}`);
  assertEqual(result.data.migrated.currentPhase, 'PLAN', 'SCOPE → PLAN');
});

test('run-24-playwright: round-trip apply → restore', (root) => {
  copyFixtureState('run-24-playwright-state.json', root);
  const originalContent = fs.readFileSync(path.join(root, 'generated-docs/context/workflow-state.json'), 'utf-8');

  const applyResult = run(['--root', root, '--apply']);
  assert(applyResult.ok, `apply failed: ${applyResult.stderr}`);
  assertEqual(applyResult.data.status, 'applied', 'apply status');
  assert(fs.existsSync(path.join(root, 'generated-docs/context/workflow-state.legacy-backup.json')), 'backup created');

  // State on disk now reflects new schema.
  const newState = readState(root);
  assertEqual(newState.currentPhase, 'BUILD', 'on-disk currentPhase after apply');

  // Restore reverts.
  const restoreResult = run(['--root', root, '--restore']);
  assert(restoreResult.ok, `restore failed: ${restoreResult.stderr}`);
  assertEqual(restoreResult.data.status, 'restored', 'restore status');
  const restored = fs.readFileSync(path.join(root, 'generated-docs/context/workflow-state.json'), 'utf-8');
  assertEqual(restored, originalContent, 'restored content matches original');
  assert(!fs.existsSync(path.join(root, 'generated-docs/context/workflow-state.legacy-backup.json')), 'backup removed after restore');
});

// =============================================================================
// SPEC COPY
// =============================================================================

console.log('\nSpec copy:');

test('--apply copies FRS to brief with migration header', (root) => {
  const frsBody = '# Feature Requirements\n\n- R1: Something\n';
  writeFile(root, 'generated-docs/specs/feature-requirements.md', frsBody);
  // No state file — just exercise the spec-copy path.
  const result = run(['--root', root, '--apply']);
  assert(result.ok, `apply failed: ${result.stderr}`);
  assertEqual(result.data.status, 'applied', 'status');
  const brief = fs.readFileSync(path.join(root, 'generated-docs/specs/project-brief.md'), 'utf-8');
  assert(brief.startsWith('<!-- Migrated from feature-requirements.md'), 'brief has migration header');
  assert(brief.includes(frsBody), 'brief preserves FRS body');
});

test('--apply skips FRS copy if brief already exists, with warning', (root) => {
  // Legacy state file gives the migration a reason to run; the spec-coexistence
  // warning only surfaces when there is already other work to migrate.
  copyFixtureState('run-23-state.json', root);
  writeFile(root, 'generated-docs/specs/feature-requirements.md', '# FRS');
  writeFile(root, 'generated-docs/specs/project-brief.md', '# Existing brief');
  const result = run(['--root', root, '--apply']);
  assert(result.ok, `apply failed: ${result.stderr}`);
  assertEqual(fs.readFileSync(path.join(root, 'generated-docs/specs/project-brief.md'), 'utf-8'), '# Existing brief', 'brief unchanged');
  assert(result.data.warnings.some(w => w.includes('Both feature-requirements.md and project-brief.md exist')), 'expected warning');
});

test('--restore removes only migration-header brief, leaves user-edited brief', (root) => {
  copyFixtureState('run-24-playwright-state.json', root);
  writeFile(root, 'generated-docs/specs/feature-requirements.md', '# FRS body\n');
  run(['--root', root, '--apply']);
  writeFile(root, 'generated-docs/specs/project-brief.md', '# User-edited brief\n');

  const restoreResult = run(['--root', root, '--restore']);
  assert(restoreResult.ok, `restore failed: ${restoreResult.stderr}`);
  assert(fs.existsSync(path.join(root, 'generated-docs/specs/project-brief.md')), 'user brief preserved');
  assert(restoreResult.data.warnings.some(w => w.includes('does not carry the migration header')), 'expected warning about user-edited brief');
});

// =============================================================================
// EDGE CASES
// =============================================================================

console.log('\nEdge cases:');

test('--restore with no backup exits 1', (root) => {
  const result = run(['--root', root, '--restore']);
  assert(!result.ok, 'expected non-zero exit');
  assertEqual(result.exitCode, 1, 'exit code');
});

test('warns on existing backup during second apply', (root) => {
  copyFixtureState('run-23-state.json', root);
  run(['--root', root, '--apply']);
  // After first apply, state is on the 4-phase model so a second --apply would be a no-op.
  // Forge a fresh legacy state next to the existing backup to exercise the warning path.
  copyFixtureState('run-12-state.json', root);
  const result = run(['--root', root, '--apply']);
  assert(result.ok, `second apply failed: ${result.stderr}`);
  assert(result.data.warnings.some(w => w.includes('Backup') && w.includes('already exists')), 'expected backup-exists warning');
});

test('second apply over an existing backup reports status "skipped", not "applied"', (root) => {
  copyFixtureState('run-23-state.json', root);
  run(['--root', root, '--apply']);
  // Forge a fresh legacy state next to the existing backup, then re-apply: the rewrite must
  // be skipped AND the status must reflect that (state.json on disk is still legacy).
  copyFixtureState('run-12-state.json', root);
  const before = fs.readFileSync(path.join(root, 'generated-docs/context/workflow-state.json'), 'utf-8');
  const result = run(['--root', root, '--apply']);
  assert(result.ok, `second apply failed: ${result.stderr}`);
  assertEqual(result.data.status, 'skipped', 'status must be "skipped" when the rewrite is skipped');
  const after = fs.readFileSync(path.join(root, 'generated-docs/context/workflow-state.json'), 'utf-8');
  assertEqual(after, before, 'state.json must be unchanged when the rewrite is skipped');
});

test('integration tests are counted once, not double-counted', (root) => {
  copyFixtureState('run-12-state.json', root);
  // run-12 has epic 1 / story 1 COMPLETE. A single integration test lives under the
  // integration/ subdir of __tests__ — it must contribute testFiles=1, not 2.
  writeFile(root, 'web/src/__tests__/integration/epic-1-story-1-foo.test.tsx', 'test("x", () => {});\n');
  const result = run(['--root', root]);
  assert(result.ok, `dry-run failed: ${result.stderr}`);
  assertEqual(result.data.migrated.epics['1'].stories['1'].testFiles, 1, 'one integration test = testFiles 1');
});

test('a present-but-falsy completion field (e2eStatus: "") is preserved, not synthesized over', (root) => {
  copyFixtureState('run-12-state.json', root);
  const statePath = path.join(root, 'generated-docs/context/workflow-state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  state.epics['1'].stories['1'].e2eStatus = ''; // present but falsy — real data
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  const result = run(['--root', root]);
  assert(result.ok, `dry-run failed: ${result.stderr}`);
  assertEqual(result.data.migrated.epics['1'].stories['1'].e2eStatus, '', 'empty e2eStatus preserved, not overwritten with "passed"');
});

test('AC count is synthesized from story file when available', (root) => {
  copyFixtureState('run-12-state.json', root);
  const epicDir = path.join(root, 'generated-docs/stories/epic-1-foo');
  fs.mkdirSync(epicDir, { recursive: true });
  fs.writeFileSync(path.join(epicDir, 'story-1-bar.md'), `# Story 1\n\n## Acceptance Criteria\n\n- [x] AC-1: thing\n- [x] AC-2: other\n- [x] AC-3: third\n`);
  const result = run(['--root', root]);
  assert(result.ok, `dry-run failed: ${result.stderr}`);
  const story = result.data.migrated.epics['1'].stories['1'];
  assert(story.acceptance, 'acceptance synthesized');
  assertEqual(story.acceptance.total, 3, 'AC total');
  assertEqual(story.acceptance.checked, 3, 'AC checked');
});

// =============================================================================
// SUMMARY
// =============================================================================

summary();
