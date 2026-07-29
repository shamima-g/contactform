#!/usr/bin/env node

/**
 * Security Pattern Validator
 *
 * Validates code against security best practices for:
 * - Role-Based Access Control (RBAC)
 * - Input Validation
 * - XSS Protection
 * - SQL Injection Prevention
 * - Authentication Checks
 *
 * Adapted for stadium-8 structure (web/src/)
 */

const fs = require('fs');
const path = require('path');

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

/**
 * Severity levels for security checks
 * - 'error': Blocks PR, must be fixed before merge
 * - 'warning': Displayed but does not block PR
 * - 'off': Check is disabled
 */
const SEVERITY = {
  ERROR: 'error',
  WARNING: 'warning',
  OFF: 'off',
};

/**
 * Risk levels for security findings.
 *
 * This describes HOW SERIOUS a finding of a given kind is — it is completely
 * independent of whether the check blocks the merge (that is `severity`, above).
 * A check can be high-risk but non-blocking, or low-risk but blocking; the two
 * facts answer different questions and are reported in different columns.
 */
const RISK = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

/** Coloured badge for a risk level, used in the GitHub job summary. */
function riskBadge(risk) {
  switch (risk) {
    case RISK.CRITICAL:
      return '🔴 Critical';
    case RISK.HIGH:
      return '🟠 High';
    case RISK.MEDIUM:
      return '🟡 Medium';
    case RISK.LOW:
      return '🔵 Low';
    default:
      return risk;
  }
}

/**
 * Configuration for security checks.
 *
 * Each check carries two independent facts:
 * - `severity` (error|warning|off): the ENFORCEMENT policy — does a finding
 *   block the merge? `error` blocks, `warning` doesn't, `off` disables the
 *   check. Overridable via environment variables (e.g. SECURITY_RBAC_SEVERITY).
 * - `risk` (Critical|High|Medium|Low): how SERIOUS a finding of this kind is,
 *   regardless of whether it blocks the merge.
 */
const config = {
  rbac: {
    severity: process.env.SECURITY_RBAC_SEVERITY || SEVERITY.ERROR,
    risk: RISK.CRITICAL,
    name: 'Access control (RBAC)',
    description: 'Role-Based Access Control checks',
  },
  inputValidation: {
    severity: process.env.SECURITY_INPUT_VALIDATION_SEVERITY || SEVERITY.ERROR,
    risk: RISK.HIGH,
    name: 'Input validation',
    description: 'Input validation and sanitization checks',
  },
  xssProtection: {
    severity: process.env.SECURITY_XSS_SEVERITY || SEVERITY.ERROR,
    risk: RISK.HIGH,
    name: 'XSS protection',
    description: 'Cross-Site Scripting protection checks',
  },
  sqlInjection: {
    severity: process.env.SECURITY_SQL_INJECTION_SEVERITY || SEVERITY.ERROR,
    risk: RISK.CRITICAL,
    name: 'SQL injection prevention',
    description: 'SQL injection prevention checks',
  },
  authentication: {
    severity: process.env.SECURITY_AUTH_SEVERITY || SEVERITY.WARNING,
    risk: RISK.MEDIUM,
    name: 'Authentication checks',
    description: 'Authentication configuration checks',
  },
};

/**
 * Check if a severity level should block the build
 * @param {string} severity - The severity level
 * @returns {boolean}
 */
function isBlockingSeverity(severity) {
  return severity === SEVERITY.ERROR;
}

/**
 * Check if a check is enabled
 * @param {string} checkKey - The check key (e.g., 'rbac', 'xssProtection')
 * @returns {boolean}
 */
function isCheckEnabled(checkKey) {
  return config[checkKey]?.severity !== SEVERITY.OFF;
}

const results = {
  rbac: { pass: true, issues: [] },
  inputValidation: { pass: true, issues: [] },
  xssProtection: { pass: true, issues: [] },
  sqlInjection: { pass: true, issues: [] },
  authentication: { pass: true, issues: [] },
};

// Track security-ignore overrides used
const overrides = [];

/**
 * Command-line options
 * Parsed from process.argv
 */
const cliOptions = {
  help: false,
};

/**
 * Progress-message wrapper.
 * @param {...any} args - Arguments to pass to console.log
 */
function log(...args) {
  console.log(...args);
}

/**
 * Parse command-line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      cliOptions.help = true;
    }
  }
}

/**
 * Show help message
 */
function showHelp() {
  console.log(`
Security Pattern Validator

Validates code against security best practices for:
  - Role-Based Access Control (RBAC)
  - Input Validation
  - XSS Protection
  - SQL Injection Prevention
  - Authentication Checks

Usage:
  node security-validator.js [options]

Options:
  --help, -h             Show this help message

Environment Variables:
  SECURITY_RBAC_SEVERITY             Set RBAC check severity (error|warning|off)
  SECURITY_INPUT_VALIDATION_SEVERITY Set input validation severity
  SECURITY_XSS_SEVERITY              Set XSS check severity
  SECURITY_SQL_INJECTION_SEVERITY    Set SQL injection check severity
  SECURITY_AUTH_SEVERITY             Set authentication check severity
  SECURITY_AUTH_ROUTE_GROUPS         Extra gated route-group names to audit (comma-separated)

Examples:
  node security-validator.js                    # Run validation
`);
}

/**
 * Security ignore pattern: // security-ignore: <reason>
 * Can be placed on the same line as the issue or on the line above
 */
const SECURITY_IGNORE_PATTERN = /\/\/\s*security-ignore:\s*(.+)/i;

/**
 * Check if a specific line in a file has a security-ignore comment
 * @param {string} filePath - Path to the file
 * @param {number} lineNumber - Line number to check (1-based)
 * @param {string} [lineContent] - Optional line content if already available
 * @returns {{ ignored: boolean, reason: string | null }}
 */
function hasSecurityIgnore(filePath, lineNumber, lineContent = null) {
  try {
    if (!fs.existsSync(filePath)) {
      return { ignored: false, reason: null };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Check current line (same-line comment)
    const currentLine = lineContent || lines[lineNumber - 1] || '';
    const currentMatch = currentLine.match(SECURITY_IGNORE_PATTERN);
    if (currentMatch) {
      return { ignored: true, reason: currentMatch[1].trim() };
    }

    // Check previous line (comment on line above)
    if (lineNumber > 1) {
      const prevLine = lines[lineNumber - 2] || '';
      const prevMatch = prevLine.match(SECURITY_IGNORE_PATTERN);
      if (prevMatch) {
        return { ignored: true, reason: prevMatch[1].trim() };
      }
    }

    return { ignored: false, reason: null };
  } catch (error) {
    return { ignored: false, reason: null };
  }
}

/**
 * Check if a file has a file-level security-ignore comment (at top of file)
 * @param {string} filePath - Path to the file
 * @param {string} checkType - Type of check to ignore (e.g., 'rbac', 'xss', 'all')
 * @returns {{ ignored: boolean, reason: string | null }}
 */
function hasFileLevelSecurityIgnore(filePath, checkType) {
  try {
    if (!fs.existsSync(filePath)) {
      return { ignored: false, reason: null };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    // Check first 10 lines for file-level ignore
    const firstLines = content.split('\n').slice(0, 10).join('\n');

    // Pattern: // security-ignore-file: <type> <reason>
    // or: // security-ignore-file: all <reason>
    const fileLevelPattern = new RegExp(
      `\\/\\/\\s*security-ignore-file:\\s*(${checkType}|all)\\s+(.+)`,
      'i'
    );
    const match = firstLines.match(fileLevelPattern);

    if (match) {
      return { ignored: true, reason: match[2].trim() };
    }

    return { ignored: false, reason: null };
  } catch (error) {
    return { ignored: false, reason: null };
  }
}

/**
 * Record an override that was used
 * @param {string} file - File path
 * @param {string} checkType - Type of security check
 * @param {string} reason - Reason provided for the override
 */
function recordOverride(file, checkType, reason) {
  overrides.push({ file, checkType, reason });
}

/**
 * Resolve the repository root and the web/ directory, tolerating both ways the
 * validator is launched:
 *  - locally from the repo root (`node .github/scripts/security-validator.js`),
 *    where process.cwd() is the repo root, and
 *  - in CI, where the job sets `working-directory: web` and invokes
 *    `node ../.github/scripts/security-validator.js`, so process.cwd() is web/.
 *
 * Without this, the CI invocation computed WEB_SRC as `web/web/src` (nonexistent)
 * and every content-scanning check passed vacuously.
 *
 * @returns {{ repoRoot: string, webRoot: string }}
 */
function resolveWebRoot() {
  // INTENTIONALLY cwd-relative — do NOT replace with .claude/scripts/lib/project-root.js's
  // getProjectRoot(). That helper anchors to the SCRIPT's own location (__dirname) to find
  // the repo the workflow scripts live in; this validator instead resolves the project it is
  // being POINTED AT via the working directory (CI sets `working-directory: web`, and the
  // test suite runs the validator against temp fixtures by setting cwd). Anchoring to
  // __dirname would make it validate this repo instead of the target.
  const cwd = process.cwd();

  // Launched from the repo root: a web/src directory lives directly under cwd.
  if (fs.existsSync(path.join(cwd, 'web', 'src'))) {
    return { repoRoot: cwd, webRoot: path.join(cwd, 'web') };
  }

  // Launched from inside web/ (CI working-directory): cwd is the web dir itself.
  if (path.basename(cwd) === 'web' && fs.existsSync(path.join(cwd, 'src'))) {
    return { repoRoot: path.dirname(cwd), webRoot: cwd };
  }

  // Fallback: assume cwd is the repo root (matches the original behaviour).
  return { repoRoot: cwd, webRoot: path.join(cwd, 'web') };
}

const { repoRoot: REPO_ROOT, webRoot: WEB_ROOT } = resolveWebRoot();

// Base directory for web source (stadium-8 structure)
const WEB_SRC = path.join(WEB_ROOT, 'src');

// project.md — records the project's chosen auth method (repo-root relative)
const PROJECT_MD_PATH = path.join(REPO_ROOT, 'generated-docs', 'project.md');

// Path to roles definition file
const ROLES_FILE = path.join(WEB_SRC, 'types', 'roles.ts');

/**
 * The authentication approaches a project can choose during INTAKE.
 * Mirrors the `Method` row of project.md §Authentication.
 */
const AUTH_METHOD = {
  BFF: 'bff',
  FRONTEND_ONLY: 'frontend-only',
  CUSTOM: 'custom',
};

/**
 * Body of a level-2 markdown section (`## <title>`) up to the next level-2
 * header or end of document. Null when the section is absent.
 * @returns {string | null}
 */
function extractMarkdownSection(md, title) {
  const header = new RegExp(`^##\\s+${title}\\s*$`, 'mi');
  const start = md.search(header);
  if (start === -1) return null;
  const afterHeader = md.indexOf('\n', start);
  if (afterHeader === -1) return '';
  const rest = md.slice(afterHeader + 1);
  const next = rest.search(/^##\s+/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * Read the project's chosen authentication method from project.md §Authentication.
 * Absent / unreadable / unfilled-placeholder reads as null, and callers fall back
 * to file-evidence detection.
 * @returns {string | null} one of 'bff' | 'frontend-only' | 'custom', or null
 */
function getAuthMethod() {
  try {
    if (!fs.existsSync(PROJECT_MD_PATH)) {
      return null;
    }
    const md = fs.readFileSync(PROJECT_MD_PATH, 'utf-8');
    const section = extractMarkdownSection(md, 'Authentication');
    if (!section) return null;
    // Parse the table row-by-row rather than positionally: split each row into cells, find
    // the cell labelled "Method", and read the cell immediately after it. This tolerates a
    // leading border/status column and a column reorder, where the old
    // `/^\|\s*Method\s*\|([^|]*)\|/` assumed Method was the first data column. (A filled
    // single-token value like `bff` has no inner pipes; the unfilled `[bff | … ]` placeholder
    // splits into non-matching cells and correctly yields null.)
    for (const line of section.split('\n')) {
      if (!line.includes('|')) continue;
      const cells = line.split('|').map((c) => c.replace(/[`*]/g, '').trim());
      const methodIdx = cells.findIndex((c) => c.toLowerCase() === 'method');
      if (methodIdx === -1 || methodIdx + 1 >= cells.length) continue;
      const value = cells[methodIdx + 1].toLowerCase();
      const match = Object.values(AUTH_METHOD).find((m) => m === value);
      if (match) return match;
    }
    return null;
  } catch (error) {
    // Malformed project.md — treat as "unknown" rather than crashing the gate.
    return null;
  }
}

/**
 * SQL drivers / query-builders / ORMs whose presence means the project actually
 * talks to a SQL database. This template is a frontend that reaches a REST backend
 * through lib/api/client.ts, so by default there is NO SQL here and the raw-SQL
 * checks would only ever fire on look-alike frontend code (a variable named
 * `query`, a `.get(a + b)` call, an English template string containing
 * "from"/"where"). The SQL-injection checks therefore run only when one of these
 * is declared as a dependency.
 */
const SQL_DB_PACKAGES = [
  'prisma', '@prisma/client', 'drizzle-orm', 'kysely',
  'pg', 'pg-promise', 'pg-native', 'postgres', 'slonik',
  '@vercel/postgres', '@neondatabase/serverless', '@databases/pg',
  'mysql', 'mysql2', 'mariadb', '@planetscale/database', '@databases/mysql',
  'better-sqlite3', 'sqlite3', 'sql.js', '@libsql/client', 'libsql', '@databases/sqlite',
  'mssql', 'tedious', 'oracledb',
  'knex', 'typeorm', 'sequelize',
];

/**
 * Whether web/package.json declares any SQL database driver/ORM (in dependencies
 * or devDependencies). When false, the SQL-injection checks are skipped: there is
 * no SQL surface to protect and the patterns would only false-positive on
 * ordinary frontend code.
 * @returns {boolean}
 */
function projectHasDatabaseDriver() {
  try {
    const pkgPath = path.join(WEB_ROOT, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    return SQL_DB_PACKAGES.some((name) =>
      Object.prototype.hasOwnProperty.call(deps, name),
    );
  } catch (error) {
    return false;
  }
}

/**
 * Extract valid role names from the UserRole enum in roles.ts
 * @returns {{ enumValues: string[], stringValues: string[] }} Object with enum keys and string values
 */
function getValidRoles() {
  try {
    if (!fs.existsSync(ROLES_FILE)) {
      log(`  ${colors.yellow}Warning: roles.ts not found at ${ROLES_FILE}${colors.reset}`);
      return { enumValues: [], stringValues: [] };
    }

    const content = fs.readFileSync(ROLES_FILE, 'utf-8');

    // Extract enum values using regex
    // Matches patterns like: ADMIN = 'admin', POWER_USER = 'power_user'
    const enumPattern = /^\s*(\w+)\s*=\s*['"]([^'"]+)['"]/gm;
    const enumValues = []; // e.g., ['ADMIN', 'POWER_USER']
    const stringValues = []; // e.g., ['admin', 'power_user']

    let match;
    while ((match = enumPattern.exec(content)) !== null) {
      enumValues.push(match[1]);
      stringValues.push(match[2]);
    }

    return { enumValues, stringValues };
  } catch (error) {
    log(`  ${colors.yellow}Warning: Could not parse roles.ts: ${error.message}${colors.reset}`);
    return { enumValues: [], stringValues: [] };
  }
}

/**
 * Recursively get all files in a directory
 * @param {string} dir - Directory to search
 * @param {string[]} [extensions] - Optional file extensions to filter (e.g., ['.ts', '.tsx'])
 * @returns {string[]} Array of file paths
 */
function getAllFiles(dir, extensions = ['.ts', '.tsx', '.js', '.jsx']) {
  const files = [];

  if (!fs.existsSync(dir)) {
    return files;
  }

  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);

    if (item.isDirectory()) {
      // Skip node_modules and hidden directories
      if (item.name !== 'node_modules' && !item.name.startsWith('.')) {
        files.push(...getAllFiles(fullPath, extensions));
      }
    } else if (item.isFile()) {
      const ext = path.extname(item.name).toLowerCase();
      if (extensions.length === 0 || extensions.includes(ext)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

/**
 * Cross-platform grep implementation using Node.js
 * Searches for a pattern in files and returns matches in grep-like format
 *
 * @param {string} pattern - Regex pattern to search for
 * @param {string} searchPath - Path to search (relative to WEB_SRC or absolute if starts with 'web/')
 * @param {string} options - Options string: '-l' for files only, '-i' for case insensitive
 * @returns {string[]} Array of matches in format "filepath:linenum:content" or just "filepath" with -l
 */
function grep(pattern, searchPath, options = '') {
  try {
    const fullPath = searchPath.startsWith('web/')
      ? path.join(REPO_ROOT, searchPath)
      : path.join(WEB_SRC, searchPath);

    if (!fs.existsSync(fullPath)) {
      return [];
    }

    // Parse options
    const filesOnly = options.includes('-l');
    const caseInsensitive = options.includes('-i');

    // Create regex from pattern
    let regex;
    try {
      regex = new RegExp(pattern, caseInsensitive ? 'i' : '');
    } catch (e) {
      // If pattern is not valid regex, escape it and try again
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(escaped, caseInsensitive ? 'i' : '');
    }

    const results = [];
    const matchedFiles = new Set();

    // Get all files to search
    const files = fs.statSync(fullPath).isDirectory()
      ? getAllFiles(fullPath)
      : [fullPath];

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            if (filesOnly) {
              if (!matchedFiles.has(file)) {
                matchedFiles.add(file);
                results.push(file);
              }
            } else {
              // Format: filepath:linenum:content (linenum is 1-based)
              results.push(`${file}:${i + 1}:${lines[i]}`);
            }
          }
        }
      } catch (readError) {
        // Skip files that can't be read (binary files, etc.)
        continue;
      }
    }

    return results;
  } catch (error) {
    return [];
  }
}

/**
 * Check if a file exists (cross-platform)
 * @param {string} filePath - Path to check
 * @returns {boolean}
 */
function fileExists(filePath) {
  try {
    // Handle both absolute paths (Unix / or Windows C:\) and relative paths
    const isAbsolute = path.isAbsolute(filePath);
    const fullPath = isAbsolute ? filePath : path.join(WEB_SRC, filePath);
    return fs.existsSync(fullPath);
  } catch {
    return false;
  }
}

/**
 * Route-group folder names that denote a server-gated area. Different auth
 * approaches use different conventions: next-auth projects gate via
 * `app/(protected)/`, BFF projects via `app/(authenticated)/`. Both (and any
 * future gated group) are recognised so the gate validates the layout the
 * project actually uses, rather than only the next-auth one.
 */
const GATED_ROUTE_GROUPS = ['(protected)', '(authenticated)'];

/**
 * Gated route-group names to audit: the conventional `(protected)` / `(authenticated)`
 * plus any extra names from SECURITY_AUTH_ROUTE_GROUPS (comma-separated; bare names are
 * wrapped in parens). Lets a project that gates via a custom group name opt that group
 * into the audit. When the env var is unset this is exactly GATED_ROUTE_GROUPS.
 * @returns {string[]}
 */
function getGatedRouteGroupNames() {
  const configured = (process.env.SECURITY_AUTH_ROUTE_GROUPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => (name.startsWith('(') ? name : `(${name})`));
  return [...new Set([...GATED_ROUTE_GROUPS, ...configured])];
}

/**
 * Absolute paths of the gated route-group directories that exist on disk.
 * @returns {string[]}
 */
function getGatedRouteGroupPaths() {
  return getGatedRouteGroupNames()
    .map((name) => path.join(WEB_SRC, 'app', name))
    .filter((p) => fs.existsSync(p));
}

/**
 * Whether a file path lives inside any gated route group.
 * @param {string} filePath
 * @returns {boolean}
 */
function isPathInGatedRouteGroup(filePath) {
  return getGatedRouteGroupNames().some((name) => filePath.includes(name));
}

/**
 * Public auth-entry route segments. A page whose route segment is one of these is
 * public by design — a sign-in / sign-up / sign-out surface a user reaches WITHOUT
 * a session — so it is exempt from the "uses session data but isn't protected"
 * check. A login page legitimately reads the just-fetched user (e.g. to choose the
 * post-login landing route) without itself being a protected page.
 */
const PUBLIC_AUTH_ROUTE_SEGMENTS = [
  'login', 'signin', 'sign-in',
  'logout', 'signout', 'sign-out',
  'register', 'signup', 'sign-up',
  'forgot-password', 'reset-password',
  'verify-email', 'verify',
  'auth',
];

/**
 * Route segments of an app-router page, from app/ down to (but excluding) the page
 * file, with route-group folders like (authenticated) stripped.
 * @param {string} pagePath
 * @returns {string[]}
 */
function routeSegments(pagePath) {
  const norm = pagePath.replace(/\\/g, '/');
  const marker = '/app/';
  const idx = norm.lastIndexOf(marker);
  if (idx === -1) return [];
  return norm
    .slice(idx + marker.length)
    .split('/')
    .slice(0, -1) // drop the page.tsx/ts file itself
    .filter((seg) => !(seg.startsWith('(') && seg.endsWith(')'))); // drop route groups
}

/**
 * Whether a page sits on a public auth-entry route (login / sign-up / logout / …).
 * @param {string} pagePath
 * @returns {boolean}
 */
function isPublicAuthRoute(pagePath) {
  return routeSegments(pagePath).some((seg) =>
    PUBLIC_AUTH_ROUTE_SEGMENTS.includes(seg.toLowerCase()),
  );
}

/**
 * Resolve a module specifier imported from `fromFile` to a first-party source file
 * on disk, or null. Handles the `@/` alias (→ web/src) and relative paths, trying
 * the usual TS/JS extensions and an index file. Bare/third-party specifiers
 * (e.g. 'next/navigation') resolve to null — we only follow the project's own code.
 * @param {string} spec
 * @param {string} fromFile - absolute path of the importing file
 * @returns {string | null}
 */
function resolveImportPath(spec, fromFile) {
  let baseNoExt;
  if (spec.startsWith('@/')) {
    baseNoExt = path.join(WEB_SRC, spec.slice(2));
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    baseNoExt = path.resolve(path.dirname(fromFile), spec);
  } else {
    return null;
  }

  const candidates = [
    `${baseNoExt}.tsx`, `${baseNoExt}.ts`, `${baseNoExt}.jsx`, `${baseNoExt}.js`,
    path.join(baseNoExt, 'index.tsx'), path.join(baseNoExt, 'index.ts'),
    path.join(baseNoExt, 'index.jsx'), path.join(baseNoExt, 'index.js'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * The import specifier a named/default identifier is imported from, or null.
 * Both `[^;]*` runs are lazy so the match anchors on the FIRST occurrence of
 * `name` after an `import` and the FIRST `from '…'` after it. Without the lazy
 * quantifiers, a file whose imports lack trailing semicolons (Prettier
 * `semi:false`) lets the greedy run spill into a later import and capture the
 * wrong module's specifier. `name` is a capitalised component identifier
 * (`[A-Z][A-Za-z0-9_]*`), so it contains no regex metacharacters.
 * @param {string} content - file source
 * @param {string} name - imported identifier (e.g. a component name)
 * @returns {string | null}
 */
function findImportSpecifier(content, name) {
  const re = new RegExp(`import[^;]*?\\b${name}\\b[^;]*?from\\s+['"]([^'"]+)['"]`);
  const m = content.match(re);
  return m ? m[1] : null;
}

/**
 * Capitalised JSX component names rendered in a file (e.g. <SessionGate …>).
 * @param {string} content
 * @returns {string[]}
 */
function getRenderedComponentNames(content) {
  const names = new Set();
  const re = /<([A-Z][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    names.add(m[1]);
  }
  return [...names];
}

// The server-side auth/role guard CALLS that count as protecting a route or layout: the
// next-auth `auth(` wrapper plus the require*/getServerSession/withRoleProtection helper
// family. Defined once and shared by fileIsSessionGate and checkRBAC so the vocabulary can't
// drift (previously `withRoleProtection` was recognised by checkRBAC but not fileIsSessionGate).
// Case-sensitive on purpose, so `auth(` matches but `requireAuth(`'s capital A doesn't double-match.
const SERVER_AUTH_GUARD_CALL =
  /\b(?:auth|getServerSession|withRoleProtection|requireAuth|requireSession|requireRole|requireMinimumRole|requireAnyRole|requireExactRole)\s*\(/;

/**
 * Whether a file's own code enforces a session gate: it both VERIFIES a session
 * and DENIES access (redirect / throw) when there isn't one. Recognises:
 *  - server-side gate helpers (requireSession / requireAuth / getServerSession /
 *    require*Role / auth()), whose call inherently redirects-or-throws — the
 *    documented canonical BFF and next-auth shapes; and
 *  - a client-or-proxy gate that verifies via the userinfo proxy (getUserInfo /
 *    a useSession hook / a fetch of …/auth/userinfo) AND redirects unauthenticated
 *    users to the sign-in route. This is the layout-level <SessionGate> shape: a
 *    real gate, enforced client-side rather than in a server component.
 *
 * The verification AND redirect requirement is what keeps the check honest — a
 * component that does neither (or only one) is not mistaken for a gate, so a
 * genuinely unprotected route group is still reported. Comments are stripped
 * first, so a commented-out or illustrative helper call ("// await
 * requireSession()") in an otherwise-ungated layout does not read as a gate.
 * @param {string} content
 * @returns {boolean}
 */
function fileIsSessionGate(content) {
  // Match against comment-stripped source so a commented-out / illustrative
  // helper call isn't read as a real gate. String literals stay intact, so a
  // redirect target like '/login' or a '…/auth/userinfo' path is still seen.
  const code = stripComments(content);

  // Server-side gate helpers: the call itself is the gate (redirects/throws).
  // `auth(` matches any call form — next-auth v5 is used both as `auth()` (session
  // getter in a layout) and `auth(req)` / `auth(handler)` (route/middleware wrapper);
  // requiring empty parens would miss the latter and falsely fail a real gate.
  if (SERVER_AUTH_GUARD_CALL.test(code)) {
    return true;
  }

  // Client / proxy gate: verify the session (a userinfo probe — see probesUserinfo —
  // or a FETCHED `USERINFO` constant, not merely a bare token), then redirect to
  // sign-in on failure. Requiring BOTH keeps the check honest: a component with only a
  // probe, or only a sign-out `router.push('/login')`, is not mistaken for a gate.
  const verifiesSession =
    /\b(?:getUserInfo|useSession)\s*\(/.test(code) ||
    probesUserinfo(code) ||
    /\bfetch\s*\([^)]*\bUSERINFO\b/.test(code);
  // Accept a sign-in path at any depth (/login, /auth/signin, /account/sign-in),
  // so a gate that redirects to a nested auth route is still recognised. Covers
  // router.replace/push, redirect(), and a raw window.location redirect (href
  // assignment or .assign()/.replace()) — all valid client redirect forms.
  const signInTail = "['\"`]\\/(?:[\\w-]+\\/)*(?:login|signin|sign-in)\\b";
  const redirectsToSignIn =
    new RegExp('\\b(?:redirect|router\\.(?:replace|push))\\s*\\(\\s*' + signInTail).test(code) ||
    new RegExp('\\bwindow\\.location(?:\\.href)?\\s*=\\s*' + signInTail).test(code) ||
    new RegExp('\\bwindow\\.location\\.(?:assign|replace)\\s*\\(\\s*' + signInTail).test(code);
  return verifiesSession && redirectsToSignIn;
}

/**
 * Whether `code` (comment-stripped source) probes the BFF session endpoint: a
 * *userinfo() client call under a fetch-y verb (authUserInfo / getUserInfo /
 * fetchUserinfo / …), a bare userinfo(), or a literal '…/auth/userinfo' path.
 * Anchored to a fetch-y prefix so a display/format helper (logUserinfo /
 * displayUserInfo) is NOT read as a probe. Shared by fileIsSessionGate and
 * middlewareIsSessionGate so the probe vocabulary lives in one place.
 * @param {string} code
 * @returns {boolean}
 */
function probesUserinfo(code) {
  return (
    /\b(?:auth|get|fetch|load|read|require|verify|check|ensure)\w*userinfo\s*\(/i.test(code) ||
    /\buserinfo\s*\(/i.test(code) ||
    /['"`][^'"`]*\/auth\/userinfo/.test(code)
  );
}

/**
 * The route-group layout file for a directory — `layout.tsx` preferred over
 * `layout.ts` — or null if neither exists.
 * @param {string} dir - absolute path to a route-group directory
 * @returns {string | null}
 */
function layoutFileFor(dir) {
  const tsx = path.join(dir, 'layout.tsx');
  const ts = path.join(dir, 'layout.ts');
  return fs.existsSync(tsx) ? tsx : fs.existsSync(ts) ? ts : null;
}

/**
 * Maximum import-following depth when deciding whether a layout delegates its
 * session gate to a rendered component (e.g. layout → <SessionGate>). Keeps the
 * resolution shallow and terminating.
 */
const SESSION_GATE_MAX_DEPTH = 2;

/**
 * Whether a route-group layout enforces a session gate — either inline in its own
 * code, or by rendering a first-party component that is itself a session gate (the
 * <SessionGate> pattern). Follows locally-imported rendered components up to
 * SESSION_GATE_MAX_DEPTH levels; `seen` guards against import cycles.
 * @param {string} layoutFilePath - absolute path to a layout file
 * @param {number} [depth]
 * @param {Set<string>} [seen]
 * @returns {boolean}
 */
// Memo of the full-depth gate result per layout file. The source tree is static
// during a run, so each layout is read + parsed once: the per-page chain walks in
// checkProtectedPageSessionValidation otherwise re-read the same shared ancestors
// (root app/layout.tsx, the group layout) for every page.
const _layoutGateCache = new Map();

function layoutHasSessionGate(layoutFilePath, depth = SESSION_GATE_MAX_DEPTH, seen = new Set()) {
  // Only memoise the public, full-depth entry. Recursive import-following calls run
  // at a lower depth (and share `seen`), so their depth-limited results must NOT be
  // cached — that would poison a later full-depth lookup of the same file.
  if (depth !== SESSION_GATE_MAX_DEPTH || seen.size > 0) {
    return layoutHasSessionGateUncached(layoutFilePath, depth, seen);
  }
  if (layoutFilePath && _layoutGateCache.has(layoutFilePath)) {
    return _layoutGateCache.get(layoutFilePath);
  }
  const result = layoutHasSessionGateUncached(layoutFilePath, depth, seen);
  if (layoutFilePath) _layoutGateCache.set(layoutFilePath, result);
  return result;
}

function layoutHasSessionGateUncached(layoutFilePath, depth, seen) {
  if (!layoutFilePath || !fs.existsSync(layoutFilePath) || seen.has(layoutFilePath)) {
    return false;
  }
  seen.add(layoutFilePath);

  const content = fs.readFileSync(layoutFilePath, 'utf-8');
  if (fileIsSessionGate(content)) {
    return true;
  }
  if (depth <= 0) {
    return false;
  }

  // Follow first-party components this layout renders (e.g. <SessionGate>) and
  // recognise the layout as gated when one of them is itself a session gate.
  for (const name of getRenderedComponentNames(content)) {
    const spec = findImportSpecifier(content, name);
    if (!spec) continue;
    const resolved = resolveImportPath(spec, layoutFilePath);
    if (resolved && layoutHasSessionGate(resolved, depth - 1, seen)) {
      return true;
    }
  }
  return false;
}

/** The app-router root directory (web/src/app), or null if absent. */
function appRootDir() {
  const d = path.join(WEB_SRC, 'app');
  return fs.existsSync(d) ? d : null;
}

/**
 * Whether any layout from `dir` up to (and including) the app/ root layout enforces
 * a session gate. A gate in an ancestor — including the root app/layout.tsx, e.g. a
 * client <AuthProvider> that probes /userinfo and redirects on 401 — protects every
 * route beneath it, whatever the route group is named. This is what lets gated-area
 * detection stop depending on the (protected)/(authenticated) name convention.
 * @param {string} dir absolute directory to start from (a route-group or page dir)
 * @returns {boolean}
 */
function layoutChainHasSessionGate(dir) {
  const root = appRootDir();
  if (!root) return false;
  const rootResolved = path.resolve(root);
  let current = path.resolve(dir);
  while (current.startsWith(rootResolved)) {
    const layout = layoutFileFor(current);
    if (layout && layoutHasSessionGate(layout)) return true;
    if (current === rootResolved) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

/** All route-group directories (app/(x)/) that exist on disk. */
function getAllRouteGroupPaths() {
  const root = appRootDir();
  if (!root) return [];
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('(') && e.name.endsWith(')'))
      .map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

/**
 * Route groups that are actually gated — by a session gate anywhere in their layout
 * chain (group layout → … → root app layout). Name-independent: recognises the
 * (protected)/(authenticated) convention AND any other group (e.g. (app)) whose chain
 * enforces a gate, including one that lives in the root layout.
 * @returns {string[]}
 */
let _structurallyGatedGroupPaths = null;
function getStructurallyGatedGroupPaths() {
  // Memoised: each call is groups × chain-depth × layout-file reads (with import
  // follows), and three call sites used to recompute it independently. The source
  // tree doesn't change during a single validator run, so cache the result.
  if (_structurallyGatedGroupPaths === null) {
    _structurallyGatedGroupPaths = getAllRouteGroupPaths().filter((p) =>
      layoutChainHasSessionGate(p),
    );
  }
  return _structurallyGatedGroupPaths;
}

/**
 * Next.js middleware file location: web/src/middleware.ts|js (App Router with a
 * src/ dir) or web/middleware.ts|js. Returns the first that exists, or null.
 * @returns {string | null}
 */
function middlewareFile() {
  const candidates = [
    path.join(WEB_SRC, 'middleware.ts'),
    path.join(WEB_SRC, 'middleware.js'),
    path.join(WEB_ROOT, 'middleware.ts'),
    path.join(WEB_ROOT, 'middleware.js'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * Whether a Next.js middleware actually ENFORCES a session — it both verifies the
 * session AND acts on the result (redirects or blocks). This is deliberately NOT
 * fileIsSessionGate: in a server-component layout, merely CALLING requireSession()
 * /getServerSession() gates (the call itself redirects/throws), but in middleware
 * calling it does nothing unless the code branches on it — a middleware that reads
 * the session and always `return NextResponse.next()` protects nothing. We require
 * an explicit enforcement action so a no-op middleware can't be mistaken for a gate.
 * @param {string} content - middleware file source
 * @returns {boolean}
 */
function middlewareIsSessionGate(content) {
  const code = stripComments(content);
  const verifiesSession =
    /\b(?:requireSession|requireAuth|getServerSession|getSession|getToken|auth|getUserInfo|useSession)\s*\(/.test(code) ||
    probesUserinfo(code);
  if (!verifiesSession) return false;
  // Acts on the result: a redirect (NextResponse.redirect/rewrite or redirect()) or
  // an explicit block (a 401/403 response).
  const enforces =
    /\bNextResponse\s*\.\s*(?:redirect|rewrite)\s*\(/.test(code) ||
    /\bredirect\s*\(/.test(code) ||
    /\bnew\s+Response\s*\([^)]*\b(?:401|403)\b/.test(code) ||
    /\b(?:status|statusCode)\s*[:=]\s*(?:401|403)\b/.test(code);
  return enforces;
}

/**
 * Whether a session-enforcing middleware gates the project's /api routes. Next.js
 * middleware runs at the edge before the route handler, so a middleware that
 * verifies a session and redirects/blocks unauthenticated requests protects the
 * routes its matcher covers — the handler needn't repeat the guard.
 *
 * We treat /api as covered only when we're confident EVERY api route is gated: the
 * middleware is a real session gate (middlewareIsSessionGate) AND either it declares
 * no `config.matcher` (Next.js runs it on every request) or a matcher that is an
 * /api CATCH-ALL. A matcher that excludes /api via a negative lookahead, or that
 * only names a specific /api subpath, is NOT treated as blanket coverage — so a
 * genuinely unguarded route is still reported rather than silently passed.
 * @returns {boolean}
 */
function middlewareCoversApiRoutes() {
  const file = middlewareFile();
  if (!file) return false;
  let content;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    // Unreadable middleware — degrade like the project.md/package readers do rather
    // than crashing the whole gate out of checkRBAC().
    return false;
  }
  if (!middlewareIsSessionGate(content)) return false;

  const code = stripComments(content);
  const matcherMatch = code.match(/matcher\s*:\s*(\[[^\]]*\]|['"`][^'"`]*['"`])/);
  // No matcher → Next runs the middleware on every request → all /api is covered.
  if (!matcherMatch) return true;
  const matcher = matcherMatch[1];
  // A negative-lookahead exclusion naming api (the standard '/((?!api|_next).*)'
  // shape, with or without a leading slash) means /api is NOT covered — even if a
  // specific /api subpath is positively re-added elsewhere in the matcher.
  if (/\(\?![^)]*\/?api\b/i.test(matcher)) return false;
  // Otherwise treat /api as covered only by an /api CATCH-ALL (/api, /api/:path*,
  // /api/(.*)). A specific subpath like /api/admin covers only that subtree, so it
  // does not prove every api route is gated. (A truncated/odd capture falls through
  // to "not covered" — the safe, route-still-reported direction.)
  return /['"`]\/api(?:\/(?::\w+\*?|\(\.\*\)|\*+)|\/?)['"`]/.test(matcher);
}

/**
 * Leaf route segments of auth endpoints that, by design, operate WITHOUT a prior
 * session — so requiring an authorization guard on them is backwards. A logout that
 * required a valid session couldn't sign out an expired one; the userinfo probe IS
 * the session check; login/register run pre-session. Mirrors the existing
 * [...nextauth] exemption for the BFF / custom auth shapes.
 */
// Derived from the canonical auth-segment list (PUBLIC_AUTH_ROUTE_SEGMENTS) so the
// page-level and API-level auth exemptions can't drift, plus the API-only actions
// that have no public page. 'auth' is omitted — anything under app/api/auth/ is
// already covered by the path leg in isAuthApiRoute.
// Segments that unambiguously denote a pre-session auth ACTION and therefore exempt a
// DIRECT child of app/api/ (e.g. app/api/login/route.ts) from the auth-guard requirement.
// Generic words that double as ordinary business nouns — session, callback, refresh,
// userinfo, and the bare `verify` — are deliberately EXCLUDED: they only count as auth when
// nested under app/api/auth/ (the path leg of isAuthApiRoute), so a top-level
// app/api/session/route.ts or app/api/verify/route.ts is still required to guard.
const AUTH_API_SEGMENTS = [
  ...new Set(
    PUBLIC_AUTH_ROUTE_SEGMENTS.filter((s) => s !== 'auth' && s !== 'verify'),
  ),
];

/**
 * The leaf route segment (the folder directly containing route.ts) of an API route
 * file, lowercased, or null. Path is normalised for Windows.
 * @param {string} filePath
 * @returns {string | null}
 */
function apiRouteLeafSegment(filePath) {
  const m = filePath.replace(/\\/g, '/').match(/\/([\w-]+)\/route\.(?:ts|tsx|js|jsx)$/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Whether an API route file is an auth endpoint exempt from the authorization check:
 * any route under `app/api/auth/`, OR a DIRECT child of `app/api/` whose own segment
 * is a known auth action (so `app/api/login/route.ts` is covered). The leaf-name
 * match is scoped to `/api/<seg>` so an unrelated nested route that merely reuses an
 * auth-ish word — e.g. `app/api/billing/session/route.ts` — is NOT exempted.
 * @param {string} filePath
 * @returns {boolean}
 */
function isAuthApiRoute(filePath) {
  const norm = filePath.replace(/\\/g, '/');
  if (/\/api\/auth\//.test(norm)) return true;
  const direct = norm.match(/\/api\/([\w-]+)\/route\.(?:ts|tsx|js|jsx)$/i);
  return direct ? AUTH_API_SEGMENTS.includes(direct[1].toLowerCase()) : false;
}

// Auth endpoints that DON'T carry a request body, so requiring a request-body schema on
// them is a false positive. Listed explicitly as an allow-list rather than "anything that
// isn't login/register": a bare app/api/auth/route.ts or an unrecognised auth-family segment
// may well accept credentials, so it must keep its input-validation guard.
const BODY_LESS_AUTH_SEGMENTS = ['logout', 'signout', 'sign-out', 'refresh', 'userinfo', 'session', 'callback'];

/**
 * Whether an API route is a KNOWN body-less auth endpoint exempt from the request-body
 * input-validation check. Only the explicit body-less actions above qualify; an auth route
 * whose leaf is anything else — login, register, the bare `auth` handler, or an unrecognised
 * action — is treated as potentially credential-bearing and stays validated. Uses the leaf
 * segment (last folder before route.ts), so `auth/logout` is classified by its own action.
 * @param {string} filePath
 * @returns {boolean}
 */
function isBodylessAuthApiRoute(filePath) {
  if (!isAuthApiRoute(filePath)) return false;
  const leaf = apiRouteLeafSegment(filePath);
  return leaf ? BODY_LESS_AUTH_SEGMENTS.includes(leaf) : false;
}

/**
 * 1. RBAC: Check for API routes without authentication
 */
function checkRBAC() {
  if (!isCheckEnabled('rbac')) {
    log(`\n${colors.yellow}Skipping RBAC check (disabled)${colors.reset}`);
    return;
  }

  log(`\n${colors.blue}Checking RBAC implementation...${colors.reset}`);

  // A session-enforcing middleware that covers /api gates the route handlers at
  // the edge, so they needn't repeat the guard. When present, don't flag routes
  // for a missing inline auth call. (See middlewareCoversApiRoutes for the
  // conservative coverage rule — ambiguous matchers are NOT assumed to cover.)
  const apiGatedByMiddleware = middlewareCoversApiRoutes();
  if (apiGatedByMiddleware) {
    log(`  ${colors.green}API routes gated by session-enforcing middleware${colors.reset}`);
  }

  // Find all API route files. This scan does not depend on roles.ts: it flags any API route
  // that lacks an auth guard. A project with no app/api routes yields an empty list and passes
  // silently — so there's no need to gate on roles.ts existence (doing so previously disabled
  // the check entirely for any project without that file, letting unguarded routes ship).
  const apiRoutes = grep('export.*GET|POST|PUT|DELETE|PATCH', 'app/api', '-l');

  // Check each API route for authentication
  apiRoutes.forEach((file) => {
    // grep('-l') yields a bare file path. Don't split on ':' — a Windows path
    // (C:\…) would be truncated at the drive-letter colon, silently skipping every
    // route. The path is used as-is (parseGrepMatch is only for non '-l' output).
    const filePath = file;
    if (!fs.existsSync(filePath)) return;

    // Check for file-level security ignore
    const fileIgnore = hasFileLevelSecurityIgnore(filePath, 'rbac');
    if (fileIgnore.ignored) {
      recordOverride(filePath, 'rbac', fileIgnore.reason);
      return;
    }

    const content = fs.readFileSync(filePath, 'utf-8');

    // Detect a real auth/role guard CALL in comment- and string-stripped source, so a
    // keyword inside a comment (`// add auth()`) or a string literal (`"auth("`) can't
    // satisfy the gate. Uses the shared SERVER_AUTH_GUARD_CALL vocabulary (same set
    // fileIsSessionGate accepts), which includes the full require*Role family so a route
    // guarded by one of those is not falsely flagged.
    const code = stripCommentsAndStrings(content);
    const hasAuth = SERVER_AUTH_GUARD_CALL.test(code);

    if (!hasAuth && !apiGatedByMiddleware && !filePath.includes('[...nextauth]') && !isAuthApiRoute(filePath)) {
      // Check for inline security-ignore comment (check first export line)
      const lines = content.split('\n');
      const exportLineIndex = lines.findIndex((line) =>
        /export.*(GET|POST|PUT|DELETE|PATCH)/.test(line)
      );

      // Line number for reporting (1-based)
      const lineNum = exportLineIndex !== -1 ? exportLineIndex + 1 : 1;

      if (exportLineIndex !== -1) {
        const ignoreCheck = hasSecurityIgnore(filePath, lineNum);
        if (ignoreCheck.ignored) {
          recordOverride(filePath, 'rbac', ignoreCheck.reason);
          return;
        }
      }

      results.rbac.pass = false;
      results.rbac.issues.push({
        file: `${filePath}:${lineNum}`,
        message: 'API route missing authorization check',
        remediation:
          `Guard the route with the project's auth helper before returning data — e.g. requireSession() / requireRole() from the auth module the brief specifies, or auth() if NextAuth is in use.

`,
      });
    }
  });
}

/**
 * 1a. RBAC: Check for protected pages without proper authorization
 */
function checkProtectedPages() {
  if (!isCheckEnabled('rbac')) {
    return;
  }

  log(`\n${colors.blue}Checking protected pages for authorization...${colors.reset}`);

  // Validate whichever gated route group(s) the project actually uses —
  // (protected) for next-auth, (authenticated) for BFF, etc.
  const groupPaths = getGatedRouteGroupPaths();

  if (groupPaths.length === 0) {
    // A conventionally-named group is absent, but the app may still gate via a
    // differently-named group or a root-layout AuthProvider — say so rather than
    // implying nothing is protected.
    if (getStructurallyGatedGroupPaths().length > 0) {
      log(`  ${colors.green}Gated route group found via its layout chain (non-standard group name)${colors.reset}`);
    } else {
      log(`  ${colors.yellow}No protected/authenticated route group found - skipping protected pages check${colors.reset}`);
    }
  }

  groupPaths.forEach((protectedPagesPath) => {
    checkGatedRouteGroup(protectedPagesPath);
  });

  // Also check for pages outside gated route groups that might need auth.
  // Look for pages that use session data or call protected APIs (runs once,
  // independent of how many gated groups exist).
  const allAppPages = getAllFiles(path.join(WEB_SRC, 'app'), ['.tsx', '.ts']).filter(
    (f) =>
      (f.endsWith('page.tsx') || f.endsWith('page.ts')) &&
      !isPathInGatedRouteGroup(f) &&
      // (No `!f.includes('auth')` here: it also excluded innocent paths like app/author/ or
      // app/oauth-settings/. isPublicAuthRoute does the principled, segment-exact check.)
      !isPublicAuthRoute(f) // login / sign-up / logout pages are public by design
  );

  allAppPages.forEach((pagePath) => {
    // Skip if under auth routes
    if (pagePath.includes(path.join('app', 'auth'))) return;

    // Check for file-level security ignore
    const fileIgnore = hasFileLevelSecurityIgnore(pagePath, 'rbac');
    if (fileIgnore.ignored) {
      recordOverride(pagePath, 'rbac-unprotected-page', fileIgnore.reason);
      return;
    }

    const content = fs.readFileSync(pagePath, 'utf-8');

    // Check if page uses session data that suggests it should be protected
    const usesProtectedData =
      (content.includes('session.user') || content.includes('session?.user')) &&
      !content.includes('requireAuth') &&
      !content.includes('requireSession') &&
      !content.includes('getSession');

    if (usesProtectedData) {
      // Find line number
      const lines = content.split('\n');
      let lineNum = 1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('session.user') || lines[i].includes('session?.user')) {
          lineNum = i + 1;
          break;
        }
      }

      // Check for line-level security ignore
      const lineIgnore = hasSecurityIgnore(pagePath, lineNum, lines[lineNum - 1] || '');
      if (lineIgnore.ignored) {
        recordOverride(`${pagePath}:${lineNum}`, 'rbac-unprotected-page', lineIgnore.reason);
        return;
      }

      results.rbac.pass = false;
      results.rbac.issues.push({
        file: `${pagePath}:${lineNum}`,
        message: 'Page uses session data but is not in a protected route group',
        remediation: `Move the page under a gated route group, or gate it inline with the project's session helper. Example:

  import { requireSession } from '@/lib/auth/requireSession'; // BFF
  // import { requireAuth } from '@/lib/auth/auth-helpers';   // next-auth

  export default async function ProfilePage() {
    const session = await requireSession();
    return <div>Welcome {session.displayName}</div>;
  }

Or move the page under web/src/app/(authenticated)/ (BFF) or web/src/app/(protected)/ (next-auth) — the route-group layout handles authentication automatically.

`,
      });
    }
  });
}

/**
 * Validate a single gated route group: its root layout must enforce a recognised
 * session gate. (Per-page role checks used to live here as a keyword guess — "page
 * mentions admin + dashboard/settings ⇒ must call requireRole" — but that flagged
 * already-gated pages on substrings it couldn't verify. Whether a page is
 * role-restricted is a brief/test decision, so the heuristic was removed.)
 *
 * @param {string} protectedPagesPath - absolute path to the route-group dir
 */
function checkGatedRouteGroup(protectedPagesPath) {
  // Check if a session gate is enforced anywhere in this group's layout chain —
  // its own layout OR an ancestor, including the root app/layout.tsx (e.g. a
  // client <AuthProvider> that probes the session and redirects on 401). A group
  // named (protected)/(authenticated) is still REQUIRED to be gated; it's just no
  // longer required to gate in its own layout specifically.
  const rootLayoutFile = layoutFileFor(protectedPagesPath);

  const rootLayoutHasAuth = layoutChainHasSessionGate(protectedPagesPath);

  if (!rootLayoutHasAuth) {
    // Find line number of the export default function for better reporting
    let lineNum = 1;
    const layoutFile = rootLayoutFile || path.join(protectedPagesPath, 'layout.tsx');

    if (fs.existsSync(layoutFile)) {
      const layoutContent = fs.readFileSync(layoutFile, 'utf-8');
      const lines = layoutContent.split('\n');
      const exportLineIndex = lines.findIndex((line) =>
        /export\s+(default\s+)?(async\s+)?function/.test(line)
      );
      if (exportLineIndex !== -1) {
        lineNum = exportLineIndex + 1;
      }
    }

    results.rbac.pass = false;
    results.rbac.issues.push({
      file: `${layoutFile}:${lineNum}`,
      message: 'Protected route group layout missing authentication check',
      remediation: `Gate the route group in its layout with the project's session helper. Examples:

  // BFF (server-side session check):
  import { requireSession } from '@/lib/auth/requireSession';

  export default async function AuthenticatedLayout({ children }) {
    await requireSession(); // redirects to /login when no valid session
    return <>{children}</>;
  }

  // next-auth:
  import { requireAuth } from '@/lib/auth/auth-helpers';

  export default async function ProtectedLayout({ children }) {
    await requireAuth(); // throws if not authenticated
    return <>{children}</>;
  }

`,
    });
  }
}

/**
 * 1b. RBAC: Check that protected pages have proper session validation
 * Verifies that pages under a gated route group actually validate sessions,
 * not just import auth functions
 */
function checkProtectedPageSessionValidation() {
  if (!isCheckEnabled('rbac')) {
    return;
  }

  log(`\n${colors.blue}Checking protected pages for session validation...${colors.reset}`);

  // Validate pages under any gated area: the conventional (protected)/(authenticated)
  // groups AND any group gated structurally via its layout chain (e.g. (app) gated by
  // a root-layout AuthProvider). Name-independent.
  const groupPaths = [
    ...new Set([...getGatedRouteGroupPaths(), ...getStructurallyGatedGroupPaths()]),
  ];
  if (groupPaths.length === 0) {
    return; // Already handled by checkProtectedPages
  }

  // Session validation patterns that actually validate/use the session
  const sessionValidationPatterns = [
    // Direct session retrieval and use
    /await\s+auth\s*\(\s*\)/,
    /await\s+getServerSession\s*\(/,
    /await\s+requireAuth\s*\(\s*\)/,
    /await\s+requireRole\s*\(/,
    /await\s+requireMinimumRole\s*\(/,
    /await\s+requireAnyRole\s*\(/,
    /await\s+requireExactRole\s*\(/,
    /await\s+requireSession\s*\(/,
    // Session variable usage (indicates session was retrieved)
    /const\s+session\s*=\s*await/,
    /const\s+\{\s*user\s*\}\s*=\s*await/,
    // UseSession hook in client components (with proper check)
    /useSession\s*\(\s*\).*(?:status|data|session)/,
  ];

  // Validate pages under each gated route group the project uses.
  groupPaths.forEach((protectedPagesPath) => {
  // Get all page.tsx/ts files under this route group
  const protectedPages = getAllFiles(protectedPagesPath, ['.tsx', '.ts']).filter(
    (f) => f.endsWith('page.tsx') || f.endsWith('page.ts')
  );

  protectedPages.forEach((pagePath) => {
    // Check for file-level security ignore
    const fileIgnore = hasFileLevelSecurityIgnore(pagePath, 'rbac');
    if (fileIgnore.ignored) {
      recordOverride(pagePath, 'session-validation', fileIgnore.reason);
      return;
    }

    const content = fs.readFileSync(pagePath, 'utf-8');
    const lines = content.split('\n');

    // Check if this is a client component
    const isClientComponent = content.includes('"use client"') || content.includes("'use client'");

    // A page is protected when a session gate is enforced anywhere in its layout
    // chain — its own route-group layout, a nested layout, or an ancestor up to and
    // including the root app/layout.tsx (inline requireSession()/requireAuth(), a
    // delegated <SessionGate>, or a root <AuthProvider> that probes + redirects).
    const pageDir = path.dirname(pagePath);
    const parentLayoutHasSessionValidation = layoutChainHasSessionGate(pageDir);

    // If parent layout validates session, the page is protected
    if (parentLayoutHasSessionValidation) {
      return;
    }

    // Check if the page itself has session validation
    const pageHasSessionValidation = sessionValidationPatterns.some(pattern => pattern.test(content));

    // For client components, check for useSession with proper status check
    let clientComponentHasProperSessionCheck = false;
    if (isClientComponent) {
      // Check for useSession usage
      if (content.includes('useSession')) {
        // Look for proper session status checking
        const hasStatusCheck = content.includes('status') &&
          (content.includes('loading') || content.includes('authenticated') || content.includes('unauthenticated'));
        const hasSessionDataCheck = /session\??\./i.test(content) || /data\??\./i.test(content);

        if (hasStatusCheck || hasSessionDataCheck) {
          clientComponentHasProperSessionCheck = true;
        }
      }
    }

    // Determine if page is properly protected
    const isProperlyProtected = pageHasSessionValidation || clientComponentHasProperSessionCheck;

    if (!isProperlyProtected) {
      // Find the best line number for reporting
      let lineNum = 1;

      // Try to find the component function definition
      for (let i = 0; i < lines.length; i++) {
        if (/export\s+(default\s+)?(async\s+)?function/.test(lines[i]) ||
            /^(async\s+)?function\s+\w+Page/.test(lines[i].trim()) ||
            /export\s+default\s+\w+Page/.test(lines[i])) {
          lineNum = i + 1;
          break;
        }
      }

      // Check for line-level security ignore
      const lineIgnore = hasSecurityIgnore(pagePath, lineNum, lines[lineNum - 1] || '');
      if (lineIgnore.ignored) {
        recordOverride(`${pagePath}:${lineNum}`, 'session-validation', lineIgnore.reason);
        return;
      }

      // Determine appropriate remediation based on component type
      let remediation;
      if (isClientComponent) {
        remediation = `Add session validation using useSession() hook with proper status checks. Example:

  'use client';
  import { useSession } from 'next-auth/react';
  import { redirect } from 'next/navigation';

  export default function ProtectedClientComponent() {
    const { data: session, status } = useSession();

    if (status === 'loading') return <div>Loading...</div>;
    if (!session) redirect('/auth/signin');

    return <div>Welcome {session.user.name}</div>;
  }

Or move auth logic to a parent Server Component layout.

`;
      } else {
        remediation = `Add session validation using await requireAuth() at the start of the component. Example:

  import { requireAuth } from '@/lib/auth/auth-helpers';

  export default async function ProtectedPage() {
    const session = await requireAuth();
    // session is guaranteed to exist here
    return <div>Welcome {session.user.name}</div>;
  }

`;
      }

      results.rbac.pass = false;
      results.rbac.issues.push({
        file: `${pagePath}:${lineNum}`,
        message: `Protected page missing session validation${isClientComponent ? ' (client component)' : ''}`,
        remediation,
      });
    }
  });
  });
}

/**
 * 1c. RBAC: Check that role references use valid roles from UserRole enum
 */
function checkRoleReferences() {
  if (!isCheckEnabled('rbac')) {
    return;
  }

  if (!fs.existsSync(ROLES_FILE)) {
    return;
  }

  log(`\n${colors.blue}Checking role references against UserRole enum...${colors.reset}`);

  const { enumValues, stringValues } = getValidRoles();

  if (enumValues.length === 0) {
    log(`  ${colors.yellow}Skipping role reference check - no roles found in roles.ts${colors.reset}`);
    return;
  }

  log(`  Found valid roles: ${enumValues.join(', ')}`);

  // Search for role references in the codebase
  // Pattern 1: UserRole.SOMETHING (TypeScript enum access)
  const enumReferences = grep('UserRole\\.\\w+', 'app', '');
  const enumReferencesLib = grep('UserRole\\.\\w+', 'lib', '');
  const enumReferencesComponents = grep('UserRole\\.\\w+', 'components', '');

  // Pattern 2: hasRole(..., 'something') or requireRole('something'). NOTE: a bare
  // `role: 'x'` / `role === 'x'` literal scan used to live here, but `role` is
  // overloaded outside RBAC (a Radix/Shadcn `role="…"` prop, a data model's job
  // title, a design-system variant), so it flagged non-auth values. TypeScript
  // already catches an invalid UserRole; only the RBAC call sites below are scanned.
  const roleArgPatterns = grep("(hasRole|requireRole|hasAnyRole|hasMinimumRole|requireMinimumRole|requireAnyRole)\\([^)]*['\"]\\w+['\"]", 'app', '');
  const roleArgPatternsLib = grep("(hasRole|requireRole|hasAnyRole|hasMinimumRole|requireMinimumRole|requireAnyRole)\\([^)]*['\"]\\w+['\"]", 'lib', '');

  // Check UserRole.SOMETHING references
  const allEnumRefs = [...enumReferences, ...enumReferencesLib, ...enumReferencesComponents];
  allEnumRefs.forEach((match) => {
    const { file, lineNum, line } = parseGrepMatch(match);

    // Skip the roles.ts file itself
    if (file.includes('roles.ts')) return;

    // Skip test files
    if (file.includes('.test.') || file.includes('__tests__')) return;

    // Check for file-level security ignore
    const fileIgnore = hasFileLevelSecurityIgnore(file, 'rbac');
    if (fileIgnore.ignored) {
      recordOverride(file, 'rbac-role-reference', fileIgnore.reason);
      return;
    }

    // Check for line-level security ignore
    const lineIgnore = hasSecurityIgnore(file, parseInt(lineNum, 10), line);
    if (lineIgnore.ignored) {
      recordOverride(`${file}:${lineNum}`, 'rbac-role-reference', lineIgnore.reason);
      return;
    }

    // Extract the role name from UserRole.SOMETHING
    const roleMatch = line.match(/UserRole\.(\w+)/g);
    if (roleMatch) {
      roleMatch.forEach((ref) => {
        const roleName = ref.replace('UserRole.', '');
        if (!enumValues.includes(roleName)) {
          results.rbac.pass = false;
          results.rbac.issues.push({
            file: `${file}:${lineNum}`,
            message: `Invalid role reference: UserRole.${roleName}`,
            remediation: `Use a valid role from UserRole enum: ${enumValues.join(', ')}`,
          });
        }
      });
    }
  });

  // Check role function arguments with string literals
  const allArgRefs = [...roleArgPatterns, ...roleArgPatternsLib];
  allArgRefs.forEach((match) => {
    const { file, lineNum, line } = parseGrepMatch(match);

    // Skip the roles.ts file itself
    if (file.includes('roles.ts')) return;

    // Skip test files
    if (file.includes('.test.') || file.includes('__tests__')) return;

    // Check for file-level security ignore
    const fileIgnore = hasFileLevelSecurityIgnore(file, 'rbac');
    if (fileIgnore.ignored) {
      recordOverride(file, 'rbac-role-reference', fileIgnore.reason);
      return;
    }

    // Check for line-level security ignore
    const lineIgnore = hasSecurityIgnore(file, parseInt(lineNum, 10), line);
    if (lineIgnore.ignored) {
      recordOverride(`${file}:${lineNum}`, 'rbac-role-reference', lineIgnore.reason);
      return;
    }

    // Extract string literals from function calls
    // Match patterns like hasRole(user, 'admin') or requireRole('admin')
    const funcMatch = line.match(/(hasRole|requireRole|hasAnyRole|hasMinimumRole|requireMinimumRole|requireAnyRole)\([^)]*['"](\w+)['"]/);
    if (funcMatch) {
      const roleValue = funcMatch[2];
      // String literals should match the string values (e.g., 'admin', not 'ADMIN')
      if (!stringValues.includes(roleValue) && !enumValues.includes(roleValue)) {
        results.rbac.pass = false;
        results.rbac.issues.push({
          file: `${file}:${lineNum}`,
          message: `Invalid role in function call: '${roleValue}'`,
          remediation: `Use UserRole enum instead: UserRole.${enumValues[0]} (or valid role: ${enumValues.join(', ')})`,
        });
      }
    }
  });
}

/**
 * 2. Input Validation: Check for missing Zod schemas in API routes
 */
function checkInputValidation() {
  if (!isCheckEnabled('inputValidation')) {
    log(`\n${colors.yellow}Skipping Input Validation check (disabled)${colors.reset}`);
    return;
  }

  log(`\n${colors.blue}Checking input validation...${colors.reset}`);

  // Find API routes that handle POST/PUT/PATCH (data submission)
  const apiRoutes = grep('export.*(POST|PUT|PATCH)', 'app/api', '-l');

  apiRoutes.forEach((file) => {
    // grep('-l') yields a bare file path. Don't split on ':' — a Windows path
    // (C:\…) would be truncated at the drive-letter colon, silently skipping every
    // route. The path is used as-is (parseGrepMatch is only for non '-l' output).
    const filePath = file;
    if (!fs.existsSync(filePath)) return;

    // Check for file-level security ignore
    const fileIgnore = hasFileLevelSecurityIgnore(filePath, 'input-validation');
    if (fileIgnore.ignored) {
      recordOverride(filePath, 'input-validation', fileIgnore.reason);
      return;
    }

    const content = fs.readFileSync(filePath, 'utf-8');

    // Detect a real validation signal in comment- and string-stripped source, so the words
    // "schema"/"validate" appearing only in a comment can't pass the check. Require an actual
    // zod builder, a *.parse()/.safeParse() call, or a validate*() call.
    const code = stripCommentsAndStrings(content);
    const hasValidation =
      /\bz\s*\.\s*[a-zA-Z]/.test(code) ||              // zod builders: z.object(...), z.string()
      /\bzod\s*\./.test(code) ||                       // namespaced zod usage
      /\.\s*(?:safeParse|parse)\s*\(/.test(code) ||    // <schema>.parse(body) / .safeParse(body)
      /\bvalidate\w*\s*\(/.test(code);                 // validateRequest(...) / validate(...)

    // Skip NextAuth routes and body-less auth endpoints (logout/userinfo/… have no
    // request body to validate; login/register still do — see isBodylessAuthApiRoute).
    if (!hasValidation && !filePath.includes('[...nextauth]') && !isBodylessAuthApiRoute(filePath)) {
      // Check for inline security-ignore comment (check first export line)
      const lines = content.split('\n');
      const exportLineIndex = lines.findIndex((line) =>
        /export.*(POST|PUT|PATCH)/.test(line)
      );

      if (exportLineIndex !== -1) {
        const ignoreCheck = hasSecurityIgnore(filePath, exportLineIndex + 1);
        if (ignoreCheck.ignored) {
          recordOverride(filePath, 'input-validation', ignoreCheck.reason);
          return;
        }
      }

      results.inputValidation.pass = false;
      results.inputValidation.issues.push({
        file: filePath,
        message: 'API route missing input validation',
        remediation: `Add Zod schema validation for request body. Example:

  import { z } from 'zod';
  import { validateRequest } from '@/lib/validation/schemas';

  const requestSchema = z.object({
    name: z.string().min(1).max(100),
    email: z.string().email(),
  });

  export async function POST(request: NextRequest) {
    const body = await request.json();
    const validation = validateRequest(requestSchema, body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.errors },
        { status: 400 }
      );
    }

    const { name, email } = validation.data; // Type-safe!
    // ... process validated data
  }

`,
      });
    }
  });
}

/**
 * Strip line (`//…`) and block (`/* … *\/`) comments from source so prose in
 * comments can't trip content-substring heuristics. A small scanner — not a full
 * tokenizer — that tracks string literals (`'`, `"`, backtick) and only treats a
 * `//` or `/*` as a comment when it is OUTSIDE a string. String literals are left
 * intact (so JSX attributes such as `type="file"` stay detectable, and a `//`
 * inside a URL or string is never mistaken for a comment); a block comment is
 * replaced by a space so it can't fuse the tokens on either side.
 *
 * Regex/template-literal corner cases are not modelled (good enough for the
 * heuristic scanners): a `//` or `/*` inside a regex literal or a `${…}`
 * interpolation is treated as string content and simply left in place, which is
 * the safe direction — it never deletes real code.
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  let out = '';
  let str = null; // active string delimiter (' " `) or null when outside a string
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (str) {
      out += c;
      if (c === '\\') {
        // Escape sequence: copy the escaped char verbatim so an escaped quote
        // (\" or \') doesn't prematurely close the string.
        if (i + 1 < src.length) out += next;
        i++;
      } else if (c === str) {
        str = null;
      }
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n'; // preserve the line break so adjacent lines stay separate
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++; // land on the '/' of the closing */; loop's i++ steps past it
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      str = c;
    }
    out += c;
  }
  return out;
}

/**
 * Comment-stripped source with string-literal CONTENTS blanked (the delimiters are kept).
 * Use when detecting real CODE calls — e.g. an auth or validation helper invocation — so a
 * keyword that appears only inside a comment or a string literal (`"auth("`, `'schema'`)
 * can't be mistaken for a call. Template-literal `${…}` interpolations are blanked too,
 * which is the safe direction for these heuristics (it never invents a call).
 * @param {string} src
 * @returns {string}
 */
function stripCommentsAndStrings(src) {
  return stripComments(src).replace(/(['"`])(?:\\[\s\S]|(?!\1)[\s\S])*\1/g, '$1$1');
}

/**
 * Parse a grep result line into file path, line number, and content
 * Handles both Unix and Windows paths (e.g., C:\path\file.ts:10:content)
 * @param {string} match - The grep result line
 * @returns {{ file: string, lineNum: string, line: string }}
 */
function parseGrepMatch(match) {
  // On Windows, paths start with drive letter like "C:\", so we need special handling
  // Format: filepath:linenum:content
  // Windows: C:\path\file.ts:10:content
  // Unix: /path/file.ts:10:content

  let file, lineNum, line;

  // Check if this looks like a Windows path (has drive letter at start)
  if (/^[a-zA-Z]:/.test(match)) {
    // Windows path - find the colon after the drive letter
    const afterDrive = match.substring(2); // Skip "C:"
    const firstColon = afterDrive.indexOf(':');
    const secondColon = afterDrive.indexOf(':', firstColon + 1);

    if (firstColon !== -1 && secondColon !== -1) {
      file = match.substring(0, 2) + afterDrive.substring(0, firstColon);
      lineNum = afterDrive.substring(firstColon + 1, secondColon);
      line = afterDrive.substring(secondColon + 1);
    } else {
      // Fallback - might be files-only output
      file = match;
      lineNum = '0';
      line = '';
    }
  } else {
    // Unix path - simple split
    const parts = match.split(':');
    file = parts[0];
    lineNum = parts[1] || '0';
    line = parts.slice(2).join(':');
  }

  return { file, lineNum, line };
}

/**
 * 3. XSS Protection: Check for dangerous HTML injection
 */
function checkXSSProtection() {
  if (!isCheckEnabled('xssProtection')) {
    log(`\n${colors.yellow}Skipping XSS Protection check (disabled)${colors.reset}`);
    return;
  }

  log(`\n${colors.blue}Checking XSS protection...${colors.reset}`);

  // Find uses of dangerouslySetInnerHTML
  const dangerousHTML = grep('dangerouslySetInnerHTML', 'app', '');
  const dangerousHTMLComponents = grep('dangerouslySetInnerHTML', 'components', '');

  [...dangerousHTML, ...dangerousHTMLComponents].forEach((match) => {
    const { file, lineNum, line } = parseGrepMatch(match);

    // Check for file-level security ignore
    const fileIgnore = hasFileLevelSecurityIgnore(file, 'xss');
    if (fileIgnore.ignored) {
      recordOverride(file, 'xss', fileIgnore.reason);
      return;
    }

    // Check for line-level security ignore
    const lineIgnore = hasSecurityIgnore(file, parseInt(lineNum, 10), line);
    if (lineIgnore.ignored) {
      recordOverride(`${file}:${lineNum}`, 'xss', lineIgnore.reason);
      return;
    }

    // Verify that sanitization is actually APPLIED, not just mentioned
    const isSanitizationApplied = verifySanitizationApplied(file, parseInt(lineNum, 10), line);

    if (!isSanitizationApplied) {
      results.xssProtection.pass = false;
      results.xssProtection.issues.push({
        file: `${file}:${lineNum}`,
        message: 'dangerouslySetInnerHTML used without verified sanitization',
        remediation: `Sanitize HTML using DOMPurify or sanitizeHtml() before rendering. Example:

  import DOMPurify from 'dompurify';

  // Option 1: DOMPurify (recommended for complex HTML)
  <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(userContent) }} />

  // Option 2: Using project's sanitizeHtml utility
  import { sanitizeHtml } from '@/lib/validation/schemas';
  const safeContent = sanitizeHtml(userContent);
  <div dangerouslySetInnerHTML={{ __html: safeContent }} />

  // Option 3: Pre-sanitize and store in variable
  const sanitizedHtml = DOMPurify.sanitize(rawHtml);
  <div dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />

`,
      });
    }
  });
}

/**
 * Verify that sanitization is actually applied to the value passed to dangerouslySetInnerHTML
 * Not just mentioned nearby, but actually wrapping or transforming the value
 *
 * @param {string} filePath - Path to the file
 * @param {number} lineNumber - Line number where dangerouslySetInnerHTML is used
 * @param {string} line - The line content
 * @returns {boolean} True if sanitization is verified to be applied
 */
// The sanitizer CALLS accepted as neutralising HTML before it reaches a sink (innerHTML /
// dangerouslySetInnerHTML / document.write). Anchored with `\b…(` so a real call matches —
// including a member call like `DOMPurify.sanitize(` (the `\b` falls on the `.`) — but a
// variable NAME that merely contains the word (`uncleanValue`, `escapedKey`) does not. Bare
// `escape(` / `encodeURIComponent(` are intentionally absent: they are URL/JS encoders, not
// HTML sanitizers. Shared by verifySanitizationApplied and isSanitizedAssignment so the
// accepted-sanitizer vocabulary lives in one place.
const SANITIZER_CALL_PATTERNS = [
  /\bsanitize(?:Html)?\s*\(/i,
  /\bpurify\s*\(/i,
  /\bescapeHtml\s*\(/i,
  /\bcleanHtml\s*\(/i,
  /\bxss\s*\(/i,
];

function verifySanitizationApplied(filePath, lineNumber, line) {
  // Pattern 1: a direct sanitizer CALL on the same line
  // e.g. dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content) }} (the `.sanitize(`
  // is matched by SANITIZER_CALL_PATTERNS' bare `\bsanitize(` entry).
  if (SANITIZER_CALL_PATTERNS.some((pattern) => pattern.test(line))) {
    return true;
  }

  // Pattern 2: Check if the value is a variable that was sanitized earlier in the file
  // Extract the variable name from __html: variableName
  const htmlValueMatch = line.match(/__html\s*:\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/);
  if (htmlValueMatch) {
    const variableName = htmlValueMatch[1];

    // Read the file and check if this variable was sanitized
    try {
      if (!fs.existsSync(filePath)) {
        return false;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      // Look for sanitization assignment to this variable in preceding lines
      // Search from the start of the file up to the current line
      for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
        const precedingLine = lines[i];

        // Check for patterns like:
        // const sanitizedHtml = DOMPurify.sanitize(...)
        // const variableName = sanitize(...)
        // variableName = DOMPurify.sanitize(...)
        const assignmentPatterns = [
          new RegExp(`(const|let|var)?\\s*${variableName}\\s*=\\s*DOMPurify\\.sanitize\\s*\\(`, 'i'),
          new RegExp(`(const|let|var)?\\s*${variableName}\\s*=\\s*sanitizeHtml\\s*\\(`, 'i'),
          new RegExp(`(const|let|var)?\\s*${variableName}\\s*=\\s*sanitize\\s*\\(`, 'i'),
          new RegExp(`(const|let|var)?\\s*${variableName}\\s*=\\s*xss\\s*\\(`, 'i'),
          new RegExp(`(const|let|var)?\\s*${variableName}\\s*=\\s*escapeHtml\\s*\\(`, 'i'),
          new RegExp(`(const|let|var)?\\s*${variableName}\\s*=\\s*purify\\s*\\(`, 'i'),
        ];

        if (assignmentPatterns.some((pattern) => pattern.test(precedingLine))) {
          return true;
        }
      }

      // Pattern 3: Check if the variable name itself suggests it's sanitized
      // e.g., sanitizedContent, cleanHtml, safeHtml, purifiedContent
      const sanitizedVariablePatterns = [
        /^sanitized/i,
        /^clean/i,
        /^safe/i,
        /^purified/i,
        /^escaped/i,
        /Sanitized$/i,
        /Clean$/i,
        /Safe$/i,
        /Purified$/i,
      ];

      if (sanitizedVariablePatterns.some((pattern) => pattern.test(variableName))) {
        // Variable name suggests sanitization, but verify it's actually sanitized somewhere
        // Look for any sanitization call that results in this variable
        for (let i = 0; i < lines.length; i++) {
          const checkLine = lines[i];
          if (
            checkLine.includes(variableName) &&
            (checkLine.includes('sanitize') ||
              checkLine.includes('DOMPurify') ||
              checkLine.includes('escape') ||
              checkLine.includes('purify') ||
              checkLine.includes('clean'))
          ) {
            return true;
          }
        }
      }

    } catch (error) {
      // If we can't read the file, be conservative and return false
      return false;
    }
  }

  // Pattern 4: Check for sanitization function being called with the spread/object syntax
  // e.g., dangerouslySetInnerHTML={createMarkup(sanitizedContent)}
  // e.g., dangerouslySetInnerHTML={getSanitizedHtml()}
  const functionCallPatterns = [
    /dangerouslySetInnerHTML\s*=\s*\{?\s*[a-zA-Z_$]*[Ss]anitize[a-zA-Z_$]*\s*\(/i,
    /dangerouslySetInnerHTML\s*=\s*\{?\s*[a-zA-Z_$]*[Cc]lean[a-zA-Z_$]*\s*\(/i,
    /dangerouslySetInnerHTML\s*=\s*\{?\s*[a-zA-Z_$]*[Ss]afe[a-zA-Z_$]*\s*\(/i,
    /dangerouslySetInnerHTML\s*=\s*\{?\s*[a-zA-Z_$]*[Pp]urif[a-zA-Z_$]*\s*\(/i,
    /dangerouslySetInnerHTML\s*=\s*\{?\s*[a-zA-Z_$]*[Ee]scape[a-zA-Z_$]*\s*\(/i,
  ];

  if (functionCallPatterns.some((pattern) => pattern.test(line))) {
    return true;
  }

  return false;
}

/**
 * 3a. XSS Protection: Check for user inputs displayed without escaping
 * Detects patterns where user-provided data is rendered without proper escaping
 */
function checkUnescapedUserInput() {
  if (!isCheckEnabled('xssProtection')) {
    return;
  }

  log(`\n${colors.blue}Checking for unescaped user input display...${colors.reset}`);

  // Get all TypeScript/JavaScript files in app and components directories
  const appFiles = getAllFiles(path.join(WEB_SRC, 'app'), ['.tsx', '.jsx']);
  const componentFiles = getAllFiles(path.join(WEB_SRC, 'components'), ['.tsx', '.jsx']);
  const allFiles = [...appFiles, ...componentFiles];

  allFiles.forEach((filePath) => {
    // Skip test files
    if (filePath.includes('.test.') || filePath.includes('__tests__')) return;

    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Check for file-level security ignore
    const fileIgnore = hasFileLevelSecurityIgnore(filePath, 'xss');
    if (fileIgnore.ignored) {
      recordOverride(filePath, 'xss-unescaped-input', fileIgnore.reason);
      return;
    }

    // Track detected issues to avoid duplicates
    const reportedLines = new Set();

    lines.forEach((line, index) => {
      const lineNum = index + 1;

      // Skip comments
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;

      // Pattern 1: innerHTML assignment (not React's dangerouslySetInnerHTML)
      // e.g., element.innerHTML = userInput
      if (/\.innerHTML\s*=/.test(line) && !line.includes('dangerouslySetInnerHTML')) {
        // Check if value is sanitized
        if (!isSanitizedAssignment(line)) {
          reportXSSIssue(filePath, lineNum, line, reportedLines, 'innerHTML assignment without sanitization');
        }
      }

      // Pattern 2: outerHTML assignment
      // e.g., element.outerHTML = content
      if (/\.outerHTML\s*=/.test(line)) {
        if (!isSanitizedAssignment(line)) {
          reportXSSIssue(filePath, lineNum, line, reportedLines, 'outerHTML assignment without sanitization');
        }
      }

      // Pattern 3: document.write with user input
      // e.g., document.write(userInput)
      if (/document\.write\s*\(/.test(line)) {
        if (!isSanitizedAssignment(line)) {
          reportXSSIssue(filePath, lineNum, line, reportedLines, 'document.write usage (potential XSS vector)');
        }
      }

      // (A URL-params-in-href check used to live here — flag `href={...searchParams.x}`
      // without encodeURIComponent. It false-positived on safe `<Link href>` usage and
      // ordinary param interpolation, so it was removed; the genuinely dangerous sinks
      // below — eval / innerHTML / document.write / new Function — stay.)

      // Pattern 5: eval() with any dynamic content
      if (/\beval\s*\(/.test(line)) {
        reportXSSIssue(filePath, lineNum, line, reportedLines, 'eval() usage (critical XSS/injection vector)');
      }

      // Pattern 6: new Function() with dynamic content
      if (/new\s+Function\s*\(/.test(line)) {
        // Check if it contains variables (not just string literals)
        if (/new\s+Function\s*\([^)]*[a-zA-Z_$][a-zA-Z0-9_$]*[^)]*\)/.test(line)) {
          reportXSSIssue(filePath, lineNum, line, reportedLines, 'new Function() with dynamic content (potential code injection)');
        }
      }

      // Pattern 7: setTimeout/setInterval with string argument
      if (/(?:setTimeout|setInterval)\s*\(\s*['"`]/.test(line) ||
          /(?:setTimeout|setInterval)\s*\(\s*[a-zA-Z_$][a-zA-Z0-9_$]*\s*,/.test(line)) {
        // Check if first argument is a string variable (not a function reference)
        const match = line.match(/(?:setTimeout|setInterval)\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*,/);
        if (match) {
          // It's potentially a string being evaluated - flag for review
          // Skip if it's clearly a function name (lowercase first letter usually indicates function)
          const varName = match[1];
          if (!varName.match(/^(function|fn|callback|handler|cb|func)$/i)) {
            // Could be a string - check surrounding context
            // This is a weaker check, so only flag if we see string-related patterns
            if (content.includes(`${varName} =`) &&
                (content.includes(`${varName} = "`) || content.includes(`${varName} = '`) || content.includes(`${varName} = \``))) {
              reportXSSIssue(filePath, lineNum, line, reportedLines, 'setTimeout/setInterval with string argument (use function reference instead)');
            }
          }
        }
      }

      // Pattern 8: Script injection via createElement
      if (/createElement\s*\(\s*['"`]script['"`]\s*\)/.test(line)) {
        reportXSSIssue(filePath, lineNum, line, reportedLines, 'Dynamic script element creation (review for XSS)');
      }

      // Pattern 9: location.href or window.location assignment with user input
      if (/(?:location\.href|window\.location)\s*=/.test(line)) {
        // Check if assigned value contains user input patterns
        if (/(?:location\.href|window\.location)\s*=\s*[^;]*(?:searchParams|params|query|input|user|data)/i.test(line)) {
          if (!line.includes('encodeURIComponent') && !line.includes('encodeURI')) {
            reportXSSIssue(filePath, lineNum, line, reportedLines, 'location assignment with user input (potential open redirect/XSS)');
          }
        }
      }
    });
  });
}

/**
 * Check if an assignment line has sanitization applied
 * @param {string} line - The line to check
 * @returns {boolean}
 */
function isSanitizedAssignment(line) {
  // Assigning .textContent (rather than .innerHTML) is inherently safe.
  if (/\.\s*textContent\s*=/.test(line)) return true;
  // Otherwise require an actual sanitizer CALL on the line (shared vocabulary) — not just a
  // substring like the variable name `uncleanValue` or `escapedKey`.
  return SANITIZER_CALL_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Report an XSS issue if not already reported for this line
 * @param {string} filePath - File path
 * @param {number} lineNum - Line number
 * @param {string} line - Line content
 * @param {Set} reportedLines - Set of already reported lines
 * @param {string} message - Issue message
 */
function reportXSSIssue(filePath, lineNum, line, reportedLines, message) {
  const lineKey = `${filePath}:${lineNum}`;

  if (reportedLines.has(lineKey)) return;

  // Check for line-level security ignore
  const lineIgnore = hasSecurityIgnore(filePath, lineNum, line);
  if (lineIgnore.ignored) {
    recordOverride(lineKey, 'xss-unescaped-input', lineIgnore.reason);
    return;
  }

  reportedLines.add(lineKey);
  results.xssProtection.pass = false;
  results.xssProtection.issues.push({
    file: lineKey,
    message: message,
    remediation: `Sanitize user input before rendering. Example:

  // Option 1: React's built-in escaping (safest for text content)
  <p>{userInput}</p>  // Safe - React escapes automatically

  // Option 2: Sanitize HTML content
  import { sanitizeHtml } from '@/lib/validation/schemas';
  const safeText = sanitizeHtml(userInput);

  // Option 3: Encode URLs
  const safeUrl = encodeURIComponent(userSearchQuery);
  window.location.href = \`/search?q=\${safeUrl}\`;

  // Option 4: Use textContent for DOM manipulation
  element.textContent = userInput;  // Safe
  // NOT: element.innerHTML = userInput;  // Dangerous!

`,
  });
}

/**
 * 4. SQL Injection: Check for raw SQL queries
 * Improved to reduce false positives by:
 * - Requiring SQL keywords to appear in query-like contexts (strings, template literals)
 * - Excluding common false positives (HTTP methods, Zod enums, comments, JSDoc)
 * - Focusing on actual database query patterns
 */
function checkSQLInjection() {
  if (!isCheckEnabled('sqlInjection')) {
    log(`\n${colors.yellow}Skipping SQL Injection check (disabled)${colors.reset}`);
    return;
  }

  // This is a frontend reaching a REST backend; with no SQL driver there is no SQL
  // to protect, and the patterns would only false-positive on look-alike frontend
  // code. Skip both SQL checks unless a database driver is actually a dependency.
  if (!projectHasDatabaseDriver()) {
    log(`\n${colors.yellow}Skipping SQL Injection check (no SQL database driver in web/package.json)${colors.reset}`);
    return;
  }

  log(
    `\n${colors.blue}Checking SQL injection prevention...${colors.reset}`,
  );

  // Get all TypeScript/JavaScript files in app and lib directories
  const appFiles = getAllFiles(path.join(WEB_SRC, 'app'), ['.ts', '.tsx', '.js', '.jsx']);
  const libFiles = getAllFiles(path.join(WEB_SRC, 'lib'), ['.ts', '.tsx', '.js', '.jsx']);
  const allFiles = [...appFiles, ...libFiles];

  // Patterns that indicate actual raw SQL query construction
  // These are more specific than just matching SQL keywords
  const rawSQLPatterns = [
    // String literals containing SQL statements with table references
    // e.g., "SELECT * FROM users", 'INSERT INTO table', `DELETE FROM`
    /['"`]\s*SELECT\s+.+\s+FROM\s+/i,
    /['"`]\s*INSERT\s+INTO\s+/i,
    /['"`]\s*UPDATE\s+\w+\s+SET\s+/i,
    /['"`]\s*DELETE\s+FROM\s+/i,
    /['"`]\s*DROP\s+(TABLE|DATABASE|INDEX)\s+/i,
    /['"`]\s*CREATE\s+(TABLE|DATABASE|INDEX)\s+/i,
    /['"`]\s*ALTER\s+TABLE\s+/i,
    /['"`]\s*TRUNCATE\s+TABLE\s+/i,

    // Template literals with SQL (not tagged with sql`)
    /(?<!sql)`\s*SELECT\s+.+\s+FROM\s+/i,
    /(?<!sql)`\s*INSERT\s+INTO\s+/i,
    /(?<!sql)`\s*UPDATE\s+\w+\s+SET\s+/i,
    /(?<!sql)`\s*DELETE\s+FROM\s+/i,

    // Raw query execution patterns
    /\.query\s*\(\s*['"`]\s*(SELECT|INSERT|UPDATE|DELETE)\b/i,
    /\.execute\s*\(\s*['"`]\s*(SELECT|INSERT|UPDATE|DELETE)\b/i,
    /\.raw\s*\(\s*['"`]\s*(SELECT|INSERT|UPDATE|DELETE)\b/i,

    // SQL string variables being constructed
    /(?:const|let|var)\s+\w*(sql|query|stmt|statement)\w*\s*=\s*['"`]\s*(SELECT|INSERT|UPDATE|DELETE)\b/i,
  ];

  // Patterns that indicate SAFE usage (exclude these)
  const safePatterns = [
    // Prisma tagged template literals
    /Prisma\.sql`/i,
    /prisma\.\$queryRaw/i,
    /prisma\.\$executeRaw/i,
    /sql`/,  // Tagged template literal

    // ORM method calls (not raw SQL)
    /\.findMany\s*\(/,
    /\.findUnique\s*\(/,
    /\.findFirst\s*\(/,
    /\.create\s*\(/,
    /\.update\s*\(/,
    /\.delete\s*\(/,
    /\.upsert\s*\(/,

    // Type definitions and interfaces
    /interface\s+\w+/,
    /type\s+\w+\s*=/,

    // Import statements
    /^import\s+/,

    // HTTP methods (common false positive)
    /method:\s*['"`](GET|POST|PUT|DELETE|PATCH)['"`]/i,
    /['"`](GET|POST|PUT|DELETE|PATCH)['"`]\s*,/,

    // Zod enum patterns (common false positive)
    /z\.enum\s*\(\s*\[/,
    /\.enum\s*\(\s*\[.*(?:create|update|delete)/i,

    // React/Next.js specific patterns
    /export\s+(const|async|default)/,
  ];

  // Track reported files to avoid duplicate reports
  const reportedIssues = new Set();

  allFiles.forEach((filePath) => {
    // Skip test files
    if (filePath.includes('.test.') || filePath.includes('__tests__')) return;
    // Skip type definition files
    if (filePath.endsWith('.d.ts')) return;

    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Check for file-level security ignore
    const fileIgnore = hasFileLevelSecurityIgnore(filePath, 'sql');
    if (fileIgnore.ignored) {
      recordOverride(filePath, 'sql-raw-query', fileIgnore.reason);
      return;
    }

    lines.forEach((line, index) => {
      const lineNum = index + 1;
      const trimmedLine = line.trim();

      // Skip empty lines
      if (!trimmedLine) return;

      // Skip comments (single-line, multi-line start, JSDoc)
      if (trimmedLine.startsWith('//') ||
          trimmedLine.startsWith('/*') ||
          trimmedLine.startsWith('*') ||
          trimmedLine.startsWith('/**')) {
        return;
      }

      // Skip lines that match safe patterns
      const isSafePattern = safePatterns.some(pattern => pattern.test(line));
      if (isSafePattern) return;

      // Check if line matches any raw SQL pattern
      const matchesRawSQL = rawSQLPatterns.some(pattern => pattern.test(line));

      if (matchesRawSQL) {
        const issueKey = `${filePath}:${lineNum}`;

        // Avoid duplicate reports
        if (reportedIssues.has(issueKey)) return;

        // Check for line-level security ignore
        const lineIgnore = hasSecurityIgnore(filePath, lineNum, line);
        if (lineIgnore.ignored) {
          recordOverride(issueKey, 'sql-raw-query', lineIgnore.reason);
          return;
        }

        reportedIssues.add(issueKey);
        results.sqlInjection.pass = false;
        results.sqlInjection.issues.push({
          file: issueKey,
          message: 'Potential raw SQL query detected',
          remediation: `Use Prisma ORM or parameterized queries instead of raw SQL. Example:

  // UNSAFE - vulnerable to SQL injection:
  const query = \`SELECT * FROM users WHERE id = '\${userId}'\`;

  // SAFE - Use Prisma ORM methods:
  const user = await prisma.user.findUnique({
    where: { id: userId }
  });

  // SAFE - Use Prisma.sql tagged template for raw queries:
  import { Prisma } from '@prisma/client';
  const users = await prisma.$queryRaw(
    Prisma.sql\`SELECT * FROM users WHERE id = \${userId}\`
  );

  // The Prisma.sql tag automatically parameterizes values

`,
        });
      }
    });
  });
}

/**
 * 4a. SQL Injection: Check for string concatenation in database query patterns
 * Detects patterns like: query + userInput, sql + variable, "SELECT..." + param
 */
function checkQueryStringConcatenation() {
  if (!isCheckEnabled('sqlInjection')) {
    return;
  }

  // No SQL driver → no SQL surface; skip (checkSQLInjection logs the reason once).
  if (!projectHasDatabaseDriver()) {
    return;
  }

  log(`\n${colors.blue}Checking for string concatenation in database queries...${colors.reset}`);

  // Get all TypeScript/JavaScript files in app and lib directories
  const appFiles = getAllFiles(path.join(WEB_SRC, 'app'), ['.ts', '.tsx', '.js', '.jsx']);
  const libFiles = getAllFiles(path.join(WEB_SRC, 'lib'), ['.ts', '.tsx', '.js', '.jsx']);
  const allFiles = [...appFiles, ...libFiles];

  // SQL keywords that indicate a query context
  const sqlKeywords = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'FROM', 'WHERE', 'JOIN', 'ORDER BY', 'GROUP BY'];

  allFiles.forEach((filePath) => {
    // Skip test files
    if (filePath.includes('.test.') || filePath.includes('__tests__')) return;
    // Skip type definition files
    if (filePath.endsWith('.d.ts')) return;

    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Check for file-level security ignore
    const fileIgnore = hasFileLevelSecurityIgnore(filePath, 'sql');
    if (fileIgnore.ignored) {
      recordOverride(filePath, 'sql-concatenation', fileIgnore.reason);
      return;
    }

    // Track reported lines to avoid duplicates
    const reportedLines = new Set();

    lines.forEach((line, index) => {
      const lineNum = index + 1;
      const trimmedLine = line.trim();

      // Skip comments
      if (trimmedLine.startsWith('//') || trimmedLine.startsWith('*') || trimmedLine.startsWith('/*')) return;

      // Pattern 1: String concatenation with SQL keywords in string literals
      // e.g., "SELECT * FROM users WHERE id = " + id
      // e.g., 'DELETE FROM ' + tableName + ' WHERE...'
      const sqlStringConcatPattern = new RegExp(
        `(['"\`])\\s*(${sqlKeywords.join('|')})\\b[^'"\`]*\\1\\s*\\+\\s*[a-zA-Z_$][a-zA-Z0-9_$]*`,
        'i'
      );

      // Pattern 2: Variable + SQL keyword string
      // e.g., baseQuery + " WHERE id = " + userId
      const varPlusSqlPattern = /[a-zA-Z_$][a-zA-Z0-9_$]*\s*\+\s*['"`]\s*(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|AND|OR)\b/i;

      // Pattern 3: SQL-related variable names being concatenated
      // e.g., query + userInput, sql + param, sqlQuery + value
      const sqlVarConcatPattern = /\b(query|sql|statement|cmd|command)\s*(\+|=\s*[^=].*\+)\s*[a-zA-Z_$][a-zA-Z0-9_$]*/i;

      // Pattern 4: Template literal with SQL that includes unsafe interpolation
      // e.g., `SELECT * FROM ${table} WHERE id = ${id}`
      // This is risky if variables aren't sanitized
      const templateSqlPattern = /`[^`]*(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\b[^`]*\$\{[^}]+\}[^`]*`/i;

      // Pattern 5: String concatenation ending with user input patterns
      // e.g., "... WHERE id = " + req.body.id, "..." + params.id
      const inputConcatPattern = /['"`][^'"`]*(WHERE|AND|OR|SET|VALUES)\s*[^'"`]*['"`]\s*\+\s*(req\.|params\.|input|user|data|body|query)\b/i;

      // Pattern 6: Direct concatenation in execute/query function calls
      // e.g., db.query("SELECT * FROM " + table)
      // e.g., execute(sql + condition)
      const execConcatPattern = /\.(query|execute|raw|run|all|get)\s*\([^)]*\+[^)]*\)/i;

      let issueFound = false;
      let issueMessage = '';

      if (sqlStringConcatPattern.test(line)) {
        issueFound = true;
        issueMessage = 'SQL string concatenated with variable';
      } else if (varPlusSqlPattern.test(line)) {
        issueFound = true;
        issueMessage = 'Variable concatenated with SQL string';
      } else if (sqlVarConcatPattern.test(line)) {
        // Additional check: make sure it's not just a variable declaration
        // and that it looks like actual concatenation with user input
        const match = line.match(sqlVarConcatPattern);
        if (match && !line.includes('const ') && !line.includes('let ') && !line.includes('var ')) {
          // Check if this looks like concatenation with external input
          if (line.includes('+') && !line.match(/\+\s*['"`]/)) {
            // Concatenation with a variable, not a string literal
            issueFound = true;
            issueMessage = 'SQL query variable concatenated with another variable';
          }
        } else if (match && line.includes('+')) {
          // Even in declarations, flag if concatenating with user-related vars
          if (/\+\s*(user|input|param|req|body|data|id)\w*/i.test(line)) {
            issueFound = true;
            issueMessage = 'SQL query built with user input concatenation';
          }
        }
      }

      if (!issueFound && templateSqlPattern.test(line)) {
        // Check if template literal contains potentially unsafe interpolations
        // Safe: `sql` template tag, parameterized values
        // Unsafe: direct variable interpolation in query
        if (!line.includes('sql`') && !line.includes('Prisma')) {
          // Check if the interpolation looks like user input
          const interpolations = line.match(/\$\{([^}]+)\}/g);
          if (interpolations) {
            const hasUnsafeInterpolation = interpolations.some((interp) => {
              const varName = interp.replace(/\$\{|\}/g, '').trim();
              // Flag if it looks like user input or unparameterized value
              return /^(req|params|query|body|user|input|data|id|name|email|search|filter)/i.test(varName) ||
                     /\.(id|name|email|query|search|filter|param)/i.test(varName);
            });
            if (hasUnsafeInterpolation) {
              issueFound = true;
              issueMessage = 'SQL template literal with potentially unsafe interpolation';
            }
          }
        }
      }

      if (!issueFound && inputConcatPattern.test(line)) {
        issueFound = true;
        issueMessage = 'SQL clause concatenated with user input';
      }

      if (!issueFound && execConcatPattern.test(line)) {
        issueFound = true;
        issueMessage = 'Database query/execute call with string concatenation';
      }

      if (issueFound && !reportedLines.has(lineNum)) {
        // Check for line-level security ignore
        const lineIgnore = hasSecurityIgnore(filePath, lineNum, line);
        if (lineIgnore.ignored) {
          recordOverride(`${filePath}:${lineNum}`, 'sql-concatenation', lineIgnore.reason);
          return;
        }

        reportedLines.add(lineNum);
        results.sqlInjection.pass = false;
        results.sqlInjection.issues.push({
          file: `${filePath}:${lineNum}`,
          message: issueMessage,
          remediation: `Never concatenate user input into SQL strings. Use parameterized queries. Example:

  // UNSAFE - string concatenation:
  const query = "SELECT * FROM users WHERE name = '" + userName + "'";
  db.query(query);

  // SAFE - Prisma ORM:
  const user = await prisma.user.findMany({
    where: { name: userName }
  });

  // SAFE - Prisma.sql for raw queries:
  const result = await prisma.$queryRaw(
    Prisma.sql\`SELECT * FROM users WHERE name = \${userName}\`
  );

  // SAFE - parameterized query (other ORMs):
  db.query('SELECT * FROM users WHERE name = ?', [userName]);

`,
        });
      }
    });
  });
}

/** Whether the next-auth configuration files are present. */
function hasNextAuthConfig() {
  return (
    fs.existsSync(path.join(WEB_SRC, 'lib', 'auth', 'auth.config.ts')) ||
    fs.existsSync(path.join(WEB_SRC, 'lib', 'auth', 'auth.ts'))
  );
}

/** Whether the BFF auth-integration files are present. */
function hasBffIntegration() {
  return (
    fs.existsSync(path.join(WEB_SRC, 'lib', 'auth', 'requireSession.ts')) ||
    fs.existsSync(path.join(WEB_SRC, 'lib', 'auth', 'bffClient.ts'))
  );
}

/**
 * Whether the app enforces a recognised session gate anywhere — a gated route group
 * (by name or structurally, incl. a gate in the root layout chain), or a root layout
 * that gates with no route groups at all. Name-independent.
 */
function anyGatedLayoutHasSessionGate() {
  return (
    getStructurallyGatedGroupPaths().length > 0 ||
    (appRootDir() !== null && layoutChainHasSessionGate(appRootDir()))
  );
}

/**
 * 5. Authentication: validate against the auth approach the project chose.
 *
 * Authentication is a per-project decision (BFF / Frontend-only next-auth /
 * Custom — see the `Method` row of project.md §Authentication). This check
 * recognises whichever approach was chosen rather than assuming the next-auth
 * shape. Detection of genuinely unprotected route groups lives in the
 * route-group checks (checkProtectedPages / checkProtectedPageSessionValidation),
 * so this function does not duplicate that and does not fail a project that has
 * simply not built auth yet.
 */
function checkAuthentication() {
  if (!isCheckEnabled('authentication')) {
    log(`\n${colors.yellow}Skipping Authentication check (disabled)${colors.reset}`);
    return;
  }

  log(
    `\n${colors.blue}Checking authentication configuration...${colors.reset}`,
  );

  const method = getAuthMethod();
  const nextAuthConfig = hasNextAuthConfig();
  const bffIntegration = hasBffIntegration();
  const gatedLayoutGate = anyGatedLayoutHasSessionGate();
  const hasGatedGroups = getGatedRouteGroupPaths().length > 0;

  switch (method) {
    case AUTH_METHOD.FRONTEND_ONLY:
      // Validated exactly as before: a next-auth project must ship its config.
      if (!nextAuthConfig) {
        results.authentication.pass = false;
        results.authentication.issues.push({
          file: 'lib/auth/',
          message: 'Authentication configuration not found',
          remediation: `Create authentication configuration files. Expected structure:

  web/src/lib/auth/
  ├── auth.ts          # NextAuth configuration export
  ├── auth.config.ts   # Auth options (providers, callbacks)
  └── auth-helpers.ts  # RBAC helper functions

  Example auth.ts:
  import NextAuth from 'next-auth';
  import { authConfig } from './auth.config';

  export const { auth, handlers, signIn, signOut } = NextAuth(authConfig);

`,
        });
      } else {
        log(`  ${colors.green}Frontend-only (next-auth) configuration recognised${colors.reset}`);
      }
      return;

    case AUTH_METHOD.BFF:
      // Recognise the BFF integration (requireSession.ts / bffClient.ts and/or
      // an authenticated route-group layout calling requireSession()). Missing
      // gating on an existing route group is reported by the route-group checks.
      if (bffIntegration || gatedLayoutGate) {
        log(`  ${colors.green}BFF authentication integration recognised${colors.reset}`);
      } else if (!hasGatedGroups) {
        log(`  ${colors.yellow}Note: no authentication integration built yet — nothing to gate${colors.reset}`);
      } else {
        log(`  ${colors.yellow}Note: gated route group present without a recognised BFF session gate (see access-control findings)${colors.reset}`);
      }
      return;

    case AUTH_METHOD.CUSTOM:
      // Custom auth is bespoke — never require the next-auth (or any single)
      // shape. Access control is validated by the route-group checks.
      log(`  ${colors.yellow}Custom authentication selected — validated by access-control checks, not a fixed shape${colors.reset}`);
      return;

    default:
      // No project.md / unknown method: detect by evidence, never assume next-auth.
      if (nextAuthConfig || bffIntegration || gatedLayoutGate) {
        log(`  ${colors.green}Authentication integration recognised${colors.reset}`);
      } else {
        log(`  ${colors.yellow}Note: no authentication integration detected; access-control checks still apply${colors.reset}`);
      }
      return;
  }
}

/**
 * Check if running in GitHub Actions environment
 * @returns {boolean}
 */
function isGitHubActions() {
  return process.env.GITHUB_ACTIONS === 'true';
}

/**
 * Generate GitHub Actions Job Summary with markdown tables
 * Writes to GITHUB_STEP_SUMMARY environment file
 * @see https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#adding-a-job-summary
 */
function generateGitHubSummary() {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) {
    return; // Not running in GitHub Actions or summary not available
  }

  const categories = Object.keys(config).map((key) => ({
    key,
    name: config[key].name,
    severity: config[key].severity,
    risk: config[key].risk,
  }));

  let markdown = '# 🔒 Security Validation Report\n\n';

  // Summary table.
  //
  // The columns answer three separate questions and never overlap:
  // - Result: did this check pass? (✅ Passed / ❌ Failed)
  // - Risk level: how serious are the findings? (Critical/High/Medium/Low) —
  //   shown only when there are findings, so a passing check shows no risk
  //   rating and can't be misread as having a problem.
  // - Blocks merge if failed: the enforcement policy, on its own heading so it
  //   is never confused with how serious a finding is.
  markdown += '## Summary\n\n';
  markdown += '| Check | Result | Risk level | Blocks merge if failed | Findings |\n';
  markdown += '|-------|--------|------------|------------------------|----------|\n';

  let totalIssues = 0;
  let totalErrors = 0;
  let totalWarnings = 0;

  categories.forEach(({ name, key, severity, risk }) => {
    if (severity === SEVERITY.OFF) {
      markdown += `| ${name} | ⏭️ Not run | — | — | — |\n`;
      return;
    }

    const result = results[key];
    const issueCount = result.issues.length;
    totalIssues += issueCount;

    const blocksMerge = severity === SEVERITY.ERROR ? 'Yes' : 'No';

    // Result is a clean pass/fail based purely on whether findings exist.
    // Risk level rates the findings; with none, there is nothing to rate, so
    // we show "—" rather than a rating that would imply a problem.
    let resultLabel;
    let riskLevel;

    if (result.pass) {
      resultLabel = '✅ Passed';
      riskLevel = '—';
    } else {
      resultLabel = '❌ Failed';
      riskLevel = riskBadge(risk);
      if (severity === SEVERITY.ERROR) {
        totalErrors += issueCount;
      } else {
        totalWarnings += issueCount;
      }
    }

    markdown += `| ${name} | ${resultLabel} | ${riskLevel} | ${blocksMerge} | ${issueCount} |\n`;
  });

  markdown += '\n';

  // Overall status. Phrased in terms of findings and whether they block the
  // merge — no overloaded "error/warning" labels that read like risk ratings.
  if (totalErrors > 0) {
    markdown += `> **❌ Failed** — ${totalErrors} finding(s) must be fixed before this can merge\n\n`;
  } else if (totalWarnings > 0) {
    markdown += `> **✅ Passed** — ${totalWarnings} finding(s) found that don't block the merge but should be reviewed\n\n`;
  } else {
    markdown += `> **✅ Passed** — no findings\n\n`;
  }

  // Detailed issues section
  let hasDetailedIssues = false;
  categories.forEach(({ name, key, severity, risk }) => {
    if (severity === SEVERITY.OFF) return;

    const result = results[key];
    if (!result.pass && result.issues.length > 0) {
      if (!hasDetailedIssues) {
        markdown += '## Findings\n\n';
        hasDetailedIssues = true;
      }

      const blocksMerge = severity === SEVERITY.ERROR ? 'blocks the merge' : 'does not block the merge';
      markdown += `### ${name}\n\n`;
      markdown += `${riskBadge(risk)} risk — ${blocksMerge}.\n\n`;

      markdown += '| File | Issue | Remediation |\n';
      markdown += '|------|-------|-------------|\n';

      result.issues.forEach((issue) => {
        const { filePath, lineNumber } = parseIssueFile(issue.file);
        const fileLink = lineNumber
          ? `\`${filePath}:${lineNumber}\``
          : `\`${filePath}\``;

        // Escape pipe characters and truncate long remediation for table
        const escapedMessage = issue.message.replace(/\|/g, '\\|').replace(/\n/g, ' ');
        const remediationPreview = getRemediationPreview(issue.remediation);

        markdown += `| ${fileLink} | ${escapedMessage} | ${remediationPreview} |\n`;
      });

      markdown += '\n';

      // Add full remediation details in collapsible sections
      markdown += '<details>\n<summary>📚 Full Remediation Details</summary>\n\n';
      result.issues.forEach((issue, index) => {
        const { filePath, lineNumber } = parseIssueFile(issue.file);
        const fileRef = lineNumber ? `${filePath}:${lineNumber}` : filePath;
        markdown += `#### Issue ${index + 1}: \`${fileRef}\`\n\n`;
        markdown += '```\n';
        markdown += issue.remediation;
        markdown += '\n```\n\n';
      });
      markdown += '</details>\n\n';
    }
  });

  // Security overrides section
  if (overrides.length > 0) {
    markdown += '## 🔓 Security Overrides Applied\n\n';
    markdown += '| File | Check Type | Reason |\n';
    markdown += '|------|------------|--------|\n';

    overrides.forEach((override) => {
      const escapedReason = override.reason.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      markdown += `| \`${override.file}\` | ${override.checkType} | ${escapedReason} |\n`;
    });

    markdown += '\n';
  }

  // Write to GitHub Step Summary
  try {
    fs.appendFileSync(summaryFile, markdown);
  } catch (error) {
    console.error(`Failed to write GitHub summary: ${error.message}`);
  }
}

/**
 * Get a short preview of remediation text for the summary table
 * @param {string} remediation - Full remediation text
 * @returns {string} Short preview suitable for table cell
 */
function getRemediationPreview(remediation) {
  // Extract the first sentence or line
  const firstLine = remediation.split('\n')[0].trim();

  // Find the first meaningful instruction (skip "Example:" type headers)
  const cleanedLine = firstLine
    .replace(/^(Example|See|Add|Use|Create|Sanitize|Never):?\s*/i, '')
    .trim();

  // Truncate if needed
  const maxLength = 60;
  if (cleanedLine.length > maxLength) {
    return cleanedLine.substring(0, maxLength - 3) + '...';
  }

  // If the first line is too short, try to get more context
  if (cleanedLine.length < 20) {
    return firstLine.substring(0, maxLength);
  }

  return cleanedLine || firstLine.substring(0, maxLength);
}

/**
 * Parse file path and line number from issue file string
 * @param {string} fileString - File string in format "path:line" or just "path"
 * @returns {{ filePath: string, lineNumber: number | null }}
 */
function parseIssueFile(fileString) {
  // Handle Windows paths (C:\path\file.ts:10)
  let filePath, lineNumber;

  if (/^[a-zA-Z]:/.test(fileString)) {
    // Windows path
    const afterDrive = fileString.substring(2);
    const lastColonIndex = afterDrive.lastIndexOf(':');

    if (lastColonIndex !== -1) {
      const potentialLineNum = afterDrive.substring(lastColonIndex + 1);
      if (/^\d+$/.test(potentialLineNum)) {
        filePath = fileString.substring(0, 2) + afterDrive.substring(0, lastColonIndex);
        lineNumber = parseInt(potentialLineNum, 10);
      } else {
        filePath = fileString;
        lineNumber = null;
      }
    } else {
      filePath = fileString;
      lineNumber = null;
    }
  } else {
    // Unix path
    const lastColonIndex = fileString.lastIndexOf(':');
    if (lastColonIndex !== -1) {
      const potentialLineNum = fileString.substring(lastColonIndex + 1);
      if (/^\d+$/.test(potentialLineNum)) {
        filePath = fileString.substring(0, lastColonIndex);
        lineNumber = parseInt(potentialLineNum, 10);
      } else {
        filePath = fileString;
        lineNumber = null;
      }
    } else {
      filePath = fileString;
      lineNumber = null;
    }
  }

  // Convert absolute path to relative path for GitHub Actions
  // GitHub Actions expects paths relative to the repository root
  const cwd = process.cwd();
  if (filePath.startsWith(cwd)) {
    filePath = filePath.substring(cwd.length + 1);
  }

  // Normalize path separators for GitHub Actions (use forward slashes)
  filePath = filePath.replace(/\\/g, '/');

  return { filePath, lineNumber };
}

/**
 * Output GitHub Actions annotation
 * @param {'error' | 'warning'} level - Annotation level
 * @param {string} fileString - File path with optional line number
 * @param {string} message - The issue message
 * @param {string} title - Title for the annotation
 */
function outputGitHubAnnotation(level, fileString, message, title) {
  const { filePath, lineNumber } = parseIssueFile(fileString);

  // Build the annotation command
  // Format: ::error file={name},line={line},title={title}::{message}
  let annotation = `::${level} file=${filePath}`;

  if (lineNumber !== null) {
    annotation += `,line=${lineNumber}`;
  }

  if (title) {
    annotation += `,title=${title}`;
  }

  annotation += `::${message}`;

  console.log(annotation);
}

/**
 * Generate report
 */
function generateReport() {
  const inGitHubActions = isGitHubActions();

  console.log(`\n${'='.repeat(70)}`);
  console.log(`${colors.blue}SECURITY VALIDATION REPORT${colors.reset}`);
  console.log(`${'='.repeat(70)}\n`);

  const categories = Object.keys(config).map((key) => ({
    key,
    name: config[key].name,
    severity: config[key].severity,
    risk: config[key].risk,
  }));

  let hasErrors = false;
  let hasWarnings = false;

  // Track issue counts by category
  const issueCounts = {};
  let totalIssues = 0;

  categories.forEach(({ name, key, severity, risk }) => {
    // Skip disabled checks
    if (severity === SEVERITY.OFF) {
      console.log(`${name}: ${colors.yellow}Disabled${colors.reset}`);
      return;
    }

    const result = results[key];
    const isError = severity === SEVERITY.ERROR;
    const hasFailed = !result.pass;

    // Track issue counts
    const issueCount = result.issues.length;
    if (issueCount > 0) {
      issueCounts[name] = issueCount;
      totalIssues += issueCount;
    }

    // Display check result with clear, unambiguous formatting
    // - Passed checks: just show the name with a checkmark
    // - Failed checks: show name with status and severity context
    if (result.pass) {
      console.log(`${colors.green}✅${colors.reset} ${name}: ${colors.green}PASSED${colors.reset}`);
    } else if (isError) {
      hasErrors = true;
      console.log(`${colors.red}❌${colors.reset} ${name}: ${colors.red}FAILED${colors.reset} — ${risk} risk (blocks merge)`);
    } else {
      hasWarnings = true;
      console.log(`${colors.yellow}⚠️${colors.reset}  ${name}: ${colors.yellow}FAILED${colors.reset} — ${risk} risk (does not block merge)`);
    }

    if (hasFailed) {
      const issueColor = isError ? colors.red : colors.yellow;
      const issueMarker = isError ? '✗' : '⚠';

      result.issues.forEach((issue) => {
        // Output GitHub Actions annotation if running in CI
        if (inGitHubActions) {
          const annotationLevel = isError ? 'error' : 'warning';
          const title = `Security: ${name}`;
          outputGitHubAnnotation(annotationLevel, issue.file, issue.message, title);
        }

        console.log(`  ${issueColor}${issueMarker}${colors.reset}  ${issue.file}`);
        console.log(`     ${issue.message}`);
        console.log(
          `     ${colors.blue}Fix:${colors.reset} ${issue.remediation}\n`,
        );
      });
    }
  });

  // Show overrides that were used
  if (overrides.length > 0) {
    console.log(`\n${'-'.repeat(70)}`);
    console.log(`${colors.yellow}Security Overrides Applied (${overrides.length}):${colors.reset}\n`);
    overrides.forEach((override) => {
      console.log(`  ${colors.yellow}~${colors.reset}  ${override.file}`);
      console.log(`     Check: ${override.checkType}`);
      console.log(`     Reason: ${override.reason}\n`);
    });
  }

  console.log(`\n${'='.repeat(70)}`);

  // Display issue counts summary
  if (totalIssues > 0) {
    const breakdown = Object.entries(issueCounts)
      .map(([name, count]) => `${count} ${name}`)
      .join(', ');
    console.log(
      `\n${colors.blue}Summary:${colors.reset} ${totalIssues} issue${totalIssues === 1 ? '' : 's'} found: ${breakdown}`,
    );
  }

  // Generate GitHub Actions Job Summary if running in CI
  if (inGitHubActions) {
    generateGitHubSummary();
  }

  // Final status message
  if (!hasErrors && !hasWarnings) {
    console.log(
      `\n${colors.green}All security checks passed!${colors.reset}\n`,
    );
    process.exit(0);
  } else if (!hasErrors && hasWarnings) {
    console.log(
      `\n${colors.yellow}Security checks passed with warnings. Review the warnings above.${colors.reset}\n`,
    );
    process.exit(0);
  } else {
    console.log(
      `\n${colors.red}Security validation failed. Please fix the errors above.${colors.reset}\n`,
    );
    process.exit(1);
  }
}

/**
 * Time limit for validation in milliseconds (2 minutes)
 */
const TIME_LIMIT_MS = 2 * 60 * 1000;

/**
 * Warning threshold - warn if execution exceeds 80% of time limit
 */
const TIME_WARNING_THRESHOLD_MS = TIME_LIMIT_MS * 0.8;

/**
 * Track execution time and check against limits
 * @param {number} startTime - Start time from Date.now()
 * @returns {{ elapsed: number, elapsedSeconds: number, percentOfLimit: number, isOverLimit: boolean, isNearLimit: boolean }}
 */
function checkExecutionTime(startTime) {
  const elapsed = Date.now() - startTime;
  const elapsedSeconds = (elapsed / 1000).toFixed(2);
  const percentOfLimit = ((elapsed / TIME_LIMIT_MS) * 100).toFixed(1);
  const isOverLimit = elapsed > TIME_LIMIT_MS;
  const isNearLimit = elapsed > TIME_WARNING_THRESHOLD_MS;

  return { elapsed, elapsedSeconds, percentOfLimit, isOverLimit, isNearLimit };
}

/**
 * Main execution
 */
function main() {
  // Parse command-line arguments first
  parseArgs();

  // Show help and exit if requested
  if (cliOptions.help) {
    showHelp();
    process.exit(0);
  }

  const startTime = Date.now();

  console.log(
    `\n${colors.blue}Running Security Pattern Validation...${colors.reset}`,
  );

  checkRBAC();
  checkProtectedPages();
  checkProtectedPageSessionValidation();
  checkRoleReferences();
  checkInputValidation();
  checkXSSProtection();
  checkUnescapedUserInput();
  checkSQLInjection();
  checkQueryStringConcatenation();
  checkAuthentication();

  // Check execution time before generating report
  const timing = checkExecutionTime(startTime);

  // Output timing information
  console.log(`\n${colors.blue}Execution Time:${colors.reset} ${timing.elapsedSeconds}s (${timing.percentOfLimit}% of 2-minute limit)`);

  if (timing.isOverLimit) {
    console.log(`${colors.red}WARNING: Validation exceeded 2-minute time limit!${colors.reset}`);
    if (isGitHubActions()) {
      console.log(`::warning title=Security Validation Timeout::Validation took ${timing.elapsedSeconds}s, exceeding the 2-minute limit. Consider optimizing checks or splitting into parallel jobs.`);
    }
  } else if (timing.isNearLimit) {
    console.log(`${colors.yellow}WARNING: Validation approaching 2-minute time limit (>${Math.round(TIME_WARNING_THRESHOLD_MS / 1000)}s)${colors.reset}`);
    if (isGitHubActions()) {
      console.log(`::warning title=Security Validation Slow::Validation took ${timing.elapsedSeconds}s, approaching the 2-minute limit. Consider monitoring for performance degradation.`);
    }
  }

  generateReport();

  // Final timing check
  const finalTiming = checkExecutionTime(startTime);
  console.log(`Total execution time: ${finalTiming.elapsedSeconds}s`);
}

main();
