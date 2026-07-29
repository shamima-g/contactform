# Authentication Intake Policy

## Core Principle

Authentication is a critical architectural decision. **Never simplify, fold, or skip authentication questions during INTAKE.** Always present the full set of options explicitly, even when the answer seems obvious from existing documentation.

There are **two distinct auth concerns** in INTAKE — keep them separate:

1. **User-facing auth** (how end users sign in) — covered by the rules below.
2. **Backend API auth** (how the frontend authenticates to a backend service) — covered by the "Backend API Auth" section at the end of this file. This concern is owned by the `api-connectivity-agent` (spec-analysis Call A in `/start` Step 4 + smoke-test Call B in `/start` Step 6 of `/start`), but the policy lives here so reviewers see both halves of the auth picture in one place.

---

## Mandatory Rules

1. **Always ask the explicit authentication question** with all three options:
   - "Backend For Frontend (BFF)" — with description of what it means
   - "Frontend-only (next-auth)" — with description and trade-off warning
   - "Custom" — with open-ended follow-up

2. **Never infer the auth method** from API specs, documentation, or other context. The user must explicitly choose.

3. **Never fold auth into a simpler question.** Do not combine it with other questions or rephrase it as "How will authentication work?" — use the exact options above.

4. **If BFF is selected**, always ask the three follow-up sub-questions (login URL, userinfo URL, logout URL) and display the backend requirements note.

5. **If frontend-only is selected**, always display the trade-off warning about backend API calls not carrying session context.

6. **If Custom is selected**, always ask the open-ended follow-up for full details.

## Rationale

Authentication architecture affects every layer of the application — routing, middleware, API client configuration, session management, and security. Skimming over it leads to incorrect assumptions that are expensive to fix later. Even when documentation hints at an answer, the user must confirm explicitly.

---

## Backend API Auth (`/start` Step 6 — `api-connectivity-agent` smoke test)

This section governs how the *frontend* authenticates to the *backend API* — a separate concern from how end users sign in. Even when user-facing auth is handled by a BFF (so end users never see backend tokens), the dev environment usually still needs a way to call the backend during local development and integration testing. Skipping this question is the single most common cause of "first API call fails" later in the workflow.

### Mandatory rules

1. **Always run the connectivity check at `/start` Step 6** (Call B smoke test), except when `dataSource` is `mock-only` or `new-api`. Do not let the user opt out of the *check itself* — they can opt out of supplying credentials (which captures Shape 3 in project.md §Backend connectivity), but the agent must still parse the spec and persist what it found.

2. **Source `securitySchemes` from the OpenAPI spec** when one exists. Don't ask the user to repeat what the spec already declares. Surface what was found and confirm.

3. **Never accept credential VALUES via chat.** Anything typed into the conversation is captured in Claude Code's session transcript. Credentials move through `web/.env.local` (gitignored) only; the agent reads env var presence, never values.

4. **Capture env var NAMES in project.md, never values.** The §Backend connectivity `Credential env vars` row lists names like `API_TOKEN`. Values are read at runtime by the API client via `process.env`.

5. **Run a real curl smoke test when the backend is reachable.** Don't accept "looks fine in the spec" as proof. A 2xx round-trip is the proof.

6. **Distinguish failure categories.** A 401 means something different than a connection refused. The agent's `category` field maps to a specific remediation question — never use a generic "API call failed" message.

7. **Cap retries at 3 attempts.** After three failures, persist Shape 3 (unverified) and let the user proceed to PLAN. Do not block the workflow on a backend that genuinely isn't ready yet — that's what the warning and the `api-smoke-test.sh` artifact are for.

8. **Save the artifact even on failure.** `generated-docs/specs/api-smoke-test.sh` is a useful starting point for the user to debug independently, regardless of outcome.

9. **Curl-fallback secret handling.** When the user pastes an example curl as a fallback (`/start` Step 6 — see "Curl-fallback usage" below), literal credentials in the pasted curl ARE accepted but MUST be moved to `web/.env.local` and replaced with `${VAR_NAME}` placeholders before any agent output, project.md write, or artifact generation. The agent must set `redactedLiteralsDetected: true` in its return so the orchestrator surfaces a rotation warning to the user — the original message containing the literal is captured in Claude Code's session transcript, so the credential should be rotated. This is the ONLY pathway by which a literal credential is ever moved through the agent; bare credential pastes (without curl context) are still refused per Rule 3.

10. **Cookie-session auth = reachability check, never a login.** When the credential is a browser-managed session cookie minted at runtime (set by `POST /login`, no static token/key the frontend holds), the frontend has nothing to send at INTAKE, so the check verifies *reachability*, not a credentialed round-trip. (A bearer/JWT returned by a login endpoint is **not** this case — it's a static token once issued: it goes in `web/.env.local` and is smoke-tested in full mode.) The `api-connectivity-agent` detects this in Call A and sets `reachabilityOnly` on the smoke-test config; it returns the finding, and `intake-agent` records `Smoke-test mode: reachability-only` in project.md §Backend connectivity. In that mode the runner (`run-smoke-test.js`) deterministically scores a `401`/`403` on the unauthenticated probe as **success** (`category: reachable` → Shape 2) — the exception to Rule 5's 2xx requirement — so nothing reclassifies it, retries, or prompts for credentials, and login username/password are never proposed as env vars. `/api-status --check` and `/api-go-live` read `Smoke-test mode` and apply the same rule when re-running the artifact, so all three consumers agree. Credential-handling options remain: add a pre-obtained token/cookie to `web/.env.local`, defer (Shape 3), or paste a working curl.

### What "captured but unverified" means

When the user hits the 3-attempt cap and proceeds anyway, project.md §Backend connectivity gets Shape 3 (`Smoke-test status: null-deferred`, with the reason in `Smoke-test notes`). Downstream agents must treat this as a real signal:

- The `developer` agent should not assume the backend is reachable. If a story implementation needs a real backend call, surface the warning to the user before writing code that depends on it.
- `/api-status` displays the warning prominently when Shape 3 is present.
- `/api-go-live` re-runs the captured smoke test against the URL the user is going live with **before** flipping `NEXT_PUBLIC_USE_MOCK_API` off. A non-2xx blocks the flip by default; the user can override with "Flip anyway," which persists a warning to the §Backend connectivity `Smoke-test notes` row so `/api-status` continues to surface it.

### Curl-fallback usage

When the spec-driven smoke test cannot run cleanly, the orchestrator offers the user the option to paste a working curl. This is a **remediation path**, not a first-class entry point — the spec remains the primary source of truth when present and usable.

**Triggers (per Step 6 in `start.md`):**

- `curlFallbackRecommended: true` from Call A — set by the agent when `specStatus: missing`, when no safe-to-probe `GET` endpoint exists, or when the spec is so partial that auth + base URL are both unresolvable.
- `result: credentials_missing` — env vars not set; the user can paste a curl with literals as an alternative to manually populating `.env.local`.
- `result: failure` with `shouldRetry: true` — for any category (`dns`, `connection_refused`, `auth_invalid`, `forbidden`, `not_found`, `curl_parse_error`). "Paste a working curl instead" is always one of the AskUserQuestion options alongside the category-specific remediation.
- `result: skipped` — after a deferred Shape 1 or Shape 3 write, the user can verify connectivity by pasting a curl. The agent overwrites the existing shape based on the curl-driven smoke-test result.

**User behaviour:**

- **Recommended:** Replace credential values with `$ENV_VAR_NAME` placeholders before pasting (e.g., `Authorization: Bearer $API_TOKEN`). The agent records the env var names; the user fills `web/.env.local` themselves. Nothing sensitive enters the chat transcript.
- **Fallback (per Rule 9):** Paste the real curl as-is. The agent auto-redacts each literal credential to `web/.env.local`, rewrites the curl with placeholders for all subsequent persistence, and flags the rotation requirement to the orchestrator.

**Persistence:** The curl-fallback path saves the redacted smoke test to the re-runnable `generated-docs/specs/api-smoke-test.sh` artifact (credentials as `${VAR}` placeholders) and records the curl provenance in project.md §Backend connectivity (Shape 2 or Shape 3). Downstream agents — particularly `developer`, `/api-status`, `/api-go-live`, and `/api-mock-refresh` — can re-run the smoke test from that artifact without re-prompting the user.
