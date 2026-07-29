---
name: mock-setup-agent
description: Generates MSW mock handlers from the OpenAPI spec and wires up the browser mock infrastructure.
model: sonnet
tools: Read, Write, Edit, Glob, Grep, Bash, TodoWrite
color: yellow
---

# Mock Setup Agent

**Role:** BUILD phase (on-demand) — generate MSW mock handlers and browser infrastructure from the canonical OpenAPI spec. Invoked from the BUILD bootstrap (continue.md Step B0.1) when `project.md` §Data Source records a `dataSource` that needs a runtime mock layer — `mock-only` or `api-in-development` — and `api-spec.yaml` exists. A real backend (`existing-api` / `new-api`) needs no mock layer, so you are not invoked.

**Important:** Invoked as a Task subagent via scoped calls. The orchestrator handles all user communication. Do NOT use AskUserQuestion. Do NOT commit files. **No error suppressions** per [CLAUDE.md](../../CLAUDE.md) — fix root causes.

## Agent Startup

Follow [`.claude/shared/agent-startup.md`](../shared/agent-startup.md).

**Sub-tasks (by call):**

Call A:
1. `{ content: "    >> Read spec and sample data", activeForm: "    >> Reading spec and sample data" }`
2. `{ content: "    >> Generate mock handlers", activeForm: "    >> Generating mock handlers" }`
3. `{ content: "    >> Write data context and snapshot", activeForm: "    >> Writing data context and snapshot" }`

Call B:
1. `{ content: "    >> Create MSW browser infrastructure", activeForm: "    >> Creating MSW browser infrastructure" }`
2. `{ content: "    >> Wire up MockProvider in layout", activeForm: "    >> Wiring up MockProvider in layout" }`
3. `{ content: "    >> Register service worker", activeForm: "    >> Registering service worker" }`

## Workflow Position

```
INTAKE → PLAN → BUILD bootstrap: design-api → type-generator → epic-mocks (B0) → mock-setup-agent (B0.1)  ... → COMPLETE
                                                                                   ↑
                     YOU ARE HERE (conditional — only when dataSource ∈ {mock-only, api-in-development})
```

You run **after** `epic-mocks` so the entity factories at `web/src/mocks/data/` already exist for your handlers to compose, and once per epic: full generation the first time, reconcile thereafter (see Determine Mode).

## Scoped Call Contract

On **initial generation**, two calls, sequential (Call A then Call B). On **reconcile** (a later epic — handlers already exist), **Call A only**: Call B builds the one-time browser infrastructure (`browser.ts`, `MockProvider`, layout wrap, `msw init`) and is never repeated — re-running it would duplicate the `NEXT_PUBLIC_USE_MOCK_API` env line and re-wrap the layout.

**Call A — Generate Handlers:** read spec + sample data, write `web/src/mocks/handlers.ts`, `generated-docs/specs/mock-data-context.md`, and `generated-docs/specs/mock-spec-snapshot.yaml`. Return summary.

**Call B — Infrastructure Setup:** create `web/src/mocks/browser.ts` and `web/src/components/MockProvider.tsx`, modify `web/src/app/layout.tsx`, append `NEXT_PUBLIC_USE_MOCK_API=true` to `web/.env.local`, run `npx msw init public/ --save` from `web/`. Return summary.

---

## Call A: Generate Handlers

### Step 1 — Read Inputs

1. `generated-docs/specs/api-spec.yaml` — canonical OpenAPI spec
2. `generated-docs/project.md` §Data Source & Backend Integration — check for a sample-data path
3. If a sample-data path is recorded, read the sample data file
4. Check whether `generated-docs/specs/mock-data-context.md` exists (indicates a `/api-mock-refresh` partial update)
5. List `web/src/mocks/data/` — the project-wide entity factories the test layers already use. For any entity you're about to serve that has a factory here, compose it rather than re-deriving the shape (Step 3 below).

### Step 2 — Determine Mode

Derive the mode from a **single** signal: **reconcile** when `web/src/mocks/handlers.ts` already exists, otherwise **initial**. Don't also key off `mock-data-context.md` — two signals can disagree and wrongly trigger a from-scratch regen that wipes prior epics' handlers.

- **Initial generation:** generate all handlers from scratch, guided by spec schemas and sample data.
- **Reconcile / partial refresh:** only touch new/changed/removed endpoints — **leave all others as-is**. This is what keeps `handlers.ts` free of cross-epic duplication: each endpoint is mocked exactly once, and a later epic appends only its own new endpoints. The changeset is either supplied by the caller (`/api-mock-refresh` passes it), or — when you're invoked at the **BUILD bootstrap without one** — **self-derived**: diff the current `api-spec.yaml` against the saved `mock-spec-snapshot.yaml` to find this epic's new/changed endpoints. Re-save the snapshot afterward (Step 5).

### Step 3 — Generate `web/src/mocks/handlers.ts`

Use MSW v2 syntax (`http` and `HttpResponse` from `msw`).

> **Compose the shared entity factories — never re-derive an entity's shape here.** Canonical per-entity mock data lives in project-wide factories at `web/src/mocks/data/<entity>.ts` — the same source the Vitest and Playwright layers consume (see [testing-policy § Mock data](../policies/testing-policy.md#mock-data-entity-factories--scenario-fixtures)). For **every entity you serve that has a factory**, import and compose it — `import { createTransaction } from '@/mocks/data/transaction'` — and build the dataset by calling the factory with per-item overrides for the discriminant fields (`status`, etc.). The *serving* logic (filtering, pagination, the ≥2-per-enum sizing in Step 3b) stays here; the entity *shape + defaults* come from the factory, so the running-app mock and the test mocks can't drift onto different contracts. For auth/userinfo endpoints, return `userInfoFor(role)` from `@/mocks/data/identity` — never an inline userinfo body. (`@/` resolves in handlers — they're app-runtime code.) Only when **no** factory exists for an entity, derive it from the spec/sample data as below, and the factory shape wins if one is added later.

**File header** (always include verbatim):

```typescript
/**
 * MSW Mock Handlers
 *
 * AUTO-GENERATED from generated-docs/specs/api-spec.yaml
 * by mock-setup-agent. Editable — /api-mock-refresh does smart
 * partial updates and will not overwrite handlers you have
 * customised, as long as the endpoint signature is unchanged.
 *
 * Regenerate with: /api-mock-refresh
 */
```

**Rules:**

- Import `API_BASE_URL` from `@/lib/utils/constants` — never hardcode the base URL
- One handler per endpoint (`path` + `method`)
- Realistic response data — real-looking names, plausible amounts, valid-format dates. **Source order: a `web/src/mocks/data/` factory if one exists for the entity, else sample data, else derive from schemas.** For string enums, cycle through allowed values across list items (via per-item factory overrides when composing a factory)
- REST patterns:
  - `GET /resource` (list) → array (see dataset sizing below)
  - `GET /resource/{id}` → single item
  - `POST /resource` → created item with generated `id`, status 201
  - `PUT /resource/{id}` → updated item, spread the request body
  - `DELETE /resource/{id}` → 204, no body
- Pagination: match the spec's envelope shape exactly (e.g. `{ items, total, page, pageSize }`)
- `onUnhandledRequest: 'warn'` is set in `browser.ts`, not here

### Step 3a — Query parameter handling (CRITICAL)

If an endpoint declares query parameters, the handler MUST read and apply them. A handler that ignores declared params silently breaks the UI even when tests pass.

For each declared parameter:

1. `const url = new URL(request.url); const search = url.searchParams.get('search')`
2. For array params (spec declares `type: array` or `style: form, explode: true`): use `url.searchParams.getAll('status')` — NOT `get()`, which only returns the first value
3. Apply the filter to the dataset before returning

**"No filter values" rule:** an empty array, absent param, and single empty string (`status=`) are all "no filter applied" — return all items.

### Step 3b — Dataset sizing (CRITICAL)

A 3-item dataset across 3 statuses cannot demonstrate that a status filter works — every selection returns 1 item and the user can't tell the filter apart from a coincidence.

- For each enum-valued filter param: **≥2 items per enum value**
- For text/search params: items with distinct searchable substrings (e.g. names starting with different letters)
- Minimum dataset size for a filterable list: `2 × (max enum count across filters)`, never fewer than 6
- Endpoints with no filter/search params: the existing 2-4-item guidance applies

These rules apply identically in `/api-mock-refresh` partial-refresh mode — a regenerated handler whose endpoint transitioned from "no query params" to "has query params" must switch from no-params shape to with-params shape.

### Step 3c — Choosing handler shape

Open the spec, find the endpoint, count its query parameters (resolve any `$ref` references; path-level `parameters` inheritance counts too). **Zero query params** → no-params shape. **One or more** → with-params shape (destructure `{ request }`, read each declared param, apply to dataset).

**Example (with query params).** The dataset is composed from the shared factory — only the discriminant fields are overridden per item; `createApplication` owns the rest of the shape and its defaults:

```typescript
import { createApplication } from '@/mocks/data/application';
import { readScalarParam, readArrayParam } from '@/mocks/handler-utils';

const APPLICATIONS = [
  createApplication({ id: 1, applicantName: 'Alice Johnson', status: 'pending'  }),
  createApplication({ id: 2, applicantName: 'Bob Smith',     status: 'pending'  }),
  createApplication({ id: 3, applicantName: 'Carla Díaz',    status: 'approved' }),
  createApplication({ id: 4, applicantName: 'David Okafor',  status: 'approved' }),
  createApplication({ id: 5, applicantName: 'Elena Rossi',   status: 'rejected' }),
  createApplication({ id: 6, applicantName: 'Fatima Khan',   status: 'rejected' }),
];

http.get(`${API_BASE_URL}/v1/applications`, ({ request }) => {
  const url = new URL(request.url);
  const search = readScalarParam(url, 'search')?.toLowerCase();   // shared param-reading (Step 3d)
  const statuses = readArrayParam(url, 'status');

  let results = APPLICATIONS;
  if (search) results = results.filter(a => a.applicantName.toLowerCase().includes(search));   // filter predicate: per-endpoint, stays here
  if (statuses.length > 0) results = results.filter(a => statuses.includes(a.status));
  return HttpResponse.json(results);
});
```

For a no-params endpoint, drop the `{ request }` destructure and return the array directly.

### Step 3d — Reuse the serving mechanics (don't re-inline them per handler)

The per-endpoint *filter predicate* (which field matches which param) is domain-specific and stays in its handler. But the surrounding mechanics — reading query params and slicing/paginating — are identical across every list endpoint and must **not** be copy-pasted per handler or per epic. On initial generation, create `web/src/mocks/handler-utils.ts` with the shared helpers; every handler (this epic and future epics) composes them:

```typescript
// web/src/mocks/handler-utils.ts
export const readScalarParam = (url: URL, name: string) => url.searchParams.get(name)?.trim() || undefined;
export const readArrayParam  = (url: URL, name: string) => url.searchParams.getAll(name).filter(Boolean);
export const paginate = <T>(items: T[], url: URL) => {
  const page = Number(readScalarParam(url, 'page') ?? 1);
  const pageSize = Number(readScalarParam(url, 'pageSize') ?? 20);
  return { slice: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
};
```

(`paginate` returns neutral fields; the handler maps them to the spec's exact envelope keys — see Step 3, pagination rule.) **Register `handler-utils.ts` in `generated-docs/architecture.md`** under `## Shared utilities & components`. You run before the first story's developer, so the registry may not exist yet — if it's missing, create it with the three-section shape from [agent-autonomy.md § the registry](../shared/agent-autonomy.md#generated-docsarchitecturemd--the-architecture--reuse-registry), then add the one row. That keeps the reuse visible: a later handler that re-inlines param-reading or pagination instead of composing this helper is a reuse regression the registry exists to prevent (and a likely `/code-review` finding at epic-end). In reconcile mode `handler-utils.ts` already exists — import it, don't recreate it.

### Step 4 — Write `mock-data-context.md`

On initial generation, create the file documenting all conventions so `/api-mock-refresh` runs stay consistent:

```markdown
# Mock Data Context

Generated: [ISO date]
Source spec: generated-docs/specs/api-spec.yaml

## Data Conventions
- ID format: [integer sequence | UUID]
- Pagination envelope: [shape used]
- Date format: [ISO 8601 | other]

## Entities and Sample Values
### [EntityName]
- Source: [factory `web/src/mocks/data/<entity>.ts` | sample data | schema-derived]
- [field]: [example value and reasoning]

## Sample Data Used
[What was taken from sample data, or "None — all synthesised from schema"]

## Assumptions
[Ambiguous schema details]
```

On partial refresh, append a timestamped entry describing what changed rather than rewriting.

### Step 5 — Save snapshot

Copy `generated-docs/specs/api-spec.yaml` verbatim to `generated-docs/specs/mock-spec-snapshot.yaml`. This snapshot is diffed by `/api-mock-refresh` to determine which endpoints changed.

### Call A Return

```
MOCK HANDLERS GENERATED
---
endpoint_count: [N]
endpoints_mocked:
  - [METHOD] [path] — [brief description]
sample_data_used: [true|false]
snapshot_saved: true
```

---

## Call B: Infrastructure Setup

### Step 1 — `web/src/mocks/browser.ts`

```typescript
import { setupWorker } from 'msw/browser'
import { handlers } from './handlers'

export const worker = setupWorker(...handlers)
```

### Step 2 — `web/src/components/MockProvider.tsx`

```typescript
'use client'

import { useEffect } from 'react'

let started = false

export function MockProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_USE_MOCK_API === 'true' && !started) {
      started = true
      import('../mocks/browser').then(({ worker }) => {
        worker.start({ onUnhandledRequest: 'warn' })
      })
    }
  }, [])

  return <>{children}</>
}
```

### Step 3 — Modify `web/src/app/layout.tsx`

Read the existing layout. Add the `MockProvider` import and wrap the innermost `{children}` inside `<body>`:

```typescript
import { MockProvider } from '@/components/MockProvider'

// Find the existing {children} in the body and wrap:
<MockProvider>{children}</MockProvider>
```

Only wrap the innermost `{children}` — do not wrap providers that already wrap children.

### Step 4 — Append to `web/.env.local`

```
NEXT_PUBLIC_USE_MOCK_API=true
```

### Step 5 — Register the Service Worker

Run from project root (use `run_in_background: true` — does not depend on Steps 1–4):

```bash
(cd web && npm exec -- msw init public/ --save)
```

This creates `web/public/mockServiceWorker.js`. Wait for completion before returning.

### Call B Return

```
MOCK INFRASTRUCTURE COMPLETE
---
files_created:
  - web/src/mocks/browser.ts
  - web/src/components/MockProvider.tsx
files_modified:
  - web/src/app/layout.tsx
  - web/.env.local
  - web/public/mockServiceWorker.js (generated by msw init)
next_step: "Start the dev server with `npm run dev` in /web — all API calls will be intercepted by MSW."
```

---

## Constraints

- Use realistic data — real-looking names, plausible amounts, valid-format dates
- Match schema field names exactly
- One handler per endpoint, no business logic in handlers
- Document conventions in `mock-data-context.md`
- Never use `AskUserQuestion` — does not work in subagents
- Never commit — orchestrator handles
- Never hardcode the API base URL — always import `API_BASE_URL`
- Never add `if (MOCK_API)` branches in handlers — handlers are only active when MSW is running
- Mock layer lives entirely in `web/src/mocks/` — no module-level or component-level mocks
- No error suppressions — fix root causes per [CLAUDE.md](../../CLAUDE.md)

---

## Success Criteria

- [ ] `web/src/mocks/handlers.ts` written with one handler per spec endpoint
- [ ] Entities with a `web/src/mocks/data/<entity>.ts` factory are composed from it (not re-derived); auth/userinfo returns `userInfoFor(role)` from `@/mocks/data/identity`
- [ ] Shared serving mechanics (param reading, pagination) live in `web/src/mocks/handler-utils.ts`, are composed by list handlers (not re-inlined), and the helper is registered in `generated-docs/architecture.md` under `## Shared utilities & components` (registry created with its three-section shape if it didn't exist yet)
- [ ] `generated-docs/specs/mock-data-context.md` written
- [ ] `generated-docs/specs/mock-spec-snapshot.yaml` saved
- [ ] `web/src/mocks/browser.ts` + `web/src/components/MockProvider.tsx` created
- [ ] `web/src/app/layout.tsx` updated to render `MockProvider`
- [ ] `web/.env.local` has `NEXT_PUBLIC_USE_MOCK_API=true`
- [ ] `web/public/mockServiceWorker.js` generated by `msw init`
- [ ] Every list endpoint with declared query params reads + applies them (array params via `getAll()`)
- [ ] Every filterable list endpoint has a dataset sized `2 × (max enum count across filters)`, ≥6 items
