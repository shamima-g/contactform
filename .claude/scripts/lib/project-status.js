'use strict';

const fs = require('fs');
const path = require('path');
// Layout paths come from the layout SSOT (resolve-state-path.js), so the
// generated-docs root is written down once and this check can't drift from it.
const { PROJECT_MD_REL, LEGACY_STATE_REL } = require('../resolve-state-path');

/**
 * Classify a project directory the same way for every workflow view, so /dashboard
 * and /build-report never disagree on whether a project exists or needs migration.
 * Returns 'ok' | 'no_project' | 'legacy_detected'. Callers own the user-facing
 * message for each status — the wording differs by surface.
 */
function projectStatus(root) {
  const hasProjectMd = fs.existsSync(path.join(root, PROJECT_MD_REL));
  const hasLegacyState = fs.existsSync(path.join(root, LEGACY_STATE_REL));
  if (!hasProjectMd && hasLegacyState) return 'legacy_detected';
  if (!hasProjectMd && !hasLegacyState) return 'no_project';
  return 'ok';
}

module.exports = { projectStatus };
