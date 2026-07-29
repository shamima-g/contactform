# Testing Policy

Canonical operational checklist for testing, referenced by [`test-generator`](../agents/test-generator.md) and [`developer`](../agents/developer.md), and enforced by the `test-quality` gate in `quality-gates.js`. CLAUDE.md covers rationale.

---

## Where each scenario belongs

Every acceptance criterion carries **exactly one** coverage tag, assigned by the [feature-planner](../agents/feature-planner.md#coverage-tagging) at PLAN and rendered mechanically by `test-generator` (one tag → one test). Tag by **where the behaviour lives**, not by how thorough it would feel:

| The behaviour lives in… | Tag | Examples |
|---|---|---|
| the **React render** (jsdom-observable) | `vitest` (`web/src/__tests__/`) | role-gating, conditional UI, form-state, loading/empty/error states, hook behaviour, schema-driven form validation |
| the **browser + mocked-backend round-trip** | `playwright` (`web/e2e/`) | navigation/redirects, submit-and-see-next-page, the app's real `authorize()` against a mocked backend, role-aware visibility, route guards (middleware), localStorage across a real reload, filter/sort/pagination against mocked responses, drag/drop, downloads, file picker, **accessibility** (one real-browser `@axe-core/playwright` scan), **time-dependent flows** (`page.clock`) |
| **visual / assistive-tech / OS**, or **absorbed by a sibling AC's test** | `none` (manual-only ACs surface in `manualOnlyACs`) | screen-reader announcements, OS-level theme, human-eye contrast, cross-browser parity; or "another AC's test in this story already proves this" |

**One tag, one layer — no sibling tests across layers.** A sign-in redirect belongs in Playwright; the Vitest version would mock `signIn()` and recreate the exact blind spot the pipeline exists to close. The Playwright spec *is* the test. Vitest stays a respected, narrow tier — written exactly where it has value, never as a default or a "for completeness" duplicate.

**`none` is first-class.** Static chrome ("page has the heading 'File Logs'") and visual/AT/OS checks are tagged `none`; a `none` AC the user can still eyeball belongs in `manualTestChecklist`.

---

## Time-dependent behaviour

Timeouts, polling, debounce, auto-dismiss, countdowns — anything driven by the clock.

**Time-driven *flows* belong in Playwright, via [`page.clock`](https://playwright.dev/docs/clock) — not Vitest fake timers.** `page.clock.install()` then `fastForward('15:00')` / `runFor(1000)` / `pauseAt(...)` advances the browser clock deterministically against the **real** configured durations — no injected short values, no real elapsed time, and (the part that matters) **no test-only hooks in production code**. It also sidesteps the jsdom failure modes that make `vi.useFakeTimers()` fragile: it deadlocks RTL's `waitFor`/`findBy*` and hangs `axe()`.

Split the layers:

- **Flow** — warning modal appears before expiry, countdown ticks down, redirect fires on expiry, a control disables during a cooldown → `playwright` + `page.clock`.
- **Pure time arithmetic** — the idle-vs-absolute decision, "seconds remaining" math → extract it into a plain function/hook and unit-test with **explicit inputs in Vitest, no timers at all**. Prefer a timestamp-derived value (`Math.ceil((expiresAt - now) / 1000)`) over a `setInterval` that mutates its own state — it's deterministic and needs no clock to test.
- `vi.useFakeTimers()` is the **last resort** — only a genuinely component-local timer with no observable flow. If you reach for it, never run `axe()` in the same test (axe defers on `setTimeout` and will hang under a frozen fake clock) — accessibility is asserted by the Playwright `@axe-core/playwright` scan anyway.

**"Mounted app-wide / no page of its own" is not non-routable.** A session-timeout manager lives in the shell, but its effects are observable on any signed-in page — drive a browser to one and use `page.clock`. See [Non-routable Playwright stubs](#non-routable-playwright-stubs).

Two consequences worth banking:

- **Don't add test-only timing config to production.** Shortened-duration props/env switches exist only to make fake-timer tests bearable; `page.clock` exercises the real 15-min / 8-hr values instantly, so production keeps its real defaults and gains no test scaffolding.
- **Don't duplicate the durations as a manual step.** Because `page.clock` verifies the real configured values automatically, a `manualTestChecklist` item like "confirm the timeout fires at 15 minutes" is redundant — drop it.

---

## Accessibility

Asserted by a real-browser `@axe-core/playwright` scan in the routable story's Playwright spec — **not** `vitest-axe` in jsdom (which can't see contrast, layout, or focus order).

- **Scope to the standard.** `.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])` — matches `NFR-base-1` (WCAG 2.1 AA). Axe's defaults also run *best-practice* rules; leaving them on fails specs on issues outside the agreed bar.
- **Scan each distinct state the story introduces** — happy path plus error / empty / open-modal / disabled — not just the default render. axe violations are usually state-specific, and a page-level scan only sees the states the spec drives to.
- **Scan a settled DOM** — await a stable element before scanning so the scan isn't racing a loading skeleton or an animation.
- A component with no routable surface of its own is covered when a routable page renders it; it is not separately axe-scanned in Vitest. The automated in-loop signal is the routable page's `@axe-core/playwright` scan (run batched at epic-end); the epic-end `/code-review` pass is a further backstop for semantic-HTML / ARIA / keyboard concerns.

---

## Test organization

| Directory | Contents |
|---|---|
| `web/src/__tests__/integration/` | Integration tests (primary focus) |
| `web/src/__tests__/scripts/` | Template tooling and script tests |
| `web/src/__tests__/api/` | API endpoint tests (if needed) |
| `web/e2e/` | Playwright specs |

File naming: `.test.ts` for non-React code, `.test.tsx` for React components/pages. Use descriptive names tied to the behavior under test.

---

## Per-epic baseline

Cross-story invariants live in **one file per epic**, not duplicated across every story's test file:

- File: `web/src/__tests__/integration/epic-<slug>-baseline.test.tsx`.
- Created by **Story 1's** `test-generator` when the planner set `epicIntroducesSharedSurface: true` (the epic introduces a shared shell, `layout.tsx`, route group, or provider).
- Covers epic-wide invariants: role-gating that spans the epic's pages, shared-shell navigation, shared layout. (The epic's accessibility baseline is a `@axe-core/playwright` scan in the shared-surface story's Playwright spec — not this Vitest file.)
- **Later stories in the epic do NOT re-assert these** — their test files cover only the story's delta. If a later story introduces a *genuinely new* shared surface, extend the baseline (add only the new invariants) rather than recreating it.

---

## Test budget

**Tests = coverage tags.** The feature-planner assigns one `coverage` tag per (consolidated, ≤6) AC; `test-generator` renders one test per tag. There is no separate count target — the count is whatever the tags produce.

**Hard ceiling: 12 `it()` blocks per Vitest file and 12 `test()` blocks per Playwright spec.** If a file would exceed it, the planner over-tagged or the story is too large — return a `briefDriftNotes` entry for consolidation rather than letting the file grow.

### Representative vs exhaustive

Consolidation happens at PLAN (one AC = "validates fields per the brief", not one AC per field), so one tag yields one representative test, not one per data point.

| Behavior | Representative (correct) | Exhaustive (wrong) |
|---|---|---|
| Pagination | Forward, backward, first-page disables prev, last-page disables next (4) | Pages 1–10 individually (10) |
| Sorting | Click → asc, click again → desc, verify one column (2-3) | Every column × both directions (12+) |
| Filtering | Apply filter → narrows, clear → restores, combine two (3) | Every filter value × every combination (20+) |
| Validation | One required empty, one invalid format, all valid (3) | Every field × every rule (15+) |
| Empty / error / loading | One each (3) | Multiple error codes × multiple empty scenarios (10+) |

When multiple tests differ only by a data value (column name, page number, filter option), that's a signal to test the mechanism once and trust the implementation. Use `it.each` sparingly — only for genuinely distinct edge cases (number vs date vs string formatting), never data variations. Keep `it.each` tables ≤5 rows.

---

## Query priority (accessibility-first)

| Priority | Query | When to use |
|---|---|---|
| 1 | `getByRole` | Buttons, links, headings, forms — **preferred for most elements** |
| 2 | `getByLabelText` | Form inputs with labels |
| 3 | `getByPlaceholderText` | Inputs without visible labels |
| 4 | `getByText` | Non-interactive content |
| 5 | `getByDisplayValue` | Filled form inputs |
| Last resort | `getByTestId` | Only when no semantic query works |

**`getByTestId` is an anti-pattern in most cases.** If you find yourself adding `data-testid` attributes, first ask: "Is there a semantic HTML element or ARIA role I should use instead?" The answer is usually yes.

---

## AC traceability

Every `it()` / `test()` block carries a `// AC-N` comment on the line above it. Multiple ACs can be comma-separated:

```typescript
// AC-1, AC-3
it('displays payment list and handles API errors', () => { ... });
```

---

## Anti-patterns (forbidden)

Tests must fail before implementation, import real production code (never mock the code under test), assert user-observable behavior, and follow the **No Error Suppressions** rule in CLAUDE.md. The patterns below are the recurring ways those principles get violated:

### 1. No placeholder components inside test files

Every `import` must point to production code. If the component doesn't exist, that's the expected TDD failure — don't define a placeholder.

```typescript
// WRONG — tests zero production code
const ExamplePage = () => <div>Example</div>;

// CORRECT — import will fail until implemented
import { ExamplePage } from '@/app/example/page';
```

### 2. No `||` query fallbacks

`getBy*` throws on no match, so the `||` branch never executes.

```typescript
// WRONG
screen.getByLabelText(/date/i) || screen.getByPlaceholderText(/date/i)

// CORRECT — use queryBy for conditional checks
screen.queryByLabelText(/date/i) ?? screen.getByPlaceholderText(/date/i)
```

### 3. No speculative normalization tests

Don't test multiple casings of the same enum value unless the spec documents mixed casing.

### 4. Every `it()` must have a meaningful assertion

Rendering a component and asserting only that a hardcoded input value appears verifies nothing. Either add an assertion that would fail if the feature broke, or don't generate the test.

### 5. No library-internal assertions

No assertions on third-party library internals (Recharts SVG, Zod schemas, mock call counts). Assert user-observable outcomes.

```typescript
// WRONG
expect(container.querySelector('.recharts-bar-rectangle')).toHaveAttribute('fill', '#8884d8');
expect(mockFn).toHaveBeenCalledTimes(3);
expect(button).toHaveClass('btn-primary');

// CORRECT
expect(screen.getByText('Sales: $1,234')).toBeInTheDocument();
expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
```

**Charts and visualizations specifically:** jsdom cannot render SVG/Canvas, so any test querying internal `<rect>` / `<path>` elements is meaningless. Test that the component renders without crashing, that data transformation/formatting functions work (test those separately), that loading/error/empty states render, and use accessibility features (aria-labels, sr-only text) to verify data display. Defer visual correctness to E2E or manual QA.

### 6. No placeholder-removal-only tests

Don't test that template placeholder text is absent. Real content rendering implicitly proves it.

### 7. No fragile index-based row selection

Use `within()` to scope queries to a row, not array indices.

```typescript
// WRONG — assumes API ordering
const links = screen.getAllByRole('link', { name: /view/i });
const firstRowLink = links[0];

// CORRECT — scoped to the row containing the expected text
const row = screen.getByText('ABC Realty').closest('tr')!;
const link = within(row).getByRole('link', { name: /view/i });
```

### 8. No loose range comparisons on count assertions

`toBeLessThanOrEqual(20)` passes even if the component renders zero rows. When the fixture has N items and you expect N visible, assert the exact count.

```typescript
// WRONG — passes on an empty render
expect(screen.getAllByRole('row').length).toBeLessThanOrEqual(20);

// CORRECT — pins the contract to the fixture
expect(screen.getAllByRole('row')).toHaveLength(N);
```

### 9. No unscoped numeric or short-string `getByText`

`screen.getByText('6')` matches any "6" anywhere in the DOM. For text shorter than ~4 chars, or any value that could appear in more than one place, scope it with `within()`.

```typescript
// WRONG
expect(screen.getByText('6')).toBeInTheDocument();

// CORRECT
const card = screen.getByRole('group', { name: /pending/i });
expect(within(card).getByText('6')).toBeInTheDocument();
```

### 10. No conditional assertions that pass under either implementation

A test that asserts one thing if an element exists and the opposite if it doesn't pins no contract. Pick the expected behaviour and assert that.

```typescript
// WRONG — green whether the button is disabled OR absent
if (button) expect(button).toBeDisabled();
else expect(button).not.toBeInTheDocument();

// CORRECT — decide the contract and assert it
expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();
```

### 11. No empirical Playwright locator probing

When a value appears in more than one place (e.g. a reference shown in both a filter chip and the results table), `getByText` matches 2+ elements and throws Playwright's strict-mode error. Reason out a scoped locator — don't write throwaway probe specs to discover which element matches, and never write scratch specs into `web/e2e/` or `/tmp`.

```typescript
// WRONG — matches the chip AND the table cell → strict-mode violation
await expect(page.getByText('TXN-20260415-0002')).toBeVisible();

// CORRECT — scope to a region/role, or use exact / filter({ hasText })
await expect(page.getByRole('table').getByRole('cell', { name: 'TXN-20260415-0002' })).toBeVisible();
```

---

## Forbidden test files

- `constants.test.ts`, `types.test.ts`, `*-schemas.test.ts` — tests for things TypeScript already proves

---

## Mocking strategy

| Scenario | Mock? | How |
|---|---|---|
| API client | Yes | `vi.mock('@/lib/api/client', () => ({ get: vi.fn() }))` |
| External services | Yes | `vi.mock` the service module |
| Child components | No | Test the real component |
| React hooks | No | Test through behavior |
| Date/time | Prefer not to mock | Time-driven *flows* → Playwright `page.clock`; pure time math → plain inputs in Vitest (no timers). `vi.useFakeTimers()` only for a component-local timer with no flow — see [Time-dependent behaviour](#time-dependent-behaviour) |

**Do not "fix" data-contract tests** by using the real API client or real MSW handlers inside Vitest. The convention `vi.mock('@/lib/api/client', () => ({ get: vi.fn() }))` is fixed.

### Playwright runs against mocks, never live

Playwright specs **never contact a live backend** and **never require real credentials** — every backend call is intercepted by `page.route()` (default) or MSW (when `web/src/mocks/` is wired), and login is faked with a mock session cookie. Keeps the gate deterministic and CI-runnable, needs no credentials (so never `test.skip()` on env vars), and can't pollute a real database. Real end-to-end checks happen at the human MANUAL-TEST approval. Anchor mock shapes to the brief's Data Model / OpenAPI spec.

### Playwright mocking — declare it in the spec header

Playwright specs MUST open with a `Mocking strategy:` block (see [test-generator.md](../agents/test-generator.md) template). **Always mock the backend — never live.** `page.route()` (default) only intercepts browser-side fetches — it cannot intercept Server Actions, which forces a client-side implementation. MSW (Node) intercepts both but needs `web/src/mocks/` wired. The developer reads this in Step 1 and implements to it.

### Common mock pitfalls

**Multiple API calls** — `mockResolvedValue` returns the same value for all calls. Use `mockResolvedValueOnce` for different sequential responses:

```typescript
mockGet
  .mockResolvedValueOnce(firstResponse)
  .mockResolvedValueOnce(secondResponse);
```

**Context providers** — mock both the hook and the Provider:

```typescript
vi.mock('@/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));
```

**Navigation hooks** — mock all the Next.js navigation imports the component uses:

```typescript
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/current-path',
  useSearchParams: () => new URLSearchParams(),
}));
```

**Async state updates** — wrap assertions in `waitFor`:

```typescript
await waitFor(() => {
  expect(screen.getByText('Expected')).toBeInTheDocument();
});
```

---

## Mock data: entity factories + scenario fixtures

Mock data has **one home per entity, shared project-wide** — not one file per epic. A per-epic file just relocates duplication to the epic boundary: three epics that all touch `Transaction` would each redefine it and drift apart — the same all-green-all-wrong failure, moved one level up. Two layers instead:

**Entity factories — `web/src/mocks/data/<entity>.ts`, one per entity, project-wide.** The single source of truth for an entity's shape **and** its canonical default values: a `create<Entity>(overrides?)` factory typed against `web/src/types/api-generated.ts` when it exists (else the brief's Data Model). Every epic and every test layer that touches that entity imports the same factory.

```typescript
// web/src/mocks/data/transaction.ts
import type { Transaction } from '@/types/api-generated';

export const createTransaction = (overrides: Partial<Transaction> = {}): Transaction => ({
  id: 'TXN-0001',
  amount: 125430.5,
  status: 'pending',
  ...overrides,
});
```

**Identity / auth is project-wide.** Roles and permissions are project facts (`project.md` §Roles & Permissions), inherited across every epic — so the userinfo contract lives once in `web/src/mocks/data/identity.ts`, exporting `userInfoFor(roleName)` (the `Roles[]` / `Pages[]` shape the app gates on). One definition, exercised identically by both test layers and the manual-test approval — this is exactly the contract the v07 nav bug diverged on.

**Scenario fixtures — thin compositions, per epic/story.** A list with mixed statuses, the empty state, a rejected transaction with a note. Compose the entity factories inline in tests (`createTransaction({ status: 'approved' })`); only promote a composition to a named export (in the entity file, or a small `web/src/mocks/scenarios/epic-<slug>.ts`) when it's reused across stories or across the Vitest/Playwright boundary. Scenario fixtures carry **no** shape definitions.

**Both test layers consume the same factories.** Vitest imports via the `@/` alias (`@/mocks/data/transaction`); Playwright imports via a **relative** path from `e2e/` (`../src/mocks/data/identity`) to dodge alias resolution at Playwright runtime. So every module under `web/src/mocks/` that the e2e layer can import — entity factories in `data/` **and** scenario fixtures in `scenarios/` — must import **types** with `import type` only (erased at compile) and import **sibling/peer factories** by relative path (`./user`, or `../data/transaction` from a `scenarios/` file), never the `@/` alias — that keeps each module importable from the e2e layer without any alias plumbing. (The `@/` alias is fine in Vitest test files and in app-runtime code like `web/src/mocks/handlers.ts`, which Playwright never imports relatively — the rule is only for the modules an e2e spec reaches through a relative import.)

**The runtime mock layer consumes them too.** When the project ships MSW handlers (`web/src/mocks/handlers.ts`, the running-app mock used in mock mode), they compose the same factories — `createX(overrides)` for entity bodies, `userInfoFor(role)` for auth — so the dev/demo app and the tests can't drift onto different contracts. The handler keeps the *serving* logic (filtering, pagination, ≥2-per-enum dataset sizing); only the entity *shape + defaults* come from the factory. So all three mock surfaces — Vitest, Playwright, and the MSW runtime — draw from one source. See [mock-setup-agent § Generate handlers](../agents/mock-setup-agent.md#step-3--generate-websrcmockshandlersts).

**Evolving an entity:** when an epic genuinely adds a field, **extend** the one entity file (a deliberate, reviewable edit — journal it as a Tier-2 factual addition); never copy the entity into a new file. The per-entity files are a coordinated shared surface across epic branches: real edit-conflicts are rare (definitions are append-mostly), and when they do happen they're a genuine shared-contract change governed by [epic-branch-concurrency §6.2](./epic-branch-concurrency.md). Duplication, by contrast, guarantees silent drift.

---

## Mock data accuracy

Before creating mocks, check for OpenAPI specs at `generated-docs/specs/api-spec.yaml` (canonical) or `documentation/*.yaml` (user-provided). Specs don't always reflect reality (string enums, unexpected nulls, extra fields), so when sample data exists, use it as the basis. Type your factories so TypeScript catches obvious mismatches.

When a quirk is discovered (spec says enum, API returns string), document it in the type definition so both tests and implementation benefit:

```typescript
export interface Portfolio {
  /** API returns 'ACTIVE' | 'INACTIVE' as string, not a typed enum */
  status: string;
}
```

---

## Render scope — component vs full page

Default to the narrowest scope that covers the ACs. Full-page renders cascade failures across every suite when one component breaks; component-level renders isolate them.

| Story type | Render |
|---|---|
| Targets a specific component (chart, grid, form) | That component directly |
| Covers page layout / cross-component interactions | Full page |
| Story 1 (page setup) with many sections | Full page (first story establishes the page) |

---

## Testability classification (inline tags)

The `coverage` tag decides the layer (and therefore the file). These inline annotations are a **secondary** note for the residual jsdom-blindness *inside* a `vitest`-tagged test — they never override the tag or add a cross-layer sibling:

- **Runtime-only** (a `vitest`-tagged AC whose render you can assert, but whose middleware/server-component/layout-composition aspect jsdom can't exercise) — keep the Vitest test for component-level regression, add `// Runtime-only: verified during manual checklist` above it. If the *primary* behaviour is the redirect/guard itself, it should have been tagged `playwright`, not `vitest`.
- **Data-contract** (Vitest mocks `@/lib/api/client`, so the test verifies component behaviour with a mocked response but cannot verify real client → handler → dataset wiring) — add `// Data-contract: full chain verified during manual checklist`
- **Manual-only** — this is what a `none` tag with a user-eyeball nature means: do NOT generate a test; surface it in `manualOnlyACs` so the orchestrator folds it into the manual checklist

---

## Mock boundary blindness

Vitest + RTL runs in jsdom, which cannot exercise certain Next.js integration layers. Tests that mock each boundary independently will pass even when the boundaries aren't connected at runtime — this is why [Testability classification](#testability-classification-inline-tags) exists.

**jsdom CAN verify (unit-testable):**

- Component rendering and conditional content
- Form interactions and validation feedback
- Hook behavior and state changes
- Error message display
- Client-side navigation calls (`router.push` was called with correct args)

**jsdom CANNOT verify (runtime-only):**

- Middleware actually intercepts requests and redirects
- Server-component auth (`requireSession()`) actually blocks rendering
- Layout composition (a page inside `(authenticated)/` inherits the protected layout)
- Multi-layer redirects (middleware → login → return-to-original-page)
- `"use client"` boundaries (server-side auth in a client component is silently skipped)

**jsdom CANNOT verify (data-contract):**

A component that calls the API client with mocked HTTP passes its Vitest tests but doesn't exercise:

- Query-param serialization (repeated vs comma-joined arrays)
- `buildUrl` correctness for array values
- MSW handler contract (does it actually read declared query params?)
- Mock dataset realism (≥2 items per enum so filters visibly narrow)
- Empty-filter semantics (no filters → all items, not zero)

A list with a broken status filter passes every component test because the test never touches the actual URL. The bug only appears when the real API client meets the real MSW handler in the browser.

**How the workflow handles it:** the `developer` performs integration-wiring checks and synthesizes runtime verification items from the story's ACs — so the manual checklist always surfaces runtime-only and data-contract concerns — and the epic-end `/code-review` pass is a further backstop. `mock-setup-agent` generates handlers that honor their OpenAPI contract (query params read and applied; ≥2 items per enum value) to prevent the most common data-contract bugs from shipping as mocks.

The most dangerous case is when a behaviour depends on a backend response shape the brief *assumed* rather than *verified*: the mocks are built from that same assumption, so the code, the mocks, and every test agree — all green, all wrong (e.g. deriving nav from a `Pages[]` array the real backend returns sparsely). These are captured at PLAN as the epic's [`unverifiedAssumptions`](../agents/feature-planner.md#unverified-assumptions-the-manual-test-approval-ledger) and floated to the **top** of the manual-test approval as a "check these first" list — the human is the only place reality enters the loop, so point their attention at exactly what the pipeline couldn't prove.

---

## Non-routable Playwright stubs

Stories with `route === null` still get a Playwright spec file (so the file structure exists for later promotion), but each test is a `test.fixme()` stub — using the **version-agnostic** form below: a real `test(...)` whose body calls `test.fixme()` to skip at runtime. Prefer this form; it behaves consistently across Playwright versions. Avoid the declarative `test.fixme('title', fn)` overload, which has produced version-dependent parse errors.

```ts
import { test } from '@playwright/test';

// Non-routable: <one-line reason from the story's summary>
test('Epic N, Story M: <title> (deferred to consumer stories)', () => {
  test.fixme(); // skips at runtime; behaves consistently across Playwright
                // versions, unlike the declarative test.fixme('title', fn) form
});
```

`test.fixme()` is **only** permitted for explicitly non-routable stories (`route === null`). Never as a tool to avoid failing tests.

**Time-driven ≠ non-routable.** Do not downgrade a routable story (`route !== null`) to a stub because its behaviour is timer-driven or because the component is mounted app-wide with "no surface to navigate to." `page.clock` advances the clock deterministically with no production hooks, and an app-wide manager's effects are observable on any real page — so session-timeout / polling / auto-dismiss stories get a **live** `page.clock` spec (see [Time-dependent behaviour](#time-dependent-behaviour)). `test.fixme()` is for stories with no observable browser surface at all, not for ones that are merely awkward to time.
