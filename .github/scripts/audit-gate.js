#!/usr/bin/env node

/**
 * Dependency Audit Gate
 *
 * Runs `npm audit` against PRODUCTION dependencies only and decides whether the
 * Security gate passes:
 *
 *   - A Critical or High severity advisory FAILS the gate (exit 1), so the run
 *     fails — identically on pull requests and on direct pushes.
 *   - Medium (npm calls this "moderate") and Low advisories are ADVISORY only:
 *     reported, never failing.
 *   - A specific advisory with no upstream fix can be granted a visible,
 *     time-boxed exception in `dependency-audit-exceptions.json` in the web/ folder.
 *     An exception applies only to the named advisory and expires; once expired,
 *     that advisory fails runs again.
 *
 * The report names the offending dependency and advisory in plain language and
 * states that it is the reason the run failed.
 *
 * Both the CI workflow and the local `/quality-check` runner call this one
 * script, so the gate behaves the same everywhere.
 *
 * Usage:
 *   node .github/scripts/audit-gate.js            # human-readable + CI output
 *   node .github/scripts/audit-gate.js --json     # single-line JSON summary
 *   node .github/scripts/audit-gate.js --help
 *
 * Exit code: 0 = pass, 1 = blocking advisory found (or audit could not run).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ANSI colour codes (matches security-validator.js)
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

/**
 * Everything we need to know per npm severity, in one place:
 *  - rank:   sort order, lower = more serious (for ordering reports)
 *  - label:  human label (npm uses "moderate" for what we call Medium)
 *  - blocks: whether this severity fails the gate
 */
const SEVERITIES = {
  critical: { rank: 0, label: 'Critical', blocks: true },
  high: { rank: 1, label: 'High', blocks: true },
  moderate: { rank: 2, label: 'Medium', blocks: false },
  low: { rank: 3, label: 'Low', blocks: false },
  info: { rank: 4, label: 'Info', blocks: false },
};

/** Sort rank for an unknown severity — ordered after everything known. */
const UNKNOWN_RANK = 9;

/**
 * Comparator that orders advisories most-serious first, then by package name
 * for a stable, readable order within a severity.
 */
function bySeverity(a, b) {
  const rank = (SEVERITIES[a.severity]?.rank ?? UNKNOWN_RANK) - (SEVERITIES[b.severity]?.rank ?? UNKNOWN_RANK);
  if (rank !== 0) return rank;
  return ([...a.packages][0] || '').localeCompare([...b.packages][0] || '');
}

/** Human label for an npm severity (npm uses "moderate" for what we call Medium). */
function severityLabel(severity) {
  return SEVERITIES[(severity || '').toLowerCase()]?.label || severity || 'Unknown';
}

/** True when an advisory of this severity fails the gate (Critical/High). */
function isBlockingSeverity(severity) {
  return SEVERITIES[(severity || '').toLowerCase()]?.blocks === true;
}

/** CLI options parsed from argv. */
const cliOptions = { help: false, json: false };

function parseArgs() {
  for (const arg of process.argv.slice(2)) {
    if (arg === '--help' || arg === '-h') cliOptions.help = true;
    else if (arg === '--json') cliOptions.json = true;
  }
}

function showHelp() {
  console.log(`
Dependency Audit Gate

Audits production dependencies for known vulnerabilities and fails the Security
gate on any Critical or High advisory. Medium and Low advisories are reported
but never fail the run.

Usage:
  node .github/scripts/audit-gate.js          Run the gate (human-readable)
  node .github/scripts/audit-gate.js --json   Emit a single-line JSON summary
  node .github/scripts/audit-gate.js --help   Show this message

Exceptions:
  An advisory with no upstream fix can be granted a time-boxed exception in
  dependency-audit-exceptions.json in the web/ folder: add its id under "advisories" with
  a "reason" and an ISO "expires" date. See the Quality Gates help doc for details.

Exit code:
  0  No blocking advisories (or only advisory-level findings).
  1  At least one Critical/High advisory with no valid exception, or the audit
     could not be run.
`);
}

/** True when running inside GitHub Actions. */
function isGitHubActions() {
  return process.env.GITHUB_ACTIONS === 'true';
}

/**
 * Resolve the web/ directory, tolerating both launch styles:
 *  - from the repo root (`node .github/scripts/audit-gate.js`), and
 *  - from inside web/ in CI (`node ../.github/scripts/audit-gate.js` with
 *    working-directory: web).
 *
 * @returns {string} absolute path to the web/ directory
 */
function resolveWebRoot() {
  const cwd = process.cwd();
  // CI runs with working-directory: web, so cwd is already web/.
  if (path.basename(cwd) === 'web' && fs.existsSync(path.join(cwd, 'package.json'))) {
    return cwd;
  }
  // Otherwise web/ sits under cwd (run from the repo root).
  return path.join(cwd, 'web');
}

/**
 * Run `npm audit` for production dependencies and return parsed JSON.
 *
 * npm exits non-zero when advisories exist, but still prints the JSON report to
 * stdout — so we capture stdout even on a thrown error and parse it. Returns
 * null only when no parseable report was produced (e.g. npm itself errored).
 *
 * @param {string} webRoot - directory containing package.json / package-lock.json
 * @returns {{ json: object|null, error: string|null }}
 */
function runNpmAudit(webRoot) {
  let stdout = '';
  try {
    stdout = execSync('npm audit --omit=dev --json', {
      cwd: webRoot,
      encoding: 'utf-8',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // Non-zero exit (advisories found) lands here; the JSON is still on stdout.
    stdout = (err.stdout && err.stdout.toString()) || '';
    if (!stdout) {
      return { json: null, error: (err.stderr && err.stderr.toString()) || err.message };
    }
  }

  try {
    return { json: JSON.parse(stdout), error: null };
  } catch (parseErr) {
    return { json: null, error: `Could not parse npm audit output: ${parseErr.message}` };
  }
}

/** Extract a GHSA identifier from an advisory URL, if present. */
function ghsaFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
  return m ? m[0] : null;
}

/**
 * Collect distinct advisories from an npm audit JSON report (npm v7+ shape).
 *
 * Each entry in a vulnerability's `via` array is either a string (a transitive
 * reference to another vulnerable package — skipped here) or an advisory object
 * with `source`, `title`, `url`, and `severity`. We key advisories by their
 * GHSA id where available (stable and human-readable), falling back to npm's
 * numeric `source` id.
 *
 * @param {object} auditJson
 * @returns {Map<string, {id:string, source:(number|undefined), title:string, url:string, severity:string, packages:Set<string>, fixAvailable:any}>}
 */
function collectAdvisories(auditJson) {
  const advisories = new Map();
  const vulns = (auditJson && auditJson.vulnerabilities) || {};

  for (const [pkgName, v] of Object.entries(vulns)) {
    for (const via of v.via || []) {
      if (!via || typeof via !== 'object') continue; // string = transitive ref

      const id = ghsaFromUrl(via.url) || (via.source != null ? String(via.source) : null);
      if (!id) continue;

      if (!advisories.has(id)) {
        advisories.set(id, {
          id,
          source: via.source,
          title: via.title || 'Known security advisory',
          url: via.url || '',
          severity: (via.severity || v.severity || '').toLowerCase(),
          packages: new Set(),
          fixAvailable: v.fixAvailable,
        });
      }
      advisories.get(id).packages.add(via.name || pkgName);
    }
  }

  return advisories;
}

/**
 * Tally distinct advisories by severity for the report's summary line. Counts the
 * advisories themselves — matching the lists shown — rather than npm's
 * metadata.vulnerabilities, which counts vulnerable packages at their highest
 * severity and so under-counts a package carrying several advisories. Severities
 * outside the four reported buckets (e.g. info) are ignored.
 *
 * @param {Map<string, {severity:string}>} advisories
 * @returns {{ critical:number, high:number, moderate:number, low:number }}
 */
function countBySeverity(advisories) {
  const counts = { critical: 0, high: 0, moderate: 0, low: 0 };
  for (const a of advisories.values()) {
    if (Object.prototype.hasOwnProperty.call(counts, a.severity)) counts[a.severity] += 1;
  }
  return counts;
}

/**
 * Load recorded exceptions from dependency-audit-exceptions.json in the web/ folder.
 *
 * Accepts either a flat object keyed by advisory id, or `{ advisories: {...} }`.
 * Each value is `{ reason, expires }` where `expires` is an ISO date (YYYY-MM-DD)
 * after which the exception no longer applies.
 *
 * @param {string} webRoot
 * @returns {{ map: Record<string,{reason?:string, expires?:string}>, path: string, error: string|null }}
 */
function loadExceptions(webRoot) {
  const filePath = path.join(webRoot, 'dependency-audit-exceptions.json');
  if (!fs.existsSync(filePath)) {
    return { map: {}, path: filePath, error: null };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const map =
      raw && typeof raw.advisories === 'object' && raw.advisories !== null
        ? raw.advisories
        : raw;
    // Valid JSON of the wrong shape (a string, number, null, or array) cannot be
    // a map of advisories. Treat it like unreadable JSON — drop all exceptions
    // and surface a warning — rather than silently swallowing it.
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      return {
        map: {},
        path: filePath,
        error:
          'dependency-audit-exceptions.json must be a JSON object keyed by advisory id (or { "advisories": { ... } }).',
      };
    }
    return { map, path: filePath, error: null };
  } catch (err) {
    return { map: {}, path: filePath, error: err.message };
  }
}

/**
 * Find a valid (matching, unexpired) exception for an advisory.
 *
 * Matches the exception key against the advisory's GHSA id or numeric source id.
 * An exception with a missing/invalid/past `expires` date does not protect the
 * advisory — it is surfaced separately so an expired exception is visible.
 *
 * @returns {{ status: 'valid'|'expired'|'invalid'|'none', key?: string, reason?: string, expires?: string }}
 */
function findException(advisory, exceptionsMap, now) {
  const candidateKeys = [advisory.id];
  if (advisory.source != null) candidateKeys.push(String(advisory.source));

  for (const key of candidateKeys) {
    if (!Object.prototype.hasOwnProperty.call(exceptionsMap, key)) continue;
    const entry = exceptionsMap[key] || {};
    const expiresMs = entry.expires ? Date.parse(entry.expires) : NaN;

    if (Number.isNaN(expiresMs)) {
      return { status: 'invalid', key, reason: entry.reason, expires: entry.expires };
    }
    if (expiresMs < now) {
      return { status: 'expired', key, reason: entry.reason, expires: entry.expires };
    }
    return { status: 'valid', key, reason: entry.reason, expires: entry.expires };
  }
  return { status: 'none' };
}

/** Describe whether/how a fix is available, in plain language. */
function describeFix(fixAvailable) {
  if (fixAvailable === false || fixAvailable == null) {
    return 'No upstream fix is available yet.';
  }
  if (fixAvailable === true) {
    return 'A fix is available — update the dependency (try `npm audit fix`).';
  }
  // Object form: { name, version, isSemVerMajor }
  if (typeof fixAvailable === 'object' && fixAvailable.name) {
    const major = fixAvailable.isSemVerMajor ? ' (a major version change — test carefully)' : '';
    return `A fix is available — update ${fixAvailable.name} to ${fixAvailable.version}${major}.`;
  }
  return 'A fix may be available — try `npm audit fix`.';
}

/**
 * Classify all advisories into blocking / excepted / advisory-only, and surface
 * any recorded exceptions that are expired, invalid, or no longer match a live
 * advisory.
 */
function classify(advisories, exceptionsMap, now) {
  const blocking = [];
  const excepted = [];
  const advisoryOnly = [];

  for (const advisory of advisories.values()) {
    if (!isBlockingSeverity(advisory.severity)) {
      advisoryOnly.push(advisory);
      continue;
    }

    const exception = findException(advisory, exceptionsMap, now);
    if (exception.status === 'valid') {
      excepted.push({ ...advisory, exception });
    } else {
      blocking.push({ ...advisory, exception });
    }
  }

  // Exceptions in the file that did not protect a live advisory: expired,
  // unparseable, or referencing an advisory that no longer appears. Only keys
  // that were actually applied (valid) are excluded — a key attached to a still-
  // blocking advisory (because it was expired/invalid) must still be surfaced.
  const appliedKeys = new Set();
  excepted.forEach((a) => {
    if (a.exception && a.exception.key) appliedKeys.add(a.exception.key);
  });

  const staleExceptions = [];
  for (const [key, entry] of Object.entries(exceptionsMap)) {
    if (appliedKeys.has(key)) continue;
    const rawExpires = entry && entry.expires;
    const expiresMs = rawExpires ? Date.parse(rawExpires) : NaN;
    // `why` is self-contained — render sites print it as-is.
    let why;
    if (!rawExpires) why = 'missing an expiry date';
    else if (Number.isNaN(expiresMs)) why = `invalid expiry date "${rawExpires}" (use an ISO date like 2026-12-31)`;
    else if (expiresMs < now) why = `expired on ${rawExpires}`;
    else why = 'no matching advisory in the current audit';
    staleExceptions.push({ key, reason: (entry && entry.reason) || '', expires: rawExpires || '', why });
  }

  // Order every list most-serious first so reports read consistently.
  blocking.sort(bySeverity);
  excepted.sort(bySeverity);
  advisoryOnly.sort(bySeverity);

  return { blocking, excepted, advisoryOnly, staleExceptions };
}

/** Emit a GitHub Actions error annotation. */
function annotateError(message) {
  if (isGitHubActions()) {
    console.log(`::error title=Security Gate: dependency vulnerability::${message}`);
  }
}

/** Append markdown to the GitHub Actions job summary, if available. */
function appendJobSummary(markdown) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  try {
    fs.appendFileSync(summaryFile, markdown);
  } catch {
    // Best-effort only.
  }
}

/** Build the GitHub job-summary markdown for the run. */
function buildJobSummary({ blocking, excepted, advisoryOnly, staleExceptions }) {
  let md = '# 🔒 Dependency Audit\n\n';

  if (blocking.length === 0) {
    md += excepted.length
      ? '✅ No blocking advisories. Some Critical/High advisories are temporarily allowed by exception (see below).\n\n'
      : '✅ No Critical or High advisories in production dependencies.\n\n';
  } else {
    md += `❌ **${blocking.length} blocking advisor${blocking.length === 1 ? 'y' : 'ies'} (Critical/High)**\n\n`;
    md += '| Severity | Dependency | Advisory | Fix |\n|---|---|---|---|\n';
    blocking.forEach((a) => {
      const pkgs = [...a.packages].join(', ');
      const adv = a.url ? `[${a.id}](${a.url})` : a.id;
      md += `| ${severityLabel(a.severity)} | \`${pkgs}\` | ${adv}: ${a.title.replace(/\|/g, '\\|')} | ${describeFix(a.fixAvailable).replace(/\|/g, '\\|')} |\n`;
    });
    md += '\n';
  }

  if (excepted.length) {
    md += '<details><summary>⏳ Temporarily allowed by exception</summary>\n\n';
    md += '| Dependency | Advisory | Expires | Reason |\n|---|---|---|---|\n';
    excepted.forEach((a) => {
      const pkgs = [...a.packages].join(', ');
      md += `| \`${pkgs}\` | ${a.id} | ${a.exception.expires} | ${(a.exception.reason || '').replace(/\|/g, '\\|')} |\n`;
    });
    md += '\n</details>\n\n';
  }

  if (advisoryOnly.length) {
    md += `<details><summary>ℹ️ ${advisoryOnly.length} non-blocking advisor${advisoryOnly.length === 1 ? 'y' : 'ies'} (Medium/Low)</summary>\n\n`;
    advisoryOnly.forEach((a) => {
      md += `- ${severityLabel(a.severity)}: \`${[...a.packages].join(', ')}\` — ${a.id}: ${a.title}\n`;
    });
    md += '\n</details>\n\n';
  }

  if (staleExceptions.length) {
    md += '<details><summary>⚠️ Exceptions needing attention (dependency-audit-exceptions.json)</summary>\n\n';
    staleExceptions.forEach((e) => {
      md += `- \`${e.key}\` — ${e.why}\n`;
    });
    md += '\n</details>\n\n';
  }

  return md;
}

/** Print the human-readable report to the console. */
function printHumanReport(result, exceptionsPath) {
  const { blocking, excepted, advisoryOnly, staleExceptions, counts } = result;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`${colors.blue}DEPENDENCY AUDIT (production dependencies)${colors.reset}`);
  console.log(`${'='.repeat(70)}`);
  console.log(
    `Found: ${counts.critical} critical, ${counts.high} high, ${counts.moderate} medium, ${counts.low} low.\n`,
  );

  if (blocking.length > 0) {
    console.log(
      `${colors.red}❌ The Security gate FAILED because of known vulnerabilities in dependencies your app ships:${colors.reset}\n`,
    );
    blocking.forEach((a) => {
      const pkgs = [...a.packages].join(', ');
      console.log(`  ${colors.red}✗${colors.reset} ${severityLabel(a.severity)} — package "${pkgs}"`);
      console.log(`     Advisory: ${a.id} — ${a.title}`);
      if (a.url) console.log(`     More info: ${a.url}`);
      console.log(`     ${describeFix(a.fixAvailable)}`);
      if (a.fixAvailable === false || a.fixAvailable == null) {
        console.log(
          `     If you must ship before a fix exists, record a time-boxed exception for ${a.id}`,
        );
        console.log(`     under "advisories" in dependency-audit-exceptions.json (reason + ISO expiry date).`);
      }
      console.log('');
    });
  } else {
    console.log(`${colors.green}✅ No blocking (Critical/High) advisories.${colors.reset}\n`);
  }

  if (excepted.length > 0) {
    console.log(`${colors.yellow}⏳ Temporarily allowed by exception (still need fixing):${colors.reset}`);
    excepted.forEach((a) => {
      console.log(
        `  ${colors.yellow}~${colors.reset} ${a.id} in "${[...a.packages].join(', ')}" — expires ${a.exception.expires}` +
          (a.exception.reason ? ` (${a.exception.reason})` : ''),
      );
    });
    console.log('');
  }

  if (advisoryOnly.length > 0) {
    console.log(`${colors.blue}ℹ️  ${advisoryOnly.length} non-blocking advisor${advisoryOnly.length === 1 ? 'y' : 'ies'} (Medium/Low):${colors.reset}`);
    advisoryOnly.forEach((a) => {
      console.log(`  - ${severityLabel(a.severity)}: ${a.id} in "${[...a.packages].join(', ')}" — ${a.title}`);
    });
    console.log('');
  }

  if (staleExceptions.length > 0) {
    console.log(`${colors.yellow}⚠️  Exceptions needing attention (${path.basename(exceptionsPath)}):${colors.reset}`);
    staleExceptions.forEach((e) => {
      console.log(`  - ${e.key}: ${e.why}`);
    });
    console.log('');
  }

  console.log('='.repeat(70));
}

function main() {
  parseArgs();
  if (cliOptions.help) {
    showHelp();
    process.exit(0);
  }

  const webRoot = resolveWebRoot();
  const { json: auditJson, error: auditError } = runNpmAudit(webRoot);

  // Fail safe: if the audit could not run, do not let the gate pass silently.
  if (!auditJson) {
    const message = `Could not run the dependency audit: ${auditError || 'unknown error'}`;
    if (cliOptions.json) {
      console.log(JSON.stringify({ passed: false, error: message }));
    } else {
      console.error(`${colors.red}${message}${colors.reset}`);
      annotateError(message);
    }
    process.exit(1);
  }

  const { map: exceptionsMap, path: exceptionsPath, error: exceptionsError } = loadExceptions(webRoot);
  const now = Date.now();
  const advisories = collectAdvisories(auditJson);
  const counts = countBySeverity(advisories);
  const classified = { ...classify(advisories, exceptionsMap, now), counts };

  const passed = classified.blocking.length === 0;

  if (cliOptions.json) {
    // Single-line JSON for the local /quality-check runner to parse.
    console.log(
      JSON.stringify({
        passed,
        counts,
        blocking: classified.blocking.map((a) => ({
          id: a.id,
          severity: a.severity,
          packages: [...a.packages],
          title: a.title,
          fix: describeFix(a.fixAvailable),
        })),
        exceptionsApplied: classified.excepted.map((a) => ({ id: a.id, expires: a.exception.expires })),
        staleExceptions: classified.staleExceptions,
        exceptionsError,
      }),
    );
    process.exit(passed ? 0 : 1);
  }

  if (exceptionsError) {
    console.error(
      `${colors.yellow}Warning: could not read ${path.basename(exceptionsPath)} (${exceptionsError}). Treating all advisories as un-excepted.${colors.reset}`,
    );
  }

  printHumanReport(classified, exceptionsPath);

  if (isGitHubActions()) {
    appendJobSummary(buildJobSummary(classified));
  }

  if (passed) {
    console.log(`\n${colors.green}Dependency audit passed.${colors.reset}\n`);
    process.exit(0);
  } else {
    // One annotation for the whole failure
    const count = classified.blocking.length;
    const offenders = classified.blocking
      .map((a) => `${severityLabel(a.severity)} in ${[...a.packages].join(', ')} (${a.id})`)
      .join('; ');
    annotateError(`${count} Critical/High advisor${count === 1 ? 'y' : 'ies'} block the build: ${offenders}`);
    console.log(
      `\n${colors.red}Dependency audit failed: fix the Critical/High advisories above, or record a time-boxed exception.${colors.reset}\n`,
    );
    process.exit(1);
  }
}

// Run as a CLI when invoked directly; expose pure helpers for unit testing.
if (require.main === module) {
  main();
}

module.exports = {
  severityLabel,
  ghsaFromUrl,
  collectAdvisories,
  countBySeverity,
  loadExceptions,
  findException,
  describeFix,
  classify,
};
