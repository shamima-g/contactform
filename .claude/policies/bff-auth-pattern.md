# BFF Authentication Pattern

## Core Principle

When `project.md` §Authentication records `Method: bff`, the developer agent implements the **Next.js client-side integration** with a Backend For Frontend (BFF) — a separate backend service that holds the session cookie, talks to whatever identity provider the project uses, and exposes a small set of auth endpoints back to the frontend. The frontend never sees a token in JavaScript; the browser holds a single HttpOnly session cookie, and protected routes are gated server-side.

This policy is **applied inline during BUILD** by the `developer` agent (when implementing auth stories) and **verified at epic-end** by the `/code-review` pass over the epic diff (continue.md Step B7.0.5), which surfaces a client-reachable token or auth origin as a correctness/security finding.

This is the **encouraged path** because it is the most secure of the three auth options ([authentication-intake.md](./authentication-intake.md)). Tokens stay in HttpOnly cookies server-side; JavaScript can't read them, so XSS can't exfiltrate them. The client bundle ships no auth library. CSRF is handled by `SameSite=Strict` cookies. Auth/authz can be enforced uniformly across all API consumers by the backend.

---

## What "BFF" Means in This Repo

The starter template generates **only the Next.js client side** of the BFF integration. The BFF runtime itself (Node, .NET, Go, Linx, etc.) is a separate process at `BFF_BASE_URL`, owned by the project's backend team. This policy describes:

1. **The endpoint contract** the BFF must satisfy — so the frontend integration code can be written against a stable shape
2. **The security best-practices** that must hold inside the BFF — regardless of which runtime implements it
3. **The Next.js integration pattern** the developer agent writes when an auth story comes up

When the BFF is implemented in-house, the security rules below are the developer agent's responsibility to surface and enforce. When the BFF is implemented by another team, the policy doubles as the integration spec the frontend will hold them to.

---

## Endpoint Contract

All endpoints live under `/bff/auth/`. JSON bodies. Error envelope:

```json
{ "error": "STRING_CODE", "message": "human-readable" }
```

Error codes: `INVALID_REQUEST`, `INVALID_CREDENTIALS`, `SESSION_INVALID`, `INTERNAL_SERVER_ERROR`.

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/bff/auth/login` | none | `{ username, password }` | 200 `{ message }` + session cookie; 400 / 401 / 500 |
| POST | `/bff/auth/logout` | cookie | none | 200 `{ message }` + cookie clear |
| GET | `/bff/auth/userinfo` | cookie | none | 200 `{ username, displayName }`; 401 |
| GET | `/bff/health` | none | none | 200 |

**No refresh endpoint.** Sessions extend on access (sliding window) and are capped by an absolute lifetime.

The `/userinfo` response **must include both `username` and `displayName`** — a single field that conflates them is a bug seen in early reference implementations. The frontend may show `displayName` in UI and use `username` for identity.

---

## Cookie Defaults

```
Name:     session
Value:    opaque base64url (32 random bytes; stored hashed server-side)
HttpOnly; SameSite=Strict; Path=/; Secure
Max-Age:  idle TTL (default 30 min)
```

- `Secure` is **on by default**. In local development on plain HTTP, opt out via an explicit `BFF_INSECURE_COOKIE=1` env var. Never hardcode `Secure=false` in the cookie template — that silently breaks production HTTPS deployments if the value sticks.
- `Path=/` is required. A missing `Path` defaults to the request path and can cause subtle "logged in on /app but not on /api" bugs.
- The cookie name `session` is the contract value the Next.js integration expects. If the BFF picks a different name, it must be configurable on the Next.js side.

---

## Session Storage (server-side, inside the BFF)

Reference table shape:

```sql
session (
  id_hash         varchar(64) primary key,  -- SHA-256 of raw token
  user_id         int not null,
  created_at      timestamp not null,
  last_access_at  timestamp not null,
  expires_at      timestamp not null,       -- absolute cap
  ip_address      varchar(45),
  user_agent      varchar(512)
)
```

- **Tokens generated as 32 random bytes** (256 bits — well above the OWASP minimum of 128). 96-bit / 16-character tokens are too small.
- **Only the SHA-256 hash is stored.** A database compromise must not yield session takeover. Compare hash on lookup.
- **Idle expiry** via `last_access_at + idle_ttl`. Refresh `last_access_at` on each successful request.
- **Absolute expiry** via `expires_at` — capped regardless of activity. Default 12h. Prevents indefinite session extension through continued use.
- **Logout filters by `id_hash`, NOT by `user_id`.** Logging out one device must not kill the user's concurrent sessions on other devices.

---

## Mandatory Security Rules

These hold inside the BFF runtime. The developer agent surfaces them in code review / integration discussions when the BFF is built by another team.

1. **Password hashing:** bcrypt (cost ≥12) or argon2id, with a per-user salt. **Never SHA-512.** Never unsalted. The salt is per-user and stored alongside the hash.

2. **Constant-time hash compare** for both passwords and session tokens. `==` on a hash value leaks timing information. Use the runtime's `crypto.timingSafeEqual` (Node), `subtle.constantTimeCompare` (Web Crypto), or equivalent.

3. **Login rate limit:** token-bucket per IP + per username. Lockout after N failures in M minutes (sensible defaults: 5 failures / 15 min). Both axes — per-IP alone misses credential-stuffing from a botnet; per-username alone is bypassable by IP rotation.

4. **Server-error suppression:** stack traces and internal error messages **never** reach the client. The response is `{ error: "INTERNAL_SERVER_ERROR", message: "An error occurred" }`. Detailed errors go to the server log only.

5. **Audit log:** structured JSON lines for `auth.login.success`, `auth.login.failure`, `auth.logout`, `auth.session.invalid`. Include: timestamp, username (for failure cases too — for monitoring), IP, user-agent, session id hash (for success). Never include the raw token or password.

6. **HSTS header on all responses** in production. `Strict-Transport-Security: max-age=31536000; includeSubDomains`. Combined with an HTTP → HTTPS redirect at the edge.

7. **CSRF protection:** `SameSite=Strict` on the session cookie is acceptable for BFF deployments because the BFF and frontend share the same registrable domain. If the deployment topology requires cross-site cookies (BFF on a different eTLD+1 from the frontend), layer token-based CSRF on top — generate a CSRF token bound to the session, surface it to the frontend, require it on state-changing requests.

8. **Logout response handling on the frontend:** the client-side `handleLogout` **must branch on `res.ok`** before redirecting. A failed logout that redirects unconditionally looks identical to a successful one and leaves the cookie alive on the BFF.

9. **Cookie clear on logout** uses the **same attributes** as the original set (Name, Path, Domain, Secure, SameSite) plus `Max-Age=0`. A mismatch silently fails to clear the cookie. A common bug is clearing `key=` when the cookie was actually `session=`.

10. **Secrets never in source control.** Database passwords, JWT signing keys (if used internally by the BFF), OAuth client secrets — all live in environment variables. Reference samples that ship with literal secrets in committed config files are wrong; rotate any leaked secret and externalise it.

---

## Next.js Integration Pattern

Two shapes, by backend topology — and the choice matters (the wrong one ships a working-but-weaker app: cross-origin CORS and client-only gating). **Either way the browser only ever calls same-origin paths, and the `(authenticated)` layout is gated server-side.**

- **A single BFF you control** (reachable at `BFF_BASE_URL`) → the route-handler flow below: `bffClient.ts` fetches server-side and `requireSession()` gates the layout.
- **An existing backend, or more than one** (a backend team owns the API) → same-origin **rewrites** (next subsection), keeping the same invariant.

When implementing a BFF auth story, the developer agent produces approximately the structure below. Names and paths are the canonical shape; deviate only when the brief calls for it.

### Existing or multiple backends — same-origin rewrites

Map same-origin paths to the real origins in `next.config` so the browser never calls a backend cross-origin (no CORS, origins stay server-side):

```typescript
// web/next.config.ts — the browser only ever calls same-origin /v1/* paths.
const AUTH_API = process.env.AUTH_API_BASE_URL ?? 'http://localhost:10010';
const TX_API = process.env.TRANSACTIONS_API_BASE_URL ?? 'http://localhost:10005';

export default {
  async rewrites() {
    return [
      { source: '/v1/auth/:path*', destination: `${AUTH_API}/v1/auth/:path*` },
      { source: '/transactions-api/:path*', destination: `${TX_API}/:path*` },
    ];
  },
};
```

Gate the `(authenticated)` layout server-side either way — the `requireSession()` shape below, or a lighter `next/headers` cookie-presence redirect when you don't want a per-navigation `/userinfo` round-trip (client revalidation covers liveness).

**Anti-pattern:** backend base URLs as `NEXT_PUBLIC_*` fetched cross-origin from the browser, gated only by a client `<AuthProvider>` that redirects after render — it forces a CORS preflight on every call (which silently fails when the origin isn't allowed), ships gating to the client, and leaks origins into the bundle. Use a rewrite instead.

### Environment variables (`web/.env.example` + `web/.env.local`)

```
BFF_BASE_URL=http://localhost:5120
BFF_ALLOWED_ORIGINS=http://localhost:3000
BFF_SESSION_TTL_MINUTES=30
BFF_SESSION_ABSOLUTE_TTL_HOURS=12
# BFF_INSECURE_COOKIE=1   # local dev only; opt-out from Secure cookie
```

`BFF_BASE_URL` is server-side only — **not** prefixed with `NEXT_PUBLIC_`. The browser never talks directly to the BFF in the canonical pattern; it talks to Next.js route handlers that proxy through.

### `web/src/lib/auth/bffClient.ts`

```typescript
export async function bff(path: string, init: RequestInit = {}) {
  return fetch(`${process.env.BFF_BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}
```

Server-side fetch wrapper. Cookie forwarding is the **caller's** responsibility — pass an explicit `Cookie:` header from the incoming request (as `requireSession()` does below). `credentials: 'include'` is a browser-fetch concept and has no effect server-side; don't add it.

### `web/src/lib/auth/requireSession.ts`

```typescript
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { bff } from './bffClient';

export async function requireSession() {
  const cookieStore = await cookies();
  const session = cookieStore.get('session');
  if (!session) redirect('/login');

  const res = await bff('/bff/auth/userinfo', {
    headers: { Cookie: `session=${session.value}` },
  });
  if (!res.ok) redirect('/login');

  return res.json() as Promise<{ username: string; displayName: string }>;
}
```

Server-component helper. Used by protected route group layouts to gate access.

### Protected route group: `web/src/app/(authenticated)/layout.tsx`

```typescript
import { requireSession } from '@/lib/auth/requireSession';

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireSession();
  return <>{children}</>;
}
```

The route group's layout calls `requireSession()` and `redirect()`s on 401. Every page that lives under `(authenticated)/` is gated by this layout. There is **no client-side auth state**, no `<SessionProvider>`, no `useSession()` hook.

### Login form (server action)

```typescript
// web/src/app/login/page.tsx (Server Component with Server Action)
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { bff } from '@/lib/auth/bffClient';

export default function LoginPage() {
  async function login(formData: FormData) {
    'use server';
    const res = await bff('/bff/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: formData.get('username'),
        password: formData.get('password'),
      }),
    });
    if (!res.ok) {
      redirect('/login?error=invalid');
    }

    // Server actions don't auto-pipe Set-Cookie back to the browser.
    // Use getSetCookie() (returns array — get() would mangle multi-cookie
    // responses) and forward Max-Age so the BFF's sliding-window TTL holds.
    const COOKIE_NAME = 'session';
    const header = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE_NAME}=`));
    if (!header) {
      redirect('/login?error=invalid');
    }
    const value = header.split(';', 1)[0].slice(COOKIE_NAME.length + 1);
    const maxAge = header.match(/Max-Age=(\d+)/i)?.[1];
    const cookieStore = await cookies();
    cookieStore.set(COOKIE_NAME, value, {
      httpOnly: true,
      secure: process.env.BFF_INSECURE_COOKIE !== '1',
      sameSite: 'strict',
      path: '/',
      maxAge: maxAge ? parseInt(maxAge, 10) : undefined,
    });

    redirect('/');
  }
  return (
    <form action={login}>
      <input name="username" type="text" required />
      <input name="password" type="password" required />
      <button type="submit">Sign in</button>
    </form>
  );
}
```

The cookie-forwarding block is non-optional — `Set-Cookie` from a backend response isn't auto-piped to the browser by server actions. Change `COOKIE_NAME` if the BFF uses something other than `session`.

### Logout (route handler or server action)

```typescript
// web/src/app/logout/route.ts
import { cookies } from 'next/headers';
import { bff } from '@/lib/auth/bffClient';
import { redirect } from 'next/navigation';

export async function POST() {
  const cookieStore = await cookies();
  const session = cookieStore.get('session');
  if (session) {
    const res = await bff('/bff/auth/logout', {
      method: 'POST',
      headers: { Cookie: `session=${session.value}` },
    });
    if (!res.ok) {
      // Branch on res.ok per Rule 8 — don't redirect silently on failure
      return new Response(null, { status: 500 });
    }
  }
  // Clear with matching attributes per Rule 9 — cookies().delete() does NOT
  // preserve SameSite / Secure / Path, which silently fails to clear the cookie
  // when those attributes were set on the original.
  cookieStore.set('session', '', {
    httpOnly: true,
    secure: process.env.BFF_INSECURE_COOKIE !== '1',
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
  redirect('/login');
}
```

Branches on `res.ok` (Rule 8) — a 500 surfaces the failure rather than hiding it behind a redirect. Clears the cookie with explicit attributes matching the original `set` (Rule 9) — `cookies().delete('session')` would silently fail to clear a cookie that was set with `SameSite=Strict; Secure`.

---

## What This Policy Does Not Cover

- **SSO / OIDC integration.** A separate pattern (`bff-auth-sso`) lands after the without-SSO version is solid. Until then: when the brief calls for SSO, the developer agent surfaces the gap rather than improvising.
- **Token-based CSRF.** Default scaffold relies on `SameSite=Strict`. Projects needing token-based CSRF layer it on top per Rule 7.
- **Frontend-only (next-auth) and Custom auth paths.** Those follow next-auth's documentation or the brief's bespoke description, respectively. This file is BFF-specific.
- **User management / provisioning UI.** Sign-up, invite, password reset, account disable — separate concerns, scaffolded by stories per the brief.

---

## Rationale

The 10 mandatory rules above each correspond to a real bug seen in the wild — most of them in a single reference BFF sample reviewed before this policy was written. Concrete examples behind each rule:

| Rule | Real failure it prevents |
|---|---|
| 1 | Unsalted SHA-512 password hashes that look secure but are GPU-cracked in hours |
| 2 | `==` compare on session id leaking timing information to a network attacker |
| 3 | Credential-stuffing succeeding because no rate limit existed |
| 4 | Stack traces returned in 500 responses exposing internal paths and library versions |
| 5 | No audit trail to investigate "did this account actually log in last Tuesday?" |
| 6 | Production accidentally served over plain HTTP for hours, sessions cleartext on the wire |
| 7 | Cross-origin POST silently authenticating because no SameSite / CSRF guard |
| 8 | `handleLogout` redirecting on `fetch()` reject, leaving the BFF session alive |
| 9 | `Set-Cookie: key=; Max-Age=0` failing to clear `session=...` because of name mismatch |
| 10 | Database password committed to git, found by a public-repo scan service |

Codifying the rules in this policy means the developer agent applies them by default and the epic-end `/code-review` pass checks for them — without re-deriving the threat model on every project.
