#!/usr/bin/env node
/**
 * generate-dashboard-html.js
 *
 * Renders the epic-branch dashboard from the JSON payload produced by
 * collect-dashboard-data.js. Writes generated-docs/dashboard.html and a
 * sibling generated-docs/dashboard-data.json (kept for /status + debugging).
 *
 * Usage:
 *   node .claude/scripts/generate-dashboard-html.js [--collect] [--root <dir>]
 *
 * The `--collect` flag is kept for backward compatibility with /dashboard;
 * this script always collects + renders in one pass.
 *
 * Design: dark theme carried over from the previous workflow's dashboard, on the
 * epic-branch data model. Top to bottom — header, a "needs-you" banner (adaptive:
 * a calm one-liner while building, a bold card when it needs the user), an
 * overview card, the active epic's phase pipeline with plain-language tooltips,
 * and a collapsible epics table. Any epic with a story list can expand to its
 * per-story rows — the active epic open by default, completed and planned epics
 * collapsed but expandable.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { collect } = require('./collect-dashboard-data');
// EPIC_PHASES is the single source of truth for the phase vocabulary
// (lib/epic-state.js). renderPhaseBadge validates against it so a phase typo in
// state.json — or a phase added to the enum but not here — is visible, not silent.
const { EPIC_PHASES } = require('./lib/epic-state');
const { getProjectRoot } = require('./lib/project-root');
const { esc } = require('./lib/html-escape');
// GENERATED_DOCS_REL is the layout SSOT's root (resolve-state-path.js). Deriving
// the output paths from it keeps them in step with the base reviewPageFor resolves
// its in-page links relative to, so the reopen link can't drift from where this
// file is actually written.
const { GENERATED_DOCS_REL } = require('./resolve-state-path');

const OUT_HTML = path.posix.join(GENERATED_DOCS_REL, 'dashboard.html');
const OUT_JSON = path.posix.join(GENERATED_DOCS_REL, 'dashboard-data.json');

function parseArgs(argv) {
  const args = { root: getProjectRoot() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = path.resolve(argv[++i]);
    // --collect is the only mode and is implicit; accepted for backward compat.
  }
  return args;
}

// Phase → { label, color } for the epic status badge. The phase *vocabulary* is
// owned by EPIC_PHASES; this map supplies presentation only, keyed by those same
// names. Colour groups statuses by what they mean to the user, so no two
// categories share a colour:
//   blue   (#3B82F6) — Claude is working on it; nothing needed from you
//   purple (#a855f7) — your turn (try the feature and report back)
//   green  (#10b981) — ready to start next (planned, or dependencies met)
//   grey   (#6b7280) — done
// (BLOCKED — amber — is a derived plan state, coloured at its call site.)
// Labels are plain language, not workflow jargon: "TESTING", not "EPIC-END".
const PHASE_BADGE = {
  'PLAN':               { label: 'PLANNING',    color: '#3B82F6' },
  'READY-TO-BUILD':     { label: 'PLANNED',     color: '#10b981' },
  'BUILD':              { label: 'BUILDING',    color: '#3B82F6' },
  'EPIC-END':           { label: 'TESTING',     color: '#3B82F6' },
  'MANUAL-TEST':        { label: 'YOUR REVIEW', color: '#a855f7' },
  'COMPLETE-ON-BRANCH': { label: 'WRAPPING UP', color: '#3B82F6' },
  'COMPLETE':           { label: 'COMPLETE',    color: '#6b7280' }
};

// The user-meaningful phase pipeline. COMPLETE-ON-BRANCH (an internal pre-merge
// sub-state) folds into COMPLETE for display. Each step carries a plain-language
// tooltip — no developer jargon (CLAUDE.md: write for someone who isn't a dev).
const PIPELINE = [
  { phase: 'PLAN',        label: 'PLAN',     tip: 'Claude breaks this feature into a short list of stories and checks the list with you before building anything.' },
  { phase: 'BUILD',       label: 'BUILD',    tip: 'Claude builds the feature one story at a time — writing the checks first, then the code, then making sure everything still works.' },
  { phase: 'EPIC-END',    label: 'TEST',     tip: 'Claude runs all of this feature’s browser tests together and fixes anything that slipped through.' },
  { phase: 'MANUAL-TEST', label: 'REVIEW',   tip: 'Your turn — try the feature in a browser and confirm it behaves the way you expect.' },
  { phase: 'COMPLETE',    label: 'COMPLETE', tip: 'This feature is built, tested, and merged. Done.' }
];

function phaseRank(phase) {
  if (phase === 'COMPLETE-ON-BRANCH') return PIPELINE.findIndex(p => p.phase === 'COMPLETE');
  // READY-TO-BUILD sits between PLAN and BUILD: planning is done, building hasn't
  // started. Rank it just past PLAN so PLAN shows done and BUILD shows upcoming —
  // no step reads as "active", which is right: the epic is parked.
  if (phase === 'READY-TO-BUILD') return PIPELINE.findIndex(p => p.phase === 'PLAN') + 0.5;
  return PIPELINE.findIndex(p => p.phase === phase);
}

function renderPhaseBadge(phase) {
  const known = phase != null && EPIC_PHASES.includes(phase);
  const meta = PHASE_BADGE[phase];
  const c = known ? (meta?.color ?? '#6b7280') : '#ef4444';
  const label = meta?.label ?? (phase ?? 'unknown');
  const title = known ? '' : ' title="not a known epic phase"';
  return `<span class="badge" style="background:${c}"${title}>${esc(label)}</span>`;
}

function badge(text, color, title) {
  const t = title ? ` title="${esc(title)}"` : '';
  return `<span class="badge" style="background:${color}"${t}>${esc(text)}</span>`;
}

// Friendly "x min ago" relative to the page's generation time (passed in so this
// stays a pure function of the payload).
function relTime(iso, nowIso) {
  if (!iso) return '';
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (isNaN(then) || isNaN(now)) return '';
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 90) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 90) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 36) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

// ── Needs-you banner ───────────────────────────────────────────────────────
// Adaptive prominence: building/idle render as a calm one-line strip; halt /
// manual-test / ready / complete render as a bold coloured card. Wording is
// warm and jargon-free — never the internal word "halt".
function renderBanner(data) {
  const now = data.now || { kind: 'idle' };
  const ov = data.overview || {};

  const calm = (icon, text) =>
    `<div class="banner calm"><span class="b-icon">${icon}</span><span class="b-text">${text}</span></div>`;
  // `title` is auto-escaped; `detail` is inserted as RAW HTML so callers can embed
  // <strong>/<code>. EVERY state-derived value placed into `detail` MUST be wrapped
  // in esc() by the caller (see storyLead/the cases below) — passing an un-esc()'d
  // value from state would inject markup into the dashboard.
  const card = (kind, icon, title, detail) =>
    `<div class="banner card ${kind}">
       <span class="b-icon">${icon}</span>
       <div class="b-body"><div class="b-title">${esc(title)}</div>${detail ? `<div class="b-detail">${detail}</div>` : ''}</div>
     </div>`;

  const storyLead = (n) => {
    if (now.storyIndex == null) return now.epicName ? esc(now.epicName) : '';
    const t = now.storyTitle ? ` · ${esc(now.storyTitle)}` : '';
    return `Story ${esc(now.storyIndex)}${t}`;
  };

  switch (now.kind) {
    case 'halt': {
      const reason = now.reason ? `${esc(now.reason)} ` : '';
      const lead = storyLead();
      const detail = `${lead ? `<strong>${lead}</strong> — ` : ''}${reason}Reply in Claude Code to continue.`;
      return card('attn', '⏸', 'Waiting on you', detail);
    }
    case 'manual-test': {
      const intro = `${now.epicName ? `“${esc(now.epicName)}”` : 'This feature'} is built — try it out, then tell Claude how it went.`;
      // Reopen link — present only when the data layer confirmed the check-off page
      // is on disk (now.reviewPage). Opens in a new tab so the dashboard stays put.
      const action = now.reviewPage
        ? `<a class="b-action" href="${esc(now.reviewPage)}" target="_blank" rel="noopener">▶ Open your review</a>`
        : '';
      return card('review', '👀', 'Ready for your review', `${intro}${action}`);
    }
    case 'ready':
      return card('ready', '▶', 'Ready when you are',
        now.readyCount > 1
          ? `${now.readyCount} epics are ready to start.`
          : `${now.epicName ? `<strong>${esc(now.epicName)}</strong>` : 'An epic'} can start next.`);
    case 'ready-to-build': {
      const nm = now.epicName ? `<strong>${esc(now.epicName)}</strong>` : 'An epic';
      const cnt = now.storiesTotal ? ` — ${now.storiesTotal} stories planned` : '';
      return card('ready', '◆', 'Planned, ready to build',
        `${nm}${cnt}. Run <code>/start</code> to build it.`);
    }
    case 'complete':
      return card('done', '✓', 'All done',
        `${ov.epicsTotal ?? 0} epics · ${ov.storiesDone ?? 0} stories.`);
    case 'building': {
      if (now.phase === 'PLAN') return calm('⚙', `Planning <strong>${esc(now.epicName ?? '')}</strong>`);
      if (now.phase === 'EPIC-END') return calm('⚙', `Running tests for <strong>${esc(now.epicName ?? '')}</strong>`);
      if (now.phase === 'COMPLETE-ON-BRANCH') return calm('⚙', `Wrapping up <strong>${esc(now.epicName ?? '')}</strong>`);
      if (now.storyIndex != null) {
        const t = now.storyTitle ? ` — ${esc(now.storyTitle)}` : '';
        return calm('⚙', `Building · Story ${esc(now.storyIndex)} of ${now.storiesTotal || '?'}${t}`);
      }
      return calm('⚙', `Building <strong>${esc(now.epicName ?? '')}</strong>`);
    }
    default:
      return calm('○', 'No active work. Run <code>/start</code> to begin an epic.');
  }
}

// ── Overview card ────────────────────────────────────────────────────────────
function renderOverview(data) {
  const ov = data.overview || { epicsComplete: 0, epicsTotal: 0, storiesDone: 0, storiesTotal: 0 };
  const pct = ov.storiesTotal ? Math.round((ov.storiesDone / ov.storiesTotal) * 100) : 0;
  return `
  <div class="overview">
    <div class="ov-stat"><div class="ov-num">${ov.epicsComplete}<span class="ov-of">/${ov.epicsTotal}</span></div><div class="ov-label">epics complete</div></div>
    <div class="ov-stat"><div class="ov-num">${ov.storiesDone}<span class="ov-of">/${ov.storiesTotal}</span></div><div class="ov-label">stories built</div></div>
    <div class="ov-bar-wrap">
      <div class="progress-bar"><div class="fill green" style="width:${pct}%"></div></div>
      <div class="ov-pct">${pct}% of known stories</div>
    </div>
  </div>`;
}

// ── Active epic phase pipeline ───────────────────────────────────────────────
function renderPipeline(active) {
  if (!active || active.phase == null) return '';
  const current = phaseRank(active.phase);
  const steps = PIPELINE.map((p, i) => {
    const cls = i < current ? 'done' : i === current ? 'active' : '';
    const tipId = `ph-${i}`;
    return `<div class="step-wrap">
        <div class="step ${cls}" tabindex="0" aria-describedby="${tipId}">${esc(p.label)}</div>
        <div class="step-tip" role="tooltip" id="${tipId}">${esc(p.tip)}</div>
      </div>`;
  }).join('<span class="arrow">›</span>');
  return `
  <div class="pipeline-card">
    <div class="pipeline-label">${esc(active.name ?? `epic/${active.slug}`)}</div>
    <div class="pipeline">${steps}</div>
  </div>`;
}

// ── Epics table ──────────────────────────────────────────────────────────────
function storyMarker(status) {
  return status === 'complete' ? '✓'
    : status === 'in-progress' ? '◐'
    : status === 'halted' ? '⏸'
    : '○';
}

// Browser-test (E2E) marker for a story row. Both passing states — `passed` and
// `passed-after-fix` — collapse to a single green check: by the time a user reads
// this, how a story reached green isn't actionable to them (the fix-cycle
// distinction is a build-report metric, not a dashboard one). A genuine failure
// shows a red cross — defensive; an epic shouldn't reach the dashboard's shown
// epics while failing. Everything else (deferred, or auto-skipped for
// non-routable / fixme specs) has no browser-test result to show, so nothing is
// rendered rather than a misleading badge.
function e2eMarker(e2eStatus) {
  if (e2eStatus && e2eStatus.startsWith('passed')) return `<span class="e2e ok" title="Browser tests passed">✓</span>`;
  if (e2eStatus === 'failed') return `<span class="e2e bad" title="Browser tests failed">✗</span>`;
  return '';
}

function renderStoryRows(storyList) {
  return (storyList || []).map(s => {
    const label = s.title ? `Story ${esc(s.index)} — ${esc(s.title)}` : `Story ${esc(s.index)}`;
    return `<div class="story-row st-${esc(s.status)}">
        <span class="story-marker">${storyMarker(s.status)}</span>
        <span class="story-label">${label}</span>
        ${e2eMarker(s.e2eStatus)}
      </div>`;
  }).join('');
}

function progressCell(complete, total) {
  if (!total) return `<span class="prog-empty">—</span>`;
  const pct = Math.round((complete / total) * 100);
  return `<div class="prog">
      <div class="progress-bar"><div class="fill ${pct === 100 ? 'green' : 'primary'}" style="width:${pct}%"></div></div>
      <span class="prog-num">${complete}/${total}</span>
    </div>`;
}

// One epic row. `state` is the derived plan status (done | in-flight | ready |
// blocked | ready-to-build) or 'off-plan' for an in-flight epic the plan doesn't
// list. Any epic given a `storyList` renders as a <details> with per-story rows —
// open when it's the active epic, collapsed otherwise.
function renderEpicRow({ name, slug, state, phase, stories, storyList, waitingOn, completedAt, lastUpdated, isActive, generatedAt }) {
  const title = name || slug;
  let stateBadge, progress, meta = '';

  if (state === 'done') {
    stateBadge = badge(PHASE_BADGE['COMPLETE'].label, PHASE_BADGE['COMPLETE'].color);
    // Show the REAL complete/total — not total/total. A merged epic normally has
    // complete === total, but if a story was skipped the row would otherwise read
    // 100% while the overview's storiesDone counts the true (lower) number.
    progress = progressCell(stories?.complete ?? 0, stories?.total ?? 0);
    meta = completedAt ? `<span class="row-meta">${esc((completedAt).slice(0, 10))}</span>` : '';
  } else if (state === 'in-flight' || state === 'off-plan' || state === 'ready-to-build') {
    stateBadge = renderPhaseBadge(phase);
    progress = progressCell(stories?.complete ?? 0, stories?.total ?? 0);
    const rt = relTime(lastUpdated, generatedAt);
    meta = rt ? `<span class="row-meta">${esc(rt)}</span>` : '';
  } else if (state === 'ready') {
    stateBadge = badge('NEXT UP', '#10b981', 'dependencies met — ready to start next');
    progress = `<span class="prog-empty">—</span>`;
  } else { // blocked
    stateBadge = badge('BLOCKED', '#f59e0b', 'waiting on other epics to finish');
    progress = `<span class="prog-empty">—</span>`;
  }

  const head = `<div class="epic-head">
      <span class="epic-name">${esc(title)}${isActive ? ' <span class="here">you are here</span>' : ''}</span>
      <span class="epic-badge">${stateBadge}</span>
      <span class="epic-prog">${progress}</span>
      <span class="epic-meta">${meta}</span>
    </div>`;

  const expandable = storyList && storyList.length;
  if (expandable) {
    // Any epic with a story list can expand to its per-story rows. The active epic
    // is open by default; completed and planned epics are collapsed until the user
    // opens them (their open/closed choice is then remembered per epic).
    const open = !!isActive;
    return `<details class="epic" id="epic-${esc(slug)}" data-default-open="${open}"${open ? ' open' : ''}>
      <summary class="epic-summary">${head}</summary>
      <div class="story-list">${renderStoryRows(storyList)}</div>
    </details>`;
  }

  const waits = (state === 'blocked' && (waitingOn || []).length)
    ? `<div class="waits">waiting on ${waitingOn.map(d => `<code>${esc(d)}</code>`).join(', ')}</div>`
    : '';
  return `<div class="epic flat${state === 'ready' ? ' is-ready' : ''}">${head}${waits}</div>`;
}

function renderEpicsSection(data) {
  const inflightBySlug = new Map(data.inFlight.map(e => [e.slug, e]));
  const mergedBySlug = new Map(data.merged.map(e => [e.slug, e]));
  const rows = [];

  if (data.hasPlan) {
    // Plan order — the full intended set, each row showing its current state.
    for (const p of data.plan) {
      const inf = inflightBySlug.get(p.slug);
      const mer = mergedBySlug.get(p.slug);
      if (p.status === 'done') {
        rows.push(renderEpicRow({ name: p.name, slug: p.slug, state: 'done', stories: mer?.stories, storyList: mer?.storyList, completedAt: mer?.completedAt, generatedAt: data.generatedAt }));
      } else if ((p.status === 'in-flight' || p.status === 'ready-to-build') && inf) {
        rows.push(renderEpicRow({ name: p.name, slug: p.slug, state: p.status, phase: inf.phase, stories: inf.stories, storyList: inf.storyList, isActive: inf.isActive, lastUpdated: inf.lastUpdated, generatedAt: data.generatedAt }));
      } else {
        rows.push(renderEpicRow({ name: p.name, slug: p.slug, state: p.status, waitingOn: p.waitingOn }));
      }
    }
    // In-flight epics the plan doesn't list (off-plan, invalid-slug, missing-state)
    // — never hide a running/broken branch behind the plan.
    const planSlugs = new Set(data.plan.map(p => p.slug));
    for (const e of data.inFlight) {
      if (planSlugs.has(e.slug)) continue;
      rows.push(renderEpicRow({ name: e.name, slug: e.slug, state: 'off-plan', phase: e.phase, stories: e.stories, storyList: e.storyList, isActive: e.isActive, lastUpdated: e.lastUpdated, generatedAt: data.generatedAt }));
    }
    // Merged epics the plan doesn't list (off-plan completed — a hotfix epic, or one later
    // dropped from the plan). They're counted in the overview totals, so they must appear in
    // the table too rather than silently vanishing while still inflating the counts.
    // (Selection computed once in the data layer as data.offPlanMerged.)
    for (const e of data.offPlanMerged || []) {
      rows.push(renderEpicRow({ name: e.name, slug: e.slug, state: 'done', stories: e.stories, storyList: e.storyList, completedAt: e.completedAt, generatedAt: data.generatedAt }));
    }
  } else {
    // No epic plan (migrated / pre-decomposition): in-flight then merged.
    for (const e of data.inFlight) {
      rows.push(renderEpicRow({ name: e.name, slug: e.slug, state: 'off-plan', phase: e.phase, stories: e.stories, storyList: e.storyList, isActive: e.isActive, lastUpdated: e.lastUpdated, generatedAt: data.generatedAt }));
    }
    for (const e of data.merged) {
      rows.push(renderEpicRow({ name: e.name, slug: e.slug, state: 'done', stories: e.stories, storyList: e.storyList, completedAt: e.completedAt, generatedAt: data.generatedAt }));
    }
  }

  const body = rows.length ? rows.join('') : `<div class="empty">No epics yet. Run <code>/start</code> to begin one.</div>`;
  return `
  <details id="section-epics" data-default-open="true" open>
    <summary class="section-summary">Epics &amp; Stories<span class="section-meta">${data.overview?.epicsComplete ?? 0}/${data.overview?.epicsTotal ?? 0} epics · ${data.overview?.storiesDone ?? 0} stories built</span></summary>
    <div class="section-body">${body}</div>
  </details>`;
}

// ── Shell ────────────────────────────────────────────────────────────────────
const BRAND_SVG = `<svg width="32" height="16" viewBox="0 0 32 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs><linearGradient id="s8grad" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#3B82F6"/><stop offset="100%" stop-color="#10B981"/></linearGradient></defs>
  <path d="M8 2C4.5 2 2 4.5 2 8s2.5 6 6 6c2 0 3.5-1 4.5-2.5L16 8l-3.5-3.5C11.5 3 10 2 8 2zm16 0c-2 0-3.5 1-4.5 2.5L16 8l3.5 3.5C20.5 13 22 14 24 14c3.5 0 6-2.5 6-6s-2.5-6-6-6z" fill="none" stroke="url(#s8grad)" stroke-width="2" stroke-linecap="round"/>
</svg>`;

function shell(bodyHtml, slugForKeys) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="10">
<title>Stadium Builder Dashboard</title>
<style>
  :root {
    --bg: #111113; --surface: #1C1C1F; --surface2: #2A2A2E; --border: #3A3A3F;
    --text: #E4E4E7; --sub: #A1A1AA; --primary: #3B82F6; --secondary: #10B981;
    --green: #a6e3a1; --yellow: #f9e2af; --red: #f38ba8; --teal: #94e2d5;
    --peach: #fab387; --purple: #c4a7e7;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); padding: 24px; line-height: 1.5; max-width: 920px; margin: 0 auto; }
  a { color: inherit; }
  code { background: var(--surface2); padding: 1px 6px; border-radius: 4px; font-size: 0.9em; font-family: ui-monospace, SFMono-Regular, monospace; }

  .header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
  .header-titles h1 { font-size: 20px; font-weight: 600; line-height: 1.2; }
  .header-titles .subtitle { font-size: 11px; color: var(--sub); letter-spacing: 1.5px; text-transform: uppercase; }
  .timestamp { margin-left: auto; font-size: 12px; color: var(--sub); }

  /* Needs-you banner */
  .banner { border-radius: 10px; margin-bottom: 16px; display: flex; align-items: flex-start; gap: 12px; }
  .banner .b-icon { flex-shrink: 0; line-height: 1.4; }
  .banner.calm { background: var(--surface); border: 1px solid var(--border); padding: 10px 16px; font-size: 13px; color: var(--sub); align-items: center; }
  .banner.calm .b-icon { color: var(--secondary); }
  .banner.calm strong { color: var(--text); font-weight: 600; }
  .banner.card { padding: 16px 18px; border: 1px solid; }
  .banner.card .b-icon { font-size: 18px; }
  .banner.card .b-title { font-size: 15px; font-weight: 700; }
  .banner.card .b-detail { font-size: 13px; color: var(--text); margin-top: 3px; opacity: 0.92; }
  .banner.card strong { font-weight: 600; }
  .banner.attn   { background: rgba(250,179,135,0.10); border-color: rgba(250,179,135,0.45); }
  .banner.attn .b-icon, .banner.attn .b-title { color: var(--peach); }
  .banner.review { background: rgba(196,167,231,0.10); border-color: rgba(196,167,231,0.45); }
  .banner.review .b-icon, .banner.review .b-title { color: var(--purple); }
  .banner.card .b-action { display: block; width: fit-content; margin-top: 10px; font-size: 12px; font-weight: 600; text-decoration: none; padding: 6px 12px; border-radius: 6px; }
  .banner.review .b-action { background: rgba(196,167,231,0.16); color: var(--purple); border: 1px solid rgba(196,167,231,0.45); }
  .banner.review .b-action:hover { background: rgba(196,167,231,0.26); }
  .banner.ready  { background: rgba(166,227,161,0.10); border-color: rgba(166,227,161,0.40); }
  .banner.ready .b-icon, .banner.ready .b-title { color: var(--green); }
  .banner.done   { background: linear-gradient(135deg, rgba(59,130,246,0.12), rgba(16,185,129,0.12)); border-color: rgba(16,185,129,0.40); }
  .banner.done .b-icon, .banner.done .b-title { color: var(--secondary); }

  /* Overview */
  .overview { display: flex; align-items: center; gap: 24px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; margin-bottom: 16px; }
  .ov-stat { text-align: center; flex-shrink: 0; }
  .ov-num { font-size: 24px; font-weight: 700; }
  .ov-num .ov-of { font-size: 15px; font-weight: 500; color: var(--sub); }
  .ov-label { font-size: 11px; color: var(--sub); text-transform: uppercase; letter-spacing: 0.5px; }
  .ov-bar-wrap { flex: 1; }
  .ov-pct { font-size: 11px; color: var(--sub); margin-top: 6px; text-align: right; }

  /* Phase pipeline */
  .pipeline-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 16px; }
  .pipeline-label { font-size: 11px; font-weight: 600; color: var(--sub); text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 10px; }
  .pipeline { display: flex; gap: 4px; align-items: center; }
  .step-wrap { position: relative; flex: 1; }
  .step { text-align: center; padding: 7px 4px; border-radius: 6px; font-size: 10px; font-weight: 700; letter-spacing: 0.5px; background: var(--surface2); color: var(--sub); cursor: help; }
  .step.done { background: rgba(166,227,161,0.15); color: var(--green); }
  .step.active { background: rgba(59,130,246,0.18); color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
  .arrow { color: var(--border); font-size: 14px; flex-shrink: 0; }
  .step-tip { position: absolute; top: calc(100% + 8px); left: 50%; transform: translateX(-50%); background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-size: 11px; font-weight: 400; line-height: 1.5; color: var(--text); width: 210px; text-align: left; opacity: 0; pointer-events: none; transition: opacity 0.15s; z-index: 50; box-shadow: 0 4px 16px rgba(0,0,0,0.5); }
  .step-tip::before { content: ''; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); border: 5px solid transparent; border-bottom-color: var(--border); }
  .step-wrap:hover .step-tip, .step-wrap:focus-within .step-tip { opacity: 1; pointer-events: auto; }

  /* Collapsible section */
  details { margin-bottom: 16px; }
  .section-summary { display: flex; align-items: center; gap: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; cursor: pointer; font-size: 14px; font-weight: 600; list-style: none; }
  .section-summary::-webkit-details-marker { display: none; }
  .section-summary::before { content: '\\25B8'; color: var(--sub); font-size: 12px; transition: transform 0.15s; }
  details[open] > .section-summary::before { transform: rotate(90deg); }
  details[open] > .section-summary { border-radius: 10px 10px 0 0; }
  .section-meta { margin-left: auto; font-size: 12px; font-weight: 400; color: var(--sub); }
  .section-body { background: var(--surface); border: 1px solid var(--border); border-top: none; border-radius: 0 0 10px 10px; padding: 8px 16px; }

  /* Epic rows */
  .epic { border-bottom: 1px solid var(--surface2); }
  .epic:last-child { border-bottom: none; }
  .epic.flat { padding: 10px 0; }
  .epic.is-ready .epic-name { color: var(--green); }
  .epic-summary { list-style: none; cursor: pointer; padding: 10px 0; }
  .epic-summary::-webkit-details-marker { display: none; }
  .epic-head { display: flex; align-items: center; gap: 12px; }
  details.epic > .epic-summary .epic-head::before { content: '\\25B8'; color: var(--sub); font-size: 10px; transition: transform 0.15s; margin-right: -4px; }
  details.epic[open] > .epic-summary .epic-head::before { transform: rotate(90deg); }
  .epic-name { flex: 1; font-weight: 600; font-size: 13px; }
  .here { font-size: 10px; font-weight: 600; color: var(--primary); background: rgba(59,130,246,0.15); padding: 1px 6px; border-radius: 4px; margin-left: 6px; letter-spacing: 0.3px; text-transform: uppercase; }
  .epic-badge { width: 130px; flex-shrink: 0; }
  .epic-prog { width: 150px; flex-shrink: 0; }
  .epic-meta { width: 70px; flex-shrink: 0; text-align: right; }
  .badge { display: inline-block; color: #11111b; font-size: 10px; font-weight: 700; padding: 3px 8px; border-radius: 4px; letter-spacing: 0.04em; }
  .prog { display: flex; align-items: center; gap: 8px; }
  .prog-num { font-size: 11px; color: var(--sub); }
  .prog-empty { color: var(--border); }
  .progress-bar { flex: 1; height: 6px; background: var(--surface2); border-radius: 3px; overflow: hidden; min-width: 60px; }
  .fill { height: 100%; border-radius: 3px; transition: width 0.3s ease; }
  .fill.green { background: var(--green); }
  .fill.primary { background: var(--primary); }
  .row-meta { font-size: 11px; color: var(--sub); }
  .waits { font-size: 11px; color: var(--sub); padding: 0 0 8px 0; }
  .waits code { font-size: 10px; }

  /* Story rows */
  .story-list { padding: 2px 0 10px 0; }
  .story-row { display: flex; align-items: center; gap: 8px; padding: 4px 0 4px 8px; font-size: 12px; color: var(--sub); border-top: 1px solid var(--surface2); }
  .story-marker { width: 14px; text-align: center; flex-shrink: 0; }
  .story-row.st-complete .story-marker { color: var(--green); }
  .story-row.st-in-progress { color: var(--text); }
  .story-row.st-in-progress .story-marker { color: var(--primary); }
  .story-row.st-halted .story-marker { color: var(--peach); }
  .story-label { flex: 1; }
  .e2e { font-size: 11px; font-weight: 700; line-height: 1; padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
  .e2e.ok { background: rgba(166,227,161,0.15); color: var(--green); }
  .e2e.bad { background: rgba(243,139,168,0.15); color: var(--red); }

  .empty { color: var(--sub); font-style: italic; padding: 12px 0; }
  .footer { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); font-size: 12px; color: var(--sub); display: flex; align-items: center; gap: 20px; }
  .footer-brand { margin-left: auto; font-size: 10px; opacity: 0.6; letter-spacing: 1px; text-transform: uppercase; }
  .auto-refresh { font-size: 10px; color: var(--sub); opacity: 0.5; margin-top: 8px; text-align: right; }
</style>
</head>
<body>
${bodyHtml}
<script>
(function() {
  var prefix = 'stadium8-' + ${JSON.stringify(slugForKeys || 'project')} + '-';
  document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('details[id][data-default-open]').forEach(function(el) {
      var key = prefix + el.id, saved = null;
      try { saved = JSON.parse(localStorage.getItem(key)); } catch (e) {}
      if (saved && saved.defaultOpen === el.getAttribute('data-default-open')) {
        if (saved.open && !el.open) el.open = true;
        if (!saved.open && el.open) el.removeAttribute('open');
      } else { try { localStorage.removeItem(key); } catch (e) {} }
    });
    document.addEventListener('toggle', function(e) {
      var el = e.target;
      if (el.tagName === 'DETAILS' && el.id && el.hasAttribute('data-default-open')) {
        try { localStorage.setItem(prefix + el.id, JSON.stringify({ open: el.open, defaultOpen: el.getAttribute('data-default-open') })); } catch (ex) {}
      }
    }, true);
  });
})();
</script>
</body>
</html>
`;
}

function renderHtml(data) {
  if (data.status === 'legacy_detected') {
    return shell(`
  <div class="header"><div class="header-titles"><h1>Legacy workflow detected</h1></div></div>
  <div class="banner card attn"><span class="b-icon">⏸</span><div class="b-body"><div class="b-title">Migration needed</div><div class="b-detail">${esc(data.message)} Run <code>/migrate-legacy</code>, then reload this page.</div></div></div>`, 'legacy');
  }
  if (data.status === 'no_project') {
    return shell(`
  <div class="header"><div class="header-titles"><h1>Getting started</h1></div></div>
  <div class="banner calm"><span class="b-icon">⚙</span><span class="b-text">${esc(data.message)}</span></div>`, 'none');
  }

  const projectName = data.project.name ?? '(unnamed project)';
  const active = data.inFlight.find(e => e.isActive) || null;
  const slugForKeys = (data.project.slug || data.project.name || 'project').replace(/[^A-Za-z0-9]+/g, '_');

  const header = `
  <div class="header">
    ${BRAND_SVG}
    <div class="header-titles">
      <h1>${esc(projectName)}</h1>
      <div class="subtitle">Stadium Builder</div>
    </div>
    <span class="timestamp">Generated ${esc(data.generatedAt.slice(0, 16).replace('T', ' '))} UTC</span>
  </div>`;

  const body = [
    header,
    renderBanner(data),
    renderOverview(data),
    renderPipeline(active),
    renderEpicsSection(data),
    `<div class="footer"><span><code>/quality-check</code> before a PR</span><span class="footer-brand">Stadium Builder</span></div>`,
    `<div class="auto-refresh">Auto-refreshes every 10 seconds</div>`
  ].join('\n');

  return shell(body, slugForKeys);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = collect(args.root);

  const htmlPath = path.join(args.root, OUT_HTML);
  const jsonPath = path.join(args.root, OUT_JSON);
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, renderHtml(data));
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2) + '\n');

  process.stdout.write(JSON.stringify({ status: 'ok', htmlPath: OUT_HTML, jsonPath: OUT_JSON, dataStatus: data.status }, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = { renderHtml };
