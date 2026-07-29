#!/usr/bin/env node
/**
 * Tests for collect-build-report-data.js pure functions.
 *
 * Usage:
 *   node .claude/scripts/collect-build-report-data.tests.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const harness = require('./lib/test-harness');
const { assert, assertEqual, assertDeepEqual, summary } = harness;
const {
  clusterSessions,
  attributeCommit,
  parseTemplateFeedback,
  summariseManualTest,
  fmtDuration,
  classifySrcFile,
  countTestBlocks,
  diffDeps,
  parseNumstat,
  countStories,
  storyFlow,
  buildFlowStats,
  readInsightsSummary,
  readGateRuns,
  readReportMeta
} = require('./collect-build-report-data');

// Temp project root with the given generated-docs files (rel path → content).
function tmpRoot(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-report-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const commit = (iso, subject = 'x') => ({ hash: iso.slice(11, 16), date: iso, subject });

// ── clusterSessions ──────────────────────────────────────────────────────────
harness.test('clusterSessions: a gap over the threshold starts a new session', () => {
  const commits = [
    commit('2026-07-01T09:00:00Z'),
    commit('2026-07-01T09:20:00Z'), // +20m — same session
    commit('2026-07-01T11:00:00Z')  // +100m — new session
  ];
  const sessions = clusterSessions(commits, 45);
  assertEqual(sessions.length, 2, 'two sessions');
  assertEqual(sessions[0].commitCount, 2, 'first session has two commits');
  assertEqual(sessions[0].durationMin, 20, 'first session spans 20 min');
});

harness.test('clusterSessions: a lone commit is a zero-minute session (floor, never over-counts)', () => {
  const sessions = clusterSessions([commit('2026-07-01T09:00:00Z')], 45);
  assertEqual(sessions.length, 1, 'one session');
  assertEqual(sessions[0].durationMin, 0, 'lone commit contributes 0 minutes');
});

harness.test('clusterSessions: empty input yields no sessions', () => {
  assertDeepEqual(clusterSessions([], 45), [], 'no sessions');
});

harness.test('clusterSessions: exactly-threshold gap stays in the same session', () => {
  const sessions = clusterSessions([
    commit('2026-07-01T09:00:00Z'),
    commit('2026-07-01T09:45:00Z') // +45m == threshold → same session
  ], 45);
  assertEqual(sessions.length, 1, 'still one session at exactly the gap');
});

// ── attributeCommit ──────────────────────────────────────────────────────────
const slugs = ['transactions-table-search-summary', 'file-upload-ingestion', 'auth-app-shell'];
const byLen = [...slugs].sort((a, b) => b.length - a.length);

harness.test('attributeCommit: conventional-commit scope with a story path', () => {
  assertEqual(attributeCommit('feat(auth-app-shell/story-2): sign-in', byLen), 'auth-app-shell', 'scope slug');
});

harness.test('attributeCommit: generic scope falls back to a slug named in the subject', () => {
  assertEqual(
    attributeCommit('docs(plan): stories for epic file-upload-ingestion', byLen),
    'file-upload-ingestion',
    'slug matched in subject'
  );
});

harness.test('attributeCommit: unrelated commit attributes to no epic', () => {
  assertEqual(attributeCommit('chore: bump deps', byLen), null, 'no epic');
});

harness.test('attributeCommit: longest slug wins when one is a prefix of another', () => {
  const s = ['transactions', 'transactions-table-search-summary'].sort((a, b) => b.length - a.length);
  assertEqual(
    attributeCommit('feat(transactions-table-search-summary/story-1): table', s),
    'transactions-table-search-summary',
    'longer slug claims it'
  );
});

// ── parseTemplateFeedback ────────────────────────────────────────────────────
harness.test('parseTemplateFeedback: splits on ## and extracts source + summary', () => {
  const md = [
    '# Template Feedback',
    '',
    '## Doubled --run mangles Vitest',
    '',
    '- **Source:** developer, epic auth-app-shell',
    '- **Issue:** the doubled --run consumes the path filter.',
    '',
    '## Another thing',
    '',
    '**Where:** the pre-commit hook',
    '**What happens:** it typechecks the whole tree.'
  ].join('\n');
  const blocks = parseTemplateFeedback(md);
  assertEqual(blocks.length, 2, 'two blocks, H1 excluded');
  assertEqual(blocks[0].title, 'Doubled --run mangles Vitest', 'title');
  assert(/developer/.test(blocks[0].source), 'source captured');
  assert(/consumes the path filter/.test(blocks[0].summary), 'summary from Issue');
  assert(/pre-commit hook/.test(blocks[1].source), 'Where treated as source');
  assert(/typechecks the whole tree/.test(blocks[1].summary), 'What happens treated as summary');
});

harness.test('parseTemplateFeedback: empty/missing input yields no blocks', () => {
  assertDeepEqual(parseTemplateFeedback(null), [], 'null → []');
  assertDeepEqual(parseTemplateFeedback(''), [], 'empty → []');
});

// ── summariseManualTest ──────────────────────────────────────────────────────
harness.test('summariseManualTest: array results give a short label + counts', () => {
  const r = summariseManualTest({ epic: { manualTestResults: [{ passed: true }, { passed: true }, { passed: false }] } });
  assertEqual(r.passed, 2, 'passed count');
  assertEqual(r.total, 3, 'total count');
  assertEqual(r.outcome, 'mixed', 'not all passed → mixed');
});

harness.test('summariseManualTest: a verbose outcome string collapses to one word, prose kept as note', () => {
  const longStr = 'all-passed (2026-07-07, after fixing the root-route template-page shadow in story 1)';
  const r = summariseManualTest({ epic: { manualTestResults: longStr } });
  assertEqual(r.outcome, 'passed', 'collapsed to a short label');
  assertEqual(r.note, longStr, 'full prose preserved as note');
});

harness.test('summariseManualTest: explicit short outcome is used verbatim', () => {
  const r = summariseManualTest({ epic: { manualTestOutcome: 'passed', manualTestNote: 'All UI tests passed.' } });
  assertEqual(r.outcome, 'passed', 'short outcome kept');
  assertEqual(r.note, 'All UI tests passed.', 'note from manualTestNote');
});

harness.test('summariseManualTest: no manual-test data → null outcome', () => {
  assertEqual(summariseManualTest({ epic: {} }).outcome, null, 'null when nothing recorded');
});

harness.test('summariseManualTest: extracts a "13/15 passed" figure from prose-only results', () => {
  const r = summariseManualTest({ epic: { manualTestResults: '2026-07-10: 13/15 passed, no code defects. Everything verified.' } });
  assertEqual(r.passed, 13, 'passed extracted from prose');
  assertEqual(r.total, 15, 'total extracted from prose');
  assertEqual(r.outcome, 'passed', '"no code defects" reads as passed');
});

harness.test('summariseManualTest: a nonsense ratio like "20/3 passed" is not extracted', () => {
  const r = summariseManualTest({ epic: { manualTestResults: 'saw 20/3 passed somewhere odd' } });
  assertEqual(r.passed, null, 'implausible ratio ignored');
});

// ── classifySrcFile ──────────────────────────────────────────────────────────
harness.test('classifySrcFile: app source, unit tests, and e2e by path', () => {
  assertEqual(classifySrcFile('web/src/components/ui/button.tsx'), 'source', 'component');
  assertEqual(classifySrcFile('web/src/app/(app)/files/page.tsx'), 'source', 'route page');
  assertEqual(classifySrcFile('web/src/__tests__/upload.test.tsx'), 'unitTests', '__tests__ dir');
  assertEqual(classifySrcFile('web/src/lib/api/client.test.ts'), 'unitTests', '.test. suffix');
  assertEqual(classifySrcFile('web/e2e/epic-x-story-1-login.spec.ts'), 'e2e', 'e2e spec');
});

harness.test('classifySrcFile: non-code files and outside paths are excluded', () => {
  assertEqual(classifySrcFile('web/src/app/favicon.ico'), null, 'asset');
  assertEqual(classifySrcFile('web/package.json'), null, 'config outside src');
  assertEqual(classifySrcFile('documentation/spec.ts'), null, 'outside web/');
});

// ── countTestBlocks ──────────────────────────────────────────────────────────
harness.test('countTestBlocks: counts test()/it() but not describe/skip; fixme counted apart', () => {
  const src = [
    "describe('x', () => {",
    "  test('a', () => {});",
    "  it('b', () => {});",
    "  test.skip('c', () => {});",
    "  test('d', () => { test.fixme(); });",
    '});'
  ].join('\n');
  const c = countTestBlocks(src);
  assertEqual(c.test, 3, 'a, b, d are live blocks');
  assertEqual(c.fixme, 1, 'fixme call counted separately');
});

harness.test('countTestBlocks: test.each counts as one block', () => {
  assertEqual(countTestBlocks("test.each([[1],[2]])('n %i', () => {});").test, 1, 'one each-block');
});

// ── diffDeps ─────────────────────────────────────────────────────────────────
harness.test('diffDeps: reports only additions relative to the baseline', () => {
  const base = { dependencies: { react: '19', next: '16' }, devDependencies: { vitest: '3' } };
  const cur = {
    dependencies: { react: '19', next: '16', 'radix-ui': '1' },
    devDependencies: { vitest: '3', msw: '2' }
  };
  assertDeepEqual(diffDeps(base, cur), { runtime: ['radix-ui'], dev: ['msw'] }, 'additions only');
});

harness.test('diffDeps: empty baseline treats everything as added', () => {
  assertDeepEqual(diffDeps({}, { dependencies: { a: '1' } }), { runtime: ['a'], dev: [] }, 'all added');
});

// ── parseNumstat ─────────────────────────────────────────────────────────────
harness.test('parseNumstat: sums only web/ code lines, skipping lockfile and binaries', () => {
  const raw = [
    '\x1eaaaaaaaa11111111',
    '10\t2\tweb/src/app/page.tsx',
    '5000\t4000\tweb/package-lock.json',
    '7\t0\tgenerated-docs/epics/x/state.json',
    '-\t-\tweb/public/logo.png',
    '\x1ebbbbbbbb22222222',
    '3\t1\tweb/e2e/spec.ts'
  ].join('\n');
  const m = parseNumstat(raw);
  assertDeepEqual(m.get('aaaaaaaa'), { add: 10, del: 2 }, 'lockfile, non-web, binary excluded');
  assertDeepEqual(m.get('bbbbbbbb'), { add: 3, del: 1 }, 'e2e counted');
});

harness.test('parseNumstat: empty input yields an empty map', () => {
  assertEqual(parseNumstat(null).size, 0, 'null → empty');
});

// ── countStories: first-pass yield inputs ────────────────────────────────────
harness.test('countStories: separates first-pass from passed-after-fix', () => {
  const s = countStories({
    stories: {
      1: { status: 'complete', e2eStatus: 'passed' },
      2: { status: 'complete', e2eStatus: 'passed-after-fix' },
      3: { status: 'in-progress', e2eStatus: null }
    }
  });
  assertEqual(s.withE2e, 2, 'two stories have an E2E outcome');
  assertEqual(s.firstPass, 1, 'one passed untouched');
  assertEqual(s.passedAfterFix, 1, 'one needed the fix cycle');
});

// ── fmtDuration ──────────────────────────────────────────────────────────────
harness.test('fmtDuration: minutes, whole hours, and h+mm', () => {
  assertEqual(fmtDuration(45), '45m', 'sub-hour');
  assertEqual(fmtDuration(120), '2h', 'whole hours');
  assertEqual(fmtDuration(168), '2h48', 'hours + zero-padded minutes');
});

// ── readInsightsSummary ──────────────────────────────────────────────────────
harness.test('readInsightsSummary: summarises the /build-report-cost data file', () => {
  const root = tmpRoot({
    'generated-docs/reports/build-cost-data.json': JSON.stringify({
      generatedAt: '2026-07-10T10:00:00Z',
      usdToZar: 18.5,
      rateProvided: true,
      grand: { costUsd: 12.34, totalTokens: 5000000, output: 400000, calls: 900, cacheHit: 0.85 },
      userInputsTotal: { typed: 10, commands: 4, manualTest: 2, interruptions: 1 },
      waitsTotal: { approvalMs: 600000, approvalCount: 5, generalMs: 120000, generalCount: 3, stallMs: 7200000, stallCount: 2 },
      stallThresholdMin: 10,
      postDelivery: { sessions: [{ id: 'abc', firstCommand: '/build-report' }], tokens: { costUsd: 1.5 } },
      agents: [{ agent: 'orchestrator', instances: null }, { agent: 'developer', instances: 6 }, { agent: 'test-generator', instances: 4 }],
      buckets: [
        { label: 'INTAKE & setup', questionsAsked: 3, tokens: { costUsd: 2 } },
        { label: 'Epic 1 — Demo', questionsAsked: 5, tokens: { costUsd: 10.34 } }
      ]
    })
  });
  const s = readInsightsSummary(root);
  assertEqual(s.costUsd, 12.34, 'cost picked up');
  assertEqual(s.agentsSpawned, 10, 'orchestrator (null instances) excluded from spawn count');
  assertEqual(s.questionsAsked, 8, 'questions summed across buckets');
  assertEqual(s.userInputs.typed, 10, 'user inputs carried through');
  assertEqual(s.postDelivery.sessions, 1, 'post-delivery session count');
  assertEqual(s.postDelivery.costUsd, 1.5, 'post-delivery cost');
  assertEqual(s.bucketCosts.length, 2, 'per-bucket costs for the bars');
});

harness.test('readInsightsSummary: absent or corrupt file yields null', () => {
  assertEqual(readInsightsSummary(tmpRoot()), null, 'absent file');
  const bad = tmpRoot({ 'generated-docs/reports/build-cost-data.json': '{nope' });
  assertEqual(readInsightsSummary(bad), null, 'corrupt file');
});

// ── readGateRuns ─────────────────────────────────────────────────────────────
harness.test('readGateRuns: per-gate totals, failures, and reruns-after-failure', () => {
  const lines = [
    { timestamp: '2026-07-01T09:00:00Z', gates: { security: 'pass', codeQuality: 'fail', testing: 'skip' }, overallStatus: 'fail' },
    { timestamp: '2026-07-01T09:10:00Z', gates: { security: 'pass', codeQuality: 'pass', testing: 'pass' }, overallStatus: 'pass' },
    { timestamp: '2026-07-01T10:00:00Z', gates: { security: 'pass', codeQuality: 'pass', testing: 'pass' }, overallStatus: 'pass' }
  ].map((r) => JSON.stringify(r)).join('\n') + '\n';
  const root = tmpRoot({ 'generated-docs/quality-gate-runs.jsonl': lines });
  const g = readGateRuns(root);
  assertEqual(g.totalRuns, 3, 'three runs');
  assertEqual(g.failedRuns, 1, 'one failed run');
  assertEqual(g.rerunsAfterFailure, 1, 'the run right after the failure counts as a rerun');
  assertEqual(g.byGate.codeQuality.fails, 1, 'code-quality failure counted');
  assertEqual(g.byGate.testing.runs, 2, 'skipped gate not counted as a run');
});

harness.test('readGateRuns: absent file or corrupt lines handled', () => {
  assertEqual(readGateRuns(tmpRoot()), null, 'absent file');
  const root = tmpRoot({ 'generated-docs/quality-gate-runs.jsonl': 'not-json\n' + JSON.stringify({ timestamp: 't', gates: { testing: 'pass' }, overallStatus: 'pass' }) + '\n' });
  assertEqual(readGateRuns(root).totalRuns, 1, 'corrupt line skipped, valid one kept');
});

// ── readReportMeta ───────────────────────────────────────────────────────────
harness.test('readReportMeta: team name read; absent/corrupt yields null', () => {
  const root = tmpRoot({ 'generated-docs/report-meta.json': '{"team": "Team A"}' });
  assertDeepEqual(readReportMeta(root), { team: 'Team A' }, 'team read');
  assertEqual(readReportMeta(tmpRoot()), null, 'absent file');
});

// ── storyFlow / buildFlowStats (Build-flow panel inputs) ─────────────────────
harness.test('storyFlow: timestamped stories sorted, titles from commits, same-day wrap-up', () => {
  const state = {
    stories: {
      '2': { status: 'complete', commit: 'bbbb222', e2eStatus: 'passed', startedAt: '2026-07-01T10:00:00Z', completedAt: '2026-07-01T10:30:00Z' },
      '1': { status: 'complete', commit: 'aaaa111', e2eStatus: 'passed', startedAt: '2026-07-01T09:00:00Z', completedAt: '2026-07-01T09:45:00Z' },
      '3': { status: 'complete' } // legacy shape: no timestamps
    }
  };
  const mine = [
    { hash: 'aaaa111ffffffffffffffffffffffffffffffffff', date: '2026-07-01T09:44:00Z', subject: 'feat(x/story-1): first thing' },
    { hash: 'bbbb222ffffffffffffffffffffffffffffffffff', date: '2026-07-01T10:29:00Z', subject: 'feat(x/story-2): second thing' },
    { hash: 'cccc333ffffffffffffffffffffffffffffffffff', date: '2026-07-01T11:15:00Z', subject: 'chore(x): epic-end review' },
    { hash: 'dddd444ffffffffffffffffffffffffffffffffff', date: '2026-07-02T08:00:00Z', subject: 'chore(x): next day — excluded from wrap-up' }
  ];
  const f = storyFlow(state, mine);
  assertEqual(f.stories.length, 2, 'only timestamped stories included');
  assertEqual(f.stories[0].n, 1, 'sorted by start time, not key order');
  assertEqual(f.stories[0].title, 'first thing', 'title read from the story commit subject');
  assertEqual(f.wrapUp.commits, 1, 'wrap-up counts same-day post-story commits only');
  assertEqual(f.wrapUp.endedAt, '2026-07-01T11:15:00Z', 'wrap-up ends at the last same-day commit');
});

harness.test('storyFlow: legacy state without timestamps degrades to an empty flow', () => {
  assertDeepEqual(storyFlow({ stories: { '1': { status: 'complete' } } }, []), { stories: [], wrapUp: null }, 'no timestamps');
  assertDeepEqual(storyFlow(null, []), { stories: [], wrapUp: null }, 'no state at all');
});

harness.test('buildFlowStats: back-to-back stories → 1× parallelism, zero overlap', () => {
  const s = buildFlowStats([[0, 600e3], [600e3, 1200e3]]);
  assertEqual(s.storyMinutes, 20, 'total story minutes');
  assertEqual(s.wallClockMinutes, 20, 'union equals total when sequential');
  assertEqual(s.parallelism, 1, 'no parallelism');
  assertEqual(s.peakInFlight, 1, 'touching intervals never count as concurrent');
  assertEqual(s.overlapPct, 0, 'no minutes with >=2 in flight');
});

harness.test('buildFlowStats: overlapping stories → parallelism, peak, overlap share', () => {
  // A 0–30m, B 10–40m, C 20–30m: 70m of work in a 40m window; 10–30m has >=2 running.
  const s = buildFlowStats([[0, 1800e3], [600e3, 2400e3], [1200e3, 1800e3]]);
  assertEqual(s.storyMinutes, 70, 'summed story minutes');
  assertEqual(s.wallClockMinutes, 40, 'union of windows');
  assertEqual(s.parallelism, 1.75, 'work / wall-clock');
  assertEqual(s.peakInFlight, 3, 'peak concurrency');
  assertEqual(s.overlapPct, 50, '20 of 40 minutes had >=2 in flight');
});

harness.test('buildFlowStats: no timestamped stories → null (panel hides)', () => {
  assertEqual(buildFlowStats([]), null, 'empty input');
});

summary();
