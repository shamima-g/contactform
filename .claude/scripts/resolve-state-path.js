#!/usr/bin/env node
/**
 * resolve-state-path.js
 *
 * Single source of truth for "where is the active workflow state file?" under
 * the epic-branch workflow. Hooks (workflow-guard.ps1, inject-phase-context.ps1)
 * and scripts use this instead of CWD-relative or hardcoded paths.
 *
 * Resolution rules:
 *   1. Determine current branch via `git symbolic-ref --short HEAD`.
 *   2. If branch matches `epic/<slug>` → `generated-docs/epics/<slug>/state.json`
 *      (kind: "epic"; the file may not yet exist on a freshly-created branch).
 *   3. Else → path: null, kind: "none".
 *
 * Legacy `generated-docs/context/workflow-state.json` is NOT a valid state
 * source under this workflow. Projects with legacy state must run
 * `/migrate-legacy` first.
 *
 * Usage:
 *   node .claude/scripts/resolve-state-path.js              # JSON to stdout
 *   node .claude/scripts/resolve-state-path.js --root <dir> # operate on <dir> instead of CWD
 *   node .claude/scripts/resolve-state-path.js --branch <name>  # override git lookup (used by tests)
 *
 * Output (JSON):
 *   {
 *     "status": "ok" | "error",
 *     "kind":   "epic" | "none",
 *     "branch": "epic/dashboard-overview" | "main" | null,
 *     "slug":   "dashboard-overview" | null,
 *     "path":   "generated-docs/epics/dashboard-overview/state.json" | null,
 *     "absolutePath": "<root>/generated-docs/epics/.../state.json" | null,
 *     "exists": true | false,
 *     "error":  "<message>"   // only when status === "error"
 *   }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getProjectRoot } = require('./lib/project-root');

const EPIC_BRANCH_PREFIX = 'epic/';
// The generated-docs root — the single home for the workflow's on-disk layout.
// EPICS_DIR_REL derives from it, and the dashboard scripts import it as the base
// their in-page links resolve relative to, so the root is written down once.
const GENERATED_DOCS_REL = 'generated-docs';
const EPICS_DIR_REL = `${GENERATED_DOCS_REL}/epics`;
const PROJECT_MD_REL = `${GENERATED_DOCS_REL}/project.md`; // project-level facts marker
const LEGACY_STATE_REL = `${GENERATED_DOCS_REL}/context/workflow-state.json`; // pre-epic-branch monolithic state

// Consume the value following a value-taking flag, erroring (rather than crashing on
// path.resolve(undefined) or silently binding the next flag as the value) when it's missing.
// Shared by the sibling state CLIs (epic-state.js, mark-epic-complete.js, migrate-legacy-state.js)
// so the guard stays in one place rather than copy-pasted per script.
function requireValue(argv, i, flag) {
  const v = argv[i];
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
  return v;
}

function parseArgs(argv) {
  const args = { root: getProjectRoot(), branch: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') { args.root = path.resolve(requireValue(argv, ++i, '--root')); }
    else if (a === '--branch') { args.branch = requireValue(argv, ++i, '--branch'); }
    else if (a === '--help' || a === '-h') { args.help = true; }
    else { throw new Error(`Unknown argument: ${a}`); }
  }
  return args;
}

function detectBranch(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'symbolic-ref', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function isValidEpicSlug(slug) {
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

function resolveStatePath({ root, branch }) {
  const effectiveBranch = branch ?? detectBranch(root);

  if (effectiveBranch && effectiveBranch.startsWith(EPIC_BRANCH_PREFIX)) {
    const slug = effectiveBranch.slice(EPIC_BRANCH_PREFIX.length);
    if (!isValidEpicSlug(slug)) {
      return {
        status: 'error',
        error: `Invalid epic slug in branch name "${effectiveBranch}" — expected kebab-case after "epic/"`,
        kind: null,
        branch: effectiveBranch,
        slug: null,
        path: null,
        absolutePath: null,
        exists: false
      };
    }
    const rel = `${EPICS_DIR_REL}/${slug}/state.json`;
    const abs = path.join(root, rel);
    return {
      status: 'ok',
      kind: 'epic',
      branch: effectiveBranch,
      slug,
      path: rel,
      absolutePath: abs,
      exists: fs.existsSync(abs)
    };
  }

  return {
    status: 'ok',
    kind: 'none',
    branch: effectiveBranch,
    slug: null,
    path: null,
    absolutePath: null,
    exists: false
  };
}

function printHelp() {
  console.log('Usage: node .claude/scripts/resolve-state-path.js [--root <dir>] [--branch <name>]');
  console.log('');
  console.log('Resolves the active workflow state.json path for the current branch.');
  console.log('Returns JSON on stdout. kind=epic when on an epic/* branch, kind=none otherwise.');
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error('Run with --help for usage.');
    process.exit(2);
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const result = resolveStatePath({ root: args.root, branch: args.branch });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.status === 'ok' ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  resolveStatePath,
  detectBranch,
  isValidEpicSlug,
  requireValue,
  EPIC_BRANCH_PREFIX,
  GENERATED_DOCS_REL,
  EPICS_DIR_REL,
  PROJECT_MD_REL,
  LEGACY_STATE_REL
};
