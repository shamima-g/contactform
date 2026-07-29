'use strict';

const { execFileSync } = require('child_process');

/**
 * Shared thin wrapper around `git` for the collectors (dashboard + build report).
 * Runs `git -C <root> <args...>`, returns trimmed stdout, or null on any failure
 * (missing repo, bad ref, non-zero exit) so callers treat "no data" uniformly.
 *
 * maxBuffer is 32 MB: the build-report collector runs `git log --all --numstat` over
 * the whole history, whose output can exceed Node's ~1 MB default and would otherwise
 * throw. A larger ceiling never changes behaviour for the small outputs the dashboard
 * reads.
 */
function tryGit(root, ...args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return null;
  }
}

module.exports = { tryGit };
