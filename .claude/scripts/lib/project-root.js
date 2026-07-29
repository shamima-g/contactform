#!/usr/bin/env node
/**
 * project-root.js
 *
 * Single source of truth for "where is the repo root?", independent of the
 * current working directory. Workflow scripts must read and write the canonical
 * artifact dirs (generated-docs/, .claude/) at the repo root — never relative to
 * process.cwd(), which drifts into web/ when an agent runs `cd web` and doesn't
 * return (the bash CWD persists across calls). A CWD-relative default produced a
 * stray web/generated-docs/ in benchmarking.
 *
 * Anchored to THIS file's location, not the CWD: it walks up from here to the
 * nearest ancestor holding a `.claude/` (or `.git/`) marker, so it returns the
 * repo root no matter where the requiring script or hook was invoked from. The
 * PowerShell hooks use the same marker-walk (Get-ProjectRoot in
 * .claude/hooks/lib/workflow-state.ps1), walking up from $PSScriptRoot.
 *
 * NOTE: this is for scripts that operate on THEIR OWN repo. A tool that validates
 * an arbitrary project it is pointed at (e.g. .github/scripts/security-validator.js)
 * must stay CWD-relative instead — see resolveWebRoot there.
 *
 * Usage:
 *   const { getProjectRoot } = require('./lib/project-root');   // from .claude/scripts/
 *   const { getProjectRoot } = require('../scripts/lib/project-root'); // from .claude/hooks/
 *   const root = getProjectRoot();
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Walk up from `startDir` (default: this file's directory) to the first
 * ancestor that contains a `.claude/` directory, and return it. Falls back to
 * `.git` as a secondary marker, then to a fixed-depth resolve from __dirname
 * (<root>/.claude/scripts/lib → <root>) if neither marker is found.
 */
function getProjectRoot(startDir = __dirname) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.claude')) || fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root without a marker
    dir = parent;
  }
  // Fixed-depth fallback (no marker found above) — see the JSDoc for the depth.
  return path.resolve(__dirname, '..', '..', '..');
}

module.exports = { getProjectRoot };
