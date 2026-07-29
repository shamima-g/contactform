---
description: Show API endpoint provenance, mock status, drift detection, and handler coverage
---

# /api-status

Display a live status view of the API layer by reading the current spec and project state. No files are modified — this is a read-only command.

## Arguments

- `--check` — In addition to the standard read-only display, re-run the saved backend smoke test (`generated-docs/specs/api-smoke-test.sh`) and update the §Backend connectivity table's `Smoke-test status` and `Smoke-test verified at` in `generated-docs/project.md`. Useful when the backend was unavailable during INTAKE (Shape 3) and is now ready, or to re-confirm before going live.

## Steps

### Step 1 — Read Project State

Read all available data sources in parallel (skip any that don't exist):

| Data | Source | What it tells us |
|------|--------|-----------------|
| Mode & data source | `generated-docs/project.md` → §Data Source & Backend Integration | api-in-development, existing-api, new-api, mock-only |
| Mock layer active? | `web/.env.local` → `NEXT_PUBLIC_USE_MOCK_API` | Whether mocks are on or off |
| Endpoint provenance | `generated-docs/specs/api-spec.yaml` → `x-source` per endpoint | User-provided vs. inferred |
| Requirement mapping | `generated-docs/specs/api-spec.yaml` → `x-requirements` per endpoint | Which R/BR numbers each endpoint covers |
| Drift detection | Diff `api-spec.yaml` against `generated-docs/specs/mock-spec-snapshot.yaml` | Have spec changes occurred since last mock refresh? |
| Last refresh timestamp | `generated-docs/specs/mock-spec-snapshot.yaml` → `# Generated:` header comment | When `/api-mock-refresh` was last run |
| Handler coverage | Cross-ref spec endpoints against `web/src/mocks/handlers.ts` | Any endpoints missing mock handlers? |
| Backend connectivity | `generated-docs/project.md` → §Backend connectivity table | Verified base URL, auth scheme, smoke-test status |

**If no API spec exists** (`generated-docs/specs/api-spec.yaml` not found): Display "No API spec found. `design-api-agent` is invoked on-demand during BUILD when an endpoint is needed — start BUILD or trigger it explicitly to generate one." and stop.

### Step 2 — Build Status Output

Assemble the output using the sections below. Adapt based on what data is available.

#### Header Box

```
API Status
──────────
  Mode:         [Data source from project.md §Data Source, e.g. "API in development (mocked)"]
  Mock layer:   [Active/Inactive based on NEXT_PUBLIC_USE_MOCK_API]
  Spec:         generated-docs/specs/api-spec.yaml
  Last refresh: [timestamp from snapshot header, or "N/A" if no snapshot]
```

#### Endpoint Provenance

Parse every operation (method + path) from the spec's `paths` section. For each, read:
- `x-source` — if missing, treat as `user-provided` (implicit default for copy-path specs and pre-provenance specs)
- `x-requirements` — the R/BR numbers this endpoint covers

Display a table:

```
Endpoint Provenance ([N] user-provided, [M] inferred, [total] total)
────────────────────
  GET    /v1/users                    [icon] User spec    R1, R3
  POST   /v1/users                    [icon] User spec    R4
  PUT    /v1/users/{id}/permissions   [icon] Inferred     R5, BR2
```

Use `✅` for user-provided endpoints and `⚠️` for agent-inferred endpoints.

**When `dataSource` is NOT `api-in-development`:** Skip the provenance breakdown (all endpoints are authoritative). Just list endpoints with their requirement mappings.

#### Drift Detection

**Only show this section when `dataSource` is `api-in-development`.**

Compare `generated-docs/specs/api-spec.yaml` against `generated-docs/specs/mock-spec-snapshot.yaml`:

- If no snapshot exists: "No mock snapshot found. Mock handlers may not have been generated yet."
- If specs are identical: "Spec and mock snapshot are in sync."
- If specs differ: List the differences using the endpoint matching rules:
  - **Match key:** HTTP method + normalized path template (parameter names ignored, trailing slashes ignored)
  - Show added endpoints, removed endpoints, and schema-changed endpoints

```
Drift Detection
───────────────
  ⚠️ Spec has changed since last mock refresh.
     Run /api-mock-refresh to reconcile.

  Changed since snapshot:
  - PUT /v1/users/{id} — response schema differs
  - GET /v1/users/{id}/activity — new endpoint (not in snapshot)
```

#### Handler Coverage

Cross-reference spec endpoints against `web/src/mocks/handlers.ts`. For each spec endpoint (method + path), check whether a corresponding handler exists in the file.

```
Handler Coverage
────────────────
  ✅ All [N] spec endpoints have mock handlers.
```

Or if gaps exist:

```
Handler Coverage
────────────────
  ⚠️ [M] of [N] spec endpoints are missing mock handlers:
  - POST /v1/notifications/send
  - GET /v1/reports/{id}/export
```

#### Backend Connectivity

Read the §Backend connectivity table from `generated-docs/project.md`. Display based on shape:

**Shape 1 (skipped):**
```
Backend Connectivity
────────────────────
  Skipped: [reason — e.g. "dataSource=mock-only"]
```

**Shape 2 (verified):**
```
Backend Connectivity
────────────────────
  ✅ Verified [verifiedAt]
     Base URL:    [baseUrl]
     Auth:        [authScheme] via [authHeader]
     Smoke test:  [METHOD endpoint] → [verifiedStatus]
     Artifact:    generated-docs/specs/api-smoke-test.sh
     Notes:       [notes if any]
```

**Shape 3 (captured but unverified):**
```
Backend Connectivity
────────────────────
  ⚠️  Captured but not verified — proceed with caution
     Base URL:       [baseUrl]
     Auth:           [authScheme] via [authHeader]
     Smoke test:     [METHOD endpoint] → not yet verified
     Notes:          [Smoke-test notes]
     Artifact:       generated-docs/specs/api-smoke-test.sh
     Re-run with:    /api-status --check
```

**No §Backend connectivity table (skipped or never run):**
```
Backend Connectivity
────────────────────
  Not yet captured. The api-connectivity-agent runs during INTAKE smoke-test step.
```

### Step 3 — Display

Output the assembled status as a single formatted message. This is read-only — do not modify any files.

### Step 4 — `--check` mode (only when the flag is passed)

Skip this step unless the user invoked `/api-status --check`.

When invoked, perform the following sequence after Step 3:

1. **Load the §Backend connectivity table from project.md.** If the table is absent or Shape 1 (skipped), output "Nothing to check — backend connectivity wasn't configured during INTAKE. Re-run `/start` if you want to add it." and stop. If `Credential env vars` is empty, stop with the same message **unless** `Smoke-test mode` is `reachability-only` — that mode has no credentials by design (cookie-session auth), so proceed: the artifact runs unauthenticated and a `401`/`403` is a pass (per Step 5).

2. **Verify the artifact exists.** If `generated-docs/specs/api-smoke-test.sh` is missing, output:
   > "The smoke-test artifact is missing. Re-run INTAKE smoke-test step to regenerate it."
   > Stop.

3. **Verify env vars are set in `web/.env.local`** for each name in `credentialEnvVars` — presence only, never read or echo values:

   ```bash
   node -e "require('dotenv').config({path:'web/.env.local'}); console.log(process.env.API_TOKEN ? 'set' : 'unset')"
   ```

   If any are unset, list them and stop.

4. **Run the artifact** with env vars sourced from `web/.env.local`:

   ```bash
   ( set -a; . web/.env.local 2>/dev/null; set +a; bash generated-docs/specs/api-smoke-test.sh )
   ```

   Capture the HTTP status. Do NOT print response bodies that might contain tokens or PII (truncate to status only on this command).

5. **Update project.md §Backend connectivity:**
   - First read `Smoke-test mode`. When it's `reachability-only` (cookie-session auth), a `3xx` redirect, `401`, or `403` counts the same as a 2xx below — the backend was reached and is enforcing auth; only a transport failure (DNS / connection refused / timeout) or a `404`/`5xx` is a real failure.
   - On success (2xx — or `401`/`403` in reachability-only mode): set `Smoke-test status` to verified, `Smoke-test verified at` to the current ISO 8601 timestamp, and clear `Smoke-test notes` (Shape 3 → Shape 2 transition).
   - On failure: record a short failure summary in `Smoke-test notes`; keep `Smoke-test status: null-deferred`.

6. **Display the new outcome.** On success: "✅ Re-verified — endpoint returned [status] at [timestamp]." (In reachability-only mode a `401`/`403` here means reachable + auth enforced.) On failure: "❌ Re-check failed: [category]. [remediation hint]."

This step is the only place `/api-status` writes to disk. Keep the update minimal — only the `Smoke-test status`, `Smoke-test verified at`, and `Smoke-test notes` rows.
