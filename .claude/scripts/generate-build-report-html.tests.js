#!/usr/bin/env node
/**
 * Tests for generate-build-report-html.js — the safe markdown-lite renderer and
 * page assembly. The renderer must never let raw HTML from journals / the insight
 * prompt reach the page, and must join hard-wrapped paragraphs so **bold** that
 * straddles a line break still renders.
 *
 * Usage:
 *   node .claude/scripts/generate-build-report-html.tests.js
 */
'use strict';

const harness = require('./lib/test-harness');
const { assert, assertEqual, summary } = harness;
const { mdLite, renderPage } = require('./generate-build-report-html');

// ── mdLite ───────────────────────────────────────────────────────────────────
harness.test('mdLite: escapes raw HTML before formatting (no injection)', () => {
  const out = mdLite('<script>alert(1)</script> and **bold**');
  assert(!out.includes('<script>'), 'script tag escaped');
  assert(out.includes('&lt;script&gt;'), 'angle brackets entity-encoded');
  assert(out.includes('<strong>bold</strong>'), 'bold still applied after escaping');
});

harness.test('mdLite: joins a hard-wrapped paragraph so straddling bold renders', () => {
  const out = mdLite('one root cause: **something that\nspans a line break** — end.');
  assert(out.includes('<strong>something that spans a line break</strong>'), 'bold spans the wrap');
  assertEqual((out.match(/<p>/g) || []).length, 1, 'rendered as a single paragraph');
});

harness.test('mdLite: headings, bullets, and inline code', () => {
  const out = mdLite('## Heading\n\n- a bullet with `code`\n- second bullet');
  assert(out.includes('<h5>Heading</h5>'), 'h2 → h5');
  assert(out.includes('<ul>') && out.includes('</ul>'), 'list wrapper');
  assertEqual((out.match(/<li>/g) || []).length, 2, 'two list items');
  assert(out.includes('<code>code</code>'), 'inline code');
});

harness.test('mdLite: blank input yields empty string', () => {
  assertEqual(mdLite(''), '', 'empty');
  assertEqual(mdLite(null), '', 'null');
});

harness.test('mdLite: a blank line closes a list (following text is its own paragraph)', () => {
  const out = mdLite('- item\n\nafter');
  const ulEnd = out.indexOf('</ul>');
  const para = out.indexOf('<p>after</p>');
  assert(ulEnd !== -1 && para > ulEnd, 'paragraph comes after the closed list');
});

// ── renderPage ───────────────────────────────────────────────────────────────
harness.test('renderPage: non-ok status renders a message page, not a crash', () => {
  const html = renderPage({ status: 'no_project', message: 'run /start' }, null);
  assert(html.includes('run /start'), 'message shown');
  assert(/Build report/i.test(html), 'still titled');
});

harness.test('renderPage: ok payload renders overview, timeline, epics, blocks', () => {
  const data = {
    status: 'ok',
    project: { name: 'Demo' },
    generatedAt: '2026-07-10T10:00:00Z',
    timeline: {
      firstCommit: { date: '2026-07-01T09:00:00Z', subject: 'init' },
      lastCommit: { date: '2026-07-02T09:00:00Z', subject: 'done' },
      spanDays: 2, totalCommits: 3, sessionCount: 1, activeMinutes: 90, gapMin: 45,
      sessions: [{ start: '2026-07-01T09:00:00Z', end: '2026-07-01T10:30:00Z', day: '2026-07-01', durationMin: 90, commitCount: 2, commits: [{ date: '2026-07-01T09:00:00Z', subject: 'a' }, { date: '2026-07-01T10:30:00Z', subject: 'fix b' }] }]
    },
    epics: [{
      slug: 'demo-epic', name: 'Demo Epic', status: 'complete',
      firstCommit: { date: '2026-07-01T09:00:00Z' }, lastCommit: { date: '2026-07-02T09:00:00Z' },
      sessionMinutes: 90, sharedSessions: false, commitCount: 2, fixCommitCount: 1,
      stories: { total: 2, complete: 2, passedAfterFix: 1 },
      manualTest: { outcome: 'passed', note: 'looked good', passed: 2, total: 2 },
      unverifiedAssumptions: 1, journal: '## Story 1\n- did a thing'
    }],
    coverage: { plannedEpics: 3, builtEpics: 1, storiesBuilt: 2 },
    rework: { fixCommitCount: 1, passedAfterFixStories: 1, fixCommits: [] },
    stumblingBlocks: [{ title: 'A snag', source: 'dev', summary: 's', body: '- **Issue:** it snagged' }]
  };
  const html = renderPage(data, '## The headline\n\nIt went **well**.');
  assert(html.startsWith('<!doctype html>'), 'doctype');
  assert(html.includes('Demo Epic'), 'epic name');
  assert(html.includes('A snag'), 'stumbling block title');
  assert(html.includes('What this means'), 'insight panel included when md supplied');
  assert(html.includes('<strong>well</strong>'), 'insight markdown rendered');
  assert(html.includes('1/3') || html.includes('1/3</div>'), 'epics delivered ratio shown');
});

harness.test('renderPage: omits the insight panel when no markdown supplied', () => {
  const data = {
    status: 'ok', project: { name: 'Demo' }, generatedAt: '2026-07-10T10:00:00Z',
    timeline: { firstCommit: null, lastCommit: null, spanDays: 0, totalCommits: 0, sessionCount: 0, activeMinutes: 0, gapMin: 45, sessions: [] },
    epics: [], coverage: { plannedEpics: null, builtEpics: 0, storiesBuilt: 0 },
    rework: { fixCommitCount: 0, passedAfterFixStories: 0, fixCommits: [] }, stumblingBlocks: []
  };
  const html = renderPage(data, null);
  assert(!html.includes('What this means'), 'no insight panel without markdown');
});

// ── renderBuildFlow ──────────────────────────────────────────────────────────
const flowData = {
  buildFlow: { storyMinutes: 50, wallClockMinutes: 35, parallelism: 1.43, peakInFlight: 2, overlapPct: 43 },
  epics: [
    {
      slug: 'alpha', name: 'Alpha <script>x</script>', createdAt: '2026-07-01T08:50:00Z',
      flow: {
        stories: [
          { n: 1, title: 'first & <b>bold</b> thing', startedAt: '2026-07-01T09:00:00Z', completedAt: '2026-07-01T09:20:00Z', commit: 'abc1234', e2eStatus: 'passed' },
          { n: 2, title: null, startedAt: '2026-07-01T09:21:00Z', completedAt: '2026-07-01T09:40:00Z', commit: null, e2eStatus: 'passed-after-fix' }
        ],
        wrapUp: { endedAt: '2026-07-01T09:55:00Z', commits: 2 }
      }
    },
    {
      slug: 'beta', name: 'Beta', createdAt: null,
      flow: { stories: [{ n: 1, title: 'b', startedAt: '2026-07-01T09:10:00Z', completedAt: '2026-07-01T09:25:00Z', commit: null, e2eStatus: null }], wrapUp: null }
    }
  ]
};

harness.test('renderBuildFlow: lanes, story bars, shoulders, in-flight strip, and stats', () => {
  const { renderBuildFlow } = require('./generate-build-report-html');
  const html = renderBuildFlow(flowData);
  assert(html.includes('2026-07-01'), 'day row rendered');
  assert((html.match(/class="fbar/g) || []).length === 3, 'one bar per story');
  assert((html.match(/class="fshoulder/g) || []).length === 2, 'lead (plan) and wrap-up shoulders for alpha');
  assert(html.includes('fstep'), 'in-flight strip rendered');
  assert(html.includes('1.43×'), 'parallelism stat shown');
  assert(html.includes('Table view'), 'table fallback present');
});

harness.test('renderBuildFlow: epic/story text is escaped (tooltips survive one attribute decode)', () => {
  const { renderBuildFlow } = require('./generate-build-report-html');
  const html = renderBuildFlow(flowData);
  assert(!html.includes('<script>x'), 'raw epic-name script tag never reaches the page');
  assert(html.includes('&lt;script&gt;x'), 'lane label escaped once');
  assert(html.includes('&amp;lt;script&amp;gt;'), 'tooltip attribute escaped twice (decodes to inert text)');
});

harness.test('renderBuildFlow: no story timestamps → quiet placeholder, no crash', () => {
  const { renderBuildFlow } = require('./generate-build-report-html');
  const html = renderBuildFlow({ buildFlow: null, epics: [{ slug: 'old', name: 'Old', flow: { stories: [], wrapUp: null } }] });
  assert(html.includes('No story timing recorded yet'), 'placeholder message');
});

summary();
