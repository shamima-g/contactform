#!/usr/bin/env node
/**
 * run-smoke-test.js
 * Executes a single HTTP smoke test for api-connectivity-agent.
 *
 * Lives under .claude/scripts/ so `node .claude/scripts/*.js` is auto-approved by the
 * bash-permission-checker hook — the agent can run a smoke test in one call instead
 * of several permission-gated bash steps.
 *
 * Usage:
 *   node .claude/scripts/run-smoke-test.js --config <path-to-config.json>
 *
 * Config JSON shape:
 *   {
 *     "attempt": 1,
 *     "baseUrl": "http://localhost:4423",
 *     "method": "GET",
 *     "path": "/v1/health",
 *     "headers": [
 *       { "name": "Authorization", "valueTemplate": "Bearer ${API_TOKEN}" },
 *       { "name": "Cookie",        "valueTemplate": "session=${API_SESSION_COOKIE}" }
 *     ],
 *     "body": null,                                              // null, or string
 *     "envFile": "web/.env.local",                               // file to source for ${VAR} expansion
 *     "timeoutMs": 10000,
 *     "reachabilityOnly": false,                                 // cookie-session auth: 401/403 counts as success
 *     "writeShellArtifact": "generated-docs/specs/api-smoke-test.sh",  // null disables
 *     "bodyExcerptLimit": 500
 *   }
 *
 * reachabilityOnly:
 *   Set true for cookie-session auth (browser-managed session cookie from POST /login,
 *   with no static token/key to send). The probe runs unauthenticated, so any response short
 *   of a wrong-URL/dead-server error proves the backend was reached. In this mode a 401/403,
 *   a 3xx redirect (e.g. to a login page), or any 2xx (including an empty-body health 200) is
 *   scored `success` / `reachable` instead of `auth_invalid` / `forbidden` / `shape_mismatch`.
 *   404, 5xx, and transport errors still classify as normal failures.
 *
 * Security invariants:
 *   - Credential VALUES never appear in stdout, the `.sh` artifact, or returned JSON.
 *     The script reads env values from envFile in-memory, substitutes them into header
 *     values for the HTTP call, and then forgets them.
 *   - The `.sh` artifact contains env var REFERENCES (`${API_TOKEN}`), not values.
 *   - If a required env var is unset, the script returns `result: "credentials_missing"`
 *     listing the unset names — without ever printing the (absent) values.
 *
 * Output (single-line JSON to stdout — agent parses this):
 *   {
 *     "status": "completed" | "error",
 *     "result": "success" | "failure" | "warning" | "credentials_missing",
 *     "category": "none" | "reachable" | "dns" | "connection_refused" | "timeout"
 *                | "auth_invalid" | "forbidden" | "not_found"
 *                | "shape_mismatch" | "tls" | "other",
 *     "httpStatus": <number|null>,
 *     "bodyExcerpt": "<first N chars, never includes credentials>",
 *     "bodyTruncated": <boolean — true if response exceeded the in-memory cap>,
 *     "elapsedMs": <number>,
 *     "missingCredentials": ["API_TOKEN", ...],
 *     "errorMessage": "<string|null>",
 *     "shellArtifactPath": "<path|null>",
 *     "corsAccessControlAllowOrigin": "<header value|null>"
 *   }
 *
 * Errors (config invalid, etc.) exit code 1 with `{ status: "error", errorMessage: ... }`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// =============================================================================
// CLI
// =============================================================================

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--config') args.config = argv[++i];
    else if (flag === '--help' || flag === '-h') args.help = true;
    else {
      bail(`Unknown argument: ${flag}`);
    }
  }
  return args;
}

function help() {
  console.log(`run-smoke-test.js — Execute one HTTP smoke test for api-connectivity-agent

Usage:
  node .claude/scripts/run-smoke-test.js --config <path-to-config.json>

Reads the config JSON, substitutes \${VAR} placeholders from the envFile, executes
the HTTP request, and prints a single-line JSON result to stdout. Optionally writes
a re-runnable bash artifact with env-var references (never values).
`);
  process.exit(0);
}

function bail(message) {
  process.stdout.write(JSON.stringify({ status: 'error', errorMessage: message }) + '\n');
  process.exit(1);
}

// =============================================================================
// ENV FILE PARSE (no external deps — dotenv-compatible subset)
// =============================================================================

function parseEnvFile(filePath) {
  if (!filePath) return {};
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    bail(`Cannot read envFile ${filePath}: ${err.message}`);
  }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const declaration = trimmed.startsWith('export ') ? trimmed.slice(7).trimStart() : trimmed;
    const eq = declaration.indexOf('=');
    if (eq <= 0) continue;
    const key = declaration.slice(0, eq).trim();
    const rawValue = declaration.slice(eq + 1).trim();
    // Strip surrounding quotes — must check before any inner-whitespace trim so
    // a quoted value like KEY="  abc  " preserves its interior whitespace.
    let value;
    if (
      rawValue.length >= 2 &&
      ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'")))
    ) {
      value = rawValue.slice(1, -1);
    } else {
      value = rawValue;
    }
    out[key] = value;
  }
  return out;
}

// =============================================================================
// PLACEHOLDER SUBSTITUTION
// =============================================================================

// Env-var references are conventionally uppercase, but accept any case so a lowercase/mixed
// ${api_token} is still detected, substituted, and flagged-when-missing — never sent literally.
const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

function findPlaceholders(template) {
  if (typeof template !== 'string') return [];
  const names = new Set();
  let match;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((match = PLACEHOLDER_RE.exec(template)) !== null) {
    names.add(match[1] || match[2]);
  }
  return [...names];
}

function substitute(template, env) {
  if (typeof template !== 'string') return template;
  PLACEHOLDER_RE.lastIndex = 0;
  return template.replace(PLACEHOLDER_RE, (_full, a, b) => {
    const name = a || b;
    return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : '';
  });
}

// =============================================================================
// HTTP REQUEST (built-in http/https)
// =============================================================================

function doRequest({ baseUrl, method, pathSuffix, headers, body, timeoutMs, bodyExcerptLimit }) {
  return new Promise((resolve) => {
    let parsedBase;
    try {
      parsedBase = new URL(baseUrl);
    } catch (e) {
      return resolve({
        ok: false,
        errorCode: 'INVALID_URL',
        errorMessage: `Invalid baseUrl: ${baseUrl} (${e.message})`,
      });
    }
    // Concatenate base.pathname + suffix instead of `new URL(suffix, base)`, which drops
    // the base path when the suffix starts with `/` (e.g. base=`http://x/api` + suffix=`/v1/h`
    // would resolve to `http://x/v1/h`, dropping `/api`).
    const basePath = parsedBase.pathname.replace(/\/$/, '');
    const fullPath = (basePath + (pathSuffix || '') + parsedBase.search) || '/';

    const lib = parsedBase.protocol === 'https:' ? https : http;
    const headerMap = {};
    for (const h of headers || []) headerMap[h.name] = h.value;
    if (body && !headerMap['Content-Length']) {
      headerMap['Content-Length'] = Buffer.byteLength(body);
    }
    const startedAt = Date.now();
    // Cap buffered bytes so a huge or unbounded response can't OOM the runner; we
    // only ever surface the first bodyExcerptLimit chars anyway.
    const maxBodyBytes = Math.max((bodyExcerptLimit || 500) * 4, 64 * 1024);
    let received = 0;
    let truncated = false;
    // Hoisted: error/end handlers below reference `timer` before its assignment.
    // `let` in TDZ would ReferenceError on any synchronous-error path.
    let timer = null;
    // Single-settle guard. Hitting the byte cap resolves with the partial body
    // and THEN aborts the request; that abort must not also resolve as an error,
    // and `res.on('end')` won't fire on a destroyed stream — so resolution can't
    // be left to 'end' alone or the promise would strand on every truncation.
    let settled = false;

    const req = lib.request(
      {
        protocol: parsedBase.protocol,
        hostname: parsedBase.hostname,
        port: parsedBase.port || (parsedBase.protocol === 'https:' ? 443 : 80),
        method: method || 'GET',
        path: fullPath,
        headers: headerMap,
      },
      (res) => {
        const chunks = [];
        const succeed = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            ok: true,
            httpStatus: res.statusCode,
            responseHeaders: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            bodyTruncated: truncated,
            elapsedMs: Date.now() - startedAt,
          });
        };
        res.on('data', (c) => {
          if (received >= maxBodyBytes) return;
          const remaining = maxBodyBytes - received;
          if (c.length <= remaining) {
            chunks.push(c);
            received += c.length;
          } else {
            chunks.push(c.subarray(0, remaining));
            received = maxBodyBytes;
            truncated = true;
            // Surface the capped body as a success, then stop downloading the
            // rest. Destroying first would suppress 'end' and strand the promise.
            succeed();
            req.destroy();
          }
        });
        res.on('end', succeed);
      }
    );
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        errorCode: err.code || 'REQUEST_ERROR',
        errorMessage: err.message,
        elapsedMs: Date.now() - startedAt,
      });
    });
    // Wall-clock timeout via setTimeout — covers DNS + connect, which req.setTimeout
    // (socket-idle) does not. Without this, a wedged DNS lookup hangs ~75s.
    if (timeoutMs && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        const err = new Error(`Request timed out after ${timeoutMs}ms`);
        err.code = 'ETIMEDOUT';
        req.destroy(err);
      }, timeoutMs);
    }
    if (body) req.write(body);
    req.end();
  });
}

// =============================================================================
// CATEGORISATION (mirrors api-connectivity-agent.md Step 3)
// =============================================================================

function categorise(result, reachabilityOnly) {
  if (!result.ok) {
    const code = result.errorCode || '';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { result: 'failure', category: 'dns' };
    if (code === 'ECONNREFUSED') return { result: 'failure', category: 'connection_refused' };
    if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return { result: 'failure', category: 'timeout' };
    if (code.startsWith('ERR_TLS_') || code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
      return { result: 'failure', category: 'tls' };
    }
    return { result: 'failure', category: 'other' };
  }
  const s = result.httpStatus;
  if (typeof s !== 'number') return { result: 'failure', category: 'other' };
  // Cookie-session auth (reachabilityOnly): we only need to prove the backend is reachable, not
  // exercise a credentialed round-trip. Any 2xx (including an empty-body health 200, NOT a
  // shape_mismatch here), a 3xx redirect (e.g. to a login page), or an auth challenge (401/403)
  // on the unauthenticated probe proves reachability. 404/5xx still fail (wrong base URL or dead
  // endpoint is a real problem).
  if (reachabilityOnly && ((s >= 200 && s < 400) || s === 401 || s === 403)) {
    return { result: 'success', category: 'reachable' };
  }
  if (s >= 200 && s < 300) {
    // 2xx with empty body on a status that should carry one (anything but 204/205) is
    // the "shape_mismatch" warning the agent doc calls out — flag for follow-up but
    // don't fail the test outright.
    const hasBody = typeof result.body === 'string' && result.body.trim() !== '';
    if (!hasBody && s !== 204 && s !== 205) return { result: 'warning', category: 'shape_mismatch' };
    return { result: 'success', category: 'none' };
  }
  if (s === 401) return { result: 'failure', category: 'auth_invalid' };
  if (s === 403) return { result: 'failure', category: 'forbidden' };
  if (s === 404) return { result: 'failure', category: 'not_found' };
  return { result: 'failure', category: 'other' };
}

// =============================================================================
// SHELL ARTIFACT (env-var references only — never values)
// =============================================================================

// Escape a value for inclusion inside a double-quoted shell string, fully neutralising shell
// metacharacters — NO variable expansion. Use for concrete literals (base URL, path, header
// names). A baseUrl like `http://x"; rm -rf ~; "` becomes inert text, not a command.
function shellDqLiteral(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$');
}

// Escape a value for a double-quoted shell string while PRESERVING ${VAR}/$VAR expansion —
// header value templates reference env vars and must still expand at run time. Command
// substitution (`$(...)`), backticks, quote breakout, and stray backslashes are neutralised;
// only a `$` that begins a `$(` command substitution is escaped, so `${TOKEN}` is untouched.
function shellDqAllowVars(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/"/g, '\\"')
    .replace(/\$\(/g, '\\$(');
}

function buildShellArtifact({ baseUrl, method, pathSuffix, headers, body, referenced }) {
  // Mirror the live request's URL assembly: the path suffix goes BEFORE the query string.
  // Naively appending the suffix to the whole base URL would produce `…/api?q=1/v1/health`
  // when the base carries a query, i.e. a different (malformed) URL than the test actually hit.
  let urlBase = baseUrl;
  let urlQuery = '';
  try {
    const u = new URL(baseUrl);
    urlQuery = u.search; // '' or '?…'
    urlBase = `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    /* unparseable base URL — emit it verbatim and let the user fix it */
  }
  const lines = [
    '#!/usr/bin/env bash',
    '# Re-runnable connectivity smoke test',
    '# Generated by .claude/scripts/run-smoke-test.js. Do not commit credentials.',
    '# Usage: ( set -a; . web/.env.local; set +a; bash generated-docs/specs/api-smoke-test.sh )',
    'set -u',
    `BASE_URL="${shellDqLiteral(urlBase)}"`,
  ];
  // Declare any env vars referenced in header templates so the script fails loudly if unset.
  // `referenced` is computed once by main() and threaded in to avoid re-scanning the headers.
  for (const name of referenced) {
    lines.push(`: "\${${name}:?${name} must be set in web/.env.local}"`);
  }
  const curlParts = ['curl', '-sS', '-o', '/tmp/smoke-body', '-w', '"%{http_code}\\n"'];
  // Method is semi-trusted config (from project.md / spec) — escape + quote it so a value like
  // `POST; rm -rf ~` becomes an inert literal method string rather than a shell injection.
  if (method && method !== 'GET') curlParts.push('-X', `"${shellDqLiteral(method)}"`);
  for (const h of headers || []) {
    // Header name is a literal; the value template may legitimately reference ${VAR}.
    curlParts.push('-H', `"${shellDqLiteral(h.name)}: ${shellDqAllowVars(h.valueTemplate)}"`);
  }
  if (body) {
    // Body must reach curl as the literal string the live request sent — wrap in
    // single quotes and escape embedded `'` via the standard `'\''` dance.
    const shellEscaped = String(body).replace(/'/g, "'\\''");
    curlParts.push('--data', `'${shellEscaped}'`);
  }
  curlParts.push(`"$BASE_URL${shellDqLiteral(pathSuffix || '')}${shellDqLiteral(urlQuery)}"`);
  lines.push(curlParts.join(' \\\n  '));
  return lines.join('\n') + '\n';
}

function writeShellArtifact(artifactPath, content) {
  const dir = path.dirname(artifactPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(artifactPath, content, 'utf8');
}

// =============================================================================
// RESULT EMISSION
// =============================================================================

function emitResult(fields) {
  process.stdout.write(
    JSON.stringify({
      status: 'completed',
      result: null,
      category: 'none',
      httpStatus: null,
      bodyExcerpt: null,
      bodyTruncated: false,
      elapsedMs: 0,
      missingCredentials: [],
      processEnvOnlyCredentials: [],
      errorMessage: null,
      shellArtifactPath: null,
      corsAccessControlAllowOrigin: null,
      ...fields,
    }) + '\n'
  );
}

// =============================================================================
// MAIN
// =============================================================================

(async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return help();
  if (!args.config) bail('Missing --config <path-to-config.json>');

  let config;
  try {
    config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  } catch (e) {
    return bail(`Cannot read config: ${e.message}`);
  }

  const env = parseEnvFile(config.envFile);
  const envFileKeys = new Set(Object.keys(env));
  // envFile is authoritative for credentials; process.env fills in only what's missing
  // (e.g., a system-wide var). This keeps `.env.local` the single source of truth.
  for (const [k, v] of Object.entries(process.env)) {
    if (!Object.prototype.hasOwnProperty.call(env, k)) env[k] = v;
  }

  // Resolve placeholders & track missing credentials
  const referenced = new Set();
  const resolvedHeaders = [];
  for (const h of config.headers || []) {
    for (const name of findPlaceholders(h.valueTemplate)) referenced.add(name);
    resolvedHeaders.push({ name: h.name, value: substitute(h.valueTemplate, env) });
  }
  const missingCredentials = [...referenced].filter((n) => !env[n] || env[n] === '');
  // Credentials resolved only from the runner's process.env (not the env file) let the
  // live request succeed, but the committed .sh artifact requires them in web/.env.local
  // (`${VAR:?... must be set in web/.env.local}`), so it would abort when re-run. Surface
  // them so the verdict isn't reported as cleanly reproducible when it isn't.
  const processEnvOnlyCredentials = [...referenced].filter(
    (n) => !envFileKeys.has(n) && typeof env[n] === 'string' && env[n] !== ''
  );

  // Always write the shell artifact (re-runnable) — references only, no values
  let shellArtifactPath = null;
  if (config.writeShellArtifact) {
    shellArtifactPath = config.writeShellArtifact;
    try {
      writeShellArtifact(
        shellArtifactPath,
        buildShellArtifact({
          baseUrl: config.baseUrl,
          method: config.method,
          pathSuffix: config.path,
          headers: config.headers,
          body: config.body,
          referenced,
        })
      );
    } catch (err) {
      process.stderr.write(
        `[run-smoke-test] Could not write shell artifact at ${shellArtifactPath}: ${err.message}\n`
      );
      shellArtifactPath = null;
    }
  }

  if (missingCredentials.length > 0) {
    emitResult({ result: 'credentials_missing', missingCredentials, shellArtifactPath });
    return;
  }

  const bodyExcerptLimit = Number.isFinite(config.bodyExcerptLimit) ? config.bodyExcerptLimit : 500;
  const reqResult = await doRequest({
    baseUrl: config.baseUrl,
    method: config.method || 'GET',
    pathSuffix: config.path || '',
    headers: resolvedHeaders,
    body: config.body || null,
    timeoutMs: Number.isFinite(config.timeoutMs) ? config.timeoutMs : 10000,
    bodyExcerptLimit,
  });
  const verdict = categorise(reqResult, config.reachabilityOnly === true);

  // Honour the security invariant: a reflective/echo endpoint can return the auth token or
  // cookie in its body or headers. Redact EVERY resolved credential value (regardless of
  // length) from anything we surface to stdout (and therefore to the committed logs) — the
  // no-leak invariant takes precedence over readability. Real tokens are long; a
  // pathologically short credential is over-redacted rather than leaked. Sort longest-first
  // so a short value that is a substring of a longer one doesn't pre-empt the more specific
  // replacement.
  const secretValues = [...new Set(
    [...referenced].map((n) => env[n]).filter((v) => typeof v === 'string' && v.length > 0)
  )].sort((a, b) => b.length - a.length);
  const redact = (text) => {
    if (typeof text !== 'string' || !text) return text;
    let out = text;
    for (const v of secretValues) out = out.split(v).join('***REDACTED***');
    return out;
  };

  const bodyExcerpt = reqResult.body ? redact(reqResult.body.slice(0, bodyExcerptLimit)) : null;
  const corsHeader = redact(
    (reqResult.responseHeaders && reqResult.responseHeaders['access-control-allow-origin']) || null
  );

  emitResult({
    result: verdict.result,
    category: verdict.category,
    httpStatus: reqResult.httpStatus ?? null,
    bodyExcerpt,
    bodyTruncated: reqResult.bodyTruncated ?? false,
    elapsedMs: reqResult.elapsedMs ?? 0,
    errorMessage: reqResult.ok ? null : redact(reqResult.errorMessage || null),
    shellArtifactPath,
    corsAccessControlAllowOrigin: corsHeader,
    processEnvOnlyCredentials,
  });
})().catch((e) => bail(`Unhandled: ${e.message}`));
