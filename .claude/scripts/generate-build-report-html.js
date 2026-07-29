#!/usr/bin/env node
/**
 * generate-build-report-html.js
 *
 * Renders the /build-report retrospective as a single self-contained, interactive
 * HTML page (no external assets — opens straight from disk via file://). Data comes
 * from collect-build-report-data.js; presentation matches the dark dashboard theme.
 *
 * Two layers, kept deliberately separate:
 *   • Metrics, timeline, per-epic effort, stumbling blocks — DETERMINISTIC, straight
 *     from the collector, so the numbers read the same every run.
 *   • An optional "What this means" insight panel — narrative the orchestrator writes
 *     by following .claude/prompts/build-report-insights.md (a prompt YOU can tweak).
 *     Picked up automatically from generated-docs/build-report-insights.md when present.
 *
 * Usage:
 *   node .claude/scripts/generate-build-report-html.js [--collect] [--root <dir>]
 *   node .claude/scripts/generate-build-report-html.js --audience stakeholders  # delivery report variant
 *   node .claude/scripts/generate-build-report-html.js --insights <file>   # override insight source
 *   node .claude/scripts/generate-build-report-html.js --no-insights       # metrics only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { collect, fmtDuration, FIX_RE } = require('./collect-build-report-data');
const { getProjectRoot } = require('./lib/project-root');
const { GENERATED_DOCS_REL } = require('./resolve-state-path'); // layout SSOT — derive output paths from it so they can't drift
const { esc } = require('./lib/html-escape');

const OUT_JSON = path.posix.join(GENERATED_DOCS_REL, 'build-report-data.json');

// Each audience gets its own page composition, its own editable insights prompt,
// and its own output file — the collected data is shared.
//   maintainer   — the full benchmark: performance ratios, churn, timeline,
//                  stumbling blocks. The default.
//   stakeholders — a delivery report for non-technical readers: what shipped,
//                  the quality evidence, what's still to come. No internals.
const AUDIENCES = {
  maintainer: {
    html: path.posix.join(GENERATED_DOCS_REL, 'build-report.html'),
    insights: path.posix.join(GENERATED_DOCS_REL, 'build-report-insights.md'),
    prompt: '.claude/prompts/build-report-insights.md'
  },
  stakeholders: {
    html: path.posix.join(GENERATED_DOCS_REL, 'build-report-stakeholders.html'),
    insights: path.posix.join(GENERATED_DOCS_REL, 'build-report-insights-stakeholders.md'),
    prompt: '.claude/prompts/build-report-insights.stakeholders.md'
  }
};

function parseArgs(argv) {
  const args = { root: getProjectRoot(), insights: undefined, noInsights: false, audience: 'maintainer' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = path.resolve(argv[++i]);
    else if (a === '--insights') args.insights = argv[++i];
    else if (a === '--no-insights') args.noInsights = true;
    else if (a === '--audience') args.audience = argv[++i];
    else if (a.startsWith('--audience=')) args.audience = a.split('=')[1];
    // --collect is implicit (this script always collects); accepted for parity with /dashboard.
  }
  return args;
}

// Minimal, SAFE markdown → HTML for journal + insight prose. Escapes first, then
// applies a small whitelist (## headings, - bullets, **bold**, `code`, blank-line
// paragraphs). No raw HTML from the source ever reaches the page.
function mdLite(src) {
  if (!src) return '';
  const inline = (t) => esc(t)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  let inList = false;
  let para = []; // buffer consecutive plain lines so a hard-wrapped paragraph (and any
                 // **bold** or `code` that straddles a line break) renders as one <p>.
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    let m;
    if ((m = line.match(/^#{1,6}\s+(.+)/))) { flushPara(); closeList(); out.push(`<h5>${inline(m[1])}</h5>`); }
    else if ((m = line.match(/^[-*]\s+(.+)/))) { flushPara(); if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (line.trim() === '') { flushPara(); closeList(); }
    else { closeList(); para.push(line.trim()); }
  }
  flushPara();
  closeList();
  return out.join('\n');
}

function fmtDate(iso) { return iso ? iso.slice(0, 10) : ''; }
function fmtTime(iso) { return iso ? iso.slice(11, 16) : ''; }
function fmtNum(n) { return Number(n ?? 0).toLocaleString('en-US'); }
function fmtMs(ms) {
  const m = Math.round((ms || 0) / 60000);
  if (m < 1) return '<1m';
  return fmtDuration(m);
}
function fmtTok(n) {
  if (n == null) return '—';
  if (n < 1e3) return String(n);
  if (n < 1e6) return `${Math.round(n / 1e3)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

// ── Cards ────────────────────────────────────────────────────────────────────
function statCard(value, label, sub) {
  return `<div class="stat"><div class="stat-v">${esc(value)}</div><div class="stat-l">${esc(label)}</div>${sub ? `<div class="stat-s">${esc(sub)}</div>` : ''}</div>`;
}

// ── Timeline: sessions grouped by day, bars scaled to the busiest session ─────
function renderTimeline(t) {
  if (!t.sessions.length) return '<p class="muted">No commits yet.</p>';
  const maxDur = Math.max(1, ...t.sessions.map((s) => s.durationMin));
  const byDay = new Map();
  for (const s of t.sessions) {
    if (!byDay.has(s.day)) byDay.set(s.day, []);
    byDay.get(s.day).push(s);
  }
  const rows = [];
  for (const [day, sessions] of byDay) {
    const dayMin = sessions.reduce((n, s) => n + s.durationMin, 0);
    const chips = sessions.map((s, i) => {
      const w = Math.max(3, Math.round((s.durationMin / maxDur) * 100));
      const fixes = s.commits.filter((c) => FIX_RE.test(c.subject)).length; // same predicate as the fix/rework tiles
      const commitsList = s.commits.map((c) =>
        `<li><span class="c-time">${fmtTime(c.date)}</span> ${esc(c.subject)}</li>`).join('');
      return `<div class="sess">
          <div class="sess-head" onclick="this.parentNode.classList.toggle('open')">
            <span class="sess-time">${fmtTime(s.start)}–${fmtTime(s.end)}</span>
            <span class="bar"><span class="bar-fill${fixes ? ' has-fix' : ''}" style="width:${w}%"></span></span>
            <span class="sess-meta">${s.durationMin ? fmtDuration(s.durationMin) : '·'} · ${s.commitCount} commit${s.commitCount === 1 ? '' : 's'}${fixes ? ` · ${fixes} fix` : ''}</span>
          </div>
          <ul class="commits">${commitsList}</ul>
        </div>`;
    }).join('');
    rows.push(`<div class="day"><div class="day-label">${esc(day)}<span class="day-sum">${fmtDuration(dayMin)}</span></div><div class="day-sessions">${chips}</div></div>`);
  }
  return rows.join('');
}

// ── Build flow: story swimlanes per day — what ran in parallel ────────────────
// One lane per epic, one bar per story (startedAt → completedAt), day-segmented
// like the Timeline so idle nights don't crush the axis. Hatched shoulders are
// the derived phases around the stories (plan/test-gen before, epic-end checks
// after); the in-flight strip counts concurrent stories. Lane colors are fixed
// categorical slots (--flow-1..8, CVD-validated for this surface); lanes are
// also direct-labeled, so identity never rides on color alone.
function renderBuildFlow(data) {
  const epics = (data.epics || []).filter((e) => e.flow && e.flow.stories.length);
  const bf = data.buildFlow;
  if (!bf || !epics.length) {
    return '<p class="muted">No story timing recorded yet — story start/finish times appear here as epics are built.</p>';
  }

  // Order lanes by first story start; color follows the epic, never the day.
  const ordered = epics.slice().sort((a, b) => Date.parse(a.flow.stories[0].startedAt) - Date.parse(b.flow.stories[0].startedAt));
  const colorOf = new Map(ordered.map((e, i) => [e.slug, (i % 8) + 1]));

  // Collect every drawable segment, grouped by the day its story ran.
  const days = new Map(); // day → { lanes: Map(slug → segs[]), intervals: [[ms,ms]] }
  const day0 = (iso) => String(iso).slice(0, 10);
  const getDay = (k) => { if (!days.has(k)) days.set(k, { lanes: new Map(), intervals: [] }); return days.get(k); };
  const pushSeg = (d, slug, seg) => { if (!d.lanes.has(slug)) d.lanes.set(slug, []); d.lanes.get(slug).push(seg); };
  for (const e of ordered) {
    const first = e.flow.stories[0];
    if (e.createdAt && day0(e.createdAt) === day0(first.startedAt) && Date.parse(first.startedAt) - Date.parse(e.createdAt) > 60e3) {
      pushSeg(getDay(day0(first.startedAt)), e.slug, { kind: 'lead', start: Date.parse(e.createdAt), end: Date.parse(first.startedAt) });
    }
    for (const s of e.flow.stories) {
      const d = getDay(day0(s.startedAt));
      pushSeg(d, e.slug, { kind: 'story', start: Date.parse(s.startedAt), end: Date.parse(s.completedAt), story: s });
      d.intervals.push([Date.parse(s.startedAt), Date.parse(s.completedAt)]);
    }
    const last = e.flow.stories[e.flow.stories.length - 1];
    if (e.flow.wrapUp && Date.parse(e.flow.wrapUp.endedAt) - Date.parse(last.completedAt) > 60e3) {
      pushSeg(getDay(day0(last.completedAt)), e.slug, { kind: 'wrap', start: Date.parse(last.completedAt), end: Date.parse(e.flow.wrapUp.endedAt), commits: e.flow.wrapUp.commits });
    }
  }

  const utcHM = (ms) => new Date(ms).toISOString().slice(11, 16);
  const nameOf = (slug) => ordered.find((e) => e.slug === slug).name;

  const rows = [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, d]) => {
    const times = [...d.lanes.values()].flat().flatMap((s) => [s.start, s.end]);
    const pad = 5 * 60e3;
    const t0 = Math.min(...times) - pad, t1 = Math.max(...times) + pad;
    const X = (t) => ((t - t0) / (t1 - t0)) * 100;

    let ticks = '';
    for (let h = Math.ceil(t0 / 36e5) * 36e5; h < t1; h += 36e5) {
      ticks += `<span class="ftick" style="left:${X(h).toFixed(2)}%"><i></i>${utcHM(h)}</span>`;
    }

    const lanes = [...d.lanes.entries()]
      .sort(([, a], [, b]) => Math.min(...a.map((s) => s.start)) - Math.min(...b.map((s) => s.start)))
      .map(([slug, segs]) => {
        const ci = colorOf.get(slug);
        const chips = segs.map((seg) => {
          const w = Math.max(0.6, X(seg.end) - X(seg.start));
          const range = `${utcHM(seg.start)}–${utcHM(seg.end)} UTC · ${fmtDuration(Math.round((seg.end - seg.start) / 60e3))}`;
          if (seg.kind === 'story') {
            const s = seg.story;
            const tip = `<strong>Story ${s.n}${s.title ? ` — ${esc(s.title)}` : ''}</strong><br>${esc(nameOf(slug))}<br>${range}<br>E2E: ${esc(s.e2eStatus || '—')} · commit ${esc(s.commit || '—')}`;
            const lbl = w >= 3 ? `<em>S${s.n}</em>` : '';
            return `<span class="fbar fc-${ci}" data-tip="${esc(tip)}" style="left:${X(seg.start).toFixed(2)}%;width:${w.toFixed(2)}%">${lbl}</span>`;
          }
          const what = seg.kind === 'lead'
            ? 'Plan &amp; test generation'
            : `Epic-end review, E2E &amp; manual test (${seg.commits} commit${seg.commits === 1 ? '' : 's'})`;
          const tip = `<strong>${what}</strong><br>${esc(nameOf(slug))}<br>${range}`;
          return `<span class="fshoulder fc-${ci}" data-tip="${esc(tip)}" style="left:${X(seg.start).toFixed(2)}%;width:${w.toFixed(2)}%"></span>`;
        }).join('');
        return `<div class="flane"><div class="flane-label"><span class="swatch fc-${ci}"></span>${esc(nameOf(slug))}</div><div class="ftrack">${chips}</div></div>`;
      }).join('');

    // In-flight strip: sweep the day's story intervals (ends before starts, so
    // back-to-back stories don't register as overlap).
    const ev = [];
    for (const [s, e] of d.intervals) ev.push([s, 1], [e, -1]);
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let n = 0, prev = null, steps = '';
    for (const [t, delta] of ev) {
      if (prev !== null && n > 0 && t > prev) {
        steps += `<span class="fstep" data-tip="<strong>${n} ${n === 1 ? 'story' : 'stories'} in flight</strong><br>${utcHM(prev)}–${utcHM(t)} UTC" style="left:${X(prev).toFixed(2)}%;width:${(X(t) - X(prev)).toFixed(2)}%;height:${n * 5}px"></span>`;
      }
      n += delta; prev = t;
    }

    const dayMin = Math.round(d.intervals.reduce((a, [s, e]) => a + (e - s) / 60e3, 0));
    return `<div class="day"><div class="day-label">${esc(day)}<span class="day-sum">${fmtDuration(dayMin)} of story work</span></div>
      <div class="fflow"><div class="fticks">${ticks}</div>${lanes}
      <div class="flane fconc"><div class="flane-label muted">in flight</div><div class="ftrack fconc-track">${steps}</div></div></div></div>`;
  }).join('');

  const stats = `<div class="stats tight">
    ${statCard(fmtDuration(bf.storyMinutes), 'story work completed', 'sum of story durations')}
    ${statCard(fmtDuration(bf.wallClockMinutes), 'wall-clock on stories', 'union of story windows')}
    ${statCard(`${bf.parallelism}×`, 'parallelism', 'story work ÷ wall-clock')}
    ${statCard(String(bf.peakInFlight), 'peak stories in flight', `${bf.overlapPct}% of story time ≥ 2 in flight`)}
  </div>`;

  const table = `<details><summary>Table view</summary>
    <table class="ftable"><thead><tr><th>Epic</th><th>#</th><th>Story</th><th>Day</th><th>Started</th><th>Finished</th><th>Duration</th><th>E2E</th></tr></thead>
    <tbody>${ordered.flatMap((e) => e.flow.stories.map((s) =>
      `<tr><td><span class="swatch fc-${colorOf.get(e.slug)}"></span>${esc(e.name)}</td><td>S${s.n}</td><td>${esc(s.title || '—')}</td><td>${esc(day0(s.startedAt))}</td><td>${fmtTime(s.startedAt)}</td><td>${fmtTime(s.completedAt)}</td><td>${fmtDuration(Math.round((Date.parse(s.completedAt) - Date.parse(s.startedAt)) / 60e3))}</td><td>${esc(s.e2eStatus || '—')}</td></tr>`)).join('')}
    </tbody></table></details>`;

  const legend = `<div class="legend">
    <span class="key"><span class="swatch fc-1"></span> solid bar = one story (S#), start → finish</span>
    <span class="key"><span class="fkey-hatch"></span> hatched = derived phases around the stories (plan/test-gen before, epic-end checks after)</span>
    <span class="key"><span class="fkey-step"></span> in-flight strip = concurrent stories</span>
  </div>`;

  // Tooltip layer: one fixed div fed by data-tip. Tip HTML is built from
  // esc()'d parts and the whole tip is esc()'d again into the attribute, so
  // getAttribute() decodes exactly one level — our tags render, story/epic
  // text stays inert.
  const script = `<div id="ftt"></div><script>
(function(){var tt=document.getElementById('ftt');
document.addEventListener('mousemove',function(e){
  var el=e.target.closest('[data-tip]');
  if(!el){tt.style.display='none';return}
  tt.innerHTML=el.getAttribute('data-tip');
  tt.style.display='block';
  tt.style.left=Math.min(e.clientX+14,innerWidth-tt.offsetWidth-8)+'px';
  tt.style.top=Math.min(e.clientY+14,innerHeight-tt.offsetHeight-8)+'px';
});})();
</script>`;

  return `${stats}${rows}${legend}${table}${script}`;
}

// ── Per-epic cards ───────────────────────────────────────────────────────────
function mtBadge(mt) {
  if (!mt || !mt.outcome) return '<span class="pill grey">not tested yet</span>';
  const o = String(mt.outcome).toLowerCase();
  const cls = /pass/.test(o) ? 'green' : /fail|mixed/.test(o) ? 'amber' : 'grey';
  const count = mt.total ? ` (${mt.passed}/${mt.total})` : '';
  return `<span class="pill ${cls}">manual test: ${esc(mt.outcome)}${count}</span>`;
}

function renderEpic(e) {
  const shared = e.sharedSessions ? '<span class="hint" title="Built interleaved with another epic; session time is shared, not exclusive.">shared time</span>' : '';
  const stat = (v, l) => `<div class="mini"><span class="mini-v">${esc(v)}</span><span class="mini-l">${esc(l)}</span></div>`;
  const window = e.firstCommit
    ? `${fmtDate(e.firstCommit.date)}${fmtDate(e.lastCommit.date) !== fmtDate(e.firstCommit.date) ? ` → ${fmtDate(e.lastCommit.date)}` : ''}`
    : '—';
  return `<div class="epic ${e.status}">
      <div class="epic-head" onclick="this.parentNode.classList.toggle('open')">
        <span class="epic-name">${esc(e.name)}</span>
        <span class="epic-tags">${mtBadge(e.manualTest)}${e.fixCommitCount ? `<span class="pill amber">${e.fixCommitCount} fix commit${e.fixCommitCount === 1 ? '' : 's'}</span>` : ''}${shared}</span>
        <span class="chevron">▾</span>
      </div>
      <div class="epic-stats">
        ${stat(`${e.stories.complete}/${e.stories.total}`, 'stories')}
        ${stat(fmtDuration(e.sessionMinutes), 'active time')}
        ${stat(window, 'window')}
        ${stat(e.commitCount, 'commits')}
        ${stat(e.stories.withE2e ? `${e.stories.firstPass}/${e.stories.withE2e}` : '—', 'E2E first pass')}
        ${stat(`+${fmtNum(e.linesAdded)} −${fmtNum(e.linesDeleted)}`, 'lines changed')}
        ${stat(e.unverifiedAssumptions, 'assumptions to verify')}
      </div>
      <div class="epic-body">
        ${e.manualTest && e.manualTest.note ? `<h5>Manual test</h5><div class="journal"><p>${esc(e.manualTest.note)}</p></div>` : ''}
        <h5>Build journal</h5>
        <div class="journal">${e.journal ? mdLite(e.journal) : '<p class="muted">No journal recorded.</p>'}</div>
      </div>
    </div>`;
}

// ── Workflow performance (maintainer benchmark) ──────────────────────────────
// A stacked proportion bar: segments [{label, value, cls}] with a 2px surface
// gap between fills; values live in the legend (text tokens), not on the marks.
function stackBar(segments, unit) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  if (!total) return '<p class="muted">Nothing to chart yet.</p>';
  const fills = segments.filter((s) => s.value > 0).map((s) => {
    const p = (100 * s.value) / total;
    return `<span class="seg ${s.cls}" style="flex-basis:${p.toFixed(2)}%" title="${esc(s.label)}: ${fmtNum(s.value)} ${esc(unit)} (${Math.round(p)}%)"></span>`;
  }).join('');
  const legend = segments.map((s) =>
    `<span class="key"><span class="swatch ${s.cls}"></span>${esc(s.label)} — <strong>${fmtNum(s.value)}</strong> ${esc(unit)} (${total ? Math.round((100 * s.value) / total) : 0}%)</span>`).join('');
  return `<div class="hbar">${fills}</div><div class="legend">${legend}</div>`;
}

// One horizontal magnitude-bar row, shared by the "active time by epic" and
// "cost by phase / epic" charts. The caller passes already-escaped strings.
function ebarRow({ title, name, nameSuffix = '', widthPct, value }) {
  return `<div class="ebar" title="${title}">
        <span class="ebar-name">${name}${nameSuffix}</span>
        <span class="ebar-track"><span class="ebar-fill" style="width:${widthPct.toFixed(1)}%"></span><span class="ebar-v">${value}</span></span>
      </div>`;
}

// Horizontal magnitude bars, one per epic — single series, so no legend; the
// value rides the bar tip and the epic name is the row label.
function epicTimeBars(epics) {
  const rows = epics.filter((e) => e.sessionMinutes > 0);
  if (!rows.length) return '';
  const max = Math.max(...rows.map((e) => e.sessionMinutes));
  return `<h5 class="sub-h">Active time by epic</h5>` + rows.map((e) => {
    const fixNote = e.fixCommitCount ? ` · ${e.fixCommitCount} fix commit${e.fixCommitCount === 1 ? '' : 's'}` : '';
    return ebarRow({
      title: `${esc(e.name)}: ${fmtDuration(e.sessionMinutes)} active${e.sharedSessions ? ' (shared with an interleaved epic)' : ''}${fixNote}`,
      name: esc(e.name),
      nameSuffix: e.sharedSessions ? '<span class="hint" title="Session time shared with an interleaved epic.">*</span>' : '',
      widthPct: Math.max(2, (100 * e.sessionMinutes) / max),
      value: fmtDuration(e.sessionMinutes)
    });
  }).join('');
}

function renderPerformance(data) {
  const p = data.performance;
  if (!p) return '';
  const fp = p.e2eFirstPass;
  const tiles = [
    fp.total ? statCard(`${fp.pct}%`, 'first-pass E2E yield', `${fp.passed} of ${fp.total} stories passed with no fix cycle`) : '',
    p.fixCommitSharePct != null ? statCard(`${p.fixCommitSharePct}%`, 'commits were fixes', `${p.reworkChurnPct ?? 0}% of changed lines were rework`) : '',
    p.minutesPerStory != null ? statCard(`~${fmtDuration(p.minutesPerStory)}`, 'active time per story', `${p.commitsPerStory} commits · ~${fmtNum(p.sourceLocPerStory)} source lines each`) : '',
    p.testToCodeRatio != null ? statCard(p.testToCodeRatio, 'test-to-code ratio', 'test lines per source line') : '',
    p.manualChecks ? statCard(`${p.manualChecks.pct}%`, 'manual checks passed', `${p.manualChecks.passed}/${p.manualChecks.total} human-verified checks`) : '',
    statCard(p.assumptionsOpen, 'assumptions to verify', 'flagged by the workflow, not yet confirmed')
  ].filter(Boolean).join('');
  const yieldBar = fp.total ? `<h5 class="sub-h">Story E2E outcomes</h5>${stackBar([
    { label: 'Passed first time', value: fp.passed, cls: 'sg-green' },
    { label: 'Needed a fix cycle', value: fp.total - fp.passed, cls: 'sg-amber' }
  ], 'stories')}` : '';
  return `<section class="panel">
      <h2>Workflow performance <span class="muted" style="font-size:.8rem;font-weight:400">— how efficiently the build ran</span></h2>
      <div class="stats tight">${tiles}</div>
      ${yieldBar}
      ${epicTimeBars(data.epics)}
    </section>`;
}

// ── Cost & user involvement (exact transcript-derived figures) ───────────────
// Everything in this panel comes from build-cost-data.json — exact token/
// cost/user-input counts and anchored waiting-on-user durations. When the file
// hasn't been generated the panel is skipped (the Data quality section says so).
function renderCostEffort(ce) {
  if (!ce) return '';
  const zar = (usd) => ce.usdToZar != null && usd != null
    ? `R${(usd * ce.usdToZar).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : null;
  const usd = (v) => (v != null ? `$${v.toFixed(2)}` : '—');
  // Default every field so a partial object from an older insights-data schema can't
  // surface as a literal "NaN"/"undefined" in a tile.
  const ui = ce.userInputs ? { typed: 0, commands: 0, manualTest: 0, interruptions: 0, ...ce.userInputs } : null;
  const uiTotal = ui ? ui.typed + ui.commands + ui.manualTest + ui.interruptions : null;
  const w = ce.waits ? { approvalMs: 0, approvalCount: 0, generalMs: 0, generalCount: 0, stallMs: 0, stallCount: 0, ...ce.waits } : null;
  const waitMs = w ? w.approvalMs + w.generalMs : null;
  const tiles = [
    ce.costUsd != null ? statCard(zar(ce.costUsd) || usd(ce.costUsd), 'estimated AI cost', `${usd(ce.costUsd)} at API list prices · ${fmtNum(ce.apiCalls)} API calls`) : '',
    ce.totalTokens != null ? statCard(fmtTok(ce.totalTokens), 'tokens processed', `${fmtTok(ce.outputTokens)} generated`) : '',
    ce.cacheHit != null ? statCard(`${Math.round(ce.cacheHit * 100)}%`, 'cache hit rate', 'share of input served from cache') : '',
    ce.agentsSpawned != null ? statCard(fmtNum(ce.agentsSpawned), 'sub-agents spawned', `${fmtNum(ce.questionsAsked)} questions asked`) : '',
    uiTotal != null ? statCard(fmtNum(uiTotal), 'deliberate user inputs', `${ui.typed} typed · ${ui.commands} commands · ${ui.manualTest} manual-test · ${ui.interruptions} interrupts`) : '',
    waitMs != null ? statCard(fmtMs(waitMs), 'waiting on user', `${w.approvalCount + w.generalCount} waits · stalls (${fmtMs(w.stallMs)} over ${w.stallCount}) kept apart`) : ''
  ].filter(Boolean).join('');
  const costBars = (ce.bucketCosts || []).filter((b) => b.costUsd > 0);
  const maxCost = Math.max(1e-9, ...costBars.map((b) => b.costUsd));
  const bars = costBars.length ? `<h5 class="sub-h">Cost by phase / epic</h5>` + costBars.map((b) => {
    const v = esc(zar(b.costUsd) || usd(b.costUsd));
    return ebarRow({
      title: `${esc(b.label)}: ${v}`,
      name: esc(b.label),
      widthPct: Math.max(2, (100 * b.costUsd) / maxCost),
      value: v
    });
  }).join('') : '';
  const pdNote = ce.postDelivery && ce.postDelivery.sessions
    ? `<p class="muted" style="font-size:.82rem">${ce.postDelivery.sessions} post-delivery reporting session(s) — report/dashboard generation — are excluded from these totals; they cost ${esc(zar(ce.postDelivery.costUsd) || usd(ce.postDelivery.costUsd))} on their own.</p>`
    : '';
  return `<section class="panel">
      <h2>Cost &amp; user involvement <span class="muted" style="font-size:.8rem;font-weight:400">— exact figures from the session logs</span></h2>
      <div class="stats tight">${tiles}</div>
      ${bars}
      ${pdNote}
    </section>`;
}

// ── Quality-gate history (from quality-gates.js's run log) ───────────────────
function renderGateRuns(gr, p) {
  if (!gr && (!p || p.gateEscapes == null)) return '';
  const tiles = [];
  if (gr) {
    tiles.push(statCard(fmtNum(gr.totalRuns), 'quality-gate runs', `${gr.failedRuns} failed · ${gr.rerunsAfterFailure} reruns after a failure`));
    for (const [gate, g] of Object.entries(gr.byGate)) {
      const label = gate.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
      tiles.push(statCard(`${g.runs - g.fails}/${g.runs}`, `${label} gate passed`, g.fails ? `${g.fails} failing run${g.fails === 1 ? '' : 's'}` : 'never failed'));
    }
  }
  if (p && p.gateEscapes != null) {
    tiles.push(statCard(fmtNum(p.gateEscapes), 'gate escapes', 'issues a human found that the automated gates had passed'));
  }
  if (!tiles.length) return '';
  return `<section class="panel">
      <h2>Quality gates <span class="muted" style="font-size:.8rem;font-weight:400">— automated checks vs. what humans caught</span></h2>
      <div class="stats tight">${tiles.join('')}</div>
    </section>`;
}

// ── Data quality: sources, gaps, and every assumption — always rendered ──────
function renderDataQuality(dq) {
  if (!dq) return '';
  const rows = (dq.sources || []).map((s) =>
    `<li><span class="pill ${s.found ? 'green' : 'grey'}">${s.found ? 'found' : 'missing'}</span> <strong>${esc(s.name)}</strong> — ${esc(s.note)}</li>`).join('');
  const assumptions = (dq.assumptions || []).map((a) => `<li>${esc(a)}</li>`).join('');
  return `<section class="panel">
      <h2>Data quality <span class="muted" style="font-size:.8rem;font-weight:400">— what fed this report, and what to keep in mind</span></h2>
      <h5 class="sub-h">Sources</h5>
      <ul class="vlist">${rows}</ul>
      <h5 class="sub-h">Assumptions &amp; limitations</h5>
      <ul class="vlist">${assumptions}</ul>
    </section>`;
}

// ── What was built (codebase shape) ──────────────────────────────────────────
function renderCodebase(cb) {
  if (!cb) return '';
  const locBar = stackBar([
    { label: 'App source', value: cb.loc.source, cls: 'sg-blue' },
    { label: 'Unit & integration tests', value: cb.loc.unitTests, cls: 'sg-aqua' },
    { label: 'E2E specs', value: cb.loc.e2e, cls: 'sg-yellow' }
  ], 'lines');
  const deps = cb.depsAdded || { runtime: [], dev: [] };
  const depNames = [...deps.runtime, ...deps.dev.map((d) => `${d} (dev)`)];
  const tiles = [
    statCard(fmtNum(cb.loc.total), 'lines of code', `${fmtNum(cb.files.source + cb.files.unitTests + cb.files.e2e)} tracked files in web/`),
    statCard(cb.components, 'components', 'under src/components'),
    statCard(cb.routes, 'routes', 'App Router pages'),
    statCard(cb.tests.unitBlocks, 'unit/integration tests', `across ${cb.tests.unitFiles} files`),
    statCard(cb.tests.e2eBlocks, 'E2E tests', `across ${cb.tests.e2eSpecs} specs${cb.tests.e2eFixmes ? ` · ${cb.tests.e2eFixmes} fixme` : ''}`),
    statCard(depNames.length, 'dependencies added', depNames.length ? depNames.join(', ') : 'built entirely on the template stack')
  ].join('');
  return `<section class="panel">
      <h2>What was built <span class="muted" style="font-size:.8rem;font-weight:400">— the shape of the codebase</span></h2>
      <h5 class="sub-h">Code composition (tracked lines in web/src + web/e2e)</h5>
      ${locBar}
      <div class="stats tight" style="margin-top:1rem">${tiles}</div>
    </section>`;
}

// ── Stumbling blocks ─────────────────────────────────────────────────────────
function renderBlocks(blocks) {
  if (!blocks.length) return '<p class="muted">No tooling friction logged for this project. 🎉</p>';
  return blocks.map((b, i) => `<div class="block">
      <div class="block-head" onclick="this.parentNode.classList.toggle('open')">
        <span class="block-n">${i + 1}</span>
        <span class="block-title">${esc(b.title)}</span>
        <span class="chevron">▾</span>
      </div>
      ${b.source ? `<div class="block-src">${esc(b.source)}</div>` : ''}
      <div class="block-body">${mdLite(b.body)}</div>
    </div>`).join('');
}

function renderInsights(md, promptRel = AUDIENCES.maintainer.prompt) {
  if (!md) return '';
  return `<section class="panel insight">
      <h2>What this means <span class="tweak" title="Edit ${esc(promptRel)} to change how this is written.">✎ editable</span></h2>
      <div class="insight-body">${mdLite(md)}</div>
    </section>`;
}

function renderPage(data, insightsMd) {
  if (data.status !== 'ok') {
    return pageShell('Build report', `<header class="top"><h1>Build report</h1></header><p class="muted">${esc(data.message || data.status)}</p>`);
  }
  return pageShell(`Build report — ${data.project.name || 'Project'}`, renderMaintainerBody(data, insightsMd));
}

const PAGE_CSS = `
:root{--bg:#0f1117;--panel:#171a23;--panel2:#1e222d;--line:#2a2f3c;--text:#e5e7eb;--muted:#9aa4b2;--accent:#0ea5e9;--green:#10b981;--amber:#f59e0b;--red:#ef4444;--grey:#6b7280}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
.wrap{max-width:1000px;margin:0 auto;padding:2rem 1.25rem 4rem}
header.top h1{margin:0 0 .25rem;font-size:1.6rem}
header.top .sub{color:var(--muted);font-size:.9rem}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.75rem;margin:1.5rem 0}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:1rem}
.stat-v{font-size:1.7rem;font-weight:700}
.stat-l{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.03em}
.stat-s{color:var(--muted);font-size:.78rem;margin-top:.35rem}
.stats.tight{margin:.4rem 0 .2rem}
.stats.tight .stat{padding:.75rem .9rem}
.stats.tight .stat-v{font-size:1.4rem}
/* charts — series hues validated for this dark surface (CVD + contrast) */
:root{--s-blue:#3987e5;--s-aqua:#199e70;--s-yellow:#c98500}
.sub-h{color:var(--muted);text-transform:uppercase;font-size:.72rem;letter-spacing:.04em;margin:1.1rem 0 .45rem}
.hbar{display:flex;gap:2px;height:18px;border-radius:6px;overflow:hidden}
.seg{display:block;min-width:4px}
.sg-blue{background:var(--s-blue)}.sg-aqua{background:var(--s-aqua)}.sg-yellow{background:var(--s-yellow)}
.sg-green{background:var(--green)}.sg-amber{background:var(--amber)}
.legend{display:flex;flex-wrap:wrap;gap:.4rem 1.2rem;margin-top:.5rem;font-size:.82rem;color:var(--muted)}
.legend strong{color:var(--text)}
.key{display:inline-flex;align-items:center;gap:.4rem}
.swatch{width:10px;height:10px;border-radius:3px;flex:0 0 auto}
.ebar{display:grid;grid-template-columns:minmax(140px,240px) 1fr;gap:.6rem;align-items:center;padding:.22rem 0}
.ebar-name{font-size:.82rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ebar-track{display:flex;align-items:center;gap:.5rem;height:14px}
.ebar-fill{display:block;height:100%;background:var(--accent);border-radius:0 4px 4px 0}
.ebar-v{font-size:.78rem;color:var(--text);white-space:nowrap}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:1.25rem 1.4rem;margin:1.25rem 0}
.panel>h2{margin:0 0 .9rem;font-size:1.1rem;display:flex;align-items:center;gap:.5rem}
.muted{color:var(--muted)}
.tweak{font-size:.68rem;color:var(--accent);border:1px solid var(--accent);border-radius:20px;padding:.05rem .5rem;font-weight:400;cursor:help}
.insight{border-color:#1e3a5f;background:linear-gradient(180deg,#141a26,#171a23)}
.insight-body h5{margin:.9rem 0 .3rem;font-size:.98rem}
.insight-body p{margin:.4rem 0}
/* timeline */
.day{display:grid;grid-template-columns:120px 1fr;gap:.75rem;padding:.6rem 0;border-top:1px solid var(--line)}
.day:first-child{border-top:0}
.day-label{color:var(--muted);font-size:.82rem;font-variant-numeric:tabular-nums}
.day-sum{display:block;color:var(--text);font-weight:600;font-size:.9rem;margin-top:.15rem}
.sess{margin-bottom:.4rem}
.sess-head{display:flex;align-items:center;gap:.6rem;cursor:pointer;padding:.25rem .4rem;border-radius:8px}
.sess-head:hover{background:var(--panel2)}
.sess-time{font-variant-numeric:tabular-nums;font-size:.8rem;color:var(--muted);min-width:92px}
.bar{flex:1;height:8px;background:var(--panel2);border-radius:6px;overflow:hidden;min-width:60px}
.bar-fill{display:block;height:100%;background:var(--accent);border-radius:6px}
.bar-fill.has-fix{background:linear-gradient(90deg,var(--accent),var(--amber))}
.sess-meta{font-size:.78rem;color:var(--muted);white-space:nowrap}
.commits{display:none;list-style:none;margin:.2rem 0 .5rem;padding:.4rem .6rem;background:var(--panel2);border-radius:8px;font-size:.82rem}
.sess.open .commits{display:block}
.commits li{padding:.12rem 0}
.c-time{color:var(--muted);font-variant-numeric:tabular-nums;margin-right:.5rem}
/* build flow — categorical slots validated (CVD + ≥3:1 contrast) for this surface */
:root{--flow-1:#3987e5;--flow-2:#008300;--flow-3:#d55181;--flow-4:#c98500;--flow-5:#199e70;--flow-6:#d95926;--flow-7:#9085e9;--flow-8:#e66767}
.fc-1{--fc:var(--flow-1)}.fc-2{--fc:var(--flow-2)}.fc-3{--fc:var(--flow-3)}.fc-4{--fc:var(--flow-4)}
.fc-5{--fc:var(--flow-5)}.fc-6{--fc:var(--flow-6)}.fc-7{--fc:var(--flow-7)}.fc-8{--fc:var(--flow-8)}
.fflow{position:relative;padding-top:1.3rem}
.fticks{position:absolute;inset:0;pointer-events:none}
.ftick{position:absolute;top:0;bottom:0;font-size:.68rem;color:var(--muted);font-variant-numeric:tabular-nums;transform:translateX(-50%)}
.ftick i{position:absolute;left:50%;top:1.2rem;bottom:0;border-left:1px solid var(--line)}
.flane{display:grid;grid-template-columns:235px 1fr;gap:.6rem;align-items:center;margin:.3rem 0}
.flane-label{font-size:.78rem;color:var(--muted);display:flex;align-items:center;gap:.4rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.flane .swatch,.ftable .swatch{background:var(--fc)}
.ftrack{position:relative;height:18px}
.fbar{position:absolute;top:2px;height:14px;border-radius:4px;background:var(--fc);display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:default}
.fbar em{font-style:normal;font-size:.66rem;font-weight:700;color:rgba(255,255,255,.92);text-shadow:0 1px 2px rgba(0,0,0,.45)}
.fbar:hover{outline:2px solid var(--text);outline-offset:1px}
.fshoulder{position:absolute;top:6px;height:6px;border-radius:3px;background:repeating-linear-gradient(45deg,var(--fc),var(--fc) 3px,transparent 3px,transparent 6px);opacity:.4;cursor:default}
.fshoulder:hover{outline:2px solid var(--muted);outline-offset:1px}
.fconc-track{border-bottom:1px solid var(--line)}
.fstep{position:absolute;bottom:0;background:var(--accent);opacity:.75;border-radius:2px 2px 0 0}
.fkey-hatch{width:22px;height:8px;border-radius:4px;background:repeating-linear-gradient(45deg,var(--muted),var(--muted) 3px,transparent 3px,transparent 6px);opacity:.7;display:inline-block}
.fkey-step{width:14px;height:10px;background:var(--accent);opacity:.75;border-radius:2px 2px 0 0;display:inline-block}
.ftable{border-collapse:collapse;width:100%;margin-top:.6rem;font-size:.8rem}
.ftable th,.ftable td{text-align:left;padding:.3rem .5rem;border-bottom:1px solid var(--line)}
.ftable th{color:var(--muted);font-weight:600;text-transform:uppercase;font-size:.68rem;letter-spacing:.03em}
.ftable td{font-variant-numeric:tabular-nums}
#ftt{position:fixed;z-index:10;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:.5rem .7rem;font-size:.8rem;max-width:340px;pointer-events:none;display:none;box-shadow:0 6px 20px rgba(0,0,0,.5)}
details summary{cursor:pointer;color:var(--muted);font-size:.85rem;margin-top:.8rem}
/* epics */
.epic{border:1px solid var(--line);border-radius:12px;margin:.6rem 0;overflow:hidden}
.epic.complete{border-left:3px solid var(--green)}
.epic.in-flight{border-left:3px solid var(--amber)}
.epic.planned{border-left:3px solid var(--grey)}
.epic-head{display:flex;align-items:center;gap:.6rem;padding:.7rem .9rem;cursor:pointer}
.epic-head:hover{background:var(--panel2)}
.epic-name{font-weight:600;flex:1}
.epic-tags{display:flex;gap:.4rem;flex-wrap:wrap}
.chevron{color:var(--muted);transition:transform .15s}
.epic.open .chevron,.block.open .chevron{transform:rotate(180deg)}
.epic-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:.5rem;padding:0 .9rem .8rem}
.mini{background:var(--panel2);border-radius:8px;padding:.5rem .6rem}
.mini-v{display:block;font-weight:700;font-size:1.05rem}
.mini-l{color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.02em}
.epic-body{display:none;padding:.2rem .9rem 1rem;border-top:1px solid var(--line)}
.epic.open .epic-body{display:block}
.journal h5,.epic-body h5{color:var(--muted);text-transform:uppercase;font-size:.72rem;letter-spacing:.04em;margin:.8rem 0 .3rem}
.journal p,.block-body p{margin:.35rem 0}
.journal ul,.block-body ul,.insight-body ul{margin:.3rem 0 .6rem;padding-left:1.1rem}
.journal li,.block-body li{margin:.2rem 0}
code{background:var(--panel2);padding:.05rem .3rem;border-radius:4px;font-size:.85em}
/* pills */
.pill{font-size:.72rem;padding:.12rem .5rem;border-radius:20px;white-space:nowrap}
.pill.green{background:rgba(16,185,129,.15);color:#6ee7b7;border:1px solid rgba(16,185,129,.4)}
.pill.amber{background:rgba(245,158,11,.15);color:#fcd34d;border:1px solid rgba(245,158,11,.4)}
.pill.grey{background:rgba(107,114,128,.15);color:#cbd5e1;border:1px solid rgba(107,114,128,.4)}
.hint{font-size:.72rem;color:var(--muted);border-bottom:1px dotted var(--muted);cursor:help}
/* blocks */
.block{border:1px solid var(--line);border-radius:12px;margin:.55rem 0;overflow:hidden}
.block-head{display:flex;align-items:center;gap:.6rem;padding:.65rem .9rem;cursor:pointer}
.block-head:hover{background:var(--panel2)}
.block-n{background:var(--amber);color:#111;font-weight:700;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:.8rem;flex:0 0 auto}
.block-title{flex:1;font-weight:600;font-size:.95rem}
.block-src{color:var(--muted);font-size:.78rem;padding:0 .9rem .3rem 3.2rem}
.block-body{display:none;padding:.2rem .9rem 1rem 3.2rem;border-top:1px solid var(--line);font-size:.9rem}
.block.open .block-body{display:block}
footer{color:var(--muted);font-size:.78rem;margin-top:2rem;border-top:1px solid var(--line);padding-top:1rem}
.vlist{margin:.3rem 0;padding-left:1.1rem}
.vlist li{margin:.45rem 0}
`;

function pageShell(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${PAGE_CSS}</style></head>
<body><div class="wrap">
${body}
</div></body></html>`;
}

function renderMaintainerBody(data, insightsMd) {
  const t = data.timeline;
  const c = data.coverage;
  const generated = (data.generatedAt || '').replace('T', ' ').slice(0, 16);
  const ce = data.costEffort;
  const overview = [
    statCard(`${t.spanDays}d`, 'calendar span', `${fmtDate(t.firstCommit?.date)} → ${fmtDate(t.lastCommit?.date)}`),
    statCard(`~${fmtDuration(t.activeMinutes)}`, 'active build time', `${t.sessionCount} work sessions`),
    statCard(`${c.builtEpics}${c.plannedEpics ? `/${c.plannedEpics + (c.offPlanEpics || 0)}` : ''}`, 'epics delivered', `${c.storiesBuilt} stories`),
    ce && ce.costUsd != null && ce.usdToZar != null
      ? statCard(`R${(ce.costUsd * ce.usdToZar).toLocaleString('en-US', { maximumFractionDigits: 0 })}`, 'estimated AI cost', `$${ce.costUsd.toFixed(2)} at API list prices`)
      : '',
    statCard(`${data.rework.fixCommitCount}`, 'fix commits', `${data.rework.passedAfterFixStories} stories fixed post-test`),
    statCard(`${data.stumblingBlocks.length}`, 'stumbling blocks', 'tooling friction logged')
  ].filter(Boolean).join('');

  // Header carries team + project + date range so reports from different
  // teams/projects are directly comparable side by side.
  const team = data.meta && data.meta.team ? ` · Team: ${esc(data.meta.team)}` : '';
  const range = t.firstCommit ? ` · ${fmtDate(t.firstCommit.date)} → ${fmtDate(t.lastCommit?.date)}` : '';

  return `<header class="top">
  <h1>Build report — ${esc(data.project.name || 'Project')}</h1>
  <div class="sub">How this app came together${team}${range} · generated ${esc(generated)} UTC</div>
</header>
<div class="stats">${overview}</div>
${renderInsights(insightsMd)}
${renderCostEffort(ce)}
${renderPerformance(data)}
${renderGateRuns(data.gateRuns, data.performance)}
${renderCodebase(data.codebase)}
<section class="panel">
  <h2>Timeline <span class="muted" style="font-size:.8rem;font-weight:400">— click a session to see its commits</span></h2>
  ${renderTimeline(t)}
</section>
<section class="panel">
  <h2>Build flow <span class="muted" style="font-size:.8rem;font-weight:400">— which stories ran in parallel; hover a bar for detail</span></h2>
  ${renderBuildFlow(data)}
</section>
<section class="panel">
  <h2>Per-epic breakdown <span class="muted" style="font-size:.8rem;font-weight:400">— click an epic to open its journal</span></h2>
  ${data.epics.map(renderEpic).join('')}
</section>
<section class="panel">
  <h2>Stumbling blocks &amp; time-sinks</h2>
  ${renderBlocks(data.stumblingBlocks)}
</section>
${renderDataQuality(data.dataQuality)}
<footer>
  <strong>How the numbers are derived.</strong> Active build time clusters git commits into work sessions
  (a gap over ${t.gapMin} min starts a new one) and sums each session's span — a conservative <em>floor</em> on real
  effort, not a stopwatch (a lone commit counts as ~0). Per-epic time is attributed by commit scope; epics built
  interleaved share their session time (marked “shared time”). Stumbling blocks are read from
  <code>generated-docs/template-feedback.md</code>; manual-test outcomes and post-fix flags from each epic's <code>state.json</code>.
  Line counts cover git-tracked files under <code>web/src</code> and <code>web/e2e</code>; churn (lines added/deleted) is
  measured over <code>web/</code> excluding the lockfile, so generated diffs don't swamp the hand-written signal.
  “First-pass E2E yield” is the share of stories whose end-to-end tests passed without entering a fix cycle;
  “dependencies added” diffs <code>web/package.json</code> against its first committed version.
</footer>`;
}

// ── Stakeholder delivery page ────────────────────────────────────────────────
// What shipped, the quality evidence, and what's still to come — written for a
// non-technical reader. Internal machinery (churn, fix commits, work sessions,
// tooling friction) deliberately does not appear on this page.
function prettyEpicName(e) {
  if (e.name && e.name !== e.slug) return e.name;
  return e.slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function renderStakeholderEpic(e) {
  return `<div class="epic complete">
      <div class="epic-head" onclick="this.parentNode.classList.toggle('open')">
        <span class="epic-name">${esc(prettyEpicName(e))}</span>
        <span class="epic-tags">${mtBadge(e.manualTest)}<span class="pill grey">${e.stories.complete} ${e.stories.complete === 1 ? 'story' : 'stories'}</span></span>
        <span class="chevron">▾</span>
      </div>
      <div class="epic-body">
        <h5>What this delivers</h5>
        <div class="journal">${e.journal ? mdLite(e.journal) : '<p class="muted">No write-up recorded.</p>'}</div>
      </div>
    </div>`;
}

function renderStakeholdersPage(data, insightsMd) {
  if (data.status !== 'ok') {
    return pageShell('Delivery report', `<h1>Delivery report</h1><p>${esc(data.message || data.status)}</p>`);
  }
  const t = data.timeline, c = data.coverage, cb = data.codebase, p = data.performance;
  const done = data.epics.filter((e) => e.status === 'complete');
  const pending = data.epics.filter((e) => e.status !== 'complete');
  const generated = (data.generatedAt || '').replace('T', ' ').slice(0, 16);
  const overview = [
    statCard(`${c.builtEpics}${c.plannedEpics ? `/${c.plannedEpics + (c.offPlanEpics || 0)}` : ''}`, 'feature areas delivered', `${c.storiesBuilt} user stories`),
    statCard(`~${fmtDuration(t.activeMinutes)}`, 'active build effort', `across ${t.spanDays} calendar days`),
    statCard(fmtNum(cb.tests.unitBlocks + cb.tests.e2eBlocks), 'automated tests', 'run before every release'),
    p.manualChecks ? statCard(`${p.manualChecks.pct}%`, 'hands-on checks passed', `${p.manualChecks.passed} of ${p.manualChecks.total} human-verified`) : '',
    statCard(fmtNum(cb.loc.total), 'lines of code', `${cb.components} components · ${cb.routes} screens`)
  ].filter(Boolean).join('');

  const verification = `<ul class="vlist">
      <li><strong>${fmtNum(cb.tests.e2eBlocks)} end-to-end tests</strong> drive the finished app in a real browser the way a person would, across ${cb.tests.e2eSpecs} scenario files.</li>
      <li><strong>${fmtNum(cb.tests.unitBlocks)} unit &amp; integration tests</strong> check individual screens and business rules in isolation.</li>
      ${p.manualChecks ? `<li><strong>${p.manualChecks.passed} of ${p.manualChecks.total} hands-on checks passed</strong> — a person verified the finished screens against the real backend.</li>` : ''}
      ${p.assumptionsOpen ? `<li><strong>${p.assumptionsOpen} assumptions are flagged for future verification</strong> — points where behaviour depends on backend details that couldn't be fully confirmed yet. Each is written down and will be re-checked as the remaining work lands.</li>` : ''}
    </ul>`;

  const upcoming = pending.length
    ? `<section class="panel"><h2>Still to come</h2><ul class="vlist">${pending.map((e) =>
        `<li><strong>${esc(prettyEpicName(e))}</strong>${e.status === 'in-flight' ? ' — in progress' : ' — planned, not yet started'}</li>`).join('')}</ul></section>`
    : '';

  const body = `<header class="top">
  <h1>Delivery report — ${esc(data.project.name || 'Project')}</h1>
  <div class="sub">What was built and how it was verified · generated ${esc(generated)} UTC</div>
</header>
<div class="stats">${overview}</div>
${renderInsights(insightsMd, AUDIENCES.stakeholders.prompt)}
<section class="panel">
  <h2>What was delivered <span class="muted" style="font-size:.8rem;font-weight:400">— click a feature area for its full write-up</span></h2>
  ${done.map(renderStakeholderEpic).join('')}
</section>
<section class="panel">
  <h2>How it was verified</h2>
  ${verification}
</section>
${upcoming}
<footer>
  Figures are derived from the project's own records: effort from the timing of saved work (a conservative
  floor, not a billed figure), delivery from each feature area's build log, and verification from the
  automated test suites plus the recorded hands-on test results.
</footer>`;
  return pageShell(`Delivery report — ${data.project.name || 'Project'}`, body);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const aud = Object.hasOwn(AUDIENCES, args.audience) ? AUDIENCES[args.audience] : null;
  if (!aud) {
    process.stdout.write(JSON.stringify({
      status: 'error',
      message: `Unknown audience "${args.audience}". Valid audiences: ${Object.keys(AUDIENCES).join(', ')}.`
    }, null, 2) + '\n');
    process.exitCode = 1;
    return;
  }
  const data = collect(args.root);

  let insightsMd = null;
  if (!args.noInsights) {
    const insightsPath = args.insights ? path.resolve(args.insights) : path.join(args.root, aud.insights);
    try { insightsMd = fs.readFileSync(insightsPath, 'utf8').trim() || null; } catch { insightsMd = null; }
  }

  const html = args.audience === 'stakeholders'
    ? renderStakeholdersPage(data, insightsMd)
    : renderPage(data, insightsMd);
  const htmlAbs = path.join(args.root, aud.html);
  const jsonAbs = path.join(args.root, OUT_JSON);
  fs.mkdirSync(path.dirname(htmlAbs), { recursive: true });
  fs.writeFileSync(htmlAbs, html, 'utf8');
  fs.writeFileSync(jsonAbs, JSON.stringify(data, null, 2) + '\n', 'utf8');

  process.stdout.write(JSON.stringify({
    status: data.status,
    audience: args.audience,
    html: aud.html,
    json: OUT_JSON,
    insights: insightsMd ? 'included' : 'none',
    insightsFile: aud.insights,
    insightsPrompt: aud.prompt,
    message: data.status === 'ok' ? undefined : data.message
  }, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = { renderPage, renderStakeholdersPage, mdLite, renderTimeline, renderBuildFlow, parseArgs, AUDIENCES };
