#!/usr/bin/env node
/**
 * Tests for security-validator.js
 *
 * The validator is a standalone CLI (no exports; it calls process.exit), so it
 * is tested black-box: each test builds a throwaway fixture project in a temp
 * directory, runs the validator against it as a child process, and asserts on
 * its output and exit code.
 *
 * No test framework or dependency is required — this uses Node's built-in
 * runner. Run on demand from the repo root:
 *
 *   node --test .github/scripts/
 *
 * or this file directly:
 *
 *   node --test .github/scripts/security-validator.test.js
 *
 * Fixtures cover the supported auth approaches (BFF / frontend-only / custom),
 * the "genuinely unprotected" case, the roles-model gate, and that the validator
 * behaves identically whether launched from the repo root or from web/ (the CI
 * working-directory).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const VALIDATOR = path.join(__dirname, 'security-validator.js');

// --- fixture helpers -------------------------------------------------------

/** Write a file (creating parent dirs) under a fixture root. */
function writeFile(root, relPath, content) {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

/** Write a project.md whose §Authentication records the chosen auth method. */
function writeProjectAuthMethod(root, authMethod, extraContext = {}) {
  const notes = extraContext.customAuthNotes || '';
  writeFile(
    root,
    'generated-docs/project.md',
    [
      '# Project',
      '',
      '## Authentication',
      '',
      '| Field | Value |',
      '|---|---|',
      '| Method | `' + authMethod + '` |',
      '| Custom auth notes (if custom) | ' + notes + ' |',
      '',
    ].join('\n'),
  );
}

/**
 * Create a fresh temp fixture dir, build it, and register cleanup on the test.
 * @returns {string} the fixture root
 */
function makeFixture(t, build) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secval-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  build(root);
  return root;
}

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Run the validator with the given working directory.
 * @returns {{ code: number, out: string }} exit code and ANSI-stripped stdout
 */
function runValidator(cwd) {
  try {
    const out = execFileSync('node', [VALIDATOR], { cwd, encoding: 'utf-8' });
    return { code: 0, out: out.replace(ANSI, '') };
  } catch (err) {
    // Non-zero exit (blocking finding) lands here; stdout is still on the error.
    return { code: err.status ?? 1, out: String(err.stdout || '').replace(ANSI, '') };
  }
}

/** Pull the PASSED/FAILED status for a named check out of the report. */
function statusOf(out, checkName) {
  const m = out.match(new RegExp(`${checkName.replace(/[()]/g, '\\$&')}: (PASSED|FAILED)`));
  return m ? m[1] : null;
}

// --- fixture builders ------------------------------------------------------

/**
 * Write the client <SessionGate> gate plus its authClient dependency: the gate
 * verifies the session via getUserInfo() (the /api/auth/userinfo proxy) and
 * redirects unauthenticated users to `redirectPath`. Shared by the client-gate
 * fixtures, which differ only in the redirect target and the layout that renders
 * the gate.
 */
function writeClientSessionGate(root, redirectPath = '/login') {
  writeFile(root, 'web/src/lib/auth/authClient.ts',
    `export async function getUserInfo(){ const r = await fetch('/api/auth/userinfo'); return r.ok ? { authenticated: true, user: await r.json() } : { authenticated: false }; }`);
  writeFile(root, 'web/src/components/auth/SessionGate.tsx',
    `'use client';\n` +
    `import { useEffect } from 'react';\n` +
    `import { useRouter } from 'next/navigation';\n` +
    `import { getUserInfo } from '@/lib/auth/authClient';\n` +
    `export function SessionGate({ children }) {\n` +
    `  const router = useRouter();\n` +
    `  useEffect(() => { void getUserInfo().then((r) => { if (!r.authenticated) router.replace('${redirectPath}'); }); }, []);\n` +
    `  return <>{children}</>;\n` +
    `}`);
}

function bffCorrect(root) {
  writeProjectAuthMethod(root, 'bff');
  writeFile(root, 'web/src/lib/auth/requireSession.ts',
    `import { cookies } from 'next/headers';\nexport async function requireSession() { return { username: 'x', displayName: 'X' }; }`);
  writeFile(root, 'web/src/lib/auth/bffClient.ts', `export async function bff(p){ return fetch(p); }`);
  writeFile(root, 'web/src/app/(authenticated)/layout.tsx',
    `import { requireSession } from '@/lib/auth/requireSession';\nexport default async function L({ children }) { await requireSession(); return <>{children}</>; }`);
  writeFile(root, 'web/src/app/(authenticated)/dashboard/page.tsx',
    `export default function Page() { return <div>Dashboard</div>; }`);
}

function nextAuthCorrect(root) {
  writeProjectAuthMethod(root, 'frontend-only');
  writeFile(root, 'web/src/lib/auth/auth.config.ts', `export const authConfig = {};`);
  writeFile(root, 'web/src/lib/auth/auth.ts', `import NextAuth from 'next-auth'; export const { auth } = NextAuth({});`);
  writeFile(root, 'web/src/lib/auth/auth-helpers.ts', `export async function requireAuth(){ return { user: {} }; }`);
  writeFile(root, 'web/src/app/(protected)/layout.tsx',
    `import { requireAuth } from '@/lib/auth/auth-helpers';\nexport default async function L({ children }) { await requireAuth(); return <>{children}</>; }`);
  writeFile(root, 'web/src/app/(protected)/page.tsx', `export default function Page() { return <div>Home</div>; }`);
}

function nextAuthMissingConfig(root) {
  writeProjectAuthMethod(root, 'frontend-only');
  writeFile(root, 'web/src/app/page.tsx', `export default function P(){ return <div/>; }`);
}

function customAuth(root) {
  writeProjectAuthMethod(root, 'custom', { customAuthNotes: 'bespoke header token scheme' });
  writeFile(root, 'web/src/lib/auth/customSession.ts', `export function check(){ return true; }`);
  writeFile(root, 'web/src/app/page.tsx', `export default function P(){ return <div/>; }`);
}

function bffUnprotected(root) {
  writeProjectAuthMethod(root, 'bff');
  // Gated route group exists, but its layout enforces NO session check.
  writeFile(root, 'web/src/app/(authenticated)/layout.tsx',
    `export default function L({ children }) { return <>{children}</>; }`);
  writeFile(root, 'web/src/app/(authenticated)/dashboard/page.tsx',
    `export default function Page() { return <div>Dashboard</div>; }`);
}

function bffNoRolesModel(root) {
  bffCorrect(root);
  // A page using admin/dashboard words but with no roles model defined.
  writeFile(root, 'web/src/app/(authenticated)/admin/page.tsx',
    `export default function Page() { return <div>admin dashboard settings</div>; }`);
}

function nextAuthRolesViolation(root) {
  writeProjectAuthMethod(root, 'frontend-only');
  writeFile(root, 'web/src/types/roles.ts', `export enum UserRole { ADMIN = 'admin', USER = 'user' }`);
  writeFile(root, 'web/src/lib/auth/auth.config.ts', `export const authConfig = {};`);
  writeFile(root, 'web/src/app/(protected)/layout.tsx',
    `import { requireAuth } from '@/lib/auth/auth-helpers';\nexport default async function L({ children }) { await requireAuth(); return <>{children}</>; }`);
  // Page references UserRole.ADMIN content with no role check.
  writeFile(root, 'web/src/app/(protected)/admin/page.tsx',
    `import { UserRole } from '@/types/roles';\nexport default function Page() { const r = UserRole.ADMIN; return <div>{r}</div>; }`);
}

function emptyBffProject(root) {
  // PLAN-phase BFF project: auth chosen, nothing built yet.
  writeProjectAuthMethod(root, 'bff');
  writeFile(root, 'web/src/app/page.tsx', `export default function P(){ return <div/>; }`);
}

/**
 * BFF project that gates the route group with a CLIENT <SessionGate> component
 * (verifies via the /api/auth/userinfo proxy, redirects to /login on 401) instead
 * of a server-side requireSession() in the layout. A real gate — just enforced
 * client-side. Includes a public login page that reads the just-fetched user and a
 * roles/constants module mentioning "File Importer" / ROUTE_UPLOAD.
 */
function bffClientGate(root) {
  writeProjectAuthMethod(root, 'bff');
  writeFile(root, 'web/src/lib/auth/bffClient.ts', `export async function bff(p){ return fetch(p); }`);
  // Client gate component: verifies the session, redirects to /login on failure.
  writeClientSessionGate(root, '/login');
  // Layout delegates the gate to the client component — no inline session call.
  writeFile(root, 'web/src/app/(authenticated)/layout.tsx',
    `/** Gated by the client SessionGate; requireSession remains available for future server data. */\n` +
    `import { SessionGate } from '@/components/auth/SessionGate';\n` +
    `export default function AuthenticatedLayout({ children }) { return <SessionGate>{children}</SessionGate>; }`);
  // Placeholder page (no session usage) — protected purely by the layout gate.
  writeFile(root, 'web/src/app/(authenticated)/dashboard/page.tsx',
    `export default function Page() { return <div>Dashboard</div>; }`);
  // Client page that reads the shared user from context.
  writeFile(root, 'web/src/app/(authenticated)/profile/page.tsx',
    `'use client';\nimport { useSessionUser } from '@/components/auth/SessionContext';\nexport default function Page() { const user = useSessionUser(); return <div>{user.Email}</div>; }`);
  // Public login page that reads the just-fetched user to choose where to land.
  writeFile(root, 'web/src/app/login/page.tsx',
    `'use client';\n` +
    `import { getUserInfo } from '@/lib/auth/authClient';\n` +
    `export default function LoginPage() {\n` +
    `  async function go() { const session = await getUserInfo(); if (session.user) { /* redirect */ } }\n` +
    `  return <button onClick={go}>Sign in</button>;\n` +
    `}`);
  // Roles/constants module — "File Importer" label + a /upload route constant.
  writeFile(root, 'web/src/lib/auth/roles.ts',
    `/** File Importer → /dashboard; the (\`@/lib/auth/roles\`): File Importer route map. */\n` +
    `export const ROLE_FILE_IMPORTER = 'File Importer';\n` +
    `export const ROUTE_UPLOAD = '/upload';\n` +
    `const MAP = { [ROLE_FILE_IMPORTER]: [ROUTE_UPLOAD] };\n` +
    `export function routeCount() { const routes = new Set(Object.values(MAP).flat()); return routes.size; }`);
}

/**
 * BFF project whose route-group layout renders a component that does NOT verify a
 * session or redirect — a plain shell. The gate must NOT be recognised, so the
 * unprotected route group is still reported (proves the gate-component check has
 * teeth and isn't a rubber stamp for any rendered component).
 */
function bffFakeGate(root) {
  writeProjectAuthMethod(root, 'bff');
  writeFile(root, 'web/src/components/Shell.tsx',
    `export function Shell({ children }) { return <div className="shell">{children}</div>; }`);
  writeFile(root, 'web/src/app/(authenticated)/layout.tsx',
    `import { Shell } from '@/components/Shell';\nexport default function L({ children }) { return <Shell>{children}</Shell>; }`);
  writeFile(root, 'web/src/app/(authenticated)/dashboard/page.tsx',
    `export default function Page() { return <div>Dashboard</div>; }`);
}

/**
 * Client <SessionGate> layout written in Prettier `semi:false` style: the import
 * lines carry NO trailing semicolons and the gate component is imported BEFORE
 * another component. A greedy import-specifier scan would resolve <SessionGate>
 * to the LATER module ('@/components/Footer') and miss the gate; the resolver
 * must anchor on the first match.
 */
function bffClientGateNoSemicolons(root) {
  writeProjectAuthMethod(root, 'bff');
  writeClientSessionGate(root, '/login');
  writeFile(root, 'web/src/components/Footer.tsx',
    `export function Footer(){ return <footer/>; }`);
  // No semicolons anywhere -> a greedy `[^;]*` would run past the first import.
  writeFile(root, 'web/src/app/(authenticated)/layout.tsx',
    `import { SessionGate } from '@/components/auth/SessionGate'\n` +
    `import { Footer } from '@/components/Footer'\n` +
    `export default function L({ children }) { return <SessionGate>{children}<Footer/></SessionGate> }`);
  writeFile(root, 'web/src/app/(authenticated)/dashboard/page.tsx',
    `export default function Page() { return <div>Dashboard</div>; }`);
}

/**
 * BFF route-group layout whose only `requireSession()` is COMMENTED OUT — the
 * layout never actually calls it, so the route group is genuinely unprotected.
 * The gate detector must scan comment-stripped source so the commented call is
 * not mistaken for a real gate.
 */
function bffCommentedGate(root) {
  writeProjectAuthMethod(root, 'bff');
  writeFile(root, 'web/src/lib/auth/requireSession.ts',
    `export async function requireSession() { return { username: 'x' }; }`);
  writeFile(root, 'web/src/app/(authenticated)/layout.tsx',
    `import { requireSession } from '@/lib/auth/requireSession';\n` +
    `export default function L({ children }) {\n` +
    `  // TODO: await requireSession();\n` +
    `  return <>{children}</>;\n` +
    `}`);
  writeFile(root, 'web/src/app/(authenticated)/dashboard/page.tsx',
    `export default function Page() { return <div>Dashboard</div>; }`);
}

/**
 * Client <SessionGate> that redirects unauthenticated users to a NESTED sign-in
 * route ('/auth/signin') rather than a root '/login'. A real gate — the detector
 * must accept a sign-in path at any depth.
 */
function bffClientGateNestedRedirect(root) {
  writeProjectAuthMethod(root, 'bff');
  writeClientSessionGate(root, '/auth/signin');
  writeFile(root, 'web/src/app/(authenticated)/layout.tsx',
    `import { SessionGate } from '@/components/auth/SessionGate';\n` +
    `export default function L({ children }) { return <SessionGate>{children}</SessionGate>; }`);
  writeFile(root, 'web/src/app/(authenticated)/dashboard/page.tsx',
    `export default function Page() { return <div>Dashboard</div>; }`);
}

/**
 * A BFF project whose only "form-shaped" client components are NOT data entry:
 *  - a pagination control: a native <select> with fixed 5/10/20/50 options bound to
 *    local state (no user-entered data, no submission, no backend), and
 *  - the vendored Shadcn <Select> primitive in components/ui/.
 * Neither is a security concern. Client-side validation is bypassable UX, not a
 * control — the real boundary is server-side API-route validation. This fixture
 * guards against re-introducing the old over-broad "client form missing validation"
 * heuristic, which flagged both of these (a blocking false positive).
 */
function clientConstrainedControls(root) {
  emptyBffProject(root);
  // Pagination: fixed-option <select> wired to local state — nothing to validate.
  writeFile(root, 'web/src/components/shared/Table.tsx',
    `'use client';\n` +
    `import { useState } from 'react';\n` +
    `const ROWS_PER_PAGE_OPTIONS = [5, 10, 20, 50];\n` +
    `export function Table() {\n` +
    `  const [rowsPerPage, setRowsPerPage] = useState(20);\n` +
    `  return (\n` +
    `    <select value={String(rowsPerPage)} onChange={(e) => setRowsPerPage(Number(e.target.value))}>\n` +
    `      {ROWS_PER_PAGE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}\n` +
    `    </select>\n` +
    `  );\n` +
    `}`);
  // The Shadcn Select UI primitive itself.
  writeFile(root, 'web/src/components/ui/select.tsx',
    `'use client';\n` +
    `import * as SelectPrimitive from '@radix-ui/react-select';\n` +
    `export const Select = SelectPrimitive.Root;\n` +
    `export const SelectTrigger = SelectPrimitive.Trigger;`);
}

/** A raw-SQL string built by concatenation, in a frontend with no DB driver. */
const RAW_SQL_LIB =
  `export function lookup(id) {\n` +
  `  const sql = "SELECT * FROM users WHERE id = " + id;\n` +
  `  return sql;\n` +
  `}`;

/**
 * A frontend (no SQL driver in package.json) containing raw-SQL-looking code. The
 * SQL-injection checks must SKIP here — there is no SQL surface, and the patterns
 * would only false-positive (a variable named `query`, `.get(a + b)`, a template
 * string with "from"/"where").
 */
function sqlLookAlikeNoDriver(root) {
  writeProjectAuthMethod(root, 'custom');
  writeFile(root, 'web/src/lib/db.ts', RAW_SQL_LIB);
}

/** Same raw SQL, but the project declares a real SQL driver — the check runs. */
function sqlWithDriver(root) {
  writeProjectAuthMethod(root, 'custom');
  writeFile(root, 'web/package.json',
    JSON.stringify({ name: 'web', dependencies: { '@prisma/client': '^5.0.0' } }, null, 2));
  writeFile(root, 'web/src/lib/db.ts', RAW_SQL_LIB);
}

// roles.ts with one member per line — getValidRoles()'s enum parser is line-anchored.
const ROLES_TS = `export enum UserRole {\n  ADMIN = 'admin',\n  USER = 'user',\n}`;

/** A roles model exists, but `role` is used in non-RBAC ways (a UI prop, a data field). */
function roleLiteralNonAuth(root) {
  writeProjectAuthMethod(root, 'custom');
  writeFile(root, 'web/src/types/roles.ts', ROLES_TS);
  writeFile(root, 'web/src/components/Widget.tsx',
    `'use client';\n` +
    `export function Widget() {\n` +
    `  const opts = { role: 'manager' };\n` +
    `  return <button role="primary">{opts.role}</button>;\n` +
    `}`);
}

/** A genuinely invalid role passed to an RBAC helper — the kept leg must still flag it. */
function invalidRoleInCall(root) {
  writeProjectAuthMethod(root, 'custom');
  writeFile(root, 'web/src/types/roles.ts', ROLES_TS);
  writeFile(root, 'web/src/lib/guard.ts',
    `import { requireRole } from '@/lib/auth/auth-helpers';\n` +
    `export function guard() { return requireRole('superuser'); }`);
}

/** Write an unguarded API route (a GET with no auth guard) at `relPath`. */
function writeUnguardedApiRoute(root, relPath = 'web/src/app/api/users/route.ts') {
  writeFile(root, relPath, `export async function GET() { return Response.json([]); }`);
}

/**
 * Write a session-enforcing middleware (verifies the session, redirects to /login
 * when absent). `matcherLine` is appended verbatim when given (e.g. an
 * `export const config = { matcher: [...] };` line); omit it for a no-matcher
 * middleware that Next.js runs on every request.
 */
function writeGatingMiddleware(root, matcherLine = '') {
  writeFile(root, 'web/src/middleware.ts',
    `import { NextResponse } from 'next/server';\n` +
    `import { getServerSession } from '@/lib/auth';\n` +
    `export async function middleware(req) {\n` +
    `  const session = await getServerSession();\n` +
    `  if (!session) return NextResponse.redirect(new URL('/login', req.url));\n` +
    `  return NextResponse.next();\n` +
    `}` + (matcherLine ? `\n${matcherLine}` : ''));
}

/** An unguarded API route, with a session-enforcing middleware that has no matcher. */
function apiRouteGatedByMiddleware(root) {
  writeProjectAuthMethod(root, 'custom');
  writeUnguardedApiRoute(root);
  writeGatingMiddleware(root);
}

/** Same unguarded API route, but the middleware does NOT gate — route stays flagged. */
function apiRouteUngatedMiddleware(root) {
  writeProjectAuthMethod(root, 'custom');
  writeUnguardedApiRoute(root);
  writeFile(root, 'web/src/middleware.ts',
    `import { NextResponse } from 'next/server';\n` +
    `export function middleware() { return NextResponse.next(); }`);
}

/** A search-param value interpolated into an href (was flagged by the removed check). */
function hrefSearchParam(root) {
  writeProjectAuthMethod(root, 'custom');
  writeFile(root, 'web/src/app/search/page.tsx',
    `'use client';\n` +
    `export default function Page({ searchParams }) {\n` +
    `  return <a href={\`/go?q=\${searchParams.query}\`}>go</a>;\n` +
    `}`);
}

/** A real, unsanitized innerHTML assignment — the genuine XSS sink must still flag. */
function innerHtmlSink(root) {
  writeProjectAuthMethod(root, 'custom');
  writeFile(root, 'web/src/components/Danger.tsx',
    `'use client';\n` +
    `export function Danger({ html }) {\n` +
    `  const el = document.getElementById('x');\n` +
    `  if (el) el.innerHTML = html;\n` +
    `  return null;\n` +
    `}`);
}

/**
 * A client-gated BFF app shaped like the benchmark: the gate is a root-layout
 * <AuthProvider> that probes the session via the generated authUserInfo() client
 * and redirects to /login on failure, and the authenticated pages live under a
 * non-standard (app) group whose own layout is just a shell. The gate must be
 * recognised via the layout chain, regardless of the group name or the probe's
 * exact function name.
 */
function rootProviderGatesAppGroup(root) {
  writeProjectAuthMethod(root, 'bff');
  writeFile(root, 'web/src/contexts/AuthContext.tsx',
    `'use client';\n` +
    `import { useRouter } from 'next/navigation';\n` +
    `import { authUserInfo } from '@/lib/api/client';\n` +
    `export function AuthProvider({ children }) {\n` +
    `  const router = useRouter();\n` +
    `  authUserInfo().then(() => {}).catch(() => router.replace('/login'));\n` +
    `  return <>{children}</>;\n` +
    `}`);
  writeFile(root, 'web/src/app/layout.tsx',
    `import { AuthProvider } from '@/contexts/AuthContext';\n` +
    `export default function RootLayout({ children }) {\n` +
    `  return <html><body><AuthProvider>{children}</AuthProvider></body></html>;\n` +
    `}`);
  writeFile(root, 'web/src/app/(app)/layout.tsx',
    `'use client';\n` +
    `import { useAuth } from '@/contexts/AuthContext';\n` +
    `export default function AppShell({ children }) {\n` +
    `  const { status } = useAuth();\n` +
    `  if (status !== 'authenticated') return null;\n` +
    `  return <div>{children}</div>;\n` +
    `}`);
  writeFile(root, 'web/src/app/(app)/page.tsx', `export default function Page() { return <div>Home</div>; }`);
}

/**
 * Same shape, but the provider probes authUserInfo() and NEVER redirects — it's not
 * a real gate. A conventional (authenticated) group with no gate anywhere in its
 * chain must still fail: the userinfo-probe leg alone (without the sign-in redirect)
 * must not be accepted as a gate.
 */
function authProviderNoRedirect(root) {
  writeProjectAuthMethod(root, 'bff');
  writeFile(root, 'web/src/contexts/AuthContext.tsx',
    `'use client';\n` +
    `import { authUserInfo } from '@/lib/api/client';\n` +
    `export function AuthProvider({ children }) {\n` +
    `  authUserInfo().then(() => {}).catch(() => {});\n` +
    `  return <>{children}</>;\n` +
    `}`);
  writeFile(root, 'web/src/app/layout.tsx',
    `import { AuthProvider } from '@/contexts/AuthContext';\n` +
    `export default function RootLayout({ children }) { return <html><body><AuthProvider>{children}</AuthProvider></body></html>; }`);
  writeFile(root, 'web/src/app/(authenticated)/layout.tsx',
    `export default function L({ children }) { return <>{children}</>; }`);
  writeFile(root, 'web/src/app/(authenticated)/dashboard/page.tsx',
    `export default function Page() { return <div>Dashboard</div>; }`);
}

/** A logout route handler: no session guard, no request body — exempt from both. */
function authApiRouteNoGuard(root) {
  writeProjectAuthMethod(root, 'custom');
  writeFile(root, 'web/src/app/api/auth/logout/route.ts',
    `import { cookies } from 'next/headers';\n` +
    `export async function POST() {\n` +
    `  const store = await cookies();\n` +
    `  store.set('session', '', { maxAge: 0 });\n` +
    `  return Response.json({ ok: true });\n` +
    `}`);
}

/** A non-auth API route with no guard — the exemption is scoped, so this still fails. */
function nonAuthApiRouteNoGuard(root) {
  writeProjectAuthMethod(root, 'custom');
  writeFile(root, 'web/src/app/api/transactions/route.ts',
    `export async function GET() { return Response.json([]); }`);
}

/** A login route reads a credential body, so it must still validate input. */
function loginRouteNoValidation(root) {
  writeProjectAuthMethod(root, 'custom');
  writeFile(root, 'web/src/app/api/auth/login/route.ts',
    `export async function POST(request) {\n` +
    `  const body = await request.json();\n` +
    `  return Response.json({ ok: Boolean(body) });\n` +
    `}`);
}

/**
 * A non-auth route nested under app/api whose leaf folder happens to be named
 * `session` (e.g. a billing checkout-session endpoint). The auth-route exemption is
 * scoped to DIRECT children of /api, so this unguarded route must still be flagged —
 * an auth-ish word deep in the path must not exempt it.
 */
function nestedAuthWordRouteNoGuard(root) {
  writeProjectAuthMethod(root, 'custom');
  writeFile(root, 'web/src/app/api/billing/session/route.ts',
    `export async function GET() { return Response.json({ secret: 1 }); }`);
}

/**
 * A middleware that READS the session but never acts on it (always returns
 * NextResponse.next()). It gates nothing, so an unguarded /api route must still be
 * flagged — a no-op middleware must not be mistaken for an edge gate.
 */
function middlewareReadsButDoesntAct(root) {
  writeProjectAuthMethod(root, 'custom');
  writeUnguardedApiRoute(root);
  writeFile(root, 'web/src/middleware.ts',
    `import { NextResponse } from 'next/server';\n` +
    `import { getServerSession } from '@/lib/auth';\n` +
    `export async function middleware() { const s = await getServerSession(); return NextResponse.next(); }`);
}

/** A real gating middleware whose matcher is an /api catch-all — covers every /api route. */
function middlewareGatesWithApiMatcher(root) {
  writeProjectAuthMethod(root, 'custom');
  writeUnguardedApiRoute(root);
  writeGatingMiddleware(root, `export const config = { matcher: ['/((?!_next).*)', '/api/:path*'] };`);
}

/**
 * A real gating middleware whose matcher EXCLUDES /api and re-adds only /api/admin.
 * /api/users is therefore NOT covered and must still be flagged — a subset re-add
 * must not be read as blanket /api coverage.
 */
function middlewareExcludesApiMatcher(root) {
  writeProjectAuthMethod(root, 'custom');
  writeUnguardedApiRoute(root);
  writeGatingMiddleware(root, `export const config = { matcher: ['/((?!api|_next).*)', '/api/admin/:path*'] };`);
}

// --- tests -----------------------------------------------------------------

describe('BFF — recognises the chosen approach', () => {
  test('a correct BFF project passes with no auth or access-control findings', (t) => {
    const root = makeFixture(t, bffCorrect);
    const { out } = runValidator(root);
    assert.match(out, /BFF authentication integration recognised/);
    assert.equal(statusOf(out, 'Authentication checks'), 'PASSED');
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'PASSED');
    assert.doesNotMatch(out, /Authentication configuration not found/);
  });
});

describe('Frontend-only (next-auth) — unchanged behaviour', () => {
  test('a correct next-auth project passes and is recognised', (t) => {
    const root = makeFixture(t, nextAuthCorrect);
    const { out } = runValidator(root);
    assert.equal(statusOf(out, 'Authentication checks'), 'PASSED');
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'PASSED');
    assert.match(out, /next-auth\) configuration recognised/);
  });

  test('a next-auth project missing its config is still flagged (as before)', (t) => {
    const root = makeFixture(t, nextAuthMissingConfig);
    const { out } = runValidator(root);
    assert.equal(statusOf(out, 'Authentication checks'), 'FAILED');
    assert.match(out, /Authentication configuration not found/);
  });
});

describe('Custom — not forced into the next-auth shape', () => {
  test('a custom-auth project is not flagged for missing NextAuth files', (t) => {
    const root = makeFixture(t, customAuth);
    const { out } = runValidator(root);
    assert.equal(statusOf(out, 'Authentication checks'), 'PASSED');
    assert.match(out, /Custom authentication selected/);
    assert.doesNotMatch(out, /Authentication configuration not found/);
  });
});

describe('A correctly-built / not-yet-built project produces no false findings', () => {
  test('an empty PLAN-phase BFF project does not get a false auth finding', (t) => {
    const root = makeFixture(t, emptyBffProject);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Authentication checks'), 'PASSED');
    assert.doesNotMatch(out, /Authentication configuration not found/);
    assert.equal(code, 0);
  });
});

describe('A genuinely unprotected gated area is still reported', () => {
  test('an (authenticated) layout with no session check fails RBAC', (t) => {
    const root = makeFixture(t, bffUnprotected);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'FAILED');
    assert.match(out, /Protected route group layout missing authentication check/);
    assert.equal(code, 1, 'a blocking RBAC finding should exit non-zero');
  });
});

describe('Role-specific content is no longer guessed from keywords', () => {
  test('a project with no roles model produces no role/RBAC findings', (t) => {
    const root = makeFixture(t, bffNoRolesModel);
    const { out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'PASSED');
    assert.doesNotMatch(out, /role-specific content/);
    assert.doesNotMatch(out, /Invalid role/);
  });

  // The old heuristic flagged any gated page whose text contained UserRole.ADMIN
  // or "admin" + "dashboard"/"settings" and lacked a role call. The page is already
  // auth-gated by its layout, and whether it's role-restricted is a brief/test
  // decision — so a keyword scan can't verify it and the check was removed.
  test('a layout-gated page referencing admin content is not flagged for a missing role check', (t) => {
    const root = makeFixture(t, nextAuthRolesViolation);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'PASSED');
    assert.doesNotMatch(out, /role-specific content/);
    assert.equal(code, 0);
  });
});

describe('BFF — client <SessionGate> layout is recognised as a real gate', () => {
  test('a client-gated BFF project passes with no access-control findings', (t) => {
    const root = makeFixture(t, bffClientGate);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'PASSED');
    assert.doesNotMatch(out, /missing session validation/);
    assert.doesNotMatch(out, /Protected route group layout missing authentication check/);
    assert.equal(code, 0);
  });

  test('a public login page that reads the fetched user is not flagged', (t) => {
    const root = makeFixture(t, bffClientGate);
    const { out } = runValidator(root);
    assert.doesNotMatch(out, /uses session data but is not in a protected route group/);
  });
});

describe('A non-gating layout component is still reported (gate check has teeth)', () => {
  test('a layout rendering a plain shell (no verify/redirect) fails RBAC', (t) => {
    const root = makeFixture(t, bffFakeGate);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'FAILED');
    assert.match(out, /Protected route group layout missing authentication check/);
    assert.equal(code, 1, 'a fake gate must not satisfy the session-gate check');
  });
});

describe('Gate detection is robust to import style, comments, and nested sign-in paths', () => {
  test('a delegated <SessionGate> is resolved even with semicolon-free imports', (t) => {
    const root = makeFixture(t, bffClientGateNoSemicolons);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'PASSED');
    assert.doesNotMatch(out, /Protected route group layout missing authentication check/);
    assert.equal(code, 0);
  });

  test('a commented-out requireSession() does not count as a real gate', (t) => {
    const root = makeFixture(t, bffCommentedGate);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'FAILED');
    assert.match(out, /Protected route group layout missing authentication check/);
    assert.equal(code, 1, 'a commented-out gate call must not satisfy the check');
  });

  test('a client gate redirecting to a nested /auth/signin route is recognised', (t) => {
    const root = makeFixture(t, bffClientGateNestedRedirect);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'PASSED');
    assert.doesNotMatch(out, /Protected route group layout missing authentication check/);
    assert.equal(code, 0);
  });
});

describe('Client-side form validation is not a security finding', () => {
  test('a constrained <select> and the Shadcn Select primitive are not flagged', (t) => {
    const root = makeFixture(t, clientConstrainedControls);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Input validation'), 'PASSED');
    assert.doesNotMatch(out, /Client form component missing input validation/);
    assert.equal(code, 0, 'a pagination select / UI primitive must not block the merge');
  });
});

describe('SQL injection checks run only when the project has a SQL driver', () => {
  test('raw-SQL-looking frontend code is skipped when no DB driver is present', (t) => {
    const root = makeFixture(t, sqlLookAlikeNoDriver);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'SQL injection prevention'), 'PASSED');
    assert.match(out, /Skipping SQL Injection check \(no SQL database driver/);
    assert.equal(code, 0);
  });

  test('the same raw SQL still fails when a SQL driver is a dependency', (t) => {
    const root = makeFixture(t, sqlWithDriver);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'SQL injection prevention'), 'FAILED');
    assert.equal(code, 1, 'a real SQL injection finding should block');
  });
});

describe('Role references: only RBAC call sites are validated', () => {
  test('a non-RBAC `role` prop / data field is not flagged', (t) => {
    const root = makeFixture(t, roleLiteralNonAuth);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'PASSED');
    assert.doesNotMatch(out, /Invalid role string literal/);
    assert.equal(code, 0);
  });

  test('an invalid role passed to requireRole() is still flagged', (t) => {
    const root = makeFixture(t, invalidRoleInCall);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'FAILED');
    assert.match(out, /Invalid role in function call/);
    assert.equal(code, 1);
  });
});

describe('API-route auth: a session-enforcing middleware covers /api', () => {
  test('an unguarded route is not flagged when a gating middleware (no matcher) exists', (t) => {
    const root = makeFixture(t, apiRouteGatedByMiddleware);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'PASSED');
    assert.match(out, /gated by session-enforcing middleware/);
    assert.equal(code, 0);
  });

  test('a non-gating middleware does NOT rescue an unguarded route', (t) => {
    const root = makeFixture(t, apiRouteUngatedMiddleware);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'FAILED');
    assert.match(out, /API route missing authorization check/);
    assert.equal(code, 1, 'a plain passthrough middleware must not satisfy the guard');
  });

  test('a middleware that reads the session but never acts on it does NOT cover /api', (t) => {
    const root = makeFixture(t, middlewareReadsButDoesntAct);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'FAILED');
    assert.match(out, /API route missing authorization check/);
    assert.doesNotMatch(out, /gated by session-enforcing middleware/);
    assert.equal(code, 1, 'reading the session without redirecting/blocking gates nothing');
  });

  test('a gating middleware with an /api catch-all matcher covers the route', (t) => {
    const root = makeFixture(t, middlewareGatesWithApiMatcher);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'PASSED');
    assert.match(out, /gated by session-enforcing middleware/);
    assert.equal(code, 0);
  });

  test('a matcher that excludes /api and re-adds only a subpath does NOT cover the route', (t) => {
    const root = makeFixture(t, middlewareExcludesApiMatcher);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'FAILED');
    assert.match(out, /API route missing authorization check/);
    assert.equal(code, 1, 'a /api/admin re-add must not be read as blanket /api coverage');
  });
});

describe('XSS: bypassable href heuristic dropped, real sinks kept', () => {
  test('a search-param value in an href is not flagged', (t) => {
    const root = makeFixture(t, hrefSearchParam);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'XSS protection'), 'PASSED');
    assert.doesNotMatch(out, /href without encoding/);
    assert.equal(code, 0);
  });

  test('an unsanitized innerHTML assignment still fails', (t) => {
    const root = makeFixture(t, innerHtmlSink);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'XSS protection'), 'FAILED');
    assert.match(out, /innerHTML assignment without sanitization/);
    assert.equal(code, 1);
  });
});

describe('Gated-area detection is structural, not name-based', () => {
  test('a root-layout AuthProvider gate is recognised for a non-standard (app) group', (t) => {
    const root = makeFixture(t, rootProviderGatesAppGroup);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'PASSED');
    assert.match(out, /Gated route group found via its layout chain/);
    assert.doesNotMatch(out, /missing authentication check/);
    assert.equal(code, 0);
  });

  test('a userinfo probe WITHOUT a sign-in redirect is not accepted as a gate', (t) => {
    const root = makeFixture(t, authProviderNoRedirect);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'FAILED');
    assert.match(out, /Protected route group layout missing authentication check/);
    assert.equal(code, 1, 'a probe with no redirect must not satisfy the gate');
  });
});

describe('Auth endpoints are exempt from guards they do not need', () => {
  test('a logout route needs neither an auth guard nor a request-body schema', (t) => {
    const root = makeFixture(t, authApiRouteNoGuard);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'PASSED');
    assert.equal(statusOf(out, 'Input validation'), 'PASSED');
    assert.doesNotMatch(out, /missing authorization check/);
    assert.doesNotMatch(out, /missing input validation/);
    assert.equal(code, 0);
  });

  test('a non-auth route still requires an authorization guard', (t) => {
    const root = makeFixture(t, nonAuthApiRouteNoGuard);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'FAILED');
    assert.match(out, /API route missing authorization check/);
    assert.equal(code, 1, 'the auth-route exemption must not cover ordinary API routes');
  });

  test('a nested route reusing an auth word (api/billing/session) is still guarded', (t) => {
    const root = makeFixture(t, nestedAuthWordRouteNoGuard);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'FAILED');
    assert.match(out, /API route missing authorization check/);
    assert.equal(code, 1, 'the exemption is scoped to direct /api children, not nested look-alikes');
  });

  test('a login route still requires input validation (it carries a body)', (t) => {
    const root = makeFixture(t, loginRouteNoValidation);
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Input validation'), 'FAILED');
    assert.match(out, /missing input validation/);
    assert.equal(code, 1, 'login/register bodies must still be validated');
  });
});

describe('Path resolution: identical outcome from repo root and from web/', () => {
  for (const [name, build] of [
    ['BFF correct', bffCorrect],
    ['unprotected (failing)', bffUnprotected],
  ]) {
    test(`${name} reports the same result in both working directories`, (t) => {
      const root = makeFixture(t, build);
      const fromRoot = runValidator(root);
      const fromWeb = runValidator(path.join(root, 'web'));
      assert.equal(
        statusOf(fromRoot.out, 'Authentication checks'),
        statusOf(fromWeb.out, 'Authentication checks'),
        'auth outcome should match',
      );
      assert.equal(
        statusOf(fromRoot.out, 'Access control (RBAC)'),
        statusOf(fromWeb.out, 'Access control (RBAC)'),
        'RBAC outcome should match',
      );
      assert.equal(fromRoot.code, fromWeb.code, 'exit code should match');
    });
  }
});

describe('Detection is data-flow aware, not substring-based', () => {
  test('RBAC: an `auth(` substring in a comment does NOT satisfy the guard', (t) => {
    const root = makeFixture(t, (r) => {
      writeProjectAuthMethod(r, 'custom');
      writeFile(r, 'web/src/app/api/widgets/route.ts',
        `// remember to call auth() upstream\n` +
        `export async function GET() { return Response.json({ secret: 1 }); }`);
    });
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'FAILED');
    assert.match(out, /API route missing authorization check/);
    assert.equal(code, 1);
  });

  test('RBAC: an `auth(` substring in a string literal does NOT satisfy the guard', (t) => {
    const root = makeFixture(t, (r) => {
      writeProjectAuthMethod(r, 'custom');
      writeFile(r, 'web/src/app/api/widgets/route.ts',
        `export async function GET() {\n` +
        `  const label = "auth(";\n` +
        `  return Response.json({ label });\n` +
        `}`);
    });
    const { code } = runValidator(root);
    assert.equal(code, 1, 'a string containing "auth(" must not pass RBAC');
  });

  test('RBAC: a route guarded by requireMinimumRole() PASSES (no false positive)', (t) => {
    const root = makeFixture(t, (r) => {
      writeProjectAuthMethod(r, 'custom');
      writeFile(r, 'web/src/app/api/admin/route.ts',
        `import { requireMinimumRole } from '@/lib/auth';\n` +
        `export async function GET(req) {\n` +
        `  await requireMinimumRole(req, 'ADMIN');\n` +
        `  return Response.json({ ok: true });\n` +
        `}`);
    });
    const { out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'PASSED');
  });

  test('RBAC: a top-level app/api/session route is NOT exempted as auth', (t) => {
    const root = makeFixture(t, (r) => {
      writeProjectAuthMethod(r, 'custom');
      writeFile(r, 'web/src/app/api/session/route.ts',
        `export async function GET() { return Response.json({ history: [] }); }`);
    });
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Access control (RBAC)'), 'FAILED');
    assert.match(out, /API route missing authorization check/);
    assert.equal(code, 1, 'a generic top-level /api/session is a business route, not an auth route');
  });

  test('RBAC: a top-level app/api/verify route is NOT exempted as auth', (t) => {
    const root = makeFixture(t, (r) => {
      writeProjectAuthMethod(r, 'custom');
      writeFile(r, 'web/src/app/api/verify/route.ts',
        `export async function GET() { return Response.json({ valid: true }); }`);
    });
    const { code } = runValidator(root);
    assert.equal(code, 1, 'a generic top-level /api/verify must still require a guard');
  });

  test('Input validation: a "schema" mention in a comment does NOT count as validation', (t) => {
    const root = makeFixture(t, (r) => {
      writeProjectAuthMethod(r, 'custom');
      writeFile(r, 'web/src/app/api/orders/route.ts',
        `export async function POST(request) {\n` +
        `  // no schema validation applied here\n` +
        `  const body = await request.json();\n` +
        `  return Response.json(body);\n` +
        `}`);
    });
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Input validation'), 'FAILED');
    assert.match(out, /missing input validation/);
    assert.equal(code, 1);
  });

  test('Input validation: a single-handler app/api/auth/route.ts credential endpoint is NOT exempt', (t) => {
    const root = makeFixture(t, (r) => {
      writeProjectAuthMethod(r, 'custom');
      writeFile(r, 'web/src/app/api/auth/route.ts',
        `export async function POST(request) {\n` +
        `  const { email, password } = await request.json();\n` +
        `  return Response.json({ ok: Boolean(email && password) });\n` +
        `}`);
    });
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'Input validation'), 'FAILED');
    assert.match(out, /missing input validation/);
    assert.equal(code, 1, 'the bare auth handler may carry credentials, so it must validate');
  });

  test('XSS: innerHTML assigned a value whose NAME contains "clean" is still flagged', (t) => {
    const root = makeFixture(t, (r) => {
      writeProjectAuthMethod(r, 'custom');
      writeFile(r, 'web/src/components/Danger.tsx',
        `'use client';\n` +
        `export function Danger({ uncleanValue }) {\n` +
        `  const el = document.getElementById('x');\n` +
        `  if (el) el.innerHTML = uncleanValue;\n` +
        `  return null;\n` +
        `}`);
    });
    const { code, out } = runValidator(root);
    assert.equal(statusOf(out, 'XSS protection'), 'FAILED');
    assert.match(out, /innerHTML assignment without sanitization/);
    assert.equal(code, 1);
  });

  test('XSS: dangerouslySetInnerHTML with escape() (a URL encoder) is flagged', (t) => {
    const root = makeFixture(t, (r) => {
      writeProjectAuthMethod(r, 'custom');
      writeFile(r, 'web/src/components/Risky.tsx',
        `export function Risky({ userHtml }) {\n` +
        `  return <div dangerouslySetInnerHTML={{ __html: escape(userHtml) }} />;\n` +
        `}`);
    });
    const { code } = runValidator(root);
    assert.equal(code, 1, 'escape() is not an HTML sanitizer, so the sink must still flag');
  });

  test('XSS: dangerouslySetInnerHTML with DOMPurify.sanitize() PASSES', (t) => {
    const root = makeFixture(t, (r) => {
      writeProjectAuthMethod(r, 'custom');
      writeFile(r, 'web/src/components/Safe.tsx',
        `import DOMPurify from 'dompurify';\n` +
        `export function Safe({ userHtml }) {\n` +
        `  return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(userHtml) }} />;\n` +
        `}`);
    });
    const { out } = runValidator(root);
    assert.equal(statusOf(out, 'XSS protection'), 'PASSED');
  });
});
