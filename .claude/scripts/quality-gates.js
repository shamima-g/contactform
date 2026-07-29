#!/usr/bin/env node

/**
 * Quality Gates Runner
 *
 * Runs the three automated quality checks and outputs a JSON or text report.
 * Run inline by the orchestrator during BUILD (per-story light gate) and EPIC-END (full suite), and by the /quality-check command.
 *
 * Checks run in PARALLEL by default for speed. Use --sequential to run one at a time.
 * Within the Code Quality check, prettier/lint/build run concurrently; tsc runs after
 * the build (it can't run concurrently — see runCodeQualityCheck).
 *
 * Run with --help for usage information.
 *
 * Note: the Functional/Manual check is handled by the agent, not this script.
 * (These automated checks are the project's Quality Gates. The workflow's
 * INTAKE / stories / manual-test / merge pause points are separate "approvals".)
 */

const { exec, execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('./lib/project-root');

// Constants
const TIMEOUTS = {
  COMMAND: 300000, // 5 minutes
  FULL_RUN: 600000, // 10 minutes
};
const OUTPUT_TRUNCATE_LENGTH = 500;
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

// The Testing gate runs AFTER the other gates finish (see main), so Vitest gets the machine
// to itself — no `next build` competing — which is the reliable condition a standalone
// `npm test` runs under. So the gate's first run is just a normal `npm test`. A single-worker
// retry is kept as a backstop for any stray collection crash, run as a calm post-pass with the
// cache cleared (see retryVitestAfterCrash). The retry's `--no-file-parallelism` flag is passed
// on the command line, never in vitest.config, so a project's own test runs stay untouched.
const VITEST_RETRY_RUN = 'npm test -- --no-file-parallelism'; // single worker — extra-safe backstop
const VITEST_RETRY_SETTLE_MS = 2000; // brief settle before the retry
const VITEST_CACHE_DIR = 'node_modules/.vite'; // cleared before the retry in case a crash left it half-written

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

// Help text
const HELP_TEXT = `
Quality Gates Runner

Usage: node .claude/scripts/quality-gates.js [options]

Options:
  --auto-fix      Run auto-fixes before checks (format, lint:fix, audit fix)
  --json          Output results as JSON (for agent parsing)
  --checks <list> Run only the named checks (comma-separated). Default: all.
                  Names: security, prettier, tsc, lint, build, vitest, test-quality
                  e.g. --checks lint,test-quality  (the light per-story BUILD gate)
  --fail-fast     Stop on first check failure
  --sequential    Run checks sequentially instead of in parallel
  --help          Show this help message

Checks run (in parallel by default):
  Security - dependency audit (audit-gate.js), security-validator.js
  Code Quality - Prettier, TypeScript, ESLint, Build (also parallel internally)
  Testing - Vitest, test-quality-validator.js

Exit codes:
  0 - All gates pass
  1 - One or more gates fail
  2 - Script error
`;

// CLI options
const options = {
  autoFix: false,
  json: false,
  failFast: false,
  sequential: false,
  help: false,
  checks: null, // null => run all checks; otherwise a comma list (parsed into selectedChecks)
};

// Parse CLI arguments
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--auto-fix') options.autoFix = true;
  else if (arg === '--json') options.json = true;
  else if (arg === '--fail-fast') options.failFast = true;
  else if (arg === '--sequential') options.sequential = true;
  else if (arg === '--help' || arg === '-h') options.help = true;
  else if (arg === '--checks') options.checks = argv[++i];
  else if (arg.startsWith('--checks=')) options.checks = arg.slice('--checks='.length);
}

if (options.help) {
  console.log(HELP_TEXT);
  process.exit(0);
}

// --checks selector: run only a subset of the individual checks (default: all).
// Lets the per-story light gate run just lint + test-quality inline while
// epic-end and /quality-check run the full suite — one runner, one source of truth.
// Names normalise to canonical ids; an unselected check is reported with status 'skip'.
const CHECK_ALIASES = {
  security: 'security',
  prettier: 'prettier', format: 'prettier',
  tsc: 'tsc', typescript: 'tsc', typecheck: 'tsc',
  lint: 'lint', eslint: 'lint',
  build: 'build',
  vitest: 'vitest', test: 'vitest', tests: 'vitest',
  'test-quality': 'testQuality', testquality: 'testQuality', 'test:quality': 'testQuality',
};
let selectedChecks = null; // null => run everything (unchanged default behaviour)
if (options.checks) {
  selectedChecks = new Set();
  for (const raw of options.checks.split(',').map((s) => s.trim()).filter(Boolean)) {
    const canon = CHECK_ALIASES[raw.toLowerCase()];
    if (!canon) {
      console.error(
        `Unknown check "${raw}". Valid: security, prettier, tsc, lint, build, vitest, test-quality`
      );
      process.exit(2);
    }
    selectedChecks.add(canon);
  }
}
const want = (name) => selectedChecks === null || selectedChecks.has(name);

// Results structure
const results = {
  timestamp: new Date().toISOString(),
  autoFixesApplied: false,
  autoFixResults: {},
  gates: {
    security: { status: 'pending', checks: {} },
    codeQuality: { status: 'pending', checks: {} },
    testing: { status: 'pending', checks: {} },
  },
  overallStatus: 'pending',
  failedGates: [],
  summary: {},
};

// Set by the Testing gate when Vitest's first run shows the collection-crash fingerprint;
// read by main() to run the calm single-worker retry after every other gate has finished.
let vitestRetryPending = false;

// Find web directory and project root. The repo root comes from the shared,
// CWD-independent getProjectRoot() (single source of truth); only the web/ app
// location is resolved here.
function findDirectories() {
  const cwd = process.cwd();
  const projectRoot = getProjectRoot();
  let webDir = null;

  // Are we already inside the Next.js app dir (cwd has a package.json with a next dep)?
  if (fs.existsSync(path.join(cwd, 'package.json'))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
      if (pkg.name && pkg.dependencies?.next) webDir = cwd;
    } catch {
      // Invalid package.json, continue checking
    }
  }

  // Otherwise the app lives at <root>/web.
  if (!webDir) {
    const webSubdir = path.join(projectRoot, 'web');
    if (fs.existsSync(path.join(webSubdir, 'package.json'))) {
      webDir = webSubdir;
    }
  }

  return { webDir, projectRoot };
}

// Validate that the web directory has required npm scripts
function validateWebDir(webDir) {
  const pkgPath = path.join(webDir, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const requiredScripts = ['lint', 'build', 'test'];
    const missing = requiredScripts.filter((s) => !pkg.scripts?.[s]);
    if (missing.length > 0) {
      return { valid: false, error: `Missing required npm scripts: ${missing.join(', ')}` };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, error: `Cannot read package.json: ${err.message}` };
  }
}

// =============================================================================
// ASYNC COMMAND RUNNER
// =============================================================================

/**
 * Run a command asynchronously and capture result.
 * Supports AbortSignal for fail-fast cancellation.
 */
function runCommandAsync(cmd, cwd, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ success: false, output: 'Aborted (fail-fast)', exitCode: -1, aborted: true });
      return;
    }

    let onAbort;

    const child = exec(cmd, {
      cwd,
      encoding: 'utf-8',
      timeout: TIMEOUTS.COMMAND,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: { ...process.env, CI: 'true' },
    }, (error, stdout, stderr) => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      if (error) {
        const output = [stdout, stderr, error.message]
          .filter(Boolean)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .join('\n');
        // `stdout` is exposed separately so callers that need to parse a tool's
        // machine output (e.g. `npm audit --json`) can read it without the stderr /
        // "Command failed: …" text that `output` appends on a non-zero exit.
        resolve({ success: false, output, stdout: (stdout || '').trim(), exitCode: typeof error.code === 'number' ? error.code : 1 });
      } else {
        resolve({ success: true, output: (stdout || '').trim(), stdout: (stdout || '').trim(), exitCode: 0 });
      }
    });

    if (signal) {
      onAbort = () => child.kill('SIGTERM');
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// Synchronous runCommand for auto-fixes (must complete before gates)
function runCommand(cmd, cwd) {
  try {
    const output = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: TIMEOUTS.COMMAND,
      env: { ...process.env, CI: 'true' },
    });
    return { success: true, output: output.trim(), exitCode: 0 };
  } catch (error) {
    const output = [error.stdout, error.stderr, error.message]
      .filter(Boolean)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join('\n');
    return {
      success: false,
      output,
      exitCode: error.status || 1,
    };
  }
}

// =============================================================================
// LOG BUFFER — prevents interleaving during parallel execution
// =============================================================================

// Pure formatters — single source of the section/check line shapes, shared by
// the buffered LogBuffer and the direct (immediate-flush) loggers below.
function sectionLines(title) {
  return ['', `${colors.cyan}═══ ${title} ═══${colors.reset}`];
}

function checkLine(name, passed, details = '') {
  const icon = passed ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
  const detailStr = details ? ` ${colors.dim}(${details})${colors.reset}` : '';
  return `  ${icon} ${name}${detailStr}`;
}

class LogBuffer {
  constructor() {
    this.lines = [];
  }

  log(msg) {
    if (!options.json) this.lines.push(msg);
  }

  section(title) {
    if (!options.json) this.lines.push(...sectionLines(title));
  }

  check(name, passed, details = '') {
    if (!options.json) this.lines.push(checkLine(name, passed, details));
  }

  flush() {
    for (const line of this.lines) {
      console.log(line);
    }
    this.lines = [];
  }
}

// Direct log functions (for sequential sections like auto-fix and summary)
function log(msg) {
  if (!options.json) console.log(msg);
}

function logSection(title) {
  if (!options.json) for (const line of sectionLines(title)) console.log(line);
}

function logCheck(name, passed, details = '') {
  if (!options.json) console.log(checkLine(name, passed, details));
}

// Run a validator script asynchronously
async function runValidatorScriptAsync(scriptPath, cwd, signal) {
  if (!fs.existsSync(scriptPath)) {
    return { status: 'skip', reason: 'Script not found', passed: true };
  }
  const result = await runCommandAsync(`node "${scriptPath}"`, cwd, signal);
  if (result.aborted) return { status: 'skip', reason: 'Aborted', passed: false, aborted: true };
  return {
    status: result.success ? 'pass' : 'fail',
    output: result.output?.substring(0, OUTPUT_TRUNCATE_LENGTH),
    passed: result.success,
  };
}

// =============================================================================
// AUTO-FIX STEP (synchronous — must complete before gates)
// =============================================================================

function runAutoFixes(webDir) {
  logSection('Auto-Fix Step');

  results.autoFixesApplied = true;
  results.autoFixResults = {
    format: { ran: false, success: false },
    lintFix: { ran: false, success: false },
    auditFix: { ran: false, success: false },
    changedFiles: [],
  };

  // Snapshot already-modified tracked files so we can report only what the
  // auto-fixes newly touched (what the reviewer/orchestrator must commit).
  const beforeFix = new Set(gitModifiedFiles(webDir));

  // Only run the fixes whose corresponding check is selected (so a light
  // --checks run doesn't pay for fixes it won't verify). format runs for both
  // prettier and lint so lint-fix's formatting stays consistent.
  if (want('prettier') || want('lint')) {
    log('  Running npm run format...');
    const formatResult = runCommand('npm run format', webDir);
    results.autoFixResults.format = { ran: true, success: formatResult.success };
    logCheck('Prettier format', formatResult.success);
  }

  if (want('lint')) {
    log('  Running npm run lint:fix...');
    const lintFixResult = runCommand('npm run lint:fix', webDir);
    results.autoFixResults.lintFix = { ran: true, success: lintFixResult.success };
    logCheck('ESLint auto-fix', lintFixResult.success);
  }

  if (want('security')) {
    log('  Running npm audit fix...');
    const auditFixResult = runCommand('npm audit fix', webDir);
    results.autoFixResults.auditFix = { ran: true, success: auditFixResult.success };
    logCheck('npm audit fix', auditFixResult.success);
  }

  // Files the auto-fixes newly modified (excludes pre-existing working-tree edits).
  results.autoFixResults.changedFiles = gitModifiedFiles(webDir).filter((f) => !beforeFix.has(f));
}

// =============================================================================
// SECURITY CHECK (async)
// =============================================================================

async function runSecurityCheck(webDir, projectRoot, signal) {
  const buf = new LogBuffer();
  buf.section('Security');

  const gate = results.gates.security;

  if (!want('security')) {
    gate.status = 'skip';
    gate.reason = 'Not selected (--checks)';
    buf.log('  Skipped (not selected)');
    return buf;
  }

  gate.checks = {
    npmAudit: { status: 'pending', vulnerabilities: {} },
    securityValidator: { status: 'pending' },
  };

  // The dependency audit runs through the shared audit-gate.js so the local
  // gate behaves identically to CI: production-only scope, Critical/High fails,
  // Medium/Low advisory-only, and time-boxed exceptions from dependency-audit-exceptions.json.
  // --json makes it emit a single-line summary; its exit code is pass/fail.
  const auditGatePath = path.join(projectRoot, '.github/scripts/audit-gate.js');
  const auditGateExists = fs.existsSync(auditGatePath);
  const [auditResult, securityValidatorResult] = await Promise.all([
    auditGateExists
      ? runCommandAsync(`node "${auditGatePath}" --json`, webDir, signal)
      : Promise.resolve({ success: false, output: '' }),
    runValidatorScriptAsync(
      path.join(projectRoot, '.github/scripts/security-validator.js'),
      projectRoot,
      signal
    ),
  ]);

  // Parse the audit summary. When the JSON parses, its `passed` field is the
  // verdict; the process exit code is the fallback when it doesn't. The JSON also
  // gives the counts, the blocking advisories (so we can name them), exceptions
  // applied, and any problems with dependency-audit-exceptions.json (stale entries or a
  // malformed file) — surfaced as advisory warnings, they don't fail the gate.
  let auditPassed = auditResult.success;
  let vulnCount = { high: 0, critical: 0 };
  let exceptionsApplied = 0;
  let blocking = [];
  let staleExceptions = [];
  let auditError = null; // fatal: the audit could not run
  let exceptionsWarning = null; // advisory: dependency-audit-exceptions.json couldn't be read

  if (!auditGateExists) {
    auditPassed = false;
    auditError = `audit-gate.js not found at ${auditGatePath} — dependency audit could not run.`;
  } else if (auditResult.output) {
    const jsonLine = auditResult.output
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('{'));
    if (jsonLine) {
      try {
        const summary = JSON.parse(jsonLine);
        exceptionsApplied = summary.exceptionsApplied?.length || 0;
        blocking = Array.isArray(summary.blocking) ? summary.blocking : [];
        staleExceptions = Array.isArray(summary.staleExceptions) ? summary.staleExceptions : [];
        auditError = summary.error || null;
        exceptionsWarning = summary.exceptionsError || null;
        if (typeof summary.passed === 'boolean') auditPassed = summary.passed;
        // Count the blocking advisories we actually list (deduped by advisory id),
        // not npm's metadata totals — which count vulnerable packages and would
        // mismatch the lines below when one package carries several advisories.
        vulnCount = {
          high: blocking.filter((b) => b.severity === 'high').length,
          critical: blocking.filter((b) => b.severity === 'critical').length,
        };
      } catch {
        // Fall back to the exit code already captured in auditPassed.
      }
    }
  }

  gate.checks.npmAudit = {
    status: auditPassed ? 'pass' : 'fail',
    vulnerabilities: vulnCount,
    exceptionsApplied,
    ...(blocking.length && { blocking }),
    ...(staleExceptions.length && { staleExceptions }),
    ...(auditError && { error: auditError }),
    ...(exceptionsWarning && { exceptionsWarning }),
  };
  buf.check(
    'dependency audit',
    auditPassed,
    `critical: ${vulnCount.critical}, high: ${vulnCount.high}` +
      (exceptionsApplied ? `, exceptions: ${exceptionsApplied}` : ''),
  );

  // Name each blocking advisory under the failed check, so /quality-check tells
  // you which dependency to act on (matching what CI surfaces) rather than just
  // a count. Full detail: node .github/scripts/audit-gate.js
  for (const adv of blocking) {
    const sev = adv.severity === 'critical' ? 'Critical' : 'High';
    const pkgs = Array.isArray(adv.packages) ? adv.packages.join(', ') : adv.packages;
    buf.log(`      ${colors.red}•${colors.reset} ${sev} — ${pkgs} (${adv.id}): ${adv.title}`);
    if (adv.fix) buf.log(`        ${colors.dim}${adv.fix}${colors.reset}`);
  }
  if (auditError) {
    buf.log(`      ${colors.red}•${colors.reset} ${auditError}`);
  }

  // Problems with dependency-audit-exceptions.json don't fail the gate, but surface them so
  // a rotted or malformed exceptions file is visible locally, not just in CI.
  for (const e of staleExceptions) {
    buf.log(`      ${colors.yellow}⚠${colors.reset} exception ${e.key} — ${e.why}`);
  }
  if (exceptionsWarning) {
    buf.log(`      ${colors.yellow}⚠${colors.reset} dependency-audit-exceptions.json: ${exceptionsWarning}`);
  }

  gate.checks.securityValidator = {
    status: securityValidatorResult.status,
    ...(securityValidatorResult.reason && { reason: securityValidatorResult.reason }),
    ...(securityValidatorResult.output && { output: securityValidatorResult.output }),
  };
  buf.check('security-validator', securityValidatorResult.passed);

  gate.status = auditPassed && securityValidatorResult.passed ? 'pass' : 'fail';
  if (gate.status === 'fail') results.failedGates.push('security');

  return buf;
}

// =============================================================================
// CODE QUALITY CHECK (async — prettier/lint/build concurrent; tsc after build)
// =============================================================================

async function runCodeQualityCheck(webDir, signal) {
  const buf = new LogBuffer();
  buf.section('Code Quality');

  const gate = results.gates.codeQuality;
  gate.checks = {
    prettier: { status: 'pending' },
    typescript: { status: 'pending', errorCount: 0 },
    eslint: { status: 'pending', errorCount: 0, warningCount: 0 },
    build: { status: 'pending' },
  };

  // prettier, lint, and build run concurrently — none writes files the others read.
  // tsc is the exception and must NOT run concurrently with build: `next build`
  // regenerates next-env.d.ts and .next/types/** (both in tsconfig's `include`, and
  // tsconfig has `incremental: true`), so a concurrent `tsc --noEmit` reads
  // half-written files and reports spurious `error TS` failures. Run tsc AFTER the
  // build instead — race-free, and it type-checks against the freshly generated route
  // types. (When build is skipped, e.g. `--checks tsc`, tsc simply runs on its own.)
  const QSKIP = { skipped: true, success: true, output: '' };
  const [prettierResult, eslintResult, buildResult] = await Promise.all([
    want('prettier') ? runCommandAsync('npm run format:check', webDir, signal) : Promise.resolve(QSKIP),
    want('lint') ? runCommandAsync('npm run lint', webDir, signal) : Promise.resolve(QSKIP),
    want('build') ? runCommandAsync('npm run build', webDir, signal) : Promise.resolve(QSKIP),
  ]);
  const tscResult = want('tsc') ? await runCommandAsync('npx tsc --noEmit', webDir, signal) : QSKIP;

  const cqSub = []; // pass/fail of each sub-check that actually ran

  // Prettier
  if (prettierResult.skipped) {
    gate.checks.prettier = { status: 'skip' };
  } else {
    const prettierPassed = prettierResult.success;
    gate.checks.prettier = {
      status: prettierPassed ? 'pass' : 'fail',
      ...(prettierResult.output && !prettierPassed && {
        output: prettierResult.output.substring(0, OUTPUT_TRUNCATE_LENGTH),
      }),
    };
    buf.check('Prettier', prettierPassed);
    cqSub.push(prettierPassed);
  }

  // TypeScript
  if (tscResult.skipped) {
    gate.checks.typescript = { status: 'skip', errorCount: 0 };
  } else {
    const tscPassed = tscResult.success;
    let tsErrorCount = 0;
    if (!tscPassed && tscResult.output) {
      const errorMatches = tscResult.output.match(/error TS\d+/g);
      tsErrorCount = errorMatches ? errorMatches.length : 1;
    }
    gate.checks.typescript = {
      status: tscPassed ? 'pass' : 'fail',
      errorCount: tsErrorCount,
    };
    buf.check('TypeScript', tscPassed, `${tsErrorCount} errors`);
    cqSub.push(tscPassed);
  }

  // ESLint. Pass/fail is the process exit code; the counts are display-only.
  // ESLint's stylish formatter ends with a summary line:
  //   ✖ 3 problems (2 errors, 1 warning)
  // Match THAT parenthetical specifically. A naive /(\d+)\s+error/ matches the
  // first per-file message line instead (e.g. "12:10  error  ..."), capturing the
  // COLUMN number as the error count (observed: errorCount 10 for a single error
  // at column 10). When lint passes, ESLint prints nothing, so the counts stay 0.
  // On failure, the raw output is also attached so a reviewer can trust ESLint's
  // own report rather than the parsed counts.
  if (eslintResult.skipped) {
    gate.checks.eslint = { status: 'skip', errorCount: 0, warningCount: 0 };
  } else {
    const eslintPassed = eslintResult.success;
    let eslintErrorCount = 0;
    let eslintWarningCount = 0;
    // Strip ANSI once; reuse for both the count parse and the attached output.
    const eslintPlainOutput = (eslintResult.output || '').replace(ANSI_ESCAPE_PATTERN, '');
    const summaryMatch = eslintPlainOutput.match(/\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)/);
    if (summaryMatch) {
      eslintErrorCount = parseInt(summaryMatch[1], 10);
      eslintWarningCount = parseInt(summaryMatch[2], 10);
    }
    gate.checks.eslint = {
      status: eslintPassed ? 'pass' : 'fail',
      errorCount: eslintErrorCount,
      warningCount: eslintWarningCount,
      ...(!eslintPassed &&
        eslintPlainOutput && {
          output: eslintPlainOutput.substring(0, OUTPUT_TRUNCATE_LENGTH),
        }),
    };
    // When ESLint fails but no summary parenthetical was parsed (e.g. a config/crash error, or a
    // non-stylish formatter), the counts stay 0 — don't print a misleading "0 errors" beside a
    // failure; point at the attached raw output instead.
    const eslintSummary =
      !eslintPassed && eslintErrorCount === 0 && eslintWarningCount === 0
        ? 'failed (see attached output)'
        : `${eslintErrorCount} errors, ${eslintWarningCount} warnings`;
    buf.check('ESLint', eslintPassed, eslintSummary);
    cqSub.push(eslintPassed);
  }

  // Build
  if (buildResult.skipped) {
    gate.checks.build = { status: 'skip' };
  } else {
    const buildPassed = buildResult.success;
    gate.checks.build = {
      status: buildPassed ? 'pass' : 'fail',
    };
    buf.check('Build', buildPassed);
    cqSub.push(buildPassed);
  }

  gate.status = cqSub.length === 0 ? 'skip' : cqSub.every(Boolean) ? 'pass' : 'fail';
  if (gate.status === 'fail') results.failedGates.push('codeQuality');

  return buf;
}

// =============================================================================
// TESTING CHECK (async)
// =============================================================================

// Parse Vitest's summary lines into counts. The PROCESS EXIT CODE is authoritative for
// pass/fail — `vitest run` exits non-zero on a failed OR errored suite (e.g. a file with no
// test() blocks, or a collection/import error), and in that case the "Tests N passed"
// line can still show zero failed CASES. Trusting the parsed case-count alone would
// mask that non-zero exit (observed: a failed suite reported as `testing: pass`).
// So parsing only refines the displayed counts and can ADD a failure, never clear one.
function parseVitestStats(testResult) {
  const stats = { passed: 0, failed: 0, suitesFailed: 0, total: 0 };
  if (testResult.output) {
    const plainOutput = testResult.output.replace(ANSI_ESCAPE_PATTERN, '');
    // Anchored to line start (m flag) and kept on a single line ([^\n]) so only Vitest's own
    // summary lines match. The unanchored form matched "Tests"/"Test Files" anywhere, so foreign
    // stdout like `console.log('Test Files audited: 2 failed')` could phantom-match and — via the
    // testPassed gate in runTestingCheck — flip a genuinely-passing run (exit 0) to a false FAIL.
    const passedMatch = plainOutput.match(/^\s*Tests\s+[^\n]*?(\d+)\s+passed/m);
    const failedMatch = plainOutput.match(/^\s*Tests\s+[^\n]*?(\d+)\s+failed/m);
    // "Test Files  1 failed | 5 passed (6)" — the file-level (suite) failure signal
    // that the per-test "Tests" line misses for an errored/empty suite.
    const suitesFailedMatch = plainOutput.match(/^\s*Test Files\s+[^\n]*?(\d+)\s+failed/m);
    if (passedMatch) stats.passed = parseInt(passedMatch[1], 10);
    if (failedMatch) stats.failed = parseInt(failedMatch[1], 10);
    if (suitesFailedMatch) stats.suitesFailed = parseInt(suitesFailedMatch[1], 10);
    stats.total = stats.passed + stats.failed;
  }
  return stats;
}

async function runTestingCheck(webDir, projectRoot, signal) {
  const buf = new LogBuffer();
  buf.section('Testing');

  const gate = results.gates.testing;
  gate.checks = {
    vitest: { status: 'pending', passed: 0, failed: 0, total: 0 },
    testQuality: { status: 'pending' },
  };

  // test-quality is a static file scan — launch it now so it runs concurrently with the
  // Vitest run below (it's light and finishes well before the tests, so it never extends
  // the gate).
  const testQualityPromise = want('testQuality')
    ? runValidatorScriptAsync(
        path.join(projectRoot, '.github/scripts/test-quality-validator.js'),
        projectRoot,
        signal
      )
    : Promise.resolve({ status: 'skip', passed: true, skipped: true });

  // The Testing gate runs after the other gates, so this first run has the machine to itself —
  // a normal `npm test`. In the rare case it still returns the collection-crash fingerprint, we
  // DON'T retry inline; we capture diagnostics, flag it, and let main() run a single-worker retry
  // as a calm post-pass. A genuinely broken import fails that retry too.
  let testResult, testStats;
  let vitestDiagnostics = null;
  if (want('vitest')) {
    testResult = await runCommandAsync('npm test', webDir, signal);
    testStats = parseVitestStats(testResult);

    // A non-zero exit with suites that failed to COLLECT but zero failed test CASES is the
    // fingerprint of a worker crash during collection, not a real failure.
    const collectionCrash =
      !testResult.success &&
      !testResult.aborted &&
      testStats.failed === 0 &&
      testStats.suitesFailed > 0;
    if (collectionCrash) {
      // Capture what the crash looked like so a future recurrence reveals the mechanism rather
      // than us guessing: the actual error text, whether a Vite deps cache was present, and that
      // it ran with no build competing (which rules out build contention as the cause).
      vitestDiagnostics = {
        firstRunExitCode: testResult.exitCode,
        // The Testing gate runs after every other gate, so a crash here happened with NO
        // build competing — if it recurs, that rules out build contention as the cause.
        ranConcurrentlyWithBuild: false,
        viteDepsCacheExisted: fs.existsSync(path.join(webDir, VITEST_CACHE_DIR, 'deps')),
        outputTail: (testResult.output || '').replace(ANSI_ESCAPE_PATTERN, '').slice(-3000),
      };
      vitestRetryPending = true;
      buf.log(
        `  ${colors.yellow}⚠${colors.reset} Vitest: ${testStats.suitesFailed} suite(s) failed to collect, ` +
          `0 failed tests — will retry once as a single worker after the other gates finish ` +
          `(likely a worker crash under load, not a real failure).`
      );
    }
  } else {
    testResult = { skipped: true, success: true, output: '' };
    testStats = { passed: 0, failed: 0, suitesFailed: 0, total: 0 };
  }

  const testQualityResult = await testQualityPromise;

  const tSub = []; // pass/fail of each sub-check that actually ran

  if (testResult.skipped) {
    gate.checks.vitest = { status: 'skip', passed: 0, failed: 0, total: 0 };
  } else {
    const testPassed =
      testResult.success && testStats.failed === 0 && testStats.suitesFailed === 0;

    gate.checks.vitest = {
      status: testPassed ? 'pass' : 'fail',
      ...testStats,
      ...(vitestDiagnostics && { diagnostics: vitestDiagnostics }),
    };
    buf.check(
      'Vitest',
      testPassed,
      `${testStats.passed} passed, ${testStats.failed} failed` +
        (testStats.suitesFailed > 0 ? `, ${testStats.suitesFailed} suite(s) failed` : '')
    );
    tSub.push(testPassed);
  }

  if (testQualityResult.skipped) {
    gate.checks.testQuality = { status: 'skip' };
  } else {
    gate.checks.testQuality = {
      status: testQualityResult.status,
      ...(testQualityResult.reason && { reason: testQualityResult.reason }),
    };
    buf.check('test-quality-validator', testQualityResult.passed);
    tSub.push(testQualityResult.passed);
  }

  finalizeTestingGate(tSub);

  return buf;
}

// Derive the Testing gate's status from its sub-checks that actually ran and re-sync
// results.failedGates. Shared by runTestingCheck and the post-crash Vitest retry so the
// pass/fail rule lives in one place. The failedGates filter is a no-op on the first call
// (nothing added yet), so it's safe for both. `subs` = one boolean per sub-check that ran.
function finalizeTestingGate(subs) {
  const gate = results.gates.testing;
  gate.status = subs.length === 0 ? 'skip' : subs.every(Boolean) ? 'pass' : 'fail';
  results.failedGates = results.failedGates.filter((g) => g !== 'testing');
  if (gate.status === 'fail') results.failedGates.push('testing');
}

// The calm retry — run ONCE, alone, after every other gate has finished (so the build is
// done and the machine is idle). Clears the Vite cache first (a half-written cache from the
// first crash would otherwise re-poison the retry), settles briefly, then runs single-worker
// — the reliable shape a standalone `npm test` uses. Updates the Testing gate in place and
// re-syncs failedGates. Logs directly (buffers are already flushed by the time this runs).
async function retryVitestAfterCrash(webDir) {
  const gate = results.gates.testing;
  const priorDiagnostics = gate.checks.vitest.diagnostics;

  // Clear the cache dir in case the first crash left it half-written. Best-effort: a locked
  // or absent dir just means the retry runs against whatever is there.
  let clearedCache = false;
  try {
    fs.rmSync(path.join(webDir, VITEST_CACHE_DIR), { recursive: true, force: true });
    clearedCache = true;
  } catch {
    /* best-effort */
  }

  log(
    `  ${colors.yellow}⚠${colors.reset} Retrying Vitest as a single worker — other gates done, ` +
      `cache cleared, machine settled (the reliable standalone shape).`
  );
  await new Promise((resolve) => setTimeout(resolve, VITEST_RETRY_SETTLE_MS));

  const retryResult = await runCommandAsync(VITEST_RETRY_RUN, webDir, null);
  const retryStats = parseVitestStats(retryResult);
  const retryPassed =
    retryResult.success && retryStats.failed === 0 && retryStats.suitesFailed === 0;

  // Overwrite the first-run (crashed) counts with the retry's, and record what happened.
  gate.checks.vitest = {
    status: retryPassed ? 'pass' : 'fail',
    ...retryStats,
    retried: true,
    diagnostics: {
      ...priorDiagnostics,
      clearedCache,
      retryExitCode: retryResult.exitCode,
      ...(!retryPassed && {
        retryOutputTail: (retryResult.output || '').replace(ANSI_ESCAPE_PATTERN, '').slice(-3000),
      }),
    },
  };

  logCheck(
    'Vitest (retry)',
    retryPassed,
    `${retryStats.passed} passed, ${retryStats.failed} failed` +
      (retryStats.suitesFailed > 0 ? `, ${retryStats.suitesFailed} suite(s) failed` : '')
  );

  // Recompute the Testing gate from its (updated) sub-checks and re-sync failedGates.
  const subs = [];
  if (gate.checks.vitest?.status !== 'skip') subs.push(gate.checks.vitest.status === 'pass');
  if (gate.checks.testQuality?.status !== 'skip') subs.push(gate.checks.testQuality.status === 'pass');
  finalizeTestingGate(subs);
}

// =============================================================================
// MAIN
// =============================================================================

// --- Summary + git helpers (EPIC-END result-summary path) ---

// All changed files (repo-root-relative), so the before/after snapshot can
// attribute what `--auto-fix` touched and the caller reads a fact
// instead of reverse-engineering it from a fresh git diff. The union of three
// commands — `git diff --name-only` alone would miss staged edits and brand-new
// files an auto-fix might create. Each emits plain newline-separated paths
// (no status prefix), so `runCommand`'s output.trim() is harmless.
function gitModifiedFiles(webDir) {
  const commands = [
    'git diff --name-only', // unstaged tracked edits
    'git diff --cached --name-only', // staged edits
    // Untracked (new) files, respecting .gitignore. `--full-name` + the `:/`
    // top pathspec force repo-root-relative, repo-wide output — plain ls-files
    // is scoped to the cwd subtree and prints cwd-relative paths, which would
    // both miss files and clash with the repo-root-relative diff output above.
    'git ls-files --others --exclude-standard --full-name -- :/',
  ];
  const files = new Set();
  for (const cmd of commands) {
    const r = runCommand(cmd, webDir);
    if (!r.success) continue;
    for (const line of r.output.split('\n')) {
      const f = line.trim();
      if (f) files.add(f);
    }
  }
  return [...files];
}

// Append this run's outcome to generated-docs/quality-gate-runs.jsonl — an
// append-only, gitignored history that /build-report reads for gate pass/fail
// stats and rerun counts. Advisory only: a failed write warns, never fails the
// gates. (The re-exec'd child is the one that reaches here; the parent exits
// in the re-exec block, so each run logs exactly once.)
function appendGateRunLog(projectRoot) {
  try {
    let branch = null;
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe', timeout: 10000,
      }).trim() || null;
    } catch { /* not a git repo / detached — log without a branch */ }
    const record = {
      timestamp: results.timestamp,
      branch,
      checks: options.checks || 'all',
      gates: Object.fromEntries(Object.entries(results.gates).map(([k, g]) => [k, g.status])),
      overallStatus: results.overallStatus,
      failedGates: results.failedGates,
    };
    const outDir = path.join(projectRoot, 'generated-docs');
    fs.mkdirSync(outDir, { recursive: true });
    fs.appendFileSync(path.join(outDir, 'quality-gate-runs.jsonl'), JSON.stringify(record) + '\n');
  } catch (err) {
    process.stderr.write(`(could not append quality-gate-runs.jsonl: ${err.message})\n`);
  }
}

// Plain-text (no ANSI) summary for the --json path: stdout stays pure JSON,
// this goes to stderr so the orchestrator gets a readable gist without having
// to hand-roll a `node -e` parser (the source of the /tmp-vs-C:\tmp mistakes).
function buildHumanSummary(results) {
  const lines = ['═══ Quality Gates Summary ═══'];
  for (const [gateName, gate] of Object.entries(results.gates)) {
    const display = gateName.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase());
    const mark = gate.status === 'pass' ? 'PASS' : gate.status === 'skip' ? 'SKIP' : 'FAIL';
    lines.push(`  ${display}: ${mark}`);
  }
  lines.push(
    results.overallStatus === 'pass'
      ? 'OVERALL: PASS — all gates green'
      : `OVERALL: FAIL — ${results.failedGates.join(', ')}`
  );
  const changed = results.autoFixResults && results.autoFixResults.changedFiles;
  if (changed && changed.length) {
    lines.push(`Auto-fix changed ${changed.length} file(s): ${changed.join(', ')}`);
  }
  return lines.join('\n');
}

async function main() {
  const { webDir, projectRoot } = findDirectories();

  if (!webDir) {
    if (options.json) {
      console.log(JSON.stringify({ error: 'Could not find web directory with package.json' }));
    } else {
      console.error('Error: Could not find web directory with package.json');
      console.error('Run this script from the project root or web/ directory.');
    }
    process.exit(2);
  }

  // Validate npm scripts exist
  const validation = validateWebDir(webDir);
  if (!validation.valid) {
    if (options.json) {
      console.log(JSON.stringify({ error: validation.error }));
    } else {
      console.error(`Error: ${validation.error}`);
    }
    process.exit(2);
  }

  // WORKAROUND: Vitest has issues when Node.js is started from a different directory
  // than the web/ directory, even with cwd option. The vitest setup file fails to load.
  // Solution: If we're not in the web directory, re-execute this script from there.
  const currentDir = process.cwd();
  const isInWebDir = path.resolve(currentDir) === path.resolve(webDir);

  if (!isInWebDir && !process.env._QUALITY_GATES_REEXEC) {
    const scriptPath = path.resolve(__filename);

    // Re-exec this script with node directly, setting the child's cwd to web/ (equivalent to
    // `cd web && node …` but WITHOUT a shell). The previous shell form depended on
    // process.env.SHELL being a POSIX shell with single-quote arg escaping — if SHELL was
    // unset or pointed at cmd.exe/PowerShell, the quoting and `&&` misparsed and the gate
    // failed spuriously. Passing args as an array needs no quoting and no shell, so it works
    // on any platform.
    try {
      const output = execFileSync(process.execPath, [scriptPath, ...process.argv.slice(2)], {
        cwd: webDir,
        encoding: 'utf-8',
        // stdout piped (forwarded below); stderr inherited so the child's
        // --json summary line reaches the user across the re-exec.
        stdio: ['ignore', 'pipe', 'inherit'],
        timeout: TIMEOUTS.FULL_RUN,
        env: { ...process.env, _QUALITY_GATES_REEXEC: '1', CI: 'true' },
      });
      process.stdout.write(output);
      process.exit(0);
    } catch (error) {
      if (error.stdout) process.stdout.write(error.stdout);
      if (error.stderr) process.stderr.write(error.stderr);
      process.exit(error.status || 1);
    }
  }

  // --fail-fast implies sequential (can't short-circuit gates that already started)
  if (options.failFast) options.sequential = true;

  if (!options.json) {
    console.log(`${colors.blue}╔════════════════════════════════════════╗${colors.reset}`);
    console.log(`${colors.blue}║       Quality Gates Runner             ║${colors.reset}`);
    console.log(`${colors.blue}╚════════════════════════════════════════╝${colors.reset}`);
    console.log(`${colors.dim}Working directory: ${webDir}${colors.reset}`);
    if (!options.sequential) {
      console.log(`${colors.dim}Mode: parallel (use --sequential to run one at a time)${colors.reset}`);
    }
  }

  // Run auto-fixes if requested (synchronous — must complete before gates)
  if (options.autoFix) {
    runAutoFixes(webDir);
  }

  // Set up AbortController for fail-fast
  const abortController = new AbortController();
  const signal = options.failFast ? abortController.signal : null;

  if (options.sequential) {
    // Sequential mode: run gates one at a time (original behavior)
    const shouldStop = () => options.failFast && results.failedGates.length > 0;

    let buf;
    buf = await runSecurityCheck(webDir, projectRoot, signal);
    buf.flush();
    if (shouldStop()) abortController.abort();

    if (!shouldStop()) {
      buf = await runCodeQualityCheck(webDir, signal);
      buf.flush();
      if (shouldStop()) abortController.abort();
    }

    if (!shouldStop()) {
      buf = await runTestingCheck(webDir, projectRoot, signal);
      buf.flush();
    }
  } else {
    // Parallel mode (default): Security and Code Quality run concurrently, then the Testing
    // gate runs on its own AFTER they finish — so Vitest never competes with `next build`
    // (or tsc/lint) for the machine. That recreates the reliable standalone conditions; the
    // single-worker retry post-pass below stays as a backstop for any stray crash.
    const buffers = await Promise.all([
      runSecurityCheck(webDir, projectRoot, signal),
      runCodeQualityCheck(webDir, signal),
    ]);
    for (const buf of buffers) {
      buf.flush();
    }

    const testBuf = await runTestingCheck(webDir, projectRoot, signal);
    testBuf.flush();
  }

  // Calm retry post-pass: if Vitest's first run showed the collection-crash fingerprint,
  // retry it now — every other gate has finished, so the build is done and the machine is
  // idle. This recreates the reliable standalone conditions; a real failure fails again.
  if (vitestRetryPending) {
    await retryVitestAfterCrash(webDir);
  }

  // Mark skipped gates due to fail-fast
  if (options.failFast && results.failedGates.length > 0) {
    for (const gate of Object.values(results.gates)) {
      if (gate.status === 'pending') {
        gate.status = 'skip';
        gate.reason = 'Skipped due to --fail-fast';
      }
    }
  }

  // Calculate overall status
  const passedGates = Object.values(results.gates).filter(
    (g) => g.status === 'pass' || g.status === 'skip'
  ).length;
  const totalGates = Object.keys(results.gates).length;

  results.overallStatus = results.failedGates.length === 0 ? 'pass' : 'fail';
  results.summary = {
    passed: passedGates,
    failed: results.failedGates.length,
    total: totalGates,
  };

  appendGateRunLog(projectRoot);

  // Output results
  if (options.json) {
    // stdout = pure JSON (pipeable); a readable gist goes to stderr.
    process.stderr.write(buildHumanSummary(results) + '\n');
    console.log(JSON.stringify(results, null, 2));
  } else {
    logSection('Summary');
    console.log('');

    for (const [gateName, gate] of Object.entries(results.gates)) {
      // Display each check by a plain name: codeQuality → "Code Quality",
      // security → "Security".
      const displayName = gateName
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\b\w/g, (c) => c.toUpperCase());
      const icon =
        gate.status === 'pass'
          ? `${colors.green}✓ PASS${colors.reset}`
          : gate.status === 'skip'
            ? `${colors.yellow}○ SKIP${colors.reset}`
            : `${colors.red}✗ FAIL${colors.reset}`;
      console.log(`  ${displayName}: ${icon}`);
    }

    console.log('');
    if (results.overallStatus === 'pass') {
      console.log(`${colors.green}═══ ALL GATES PASSED ═══${colors.reset}`);
    } else {
      console.log(`${colors.red}═══ GATES FAILED: ${results.failedGates.join(', ')} ═══${colors.reset}`);
    }
    console.log('');
  }

  // Exit with appropriate code
  process.exit(results.overallStatus === 'pass' ? 0 : 1);
}

main();
