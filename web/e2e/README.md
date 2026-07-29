# End-to-end tests (Playwright)

Playwright specs that exercise the running Next.js app in a real browser, with **all backend calls mocked** (`page.route()` by default; MSW when `web/src/mocks/` is wired) — never a live backend, never real credentials. They run batched at **epic-end** (via `playwright-runner`), before the manual verification checklist, so runtime issues (broken redirects, route guards, wiring) get caught without user intervention.

## Directory convention

- **One spec per story**, named `epic-<N>-story-<M>-<slug>.spec.ts`.
  - Example: `epic-1-story-2-application-shell.spec.ts`.
- **Fixtures** live in `./fixtures/` (created on demand during BUILD). Mock identities for form-fill re-export from there — auth is mocked, so they're never real accounts; never hard-code real passwords in specs.
- **Non-routable stories** still get a spec file, but each `test()` calls `test.fixme()` in its body (skips at runtime) with a one-line comment explaining why. The BUILD orchestrator detects this and skips execution cleanly.

## What belongs here vs. elsewhere

**Belongs in Playwright (this directory):**

- Navigation and redirect assertions (e.g., unauthenticated visitor lands on the project's sign-in route)
- Sign-in / sign-out flows against the project's chosen auth implementation (whatever the brief specified)
- Submit-a-form, see-the-next-page flows
- Role-aware visibility on actual rendered pages (admin sees X, viewer sees Y)
- Route guards that require middleware execution (viewer typing an admin URL is redirected)
- localStorage persistence that survives a page reload
- API calls intercepted by `page.route()` (or MSW once wired) — never a live backend

**Belongs in Vitest (`web/src/__tests__/`):**

- Component rendering and axe accessibility
- Schema validation (Zod)
- Hook behavior and form-field logic
- Anything that can be asserted in jsdom

**Belongs in the manual verification checklist only** (not automated at all):

- Screen-reader announcements (NVDA / VoiceOver)
- OS-level theme preference following
- Contrast verified by human eye
- Session persistence across a _full_ browser restart (Playwright storage-state swap is a proxy, not a real restart)
- Cross-browser Edge / Firefox parity (Chromium-only today)

## Running locally

```bash
cd web
npm run test:e2e              # run all specs against an auto-started dev server
npm run test:e2e -- e2e/epic-1-story-2-*.spec.ts   # run one story's spec
npm run test:e2e:ui           # interactive debugger
npm run test:e2e:install      # one-time: download Chromium (~130 MB)
```

Playwright's `webServer` config starts `next dev` on port 3000, waits for readiness, runs the specs, and shuts it down. No manual `npm run dev` needed. If you _do_ have the dev server already running, Playwright reuses it (`reuseExistingServer: true` locally).

## Spec template

The example below uses sign-in to illustrate the spec shape. **The referenced `./fixtures/credentials` import does not exist on a fresh template clone** — mock identities are generated during BUILD when an auth story creates them. Pedagogical value is in the structure, not the specific paths.

```ts
import { test, expect } from '@playwright/test';
import { adminUser } from './fixtures/credentials'; // mock identity for form-fill — auth is mocked below

test.describe('Epic 1, Story 2: Application shell', () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test('signed-in admin lands on /dashboard with the app shell visible', async ({
    page,
  }) => {
    // Mock the backend — specs never contact a live backend.
    await page.route('**/auth/login', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'set-cookie': 'session=mock-token; Path=/; HttpOnly' },
        contentType: 'application/json',
        body: '{}',
      }),
    );
    await page.route('**/auth/userinfo', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          Email: adminUser.email,
          Roles: [{ Name: 'Admin' }],
        }),
      }),
    );

    await page.goto('/auth/signin');
    await page.getByLabel('Email').fill(adminUser.email);
    await page.getByLabel('Password').fill(adminUser.password);
    await page.getByRole('button', { name: 'Sign In' }).click();

    await expect(page).toHaveURL('/dashboard');
    await expect(page.getByRole('navigation')).toBeVisible();
  });
});
```

Prefer `getByRole` / `getByLabel`. Avoid `page.waitForTimeout()` — rely on Playwright's auto-waiting via role-based queries and `toHaveURL` / `toBeVisible`.
