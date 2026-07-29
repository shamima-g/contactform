# Architecture & Reuse Registry — Contact & Enquiry Management

The shared surfaces every story builds on. Before adding a utility, component, or
type, check here and reuse rather than reimplement.

## Key architectural decision — simulated server

`project.md` §Data Source is **mock-only**: no backend, no OpenAPI spec, "all
server behaviour simulated client-side." Rather than the template's browser-MSW
path (which needs an OpenAPI spec to generate handlers and has a first-fetch
service-worker race that is fragile under the Playwright production build), the
simulated server is an **in-memory data layer behind a typed async API module**:

- UI components call the API module (`@/lib/api/*`) — never `fetch` directly and
  never the store directly. This keeps the single data-access boundary the
  "use the API client" rule protects.
- The API module delegates to an in-memory singleton store (`@/lib/data/store`),
  which owns all server-side logic (ownership scoping, filter/sort/paginate,
  status lifecycle). It is seeded on load and lives for the browser session.

## Shared utilities & components

| Surface | Path | Purpose |
|---|---|---|
| Domain types | `web/src/types/domain.ts` | `Role`, `Category`, `Status`, `Enquiry`, `User`, `SessionUser`, query/result types, `NEXT_STATUS` lifecycle map. |
| Identity factory | `web/src/mocks/data/identity.ts` | Seeded users, `userInfoFor(role)`, `findByCredentials()`. Shared by app + both test layers. |
| Enquiry factory | `web/src/mocks/data/enquiry.ts` | `createEnquiry(overrides)` + `seedEnquiries()`. Single source of enquiry shape/defaults. |
| In-memory store | `web/src/lib/data/store.ts` | The simulated server. `listOwn`, `listAll`, `create`, `advanceStatus`, `remove`, `__resetStore`. |
| Enquiry API | `web/src/lib/api/enquiries.ts` | Async boundary the UI calls; mocked in Vitest. |
| Auth API | `web/src/lib/api/auth.ts` | `signIn()` against seeded users; `AuthError`. |
| Validation | `web/src/lib/validation/enquiry.ts` | `enquiryFormSchema`, `replyNoteSchema` (Zod). |
| Access control | `web/src/lib/auth/access.ts` | `ROUTE_ACCESS`, `roleHome(role)`, `canAccess(role, path)`. |
| Session | `web/src/lib/auth/session.tsx` | `SessionProvider` + `useSession()` — client-side simulated session in localStorage. |
| App shell | `web/src/components/app-shell.tsx` | Header, role-aware nav, user badge, sign out. Wraps protected pages. |
| Route guard | `web/src/components/route-guard.tsx` | Redirect-if-signed-out, permission-denied-if-wrong-role, else render in shell. |
| Permission banner | `web/src/components/permission-denied.tsx` | On-page RBAC denial banner. |

## Conventions

- Styling uses Shadcn neutral tokens from `globals.css` — no hex literals in components.
- Protected pages are client components wrapped in `<RouteGuard allow={[...]}>`.
- Tests mock the API modules (`@/lib/api/enquiries`, `@/lib/api/auth`), not the store.
