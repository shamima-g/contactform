---
description: Switch from mock data to the live backend API — runs a pre-flip smoke test, scans for stray mocks, and generates a go-live testing checklist
---

# /api-go-live

Run this command when your backend API is fully implemented and you're ready to switch from mock data to the live API.

## What this does

- **Re-runs the captured smoke test** (from INTAKE smoke-test step) against the live backend before flipping anything. By default, refuses to flip if the smoke test fails.
- Switches the app from MSW mock mode to the real backend
- Scans for any stray mock patterns that may have crept into the codebase
- Generates a manual testing checklist from the project brief to guide your verification

The switchover is a single env-var change. No application code needs to change — all API calls already go through `web/src/lib/api/client.ts`, which always calls the real fetch. Removing the mock env var is all it takes.

The pre-flip smoke test is the gate: if INTAKE captured a `backendConnectivity` block, the same `generated-docs/specs/api-smoke-test.sh` artifact runs here against the URL the user is about to go live with. A non-2xx blocks the flip by default — going live with a 401-ing token or a wrong base URL means every API call lands in the same broken state. Exception: for cookie-session auth, where project.md records `Smoke-test mode: reachability-only`, a `401`/`403` (or a `3xx` redirect to login) is the *expected* unauthenticated response and counts as a pass — the app's own login exercises credentials at runtime.

---

## Steps

### Step 1 — Ask for the Live API URL

Use `AskUserQuestion`:
- "What is the base URL for your live API?"
- Options: provide a text input (or common values like "http://localhost:8042" if the default is still correct)

Also ask:
- "Do you want to keep the mock files for reference, or remove them?"
- Options: "Keep web/src/mocks/ (recommended)" / "Remove web/src/mocks/"

### Step 1.5 — Pre-Flip Smoke Test

Before changing any env vars, verify that the user's live URL is actually reachable with the credentials captured during INTAKE. This step is a **gate**: a failure blocks the flip by default.

**1. Read `generated-docs/project.md` § Data Source & Backend Integration / § Backend connectivity.**

Branch on what's there:

| §Backend connectivity | Action |
|---|---|
| **Missing** | Output: "No connectivity capture found in project.md — going live without verification." Skip to Step 2. |
| **Shape 1** (`skipped: true`) | Output: "Backend connectivity was skipped during INTAKE (`[reason]`) — no smoke test to re-run." Skip to Step 2. |
| **Shape 2 / Shape 3** (config captured) | Continue with the smoke-test execution below. |

**2. Resolve which URL to smoke-test.**

If the live URL the user just provided in Step 1 differs from `backendConnectivity.baseUrl`, ask via `AskUserQuestion`:
- Question: "Captured base URL was `[backendConnectivity.baseUrl]`; you entered `[live URL from Step 1]`. Which URL should the smoke test run against?"
- Options:
  - "The new URL I just entered" (default — it's what they're going live with)
  - "The captured URL" (useful if testing against a staging URL before swapping in prod)
  - "Skip the smoke test" (proceeds to Step 2 without verification — record this as an override warning per the failure path below)

If the URLs match, proceed without asking.

**3. Verify credential env vars are present in `web/.env.local`.**

For each name in `backendConnectivity.credentialEnvVars`, check presence only — never read or echo values:

```bash
node -e "require('dotenv').config({path:'web/.env.local'}); console.log(process.env.API_TOKEN ? 'set' : 'unset')"
```

Repeat for each name. If any are `unset`, list them and use `AskUserQuestion`:
- "Missing in web/.env.local: [list]. Add them, skip the check, or stop?"
- Options: "Ready, I've added them" / "Skip the check" / "Stop"
- On "Ready" → continue to step 4. On "Skip" → proceed to Step 2 (record as override warning). On "Stop" → abort `/api-go-live` (no env-var changes made).

**4. Run the smoke test.**

Source `web/.env.local` and run the saved artifact, optionally overriding the base URL in-memory if the user chose to test the new URL:

```bash
( set -a; . web/.env.local 2>/dev/null; set +a; \
  NEXT_PUBLIC_API_BASE_URL="$LIVE_URL" \
  bash generated-docs/specs/api-smoke-test.sh )
```

(Where `$LIVE_URL` is the URL chosen in step 2. If the captured URL was chosen, omit the override.)

Capture only the HTTP status. Do NOT print the response body to the terminal — it may contain tokens or PII.

**5. Interpret + persist.**

- **Read `Smoke-test mode` first.** When it's `reachability-only` (cookie-session auth), treat a `3xx`/`401`/`403` as the **2xx-success** branch below — the backend is reachable and enforcing auth, the expected pre-flip state; end-to-end auth is exercised by the app's login at runtime, not this check. Only a transport failure or `404`/`5xx` takes the failure branch.

- **2xx success:**
  - Set the §Backend connectivity `Smoke-test status` to verified and `Smoke-test verified at` to the current ISO 8601 timestamp in `generated-docs/project.md`.
  - If project.md was Shape 3 (`Smoke-test notes` set, `Smoke-test status: null-deferred`), clear `Smoke-test notes` — Shape 3 → Shape 2 transition.
  - Display: "✅ Smoke test passed — `[METHOD endpoint]` returned `[status]`. Proceeding with the flip."
  - Continue to Step 2.

- **Non-2xx failure:** Do NOT modify `web/.env.local`. Use `AskUserQuestion`:
  - Question: "Smoke test failed: `[METHOD] [endpoint]` returned `[status]` ([category]). Going live now means every API call lands in this same broken state."
  - Options:
    - "Stop and fix" (Recommended) — abort `/api-go-live`. Display the remediation hint per category (DNS / connection refused / 401 / 403 / 404) and a pointer to `generated-docs/specs/api-smoke-test.sh` for manual debugging.
    - "Flip anyway, I know what I'm doing" — set the §Backend connectivity `Smoke-test notes` row in project.md to "Live mode entered while smoke test failed at [ISO timestamp] (HTTP [status])" and persist. Continue to Step 2.

  Use the same category-to-remediation mapping as `api-connectivity-agent`:

  | category | Remediation hint |
  |---|---|
  | `dns` | "Could not resolve `[host]`. Typo in the URL, or VPN required?" |
  | `connection_refused` | "Connection refused on `[host:port]`. Backend is not running or not reachable from here." |
  | `auth_invalid` (401) | "Got 401 — token in `.env.local` is wrong, expired, or in the wrong format." |
  | `forbidden` (403) | "Got 403 — token works but lacks scope/role for this endpoint." |
  | `not_found` (404) | "Got 404 on `[endpoint]` — base URL prefix wrong, or endpoint not implemented at this URL." |
  | `timeout` | "Request timed out against `[host:port]` — backend slow, wrong port, or a firewall dropping the connection." |
  | `tls` | "TLS error connecting to `[host]` — certificate invalid/expired, or http vs https mismatch." |
  | `other` (5xx / unexpected) | "Server reached but returned `[status]` — backend error; check its logs before going live." |

### Step 2 — Update `web/.env.local`

Read the current `web/.env.local`. Make two changes:
1. Set `NEXT_PUBLIC_API_BASE_URL` to the live URL the user provided
2. Remove the `NEXT_PUBLIC_USE_MOCK_API=true` line entirely

Write the updated file back. The app will now call the real backend on next restart.

### Step 3 — Scan for Stray Mock Patterns

Scan `web/src/` (excluding `web/src/mocks/` and `**/__tests__/**`) for patterns that suggest inline or ad-hoc mocking. Run all three searches in parallel using the Grep tool:

1. `Grep` pattern `NEXT_PUBLIC_USE_MOCK_API` in `web/src/` with glob `*.{ts,tsx}` (exclude mocks dir manually from results)
2. `Grep` pattern `\b(mockData|fakeData|hardcodedData|dummyData)\b` in `web/src/` with glob `*.{ts,tsx}`
3. `Grep` pattern `\bif\b.*\b(useMock|mockApi|MOCK_API|USE_MOCK)\b` in `web/src/` with glob `*.{ts,tsx}`

Filter out results from `web/src/mocks/` and `**/__tests__/**` directories before reporting.

If anything is found, report it clearly:

```
Stray mock patterns found — please review before going live:

  web/src/components/UserList.tsx:42
    const data = process.env.NEXT_PUBLIC_USE_MOCK_API ? hardcodedUsers : ...

  [etc]
```

If nothing is found, confirm: "No stray mock patterns found — the codebase is clean."

### Step 4 — Handle Mock Files (per user choice)

**If "Keep web/src/mocks/":** Leave all mock files in place. Confirm: "Mock files kept at `web/src/mocks/`. They won't be active without `NEXT_PUBLIC_USE_MOCK_API=true`, but they're available if you ever need to revert."

**If "Remove web/src/mocks/":** Delete the directory and remove the `MockProvider` import and wrapping from `web/src/app/layout.tsx`. Also delete `web/src/components/MockProvider.tsx`. Confirm what was removed.

### Step 5 — Generate Manual Testing Checklist

Read `generated-docs/project.md` and `generated-docs/specs/api-spec.yaml`.

Generate a checklist of key workflows to manually verify against the live API. Write it to `generated-docs/specs/go-live-checklist.md`:

```markdown
# Go-Live Testing Checklist

Generated: [ISO date]
Live API URL: [url]

## How to use
Work through each item in the browser with the dev server pointing at the live API.
Check each box as you verify it.

---

## [Workflow Name — from project brief]

**Endpoints involved:** `GET /v1/resource`, `POST /v1/resource`

- [ ] Happy path: [describe what success looks like]
- [ ] Loading state: spinner/skeleton visible while request is in flight
- [ ] Error state: appropriate error message shown when API returns 4xx/5xx
- [ ] [Any edge cases from project brief acceptance criteria]

---

[repeat for each key workflow]

---

## General Checks

- [ ] No console errors in the browser developer tools
- [ ] Network tab shows requests going to [live URL], not localhost mock
- [ ] Authentication (if applicable) working end-to-end
- [ ] No CORS errors in the browser console
```

After writing the file, display the checklist to the user in the conversation.

### Step 6 — Final Summary

Output a clear summary. The first line reflects the smoke-test outcome from Step 1.5:

```
Ready for live testing.

Pre-flip smoke test:
  [x] Verified at [verifiedAt] — [METHOD endpoint] returned [status]
  [or "Skipped — no captured connectivity (mock-only project)"]
  [or "⚠️  Override: smoke test failed but user chose to proceed — see project.md §Backend connectivity `Smoke-test notes`"]

Changes made:
  [x] NEXT_PUBLIC_API_BASE_URL set to [url]
  [x] NEXT_PUBLIC_USE_MOCK_API removed
  [x] web/src/mocks/ removed  — if chosen

Next steps:
  1. Restart the dev server: (cd web && npm run dev)
  2. Work through the checklist at generated-docs/specs/go-live-checklist.md
  3. Check the browser console for any errors or unexpected mock warnings
  4. (If override warning above) Re-run /api-status --check after fixing the underlying issue
```

---

## Notes

- To revert to mock mode at any time, add `NEXT_PUBLIC_USE_MOCK_API=true` back to `web/.env.local` and restart the dev server (mock files must still be present)
- The checklist at `generated-docs/specs/go-live-checklist.md` persists across sessions — you can track progress there over multiple sessions
