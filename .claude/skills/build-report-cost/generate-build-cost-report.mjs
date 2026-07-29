// Generates the workflow INSIGHTS report — only ground-truth data, no inferred durations.
//
//   node .claude/skills/build-report-cost/generate-build-cost-report.mjs [--rate=18.50] [--exclude=id,id]
//
// Everything here comes verbatim from the transcripts (usage blocks, tool_use events,
// sub-agent .meta.json) — token counts, API-call counts, model attribution, cache
// read/write split, tool-use counts, sub-agent fan-out, and AskUserQuestion counts are
// all exact. There are deliberately NO active/idle/elapsed time estimates: those are
// reconstructed from timestamp gaps with arbitrary caps and are not reliable.
//
// Reads:  Claude Code transcripts for this project (~/.claude/projects/<slug>/) and
//         generated-docs/epics/<slug>/state.json (per-epic createdAt = time-bucket boundaries).
// Writes: generated-docs/reports/build-cost.html (self-contained report)
//         generated-docs/reports/build-cost-data.json (raw numbers)
//
// --rate     ZAR per USD. Pass the current market rate; defaults to 18.00 with a warning.
// --exclude  Comma-separated session ids to leave out entirely (unrelated conversations).
// --keep     Comma-separated session ids to keep in the build totals even though they were
//            auto-flagged as post-delivery reporting (see POST_DELIVERY_COMMANDS below).
//
// Beyond token/cost ground truth, the script also computes:
//   - Deliberate user inputs (typed messages / slash commands / manual-test submissions /
//     interruptions), classified per transcript-hygiene rules — harness-injected user-role
//     entries (tool results, task notifications, IDE events, isMeta) are excluded.
//   - "Waiting on user" durations, measured ONLY between well-defined anchors: an
//     AskUserQuestion tool call → its tool_result (approval waits), and end of the previous
//     transcript event → the next deliberate user input (general waits). Gaps over the stall
//     threshold are reported separately as stalls, never summed into waits. These are the only
//     durations on the report; AI busy/elapsed time remains deliberately unmeasured.
//   - Post-delivery reporting sessions (first command is /build-report, /build-report-cost or
//     /dashboard) are auto-flagged: their tokens/cost are rolled up separately and excluded
//     from the build totals so report generation doesn't pollute cross-project comparison.
//   - Sibling transcript directories (git-worktree variants of the project path) are included
//     automatically — parallel epics built in worktrees log there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProjectRoot } from '../../scripts/lib/project-root.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo root via the canonical marker-walk helper — NOT process.cwd(), which drifts into web/ when
// the shell's cwd was left there. Same source of truth the dashboard/state-path scripts use, and
// it also anchors the transcript-dir slug below to the path the session was actually opened at.
const PROJECT_ROOT = getProjectRoot();

// ---- args ----
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const RATE_ARG = parseFloat(args.rate);
const RATE = RATE_ARG || 18.0;
if (!RATE_ARG) console.warn('WARNING: no --rate given, using 18.00 ZAR/USD placeholder — pass the current market rate.');
if (args.exclude === true) console.warn('WARNING: --exclude needs a value like --exclude=id1,id2 — ignoring it (nothing excluded).');
const EXCLUDE = new Set((typeof args.exclude === 'string' ? args.exclude : '').split(',').map(s => s.trim()).filter(Boolean));
const KEEP = new Set((typeof args.keep === 'string' ? args.keep : '').split(',').map(s => s.trim()).filter(Boolean));

// ---- locate the Claude Code transcript directories for this project ----
// Besides the project's own directory, include sibling directories whose slug extends this
// project's slug. The workflow creates each parallel worktree as a SIBLING of the project
// (`git worktree add ../<project>-<slug>`, `../<project>-planning`), so its transcript dir
// slugifies to `<slug>-<suffix>` — a SINGLE dash before the suffix. Skipping them silently
// drops whole epics built in parallel worktrees.
const slug = PROJECT_ROOT.replace(/[^a-zA-Z0-9]/g, '-');
const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const PROJ_DIR = path.join(PROJECTS_ROOT, slug);
if (!fs.existsSync(PROJ_DIR)) {
  console.error('Transcript directory not found: ' + PROJ_DIR);
  process.exit(1);
}
const extraDirs = [];
for (const d of fs.readdirSync(PROJECTS_ROOT)) {
  // Sibling worktree transcript dirs are `<slug>-<suffix>` (one dash: `../<project>-planning`
  // → `<slug>-planning`). The trailing dash still excludes a same-prefix name like `<slug>0`.
  // A genuinely unrelated sibling project literally named `<project>-<x>` is the only false
  // match — and folding its transcripts in over-counts, the opposite of the silent data loss
  // that requiring a double dash caused (no worktree the workflow makes ever has one).
  if (d === slug || !d.startsWith(slug + '-')) continue;
  let isDir = false;
  try { isDir = fs.statSync(path.join(PROJECTS_ROOT, d)).isDirectory(); } catch { continue; } // dangling symlink / race — skip, don't crash
  if (isDir) extraDirs.push(d);
}
const TRANSCRIPT_DIRS = [PROJ_DIR, ...extraDirs.map(d => path.join(PROJECTS_ROOT, d))];

// ---- pricing: the ONE place model knowledge lives (USD per 1M tokens) ----
// pricingNote below is generated from this table so it can never drift. A model missing here warns
// and falls back to Opus — add new models here (verify rates via the claude-api skill) when they
// appear in the warning. Cache read 0.1x input; cache write 1.25x (5m) / 2x (1h).
const CACHE_READ_MULT = 0.1, CACHE_WRITE_5M_MULT = 1.25, CACHE_WRITE_1H_MULT = 2;
const PRICING = {
  'claude-fable-5':            { input: 10, output: 50, name: 'Fable 5' },
  'claude-opus-4-8':           { input: 5,  output: 25, name: 'Opus 4.8' },
  'claude-sonnet-4-6':         { input: 3,  output: 15, name: 'Sonnet 4.6' },
  'claude-haiku-4-5-20251001': { input: 1,  output: 5,  name: 'Haiku 4.5' },
  'claude-haiku-4-5':          { input: 1,  output: 5,  name: 'Haiku 4.5' },
};
const unknownModels = new Set();
const rates = (m) => {
  let p = PRICING[m];
  if (!p) { unknownModels.add(m); p = PRICING['claude-opus-4-8']; }
  return { in: p.input, out: p.output, read: p.input * CACHE_READ_MULT, w5m: p.input * CACHE_WRITE_5M_MULT, w1h: p.input * CACHE_WRITE_1H_MULT };
};

// ---- derive time buckets from the epic-branch state files ----
// The epic-branch workflow keeps per-epic state at generated-docs/epics/<slug>/state.json — there
// is no single workflow-state.json history timeline. We bucket transcript activity into contiguous
// time windows: a leading "INTAKE & setup" window, then one window per epic running from that epic's
// `createdAt` to the next epic's `createdAt` (the last epic runs open-ended).
// Granularity is epic-level because the epic state records no per-story timestamps (stories carry
// only status/commit/e2eStatus). Sub-agent work is still broken down per agent+model within each
// window (see aggregation below).
// Caveat: contiguous createdAt windows assume epics were built sequentially — if two epics ran in
// parallel on separate branches, activity in the overlap is attributed to the earlier window.
const T = (s) => (s ? new Date(s).getTime() : NaN);

const epicsDir = path.join(PROJECT_ROOT, 'generated-docs', 'epics');
if (!fs.existsSync(epicsDir)) {
  console.error('No epics found at generated-docs/epics/ — the workflow has not created an epic yet; nothing to report.');
  process.exit(1);
}
const epics = [];
const undatedEpics = [];
for (const epicSlug of fs.readdirSync(epicsDir)) {
  const sf = path.join(epicsDir, epicSlug, 'state.json');
  if (!fs.existsSync(sf)) continue;
  try {
    const st = JSON.parse(fs.readFileSync(sf, 'utf8'));
    const createdAt = T(st.epic?.createdAt);
    // A non-finite createdAt (missing/malformed) makes this epic's bucket boundaries NaN, which
    // silently drops all its transcript activity from the report. Skip it and warn instead.
    if (!Number.isFinite(createdAt)) { undatedEpics.push(epicSlug); continue; }
    epics.push({ slug: epicSlug, name: st.epic?.name || epicSlug, createdAt, phase: st.phase || '' });
  } catch { /* skip an unreadable state file */ }
}
epics.sort((a, b) => a.createdAt - b.createdAt);
if (undatedEpics.length) console.warn('WARNING: skipped epic(s) with no valid epic.createdAt — their activity is NOT in the report: ' + undatedEpics.join(', '));
if (!epics.length) {
  console.error('No readable epic state.json under generated-docs/epics/ — nothing to report.');
  process.exit(1);
}

// Feature name for the report header: the first H1 in project.md, if present.
let feature = '';
try {
  const pm = fs.readFileSync(path.join(PROJECT_ROOT, 'generated-docs', 'project.md'), 'utf8');
  const h = pm.split('\n').find((l) => /^#\s+/.test(l));
  if (h) feature = h.replace(/^#\s+/, '').trim();
} catch { /* no project.md — leave blank */ }

const BUCKETS = [
  { key: 'intake', label: 'INTAKE & setup', group: 'Project phases', from: -Infinity, to: epics[0].createdAt },
];
for (let i = 0; i < epics.length; i++) {
  const openPhase = epics[i].phase && epics[i].phase !== 'COMPLETE' ? ` (${epics[i].phase})` : '';
  BUCKETS.push({
    key: `epic-${epics[i].slug}`,
    label: `Epic ${i + 1} — ${epics[i].name}${openPhase}`,
    group: 'Epics',
    from: epics[i].createdAt,
    to: i + 1 < epics.length ? epics[i + 1].createdAt : Infinity,
  });
}
const bucketOf = (ts) => BUCKETS.find(b => ts >= b.from && ts < b.to);

// ---- gather transcript files (each with its agent identity + owning session) ----
const files = [];
for (const dir of TRANSCRIPT_DIRS) {
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const sessionId = f.replace(/\.jsonl$/, '');
    if (EXCLUDE.has(sessionId)) continue;
    files.push({ file: path.join(dir, f), main: true, instance: sessionId, session: sessionId, agent: 'orchestrator', desc: 'Main workflow session (/start, /continue, gates)' });
    const subDir = path.join(dir, sessionId, 'subagents');
    if (!fs.existsSync(subDir)) continue;
    for (const sf of fs.readdirSync(subDir)) {
      if (!sf.endsWith('.jsonl')) continue;
      const metaFile = path.join(subDir, sf.replace(/\.jsonl$/, '.meta.json'));
      let agent = 'subagent', desc = '';
      if (fs.existsSync(metaFile)) {
        try { const m = JSON.parse(fs.readFileSync(metaFile, 'utf8')); agent = m.agentType || agent; desc = m.description || ''; } catch {}
      }
      files.push({ file: path.join(subDir, sf), main: false, instance: sf.replace(/\.jsonl$/, ''), session: sessionId, agent, desc });
    }
  }
}

// ---- transcript hygiene: classify user-role entries ----
// Transcripts record harness-injected events as user-role messages. Only entries a person
// actually produced count as deliberate input: free-text typed messages, slash-command
// invocations, manual-test checklist submissions, and interruptions. Everything else —
// tool results, task notifications, IDE events, isMeta reminders — is machine-generated
// and MUST NOT be counted, or "user prompts" inflates several-fold.
const HARNESS_PREFIXES = ['<task-notification', '<ide_', '<system-reminder', '<local-command-std'];
function classifyUserEntry(o) {
  if (o.isMeta) return null;
  const m = o.message;
  if (!m || m.role !== 'user') return null;
  let text;
  if (typeof m.content === 'string') text = m.content;
  else if (Array.isArray(m.content)) {
    const blocks = m.content.filter(b => b && b.type === 'text');
    if (!blocks.length) return null; // tool_result-only entry — machinery, not a person
    text = blocks.map(b => b.text || '').join('\n');
  } else return null;
  const t = text.trimStart();
  if (!t) return null;
  if (HARNESS_PREFIXES.some(p => t.startsWith(p))) return null;
  if (t.includes('[Request interrupted by user')) return { kind: 'interruptions', text: t };
  if (t.includes('<command-name>')) return { kind: 'commands', text: t };
  if (/^\{\s*"decision"\s*:\s*"manual-test-results"/.test(t)) return { kind: 'manualTest', text: t };
  return { kind: 'typed', text: t };
}

// ---- parse: dedupe streamed snapshots by message id for usage, tool_use AND AskUserQuestion ----
const usageByMsg = new Map(); // id -> usage record
const toolsByMsg = new Map(); // id -> { ts, session, names: [toolName, ...] }
const asksByMsg = new Map();  // id -> { ts, session, dialogs, questions } — deduped so a re-streamed message counts once
const inputEvents = [];       // { ts, session, kind } — deliberate user inputs (main sessions only)
const waitEvents = [];        // { ts, session, kind: 'approval'|'general'|'stall', ms } — waiting-on-user gaps
const sessionFirst = {};      // sessionId -> { kind, command, snippet } of the FIRST deliberate input
const STALL_MS = 10 * 60 * 1000; // gaps beyond this are stalls (overnight, meetings) — reported apart, never summed into waits

for (const { file, main, instance, session, agent, desc } of files) {
  // Waiting-on-user anchors, per main session (files are chronological):
  //   prevTs  — timestamp of the previous transcript event of any kind
  //   askId   — tool_use id of an AskUserQuestion whose answer hasn't arrived yet
  let prevTs = null, askId = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const ts = o.timestamp ? T(o.timestamp) : null;
    if (!ts) continue;
    if (main && o.type === 'user') {
      const answersAsk = askId && Array.isArray(o.message?.content) &&
        o.message.content.some(b => b && b.type === 'tool_result' && b.tool_use_id === askId);
      if (answersAsk) {
        // Approval wait: AskUserQuestion tool call → its tool_result. Well-anchored on real events.
        if (prevTs != null && ts > prevTs) {
          const ms = ts - prevTs;
          waitEvents.push({ ts, session, kind: ms > STALL_MS ? 'stall' : 'approval', ms });
        }
        askId = null;
      } else {
        const cls = classifyUserEntry(o);
        if (cls) {
          if (!(session in sessionFirst)) {
            const cmd = (cls.text.match(/<command-name>\s*([^<\s]+)\s*<\/command-name>/) || [])[1] || null;
            sessionFirst[session] = { kind: cls.kind, command: cmd && !cmd.startsWith('/') ? '/' + cmd : cmd, snippet: cls.text.slice(0, 120) };
          }
          inputEvents.push({ ts, session, kind: cls.kind });
          // General wait: end of the previous event → this deliberate input. An interruption is
          // NOT a wait — the AI was mid-generation, so that gap is busy time, not waiting.
          if (cls.kind !== 'interruptions') {
            if (prevTs != null && ts > prevTs) {
              const ms = ts - prevTs;
              waitEvents.push({ ts, session, kind: ms > STALL_MS ? 'stall' : 'general', ms });
            }
            askId = null; // a fresh input abandons any unanswered question
          }
        }
      }
    }
    if (o.type === 'assistant' && o.message?.model !== '<synthetic>') { // synthetic messages carry no real usage
      const id = o.message?.id || o.uuid;
      if (o.message?.usage) {
        usageByMsg.set(id, { ts, model: o.message.model, usage: o.message.usage, cc: o.message.usage.cache_creation, instance, session, agent, desc });
      }
      if (Array.isArray(o.message?.content)) {
        const names = [];
        let dialogs = 0, questions = 0;
        for (const blk of o.message.content) {
          if (blk.type !== 'tool_use') continue;
          names.push(blk.name);
          if (blk.name === 'AskUserQuestion' && main) {
            dialogs += 1;
            questions += Array.isArray(blk.input?.questions) ? blk.input.questions.length : 1;
            askId = blk.id || askId;
          }
        }
        if (names.length) toolsByMsg.set(id, { ts, session, names });
        // Keyed by message id like the maps above, so a re-streamed snapshot overwrites instead of
        // adding — questions aren't inflated by the number of snapshot lines for one message.
        if (dialogs) asksByMsg.set(id, { ts, session, dialogs, questions });
      }
    }
    prevTs = ts;
  }
}

// ---- post-delivery reporting sessions: auto-flag and roll up separately ----
// A session whose FIRST deliberate input is a report/analysis command is about the project,
// not part of the build. Its tokens/cost are excluded from the build buckets and shown as a
// separate line item, so report generation doesn't pollute cross-project comparison.
// --keep=<id> overrides the flag for a specific session.
// The pre-1.3 names (/workflow-insights, /build-effort) stay in the set: transcripts are
// historical, so sessions recorded before the rename must still be recognised.
const POST_DELIVERY_COMMANDS = new Set([
  '/build-report', '/build-report-cost', '/build-report-effort', '/dashboard',
  '/workflow-insights', '/build-effort',
]);
const flagged = new Set();
for (const [sid, sf] of Object.entries(sessionFirst)) {
  if (KEEP.has(sid)) continue;
  if (sf.kind === 'commands' && POST_DELIVERY_COMMANDS.has(sf.command)) flagged.add(sid);
}

// Fold the deduped questions into per-bucket interaction counts (once per unique message).
const interactions = {};       // bucketKey -> { questionDialogs, questionsAsked }
const interOf = (ts) => { const b = bucketOf(ts); return b ? (interactions[b.key] ||= { questionDialogs: 0, questionsAsked: 0 }) : null; };
for (const { ts, session, dialogs, questions } of asksByMsg.values()) {
  if (flagged.has(session)) continue;
  const it = interOf(ts);
  if (it) { it.questionDialogs += dialogs; it.questionsAsked += questions; }
}

// Fold deliberate inputs and waits into per-bucket rollups.
const mkInputs = () => ({ typed: 0, commands: 0, manualTest: 0, interruptions: 0 });
const mkWaits = () => ({ approvalMs: 0, approvalCount: 0, generalMs: 0, generalCount: 0, stallMs: 0, stallCount: 0 });
const inputsByBucket = {}, waitsByBucket = {};
for (const e of inputEvents) {
  if (flagged.has(e.session)) continue;
  const b = bucketOf(e.ts);
  if (b) (inputsByBucket[b.key] ||= mkInputs())[e.kind] += 1;
}
for (const w of waitEvents) {
  if (flagged.has(w.session)) continue;
  const b = bucketOf(w.ts);
  if (!b) continue;
  const W = waitsByBucket[b.key] ||= mkWaits();
  if (w.kind === 'stall') { W.stallMs += w.ms; W.stallCount += 1; }
  else if (w.kind === 'approval') { W.approvalMs += w.ms; W.approvalCount += 1; }
  else { W.generalMs += w.ms; W.generalCount += 1; }
}

// ---- aggregate tokens/cost/models/tools per bucket ----
const mkTok = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0, calls: 0 });
const addTok = (t, r) => { t.input += r.input; t.cacheRead += r.cacheRead; t.cacheWrite += r.cacheWrite; t.output += r.output; t.costUsd += r.costUsd; t.calls += 1; };
const agg = {};
for (const b of BUCKETS) agg[b.key] = { total: mkTok(), models: {} };

// instance -> { agent, ts of first record } — for sub-agent fan-out per bucket
const instMeta = {};
// agentType -> { calls, output, costUsd, models } — accumulated in this same pass so the cache-split
// and cost formula live in exactly one place (no second loop over usageByMsg to drift out of sync).
const agentCost = {};
// Post-delivery reporting sessions: everything they (and their sub-agents) spent, kept apart.
const postTok = mkTok();
for (const r of usageByMsg.values()) {
  const ra = rates(r.model);
  const w5 = r.cc ? (r.cc.ephemeral_5m_input_tokens || 0) : (r.usage.cache_creation_input_tokens || 0);
  const w1 = r.cc ? (r.cc.ephemeral_1h_input_tokens || 0) : 0;
  const rec = {
    input: r.usage.input_tokens || 0, cacheRead: r.usage.cache_read_input_tokens || 0,
    cacheWrite: w5 + w1, output: r.usage.output_tokens || 0,
  };
  rec.costUsd = (rec.input * ra.in + rec.output * ra.out + rec.cacheRead * ra.read + w5 * ra.w5m + w1 * ra.w1h) / 1e6;
  if (flagged.has(r.session)) { addTok(postTok, rec); continue; }
  const b = bucketOf(r.ts);
  if (!b) continue;
  const A = agg[b.key];
  addTok(A.total, rec);
  addTok(A.models[r.model] ||= mkTok(), rec);
  const im = (instMeta[r.instance] ||= { agent: r.agent, ts: r.ts });
  if (r.ts < im.ts) im.ts = r.ts;
  const a = agentCost[r.agent] ||= { calls: 0, output: 0, costUsd: 0, models: {} };
  a.calls += 1; a.output += rec.output; a.costUsd += rec.costUsd;
  a.models[r.model] = (a.models[r.model] || 0) + 1;
}

// tool-use counts per bucket
const toolsByBucket = {};
for (const b of BUCKETS) toolsByBucket[b.key] = {};
for (const { ts, session, names } of toolsByMsg.values()) {
  if (flagged.has(session)) continue;
  const b = bucketOf(ts);
  if (!b) continue;
  const tt = toolsByBucket[b.key];
  for (const n of names) tt[n] = (tt[n] || 0) + 1;
}

// sub-agent fan-out: count distinct instances per bucket per agentType (orchestrator excluded —
// it's one continuous main session, not a spawned worker). Bucket = bucket of the instance's
// first usage record.
const fanout = {}; // bucketKey -> { agentType -> instanceCount }
for (const im of Object.values(instMeta)) {
  if (im.agent === 'orchestrator') continue;
  const b = bucketOf(im.ts);
  if (!b) continue;
  const f = (fanout[b.key] ||= {});
  f[im.agent] = (f[im.agent] || 0) + 1;
}

// ---- emit per-bucket ----
const buckets = BUCKETS.map(b => {
  const A = agg[b.key];
  const t = A.total;
  const inputProcessed = t.input + t.cacheRead + t.cacheWrite; // total context tokens read in
  const cacheHit = inputProcessed ? t.cacheRead / inputProcessed : 0;
  const fo = fanout[b.key] || {};
  // Fix cycles at epic granularity: the batched Playwright pass (playwright-runner) runs once per
  // EPIC-END. Each extra run means the epic bounced back to BUILD for fixes, so its reruns are the
  // cleanest epic-level rework signal. (developer/test-generator can't be used here — at epic level
  // they run once per story, so their counts would conflate story count with rework.)
  return {
    key: b.key, label: b.label, group: b.group,
    tokens: t, cacheHit,
    models: A.models, tools: toolsByBucket[b.key], fanout: fo,
    fixCycles: Math.max(0, (fo['playwright-runner'] || 0) - 1),
    agentInstances: Object.values(fo).reduce((s, n) => s + n, 0),
    userInputs: inputsByBucket[b.key] || mkInputs(),
    waits: waitsByBucket[b.key] || mkWaits(),
    ...(interactions[b.key] || { questionDialogs: 0, questionsAsked: 0 }),
  };
}).filter(b => b.tokens.calls > 0);

// ---- global rollups ----
const sumTok = (sel) => buckets.reduce((acc, b) => {
  const t = sel(b); for (const k of Object.keys(acc)) acc[k] += t[k] || 0; return acc;
}, mkTok());
const modelTotals = {};
const toolTotals = {};
const agentTotals = {}; // agentType -> { instances }
for (const b of buckets) {
  for (const [m, mt] of Object.entries(b.models)) {
    const M = modelTotals[m] ||= mkTok();
    for (const k of Object.keys(M)) M[k] += mt[k];
  }
  for (const [tn, c] of Object.entries(b.tools)) toolTotals[tn] = (toolTotals[tn] || 0) + c;
  for (const [a, n] of Object.entries(b.fanout)) (agentTotals[a] ||= { instances: 0 }).instances += n;
}
// agentCost was accumulated in the per-bucket usage loop above — single source for the cost formula.
// Emit the raw model id + count per agent; the report template applies the display-name shortening,
// so that transform lives in one place (shortModel in build-cost-report-template.html).
const agents = Object.entries(agentCost).map(([agent, v]) => ({
  agent, calls: v.calls, output: v.output, costUsd: v.costUsd,
  instances: agent === 'orchestrator' ? null : (agentTotals[agent]?.instances || 0),
  models: Object.entries(v.models).sort((a, c) => c[1] - a[1]).map(([m, c]) => ({ model: m, count: c })),
})).sort((a, c) => c.costUsd - a.costUsd);

const grand = sumTok(b => b.tokens);
const inProc = grand.input + grand.cacheRead + grand.cacheWrite;

// Human-readable pricing line, generated from PRICING + the multipliers so it can never drift from
// the table (deduped by display name — the two Haiku ids share one name).
const pricingNote = 'USD per 1M tokens — ' +
  [...new Map(Object.values(PRICING).map(m => [m.name, `${m.name} $${m.input}/$${m.output}`])).values()].join(', ') +
  `. Cache read ${CACHE_READ_MULT}×, write ${CACHE_WRITE_5M_MULT}×/${CACHE_WRITE_1H_MULT}×.`;

// Grand rollups for the user-involvement metrics (sum of the per-bucket figures).
const userInputsTotal = mkInputs();
const waitsTotal = mkWaits();
for (const b of buckets) {
  for (const k of Object.keys(userInputsTotal)) userInputsTotal[k] += b.userInputs[k];
  for (const k of Object.keys(waitsTotal)) waitsTotal[k] += b.waits[k];
}

const result = {
  generatedAt: new Date().toISOString(),
  feature,
  usdToZar: RATE,
  rateProvided: !!RATE_ARG,
  pricingNote,
  unknownModels: [...unknownModels],
  extraDirs, // sibling (worktree) transcript directories that were included
  stallThresholdMin: STALL_MS / 60000,
  grand: { ...grand, cacheHit: inProc ? grand.cacheRead / inProc : 0, totalTokens: grand.input + grand.cacheRead + grand.cacheWrite + grand.output },
  userInputsTotal,
  waitsTotal,
  postDelivery: {
    sessions: [...flagged].map(id => ({ id, firstCommand: sessionFirst[id]?.command || null, snippet: sessionFirst[id]?.snippet || '' })),
    tokens: postTok,
  },
  modelTotals, toolTotals, agents,
  buckets,
};

const outDir = path.join(PROJECT_ROOT, 'generated-docs', 'reports');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'build-cost-data.json'), JSON.stringify(result, null, 2));

const template = fs.readFileSync(path.join(__dirname, 'build-cost-report-template.html'), 'utf8');
// Escape `<` so free-text data (feature/epic names, subagent descriptions) containing `</script>`
// or `<!--` cannot close the <script> tag early and break the whole page. The browser parses the
// unicode escape back to `<`, so the embedded DATA is byte-identical at runtime.
const dataForHtml = JSON.stringify(result).replace(/</g, '\\u003c');
// Replacer FUNCTION, not a string: a raw string replacement interprets special patterns such as
// $& and $$ in the data and mangles the injected JSON. A function replacement inserts it verbatim.
fs.writeFileSync(path.join(outDir, 'build-cost.html'), template.replace('/*__DATA__*/', () => dataForHtml));

if (unknownModels.size) console.warn('WARNING: unknown models priced as Opus 4.8 — add them to the PRICING table in this script: ' + [...unknownModels].join(', '));
console.log('written generated-docs/reports/build-cost.html');
console.log(JSON.stringify({
  buckets: buckets.length,
  totalCallsAcrossBuckets: grand.calls,
  totalCostUsd: +grand.costUsd.toFixed(2),
  totalCostZar: +(grand.costUsd * RATE).toFixed(2),
  cacheHitPct: +(result.grand.cacheHit * 100).toFixed(1),
  deliberateUserInputs: userInputsTotal,
  waitingOnUserMin: +((waitsTotal.approvalMs + waitsTotal.generalMs) / 60000).toFixed(1),
  stalls: { count: waitsTotal.stallCount, totalMin: +(waitsTotal.stallMs / 60000).toFixed(0) },
  postDeliverySessionsExcluded: result.postDelivery.sessions.map(s => `${s.id} (${s.firstCommand || s.snippet.slice(0, 40)})`),
  postDeliveryCostUsd: +postTok.costUsd.toFixed(2),
  extraTranscriptDirsIncluded: extraDirs,
  topTools: Object.entries(toolTotals).sort((a, b) => b[1] - a[1]).slice(0, 6),
  agents: agents.map(a => `${a.agent}${a.instances != null ? ' ×' + a.instances : ''}: $${a.costUsd.toFixed(2)}`),
}, null, 1));
