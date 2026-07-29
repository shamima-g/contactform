#!/usr/bin/env node
/**
 * workflow-helpers.js
 * Legacy shared helpers. Consumed only by migrate-legacy-state.js (Path A of
 * /migrate-legacy), which reads the legacy monolithic workflow-state.json.
 * NOT used by the epic-branch state path (resolve-state-path.js / epic-state.js /
 * lib/epic-state.js). Slated for removal once /migrate-legacy is retired.
 *
 * Legacy phase model: INTAKE → PLAN → BUILD → COMPLETE.
 */

const fs = require('fs');
const path = require('path');

// =============================================================================
// PATH CONSTANTS (legacy monolithic workflow layout)
// =============================================================================

const STORIES_DIR = 'generated-docs/stories';
const STATE_FILE = 'generated-docs/context/workflow-state.json';
const BRIEF_PATH = 'generated-docs/specs/project-brief.md';

// =============================================================================
// FILE FINDING HELPERS
// =============================================================================

function globToRegex(pattern) {
  return new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

function findFiles(dir, pattern) {
  const regex = globToRegex(pattern);
  try {
    return fs.readdirSync(dir)
      .filter(file => regex.test(file))
      .map(file => path.join(dir, file));
  } catch {
    return [];
  }
}

// =============================================================================
// EPIC / STORY DIRECTORY HELPERS
// =============================================================================

function findStoryFiles(epicDir) {
  const storyFiles = findFiles(epicDir, 'story-*.md').sort();
  const results = [];
  for (const file of storyFiles) {
    const basename = path.basename(file, '.md');
    const numMatch = basename.match(/story-(\d+)/);
    if (numMatch) {
      results.push({ num: parseInt(numMatch[1]), title: basename, path: file });
    }
  }
  return results;
}

// =============================================================================
// ACCEPTANCE CRITERIA HELPERS
// =============================================================================
// Parse `## Acceptance Criteria` checkbox lists from story Markdown. In the
// legacy 4-phase workflow, story AC also lived inline in workflow-state.json;
// this helper parses the Markdown form for the /migrate-legacy path.

function extractACSection(content) {
  const acHeaderPattern = /^## Acceptance Criteria\s*$/m;
  const acStart = content.search(acHeaderPattern);
  if (acStart === -1) return null;
  const afterHeader = content.indexOf('\n', acStart) + 1;
  const nextH2 = content.indexOf('\n## ', afterHeader);
  const acEnd = nextH2 === -1 ? content.length : nextH2;
  return {
    text: content.slice(afterHeader, acEnd),
    startOffset: afterHeader,
    endOffset: acEnd
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
  STORIES_DIR,
  STATE_FILE,
  BRIEF_PATH,
  findStoryFiles,
  extractACSection
};
