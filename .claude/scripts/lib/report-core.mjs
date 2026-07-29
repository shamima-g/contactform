// report-core.mjs
//
// Shared building blocks for the log-derived reports (/build-report-cost, /build-report-effort):
// the ONE pricing table, the cache multipliers, the transcript-directory discovery, and
// the deduped usage-record reader. Keeping these here means a new model / price change is
// edited in exactly one place and can't drift between reports.
//
// NOTE: build-report-cost/generate-build-cost-report.mjs still carries its own copy of the
// pricing table today; it should be migrated to import from here so there is a single
// source of truth. Until then, keep the PRICING block below in sync with that script.
//
// Pure functions only — no argv parsing, no file writes, no process.exit — so both report
// generators can compose these however they need.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---- pricing (USD per 1M tokens). Cache read 0.1x input; cache write 1.25x (5m) / 2x (1h). ----
export const CACHE_READ_MULT = 0.1, CACHE_WRITE_5M_MULT = 1.25, CACHE_WRITE_1H_MULT = 2;
export const PRICING = {
  'claude-fable-5':            { input: 10, output: 50, name: 'Fable 5' },
  'claude-opus-4-8':           { input: 5,  output: 25, name: 'Opus 4.8' },
  'claude-sonnet-5':           { input: 3,  output: 15, name: 'Sonnet 5' },
  'claude-sonnet-4-6':         { input: 3,  output: 15, name: 'Sonnet 4.6' },
  'claude-haiku-4-5-20251001': { input: 1,  output: 5,  name: 'Haiku 4.5' },
  'claude-haiku-4-5':          { input: 1,  output: 5,  name: 'Haiku 4.5' },
};
export const unknownModels = new Set();
export function rates(model) {
  let p = PRICING[model];
  if (!p) { unknownModels.add(model); p = PRICING['claude-opus-4-8']; }
  return { in: p.input, out: p.output, read: p.input * CACHE_READ_MULT, w5m: p.input * CACHE_WRITE_5M_MULT, w1h: p.input * CACHE_WRITE_1H_MULT };
}

// ---- transcript directory discovery ----
// Standard store is ~/.claude/projects/<slug>/, where slug = the project's absolute path
// with every non-alphanumeric char replaced by '-'. Sibling dirs whose slug extends this
// one (git-worktree variants: `<slug>--...`) are included too. Pass `transcriptsOverride`
// (a directory holding `<slug>/`) to read a copied snapshot instead of the live store.
export function discoverTranscriptDirs(projectRoot, transcriptsOverride) {
  const slug = projectRoot.replace(/[^a-zA-Z0-9]/g, '-');
  const projectsRoot = transcriptsOverride || path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsRoot)) return { dirs: [], slug, projectsRoot };
  const dirs = [];
  const primary = path.join(projectsRoot, slug);
  if (fs.existsSync(primary)) dirs.push(primary);
  for (const d of fs.readdirSync(projectsRoot)) {
    if (d === slug || !d.startsWith(slug + '--')) continue;
    try { if (fs.statSync(path.join(projectsRoot, d)).isDirectory()) dirs.push(path.join(projectsRoot, d)); } catch { /* skip */ }
  }
  // Fallback: if the override dir directly contains the .jsonl files (single-project snapshot
  // whose folder name isn't the slug), treat it as the one transcript dir.
  if (!dirs.length && transcriptsOverride) {
    const sub = fs.readdirSync(projectsRoot).filter(f => fs.statSync(path.join(projectsRoot, f)).isDirectory());
    for (const s of sub) dirs.push(path.join(projectsRoot, s));
  }
  return { dirs, slug, projectsRoot };
}

// ---- usage records, deduped by message id, across orchestrator + all sub-agents ----
// Returns { records:[{ts, model, cost, tokens, sessionId, agent, main}], sawSubagents:bool }.
// `sawSubagents` lets a caller detect the incomplete-log case (no sub-agent transcripts
// captured) and degrade gracefully instead of reporting wrong cost.
export function gatherUsageRecords(dirs, excludeIds = new Set()) {
  const files = [];
  let sawSubagents = false;
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const sid = f.replace(/\.jsonl$/, '');
      if (excludeIds.has(sid)) continue;
      files.push({ file: path.join(dir, f), sessionId: sid, agent: 'orchestrator', main: true });
      const subDir = path.join(dir, sid, 'subagents');
      if (!fs.existsSync(subDir)) continue;
      for (const sf of fs.readdirSync(subDir)) {
        if (!sf.endsWith('.jsonl')) continue;
        sawSubagents = true;
        let agent = 'subagent';
        const metaFile = path.join(subDir, sf.replace(/\.jsonl$/, '.meta.json'));
        if (fs.existsSync(metaFile)) { try { agent = JSON.parse(fs.readFileSync(metaFile, 'utf8')).agentType || agent; } catch { /* keep default */ } }
        files.push({ file: path.join(subDir, sf), sessionId: sid, agent, main: false });
      }
    }
  }
  const byId = new Map();
  for (const { file, sessionId, agent, main } of files) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'assistant' || o.message?.model === '<synthetic>' || !o.message?.usage) continue;
      const id = o.message?.id || o.uuid;
      const u = o.message.usage, cc = u.cache_creation;
      const w5 = cc ? (cc.ephemeral_5m_input_tokens || 0) : (u.cache_creation_input_tokens || 0);
      const w1 = cc ? (cc.ephemeral_1h_input_tokens || 0) : 0;
      const inp = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, out = u.output_tokens || 0;
      const ra = rates(o.message.model);
      const cost = (inp * ra.in + out * ra.out + cr * ra.read + w5 * ra.w5m + w1 * ra.w1h) / 1e6;
      byId.set(id, { ts: o.timestamp ? new Date(o.timestamp).getTime() : null, model: o.message.model, cost, tokens: inp + cr + w5 + w1 + out, sessionId, agent, main });
    }
  }
  return { records: [...byId.values()].filter(r => r.ts), sawSubagents };
}
