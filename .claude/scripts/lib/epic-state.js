'use strict';
/**
 * lib/epic-state.js — schema *data* for per-epic state.json.
 *
 * This is intentionally minimal. The workflow's executor is Claude (see
 * memory: feedback-llm-executor-mindset). Phase transitions, story status
 * updates, and validation are described in agent prompts and command docs —
 * Claude reads the rules and applies them via Edit/Write directly.
 *
 * This file exists only to give the rules a single canonical *data* home that
 * code with no LLM in the loop (hooks, dashboard, CI) can reference:
 *
 *   - Phase enum  + transition graph
 *   - Story status enum
 *   - E2E status enum
 *   - Halt stage enum
 *   - Default-state factory (used by `--init` only)
 *
 * Per-epic state.json shape (this module is the source of truth for it):
 *
 *   {
 *     schemaVersion: 1,
 *     epic: { slug, name, createdAt, dependsOn: [], introducesSharedSurface, unverifiedAssumptions: [], manualTestResults: [] },
 *     phase: PHASE,
 *     stories: { "<N>": { status, commit, e2eStatus, startedAt, completedAt } },
 *     halt: null | { reason, stage, raisedAt, requiresProjectChange? },
 *     lastUpdated: <ISO8601>
 *   }
 *
 * stories[N].startedAt / completedAt (ISO8601 | null) are stamped by the
 * orchestrator: startedAt when the story first goes in-progress (B1, never
 * overwritten on resume), completedAt at the story commit (B5). They exist so
 * reporting (/build-report, /build-report-cost) can attribute time and cost per
 * story instead of per epic — no workflow logic reads them.
 *
 * epic.introducesSharedSurface (bool) and epic.unverifiedAssumptions (string[]) are
 * populated by the orchestrator at PLAN from the planner's output; defaulted at init.
 * epic.manualTestResults ([{ story, test, passed, comment }]) is the last pasted-back
 * manual-test check state, persisted at B7.1 so a post-fix re-display can carry over
 * ticks and re-verify only the affected tests; defaulted to [] at init.
 *
 * Derived fields (NOT stored):
 *   - currentStory: the story with status === "in-progress" (or null)
 *   - cycleNumber: counted from commits/journal entries when needed
 */

const SCHEMA_VERSION = 1;

const EPIC_PHASES = Object.freeze([
  'PLAN',
  'READY-TO-BUILD',
  'BUILD',
  'EPIC-END',
  'MANUAL-TEST',
  'COMPLETE-ON-BRANCH',
  'COMPLETE'
]);

const STORY_STATUS_VALUES = Object.freeze(['pending', 'in-progress', 'complete', 'halted']);

// Epic-branch enum — narrower than the legacy set in lib/workflow-helpers.js.
// "deferred" is the default at story-commit time (Playwright runs at epic-end);
// "pending"/"running"/"escalated"/"user-skipped*"/"missing" are not used here.
const E2E_STATUS_VALUES = Object.freeze([
  'deferred',
  'passed',
  'passed-after-fix',
  'failed',
  'auto-skipped:non-routable',
  'auto-skipped:fixme'
]);

const HALT_STAGES = Object.freeze([
  'plan',
  'test-generator',
  'developer',
  'epic-end',
  'manual-test'
]);

// Valid phase transitions. PLAN branches by caller: → READY-TO-BUILD when `/plan`
// parks the epic ahead of time (the parallel plan-ahead path); → BUILD when
// `/start` plans and builds through in one pass. READY-TO-BUILD → BUILD when a
// parked epic is later picked up (`/start` or `/continue`). Re-entries
// (EPIC-END → BUILD, MANUAL-TEST → BUILD) cover the fix-cycle and
// manual-test-failure paths.
const VALID_TRANSITIONS = Object.freeze({
  'PLAN': ['READY-TO-BUILD', 'BUILD'],
  'READY-TO-BUILD': ['BUILD'],
  'BUILD': ['EPIC-END'],
  'EPIC-END': ['MANUAL-TEST', 'BUILD'],
  'MANUAL-TEST': ['COMPLETE-ON-BRANCH', 'BUILD'],
  'COMPLETE-ON-BRANCH': ['COMPLETE'],
  'COMPLETE': []
});

function defaultEpicState({ slug, name, dependsOn = [] } = {}) {
  if (!slug) throw new Error('defaultEpicState: slug is required');
  if (!name) throw new Error('defaultEpicState: name is required');
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    epic: { slug, name, createdAt: now, dependsOn: [...dependsOn], introducesSharedSurface: false, unverifiedAssumptions: [], manualTestResults: [] },
    phase: 'PLAN',
    stories: {},
    halt: null,
    lastUpdated: now
  };
}

module.exports = {
  SCHEMA_VERSION,
  EPIC_PHASES,
  STORY_STATUS_VALUES,
  E2E_STATUS_VALUES,
  HALT_STAGES,
  VALID_TRANSITIONS,
  defaultEpicState
};
