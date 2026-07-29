// Generates the BUILD-EFFORT report — how long and how much each story cost to build,
// grouped by screen type, for ONE project. Ground truth only:
//   - time  : per-story startedAt -> completedAt from generated-docs/epics/<slug>/state.json
//   - tokens: every transcript message (orchestrator + sub-agents) bucketed into the story
//             window containing its timestamp; priced with the shared report-core table.
//
//   node .claude/skills/build-report-effort/generate-build-effort.mjs [--rate=18.50] [--exclude=id,id]
//                                                              [--transcripts=DIR] [--project-root=DIR]
//
// Writes generated-docs/reports/build-effort.html and build-effort-data.json.
//
// Completeness gate: if no sub-agent transcripts are found (e.g. an older log format that
// only kept the orchestrator), token cost is INCOMPLETE — the report renders time-only and
// says so, rather than printing wrong dollar figures.
import fs from 'node:fs';
import path from 'node:path';
import { getProjectRoot } from '../../scripts/lib/project-root.js';
import { discoverTranscriptDirs, gatherUsageRecords, unknownModels } from '../../scripts/lib/report-core.mjs';

// ---- args ----
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
  const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true];
}));
const RATE = parseFloat(args.rate) || null; // ZAR per USD; optional
const EXCLUDE = new Set((typeof args.exclude === 'string' ? args.exclude : '').split(',').map(s => s.trim()).filter(Boolean));
const PROJECT_ROOT = (typeof args['project-root'] === 'string') ? path.resolve(args['project-root']) : getProjectRoot();
const TRANSCRIPTS = (typeof args.transcripts === 'string') ? path.resolve(args.transcripts) : null;

// ---- screen-type taxonomy (edit here to tune classification) ----
// First matching rule wins, so order = priority. Titles come from the story's Playwright
// spec filename. Deliberately title-based, never the epic slug (an epic named "…-export"
// must not tag its listing stories as Export).
const TAXONOMY = [
  { cat: 'Auth / app-shell / infra',  re: /bff|proxy|gateway|session|sign ?in|app shell|shell|nav guard|permission|badge|timeout/ },
  { cat: 'Export',                    re: /export|csv/ },
  { cat: 'Upload / create form',      re: /upload/ },
  { cat: 'Record action',             re: /approve|reject|retry|cancel|submit|delete|create|edit|update/ },
  { cat: 'Listing / table page',      re: /table|overview|filter|search|sort|paginat|card list|\blist\b/ },
  { cat: 'Detail / summary view',     re: /summary|detail|validation error|banner|audit|note|state|view/ },
];
const classify = title => (TAXONOMY.find(t => t.re.test(title.toLowerCase())) || { cat: 'Other' }).cat;

// ---- stories (time) from epic state files + titles from spec filenames ----
const epicsDir = path.join(PROJECT_ROOT, 'generated-docs', 'epics');
if (!fs.existsSync(epicsDir)) { console.error('No epics at generated-docs/epics/ — nothing to report.'); process.exit(1); }
function specTitles() {
  const dir = path.join(PROJECT_ROOT, 'web', 'e2e'); const map = {};
  if (!fs.existsSync(dir)) return map;
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^epic-(.+)-story-(\d+)-(.+)\.spec\.ts$/);
    if (m) map[`${m[1]}|${m[2]}`] = m[3].replace(/-/g, ' ');
  }
  return map;
}
const titles = specTitles();
const stories = [];
for (const slug of fs.readdirSync(epicsDir)) {
  const sf = path.join(epicsDir, slug, 'state.json');
  if (!fs.existsSync(sf)) continue;
  let st; try { st = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch { continue; }
  const epicName = st.epic?.name || slug;
  for (const [n, s] of Object.entries(st.stories || {})) {
    const a = s.startedAt ? new Date(s.startedAt).getTime() : NaN;
    const b = s.completedAt ? new Date(s.completedAt).getTime() : NaN;
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
    const title = titles[`${slug}|${n}`] || `story ${n}`;
    stories.push({ epic: slug, epicName, n, title, start: a, end: b, min: (b - a) / 60000, cat: classify(title), cost: 0, tokens: 0, calls: 0 });
  }
}
if (!stories.length) { console.error('No stories with start/complete timestamps found — nothing to report.'); process.exit(1); }
stories.sort((x, y) => x.start - y.start);

// ---- tokens: bucket transcript records into story windows ----
const { dirs } = discoverTranscriptDirs(PROJECT_ROOT, TRANSCRIPTS);
const { records, sawSubagents } = gatherUsageRecords(dirs, EXCLUDE);
let overheadCost = 0, overheadTokens = 0, totalCost = 0;
for (const r of records) {
  totalCost += r.cost;
  const s = stories.find(st => r.ts >= st.start && r.ts < st.end);
  if (s) { s.cost += r.cost; s.tokens += r.tokens; s.calls++; } else { overheadCost += r.cost; overheadTokens += r.tokens; }
}
// Completeness is coverage-based, not "does a subagents dir exist": per-story cost is only
// trustworthy if MOST stories actually got token records bucketed into them. A build whose
// sub-agent transcripts weren't captured (old log format) leaves nearly every story at $0,
// even if some unrelated session in the store has a subagents dir. Below the threshold we
// render time-only rather than publish wrong dollar figures.
const COST_COVERAGE_MIN = 0.6;
const storiesWithCost = stories.filter(s => s.cost > 0).length;
const costCoverage = stories.length ? storiesWithCost / stories.length : 0;
const costComplete = sawSubagents && dirs.length > 0 && costCoverage >= COST_COVERAGE_MIN;
const inStoryCost = stories.reduce((a, s) => a + s.cost, 0);

// ---- aggregate per category ----
const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const catOrder = ['Listing / table page', 'Record action', 'Upload / create form', 'Detail / summary view', 'Export', 'Auth / app-shell / infra', 'Other'];
const cats = {};
for (const s of stories) (cats[s.cat] ||= []).push(s);
const categories = catOrder.filter(c => cats[c]).map(c => {
  const g = cats[c];
  return {
    cat: c, n: g.length,
    medMin: median(g.map(s => s.min)), meanMin: mean(g.map(s => s.min)),
    medCost: median(g.map(s => s.cost)), medTokens: median(g.map(s => s.tokens)),
  };
});

const result = {
  generatedAt: new Date().toISOString(),
  project: PROJECT_ROOT,
  feature: (() => { try { const h = fs.readFileSync(path.join(PROJECT_ROOT, 'generated-docs', 'project.md'), 'utf8').split('\n').find(l => /^#\s+/.test(l)); return h ? h.replace(/^#\s+/, '').trim() : ''; } catch { return ''; } })(),
  costComplete, rate: RATE,
  totals: {
    stories: stories.length,
    buildMinutes: stories.reduce((a, s) => a + s.min, 0),
    medMinutes: median(stories.map(s => s.min)),
    inStoryCost, overheadCost, totalCost,
    overheadShare: totalCost ? overheadCost / totalCost : 0,
    fullyLoadedPerStory: stories.length ? totalCost / stories.length : 0,
    medCost: median(stories.map(s => s.cost)),
  },
  categories,
  stories: stories.map(s => ({ epic: s.epic, n: s.n, title: s.title, cat: s.cat, min: s.min, tokens: s.tokens, cost: s.cost })),
  unknownModels: [...unknownModels],
};

const outDir = path.join(PROJECT_ROOT, 'generated-docs', 'reports');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'build-effort-data.json'), JSON.stringify(result, null, 2));
fs.writeFileSync(path.join(outDir, 'build-effort.html'), renderHtml(result));

// ---- console summary ----
console.log(JSON.stringify({
  stories: result.totals.stories,
  medMinutesPerStory: +result.totals.medMinutes.toFixed(1),
  costComplete,
  totalCostUsd: +totalCost.toFixed(2),
  inStoryCostUsd: +inStoryCost.toFixed(2),
  overheadSharePct: +(result.totals.overheadShare * 100).toFixed(0),
  fullyLoadedPerStoryUsd: +result.totals.fullyLoadedPerStory.toFixed(2),
  byType: categories.map(c => `${c.cat}: ${c.medMin.toFixed(0)}min${costComplete ? ' / $' + c.medCost.toFixed(2) : ''} (n=${c.n})`),
  unknownModels: result.unknownModels,
}, null, 1));
if (!costComplete) console.warn('WARNING: no sub-agent transcripts found — token cost is INCOMPLETE; report shows build time only.');
if (unknownModels.size) console.warn('WARNING: unknown models priced as Opus 4.8 — add them to PRICING in report-core.mjs: ' + [...unknownModels].join(', '));
console.log('written generated-docs/reports/build-effort.html');

// ---- HTML (self-contained, theme-aware) ----
function renderHtml(r) {
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const usd = n => '$' + n.toFixed(2);
  const zar = n => r.rate ? ' · R' + (n * r.rate).toFixed(0) : '';
  const Mtok = n => (n / 1e6).toFixed(1) + 'M';
  const costCol = r.costComplete;
  const t = r.totals;
  const catRows = r.categories.map(c => `<tr><td class="name">${esc(c.cat)}${c.n === 1 ? ' <span class="flag">n=1</span>' : ''}</td><td class="num">${c.medMin.toFixed(0)} min</td>${costCol ? `<td class="num">${Mtok(c.medTokens)}</td><td class="num">${usd(c.medCost)}</td>` : ''}<td class="num">${c.n}</td></tr>`).join('');
  const storyRows = r.stories.map(s => `<tr><td class="name">${esc(s.title)}</td><td>${esc(s.cat)}</td><td class="num">${s.min.toFixed(1)}</td>${costCol ? `<td class="num">${Mtok(s.tokens)}</td><td class="num">${usd(s.cost)}</td>` : ''}</tr>`).join('');
  const incompleteBanner = costCol ? '' : `<div class="callout warn"><h3>Token cost unavailable for this project</h3><p>No sub-agent transcripts were found in the logs, so per-story token cost can't be reconstructed. Showing <b>build time only</b>. (This happens with older log formats that kept only the orchestrator session.)</p></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Build Effort — ${esc(r.feature || 'project')}</title>
<style>
:root{--bg:#f6f8f9;--surface:#fff;--surface-2:#edf1f2;--ink:#161a1c;--ink-2:#515a5e;--ink-3:#7b858a;--line:#dbe1e3;--accent:#0f766e;--accent-soft:#d6ebe8;--warn:#92610f;--warn-soft:#f3e7cf;--shadow:0 1px 2px rgba(20,30,35,.05),0 6px 20px -8px rgba(20,30,35,.12);--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,Consolas,monospace;}
@media (prefers-color-scheme:dark){:root{--bg:#101416;--surface:#171c1e;--surface-2:#1f2528;--ink:#eef2f3;--ink-2:#a7b1b5;--ink-3:#778287;--line:#2a3236;--accent:#34d0be;--accent-soft:#123531;--warn:#e2b35a;--warn-soft:#2f2611;--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px -10px rgba(0,0,0,.5);}}
:root[data-theme="light"]{--bg:#f6f8f9;--surface:#fff;--surface-2:#edf1f2;--ink:#161a1c;--ink-2:#515a5e;--ink-3:#7b858a;--line:#dbe1e3;--accent:#0f766e;--warn:#92610f;--warn-soft:#f3e7cf;}
:root[data-theme="dark"]{--bg:#101416;--surface:#171c1e;--surface-2:#1f2528;--ink:#eef2f3;--ink-2:#a7b1b5;--ink-3:#778287;--line:#2a3236;--accent:#34d0be;--warn:#e2b35a;--warn-soft:#2f2611;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:960px;margin:0 auto;padding:clamp(20px,5vw,56px) clamp(16px,4vw,36px) 64px}
.eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);margin:0 0 12px}
h1{font-size:clamp(26px,4.5vw,38px);line-height:1.08;letter-spacing:-.02em;font-weight:800;margin:0 0 14px;text-wrap:balance}
.lede{font-size:16px;color:var(--ink-2);max-width:64ch;margin:0}
.meta{font-family:var(--mono);font-size:12px;color:var(--ink-3);margin-top:16px}
section{margin-top:44px}h2{font-size:13px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.14em;color:var(--ink-3);font-weight:600;margin:0 0 16px;padding-bottom:9px;border-bottom:1px solid var(--line)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:13px;margin-top:24px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:11px;padding:17px;box-shadow:var(--shadow)}
.tile.accent{border-color:var(--accent)}.tile .k{font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);margin:0 0 7px}
.tile .v{font-size:27px;font-weight:750;font-variant-numeric:tabular-nums;letter-spacing:-.02em;line-height:1}.tile.accent .v{color:var(--accent)}.tile .v small{font-size:13px;font-weight:600;color:var(--ink-2)}.tile .note{font-size:12px;color:var(--ink-2);margin:8px 0 0}
.tblwrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:11px 15px;border-bottom:1px solid var(--line);white-space:nowrap}
thead th{font-family:var(--mono);font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-3);font-weight:600;background:var(--surface-2)}
tbody tr:last-child td{border-bottom:none}td.num,th.num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}td.name{white-space:normal}
.flag{color:var(--warn);font-family:var(--mono);font-size:11px}
.callout{border-radius:12px;padding:20px 22px;border:1px solid var(--line);border-left:4px solid var(--warn);background:color-mix(in srgb,var(--warn-soft) 55%,var(--surface));box-shadow:var(--shadow);margin-top:20px}
.callout h3{margin:0 0 8px;font-size:15px}.callout p{margin:0;font-size:14px;color:var(--ink-2)}
footer{margin-top:48px;padding-top:18px;border-top:1px solid var(--line);font-size:12px;color:var(--ink-3);font-family:var(--mono);line-height:1.7}footer b{color:var(--ink-2)}
</style></head><body><div class="wrap">
<p class="eyebrow">Delivery metrics · AI build effort</p>
<h1>Build effort by screen type${r.feature ? ' — ' + esc(r.feature) : ''}</h1>
<p class="lede">Per-story build time${costCol ? ' and token cost' : ''}, reconstructed from the workflow's own timestamps${costCol ? ' and token logs' : ''}.</p>
<p class="meta">${r.totals.stories} stories · median ${t.medMinutes.toFixed(0)} min/story${costCol ? ` · ${usd(t.medCost)} median cost/story` : ''} · generated ${esc(r.generatedAt.slice(0, 10))}</p>
${incompleteBanner}
<div class="tiles">
<div class="tile accent"><p class="k">Typical story</p><p class="v">${t.medMinutes.toFixed(0)} <small>min</small></p><p class="note">median build time</p></div>
${costCol ? `<div class="tile accent"><p class="k">Typical story cost</p><p class="v">${usd(t.medCost)}${zar(t.medCost)}</p><p class="note">median tokens/story (marginal)</p></div>
<div class="tile"><p class="k">Fully-loaded / story</p><p class="v">${usd(t.fullyLoadedPerStory)}</p><p class="note">total spend ÷ all stories</p></div>
<div class="tile"><p class="k">Overhead share</p><p class="v">${(t.overheadShare * 100).toFixed(0)}%</p><p class="note">spend outside story windows</p></div>` : `<div class="tile"><p class="k">Total build time</p><p class="v">${(t.buildMinutes / 60).toFixed(1)} <small>h</small></p><p class="note">summed across stories</p></div>`}
</div>
<section><h2>Rule of thumb by screen type</h2><div class="tblwrap"><table>
<thead><tr><th>Screen type</th><th class="num">~ Time</th>${costCol ? '<th class="num">~ Tokens</th><th class="num">~ Cost</th>' : ''}<th class="num">n</th></tr></thead>
<tbody>${catRows}</tbody></table></div></section>
${costCol ? `<section><h2>Marginal vs fully-loaded</h2><div class="callout"><h3>Only ${(100 - t.overheadShare * 100).toFixed(0)}% of spend lands inside stories</h3><p>Of ${usd(t.totalCost)} total, ${usd(t.inStoryCost)} fell inside per-story build windows; ${usd(t.overheadCost)} is workflow scaffolding (INTAKE, PLAN, epic-end E2E + fixes, PR/merge, orchestrator context between stories). <b>Marginal</b> cost of one more screen ≈ the table above; <b>fully-loaded</b> ≈ ${usd(t.fullyLoadedPerStory)}/story once that overhead is amortised in.</p></div></section>` : ''}
<section><h2>Every story, measured</h2><div class="tblwrap"><table>
<thead><tr><th>Story</th><th>Type</th><th class="num">Time (min)</th>${costCol ? '<th class="num">Tokens</th><th class="num">Cost</th>' : ''}</tr></thead>
<tbody>${storyRows}</tbody></table></div></section>
<footer>Time from each epic's state.json (startedAt→completedAt). Titles from Playwright spec filenames. ${costCol ? 'Token cost by bucketing every transcript message (orchestrator + sub-agents) into its story window; list API prices, cache read 0.1×, write 1.25×/2×. Overhead = spend outside all story windows.' : 'Token cost omitted — sub-agent transcripts absent.'} Measures AI build effort only; excludes human review / manual-test wall-time. Single project — directional, firms up as more projects are measured.</footer>
</div></body></html>`;
}
