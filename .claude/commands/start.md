---
description: Start building an epic — a new project runs INTAKE then builds the first epic; an existing one builds the next (a parked epic, or a draft/new one planned inline). To plan ahead without building, use /plan.
---

Start a new feature workflow. This command runs INTAKE only; PLAN and BUILD are handled by `/continue`, which is invoked automatically after the INTAKE approval.

**Read and follow all rules in [orchestrator-rules.md](../shared/orchestrator-rules.md).**

## Dispatch

After Step 0 (setup), check for `generated-docs/project.md`:

- **Exists → Build the next epic:** see [Build the next epic](#build-the-next-epic-projectmd-exists) below — `/start` is the build entry point. Build an already-planned (`READY-TO-BUILD`) epic, or set up and build a draft/new epic (planning its stories inline, then building through). To plan the next epic *ahead* without building it — e.g. in a second session while this one builds — use [`/plan`](plan.md) instead.

- **Does not exist, legacy `generated-docs/context/workflow-state.json` present → route to `/migrate-legacy`.** The migration tool converts legacy artifacts to the epic-branch layout. After migration runs, /start re-dispatches and lands in the build-the-next-epic path.

- **Neither exists → Case A (first-time project setup):** full INTAKE (steps below). The intake-agent produces `project.md`; `feature-planner` then **decomposes** the spec into all epics; after the epic-plan approval, `project.md` + `epic-plan.md` + one `brief.md` per epic are committed to main, and the first ready epic is planned and built on its `epic/<slug>` branch.

The handoff to `/continue` is automatic in all cases.

## Flow (Case A — first-time project setup)

```
/start → [setup check] → [welcome + onboarding routing]
       → [scan-doc.js ∥ api-connectivity-agent spec analysis]   (parallel)
       → [3-question checklist: auth, backend, roles]
       → [api-connectivity-agent smoke test]   (skipped when dataSource ∈ {mock-only, new-api})
       → [intake-agent produce mode → project.md]
       → [feature-planner decompose → epic plan (epics + deps + coverage + blockers)]
       → ── INTAKE approval (two-step): resolve blockers → approve project setup + epic plan ──
            (plan revisions → feature-planner decompose; project.md revisions → intake-agent revise)
       → [commit project.md + epic-plan.md + all epic briefs to main]
       → [create the first ready epic's branch, initialise state.json]
       → [invoke /continue inline]
```

Every epic except the first lands on main as a **draft** (a `brief.md` with no `state.json`) — `/plan` (to plan it ahead) or `/start` (to build it) picks them up later.

---

## Step 0: Setup Check

Probe state with two Bash calls — **issue both in the same assistant response** so they run in parallel:

```bash
test -d web/node_modules && echo "installed" || echo "missing"
test -f .claude/preferences.json && echo "configured" || echo "missing"
```

**Both present →** "Project setup is complete." Set `backgroundInstallTaskId = null`, `verificationPending = false`. Go to Step 1.

**Otherwise, run the missing pieces concurrently** — issue the install Bash call and the `AskUserQuestion` in the **same assistant response** so the install overlaps the user's git-prefs answer:

- **`needsInstall` →** `(cd web && npm install)` with `run_in_background: true`. Capture the task ID as `backgroundInstallTaskId`; set `verificationPending = true` (Step 8.5 blocks on it before commit).
- **`needsPreferences` →** ask via `AskUserQuestion`: "How should Claude handle git commits and pushes?" Options: *Auto-approve both (recommended) / commits only / pushes only / Always ask*. Whatever isn't auto-approved, the workflow asks before each time per [orchestrator-rules.md §Git Commit & Push Authorization](../shared/orchestrator-rules.md#git-commit--push-authorization-mandatory). Map → `node .claude/scripts/init-preferences.js --autoApproveCommit <true|false> --autoApprovePush <true|false>`. Don't use Write to create files in `.claude/` (prompts); the node script is auto-approved.

Post a one-liner ("Setup primed — dependencies installing in the background.") and continue to Step 1.

> **If Node.js isn't installed** — the background `npm install` fails with "node/npm is not recognized", or the user reports a repeating Windows "Select an app to open 'node'" popup — the fix is: install the LTS version from [nodejs.org](https://nodejs.org), **fully close and reopen VS Code** so it picks up the new PATH, then re-run `/start`. Don't work around it with a `node`/`npm` shim or stand-in file; it doesn't fix the PATH.

---

## Step 1: Confirm First-Time Entry

`/start` is the **first-time-only** entry point for a project. Dispatch has already determined this is Case A (no `generated-docs/project.md` on main). One safety guard:

- **Already on an `epic/*` branch?** (`git symbolic-ref --short HEAD` starts with `epic/`) → an epic is already in flight; this isn't a fresh start. Redirect and stop: *"You're on `epic/<slug>` — run `/continue` to resume it, or `git checkout main` first to begin a new epic."*
- **Otherwise** → proceed. There is no state file to initialise here: per-epic `state.json` is created on the epic branch at Step 9 (after the INTAKE approval), and resuming an interrupted intake is `/continue`'s job while planning or building a further epic is handled by `/plan` and `/start`'s build-the-next-epic path — not a third `/start` path.

## Step 2: Open Dashboard (Fire-and-Forget)

```bash
node .claude/scripts/generate-dashboard-html.js --collect
start "" "generated-docs/dashboard.html"
```

On script failure, output `"Dashboard generation failed — you can run /dashboard manually later."` and continue.

## Step 3: Welcome + Onboarding Routing

Pre-scan `documentation/` so the welcome message reflects what's there:

```bash
node .claude/scripts/scan-doc.js documentation/ --keywords auth,role,BFF,compliance,mock,api
```

Parse the JSON output. Welcome line based on scan result (check prototype condition first):

- **`documentation/genesis.md` or `documentation/prototype-src/` present:** "I see prototype artifacts in `documentation/` ([detected files]). We'll use those as the starting point."
- **Other substantive files:** "I see you have [N files] in `documentation/` including [2–3 key items]. We'll work with whatever's there."
- **Empty or `.gitkeep`-only:** "I don't see anything in `documentation/` yet — that's fine, we have several ways to get started."

Then ask the routing question via `AskUserQuestion`:

- **Question:** "How would you like to get started?"
- **Options:**
  - **"I have a prototype repo to import"** *(Recommended unless docs are clearly non-prototype)* — "Import artifacts from a prototyping tool repo (docs, design tokens, React source)."
  - **"I have existing docs to share"** — "Copy project materials (specs, requirements, wireframes, API docs) into `documentation/`."
  - **"Let's build requirements together"** — "I'll ask questions and we'll define the requirements from scratch."

Pre-tick rules (per Test Run 24 finding U1):

| Scan result | Recommended option |
|---|---|
| `documentation/` empty or `.gitkeep`-only | "I have a prototype repo to import" |
| `documentation/genesis.md` / `prototype-src/` / `project.pen` present | "I have a prototype repo to import" |
| Substantive non-prototype files (BRD, OpenAPI spec) | "I have existing docs to share" |

Guided Q&A is never recommended — it's the fallback when the user lacks materials.

### Option A: Share existing materials (`onboardingPath = "docs"`)

**Skip-rule (avoid redundant "ready?" prompt):**

If the Step 3 `scanResult` already shows substantive non-prototype files in `documentation/` (the same condition that pre-recommended this option — BRD, OpenAPI spec, requirements doc, etc.), the user has implicitly confirmed by picking this option. Do NOT ask the follow-up question. Instead, post a single one-liner acknowledgement and proceed directly to Step 4:

> "Working with the files already in `documentation/`. If you want guided Q&A instead, say so before I read the brief back to you."

Proceed to Step 4 with `projectDescription = null`.

**Otherwise** (the user picked Option A but `documentation/` was empty or `.gitkeep`-only — they intend to drop files in now):

> "Drop whatever you have into `documentation/` — feature specs, requirements docs, API schemas, wireframes, design files, meeting notes. Anything goes. I'll work with whatever's there."

Then via `AskUserQuestion`:
- **Question:** "Let me know when your files are in place."
- **Options:** "Ready, I've added my files" / "Actually, let's do guided Q&A instead"

If "Ready": proceed to Step 4 with `projectDescription = null`.
If "Q&A": switch to Option C.

### Option B: Prototype Import (`onboardingPath = "prototype"`)

Ask as plain text (not `AskUserQuestion`):

> "What's the path to your prototype repo? You can use an absolute path (`C:\Git\my-prototype`) or a relative path (`../my-prototype`)."

Run:

```bash
node .claude/scripts/import-prototype.js --from "<user-provided-path>"
```

If `status: "ok"`: display a summary of what was imported — requirements file, design tokens, API specs, prototype screen count, mock data, stories index. Then proceed to Step 4 with `projectDescription = null`.

If `status: "error"`: display the error. Via `AskUserQuestion`:
- "Let me fix the path and try again" → re-ask
- "I'll copy files manually instead" → switch to Option A
- "Let's do guided Q&A instead" → switch to Option C

### Option C: Guided Q&A (`onboardingPath = "qa"`)

Ask as plain text:

> "What are you building? Give me the elevator pitch — who's it for, what does it do, and what's the core problem it solves. As much or as little detail as you like."

Capture the response as `projectDescription`. Proceed to Step 4.

---

## Step 4: Pre-Intake Parallel — Spec Analysis

The deep documentation scan ran in Step 3 (`scan-doc.js`); its JSON output already populates the welcome message and pre-ticks the checklist. The only agent that needs to run here is `api-connectivity-agent` Call A — fire it now so its result is ready by the time the checklist completes.

- **`api-connectivity-agent`** Call A — spec analysis, returns smoke-test plan or empty plan when no spec exists.

Hold the Step 3 scan JSON in working memory; you'll pass it to `intake-agent` produce mode in Step 7 as `scanResult`. The agent does not run in scan-preview mode — produce mode receives the orchestrator's scan and synthesises everything in one call.

---

## Step 5: Checklist — 3 Questions

Ask three questions via batched `AskUserQuestion` calls. Inferred answers from Step 4's scan pre-tick options where applicable.

### Q1 — Roles Template

- **Question:** "Which roles template fits your app?"
- **Options** (per [roles-snippets.md](../shared/roles-snippets.md)):
  - "SaaS Standard" — Owner / Admin / Member / Viewer
  - "Internal Tool" — Admin / User
  - "Marketplace" — Buyer / Seller / Moderator
  - "Editorial" — Editor / Author / Contributor / Reader

The auto-`"Other"` affordance handles `custom`. Pre-tick the inferred template if the scan returned one.

Silent accept on the four explicit templates: post a one-line acknowledgement ("Captured: [roles list]. You can refine in the brief at the INTAKE approval.") and continue. No drilldown.

### Q2 — Authentication Method

Always asked explicitly per [authentication-intake.md](../policies/authentication-intake.md) — **never inferred**.

- **Question:** "How will users authenticate?"
- **Options:**
  - "Backend For Frontend (BFF)" — "Backend handles OIDC login/logout, sets cookies. Frontend calls backend for user info."
  - "Frontend-only (next-auth)" — "Next.js handles auth directly using next-auth. **Note:** API calls won't carry session context — protects frontend routes only."
  - "Custom" — "I have a different authentication/authorization approach."

**Conditional follow-ups (fire after Q2 returns):**
- **BFF:** plain-text prompts for login URL, userinfo URL, logout URL. Display backend-requirements + CI-implication note per [authentication-intake.md](../policies/authentication-intake.md) Rule 4.
- **Frontend-only:** display the trade-off warning per [authentication-intake.md](../policies/authentication-intake.md) Rule 5.
- **Custom:** plain-text prompt — "Describe your auth/authorization approach."

### Q3 — Backend Readiness

- **Question:** "Is your backend API up and running?"
- **Options:**
  - "Yes, it's running" — `dataSource: existing-api`
  - "No, still in development" — `dataSource: api-in-development`, mock layer required
  - "N/A — no backend API" — `dataSource: mock-only`

Combined with the scan's `hasApiSpec`, derive `dataSource` per the table in the existing decision matrix (collapsed):

| Spec exists | Backend status | dataSource |
|---|---|---|
| Yes | Running | `existing-api` |
| Yes | In dev | `api-in-development` |
| Yes | N/A | `mock-only` |
| No | Running | `new-api` |
| No | In dev | `api-in-development` |
| No | N/A | `mock-only` |

---

## Step 6: Smoke Test (skipped when dataSource is `mock-only`, or `new-api` without BFF endpoints)

Gate on the resolved `dataSource`: run `api-connectivity-agent` Call B when `dataSource` is `existing-api` (backend running); when `api-in-development`, run Call A only and defer (Shape 3 — backend not up yet); skip for `mock-only`. For `new-api` (backend running, no spec): skip **unless** BFF endpoints were captured (§Authentication) — then run a **reachability-only** Call B against the BFF `userinfo` URL, since a running backend with a known endpoint can be probed even without a spec. Auth method otherwise doesn't change the gate. Procedure per [api-connectivity-agent.md](../agents/api-connectivity-agent.md): up to 3 attempts (Call B + 2 × Call C), curl-fallback, Shape 1/2/3.

For cookie-session auth, this verifies reachability only — never ask the user for login credentials (see [authentication-intake.md](../policies/authentication-intake.md) § Backend API Auth Rule 10 for the allowed credential-handling options).

The agent **returns** `backendConnectivity` (Shape 1/2/3, including the `reachabilityOnly` flag) — it does not write project.md itself; `intake-agent` records it at Step 7 during INTAKE. (A later backend re-check persists via the [§6.1 project-change flow](../policies/epic-branch-concurrency.md#§61-project-level-changes); `/api-status` and `/api-go-live` write these rows on re-verification.)

Skip with a one-liner ("Backend connectivity check skipped (dataSource=[value]).") when not applicable.

---

## Step 7: Produce project.md (intake-agent)

Launch `intake-agent` in `produce` mode — it writes **`project.md` only** (no epic, no brief; the epics come from decomposition in Step 7.5):

```
mode: produce
onboardingPath: <docs | prototype | qa>
projectDescription: <text or null>
checklist:
  authMethod: <bff | frontend-only | custom>
  bffEndpoints: <object or null>
  customAuthNotes: <text or null>
  dataSource: <existing-api | new-api | api-in-development | mock-only>
  backendStatus: <running | in-development | none>
  rolesTemplate: <saas-standard | internal-tool | marketplace | editorial | custom>
  customRoles: <array or null>
backendConnectivity: <Shape 1/2/3 or null — carry the agent's `reachabilityOnly` flag so the `Smoke-test mode` row can be set>
```

The agent reads `documentation/`, writes `generated-docs/project.md`, and returns a `PROJECT SUMMARY` (`projectPath`, `snapshot`, `keyItemsForUserAttention`, `thinSections`). Hold it for the INTAKE approval.

There is no "derive the first epic" step — the epics come from decomposition next, and the first epic to build is just the first *ready* one in the approved plan.

## Step 7.5: Decompose the spec into an epic plan (feature-planner)

Launch `feature-planner` in `decompose` mode:

```
Agent: feature-planner
mode: decompose
project: generated-docs/project.md
scanResult: <the Step 3 scan-doc.js JSON, passed verbatim>
```

The agent reads `project.md` + the spec and returns a `DECOMPOSITION PROPOSAL`: `requirementInventory` (each requirement with the epic it's assigned to), `epics` (goal + `requirementIds` + `dependsOn`), `coverage` (`total` / `assigned` / `unassigned`), and `blockers` (plain-language; empty in the happy path). It writes no files. Hold it for the INTAKE approval.

---

## Step 8: INTAKE approval — Project setup + epic plan (two-step)

The INTAKE approval covers **`project.md` + the epic plan**. Per-epic briefs are written *after* approval (Step 9), so resolving a blocker never rewrites a brief. Two steps: clear blockers, then approve.

### Step 8a — Resolve blockers first

If the `DECOMPOSITION PROPOSAL`'s `blockers` is empty, skip to 8b.

Otherwise surface each blocker **before** the plan can be approved — one at a time, in the agent's plain language (it already applied the Translation Rule; render the three labelled lines verbatim). The `⚠` lead-in is your own one-sentence summary of `blocker.theSnag` — there is no separate headline field on the blocker. For each blocker, output the four-line block as regular text:

```
⚠ [your one-line summary of theSnag — the decision the user must make]

What you asked for: [blocker.whatYouAskedFor]
The snag:           [blocker.theSnag]
What I'd suggest:   [blocker.whatISuggest]
```

Then `AskUserQuestion`:
- **Question:** the recommended fix, phrased as a question
- **Options:** `blocker.options` (recommended first) — the auto-`"Other"` affordance covers "something else"

Re-invoke `feature-planner` `decompose` with `revisionFeedback` describing the user's choice; it returns an updated proposal (re-assigned requirements, a merged/added epic, or a dropped requirement) with `coverage` re-verified. Repeat until `blockers` is empty. **Never let the user approve a plan with an open blocker.**

### Step 8b — Approve project setup + epic plan

Follow the [Approval Pattern](../shared/approval-pattern.md). Output as regular text *before* the `AskUserQuestion` — project facts from Step 7's `PROJECT SUMMARY`, the plan from the (now blocker-free) `DECOMPOSITION PROPOSAL`:

```
Here's the project setup and the plan I've put together.

**Project setup:**
- Roles: [snapshot.rolesTemplate]
- Auth: [snapshot.authMethod]
- Data source: [snapshot.dataSource]
- Compliance: [snapshot.complianceDomains or "None"]

**The plan — [N] epics:**

1. **[Epic name]** — [goal]
   [if dependsOn non-empty:] *Builds on: [dependency epic names]*
2. **[Epic name]** — [goal]
   ...

✓ Everything you asked for is covered — all [coverage.total] requirements are assigned across these epics.

[If keyItemsForUserAttention is non-empty:
**Worth a careful look:**
- [item]
]
[If thinSections is non-empty:
**Sections that translated thinly from your sources (you may want to expand):**
- [section]
]

Full detail: project facts in `generated-docs/project.md`; the epic plan + requirement→epic map will be written to `generated-docs/epic-plan.md` on approval.
```

**Open the editable review page.** Per the [Editable HTML Review Page](../shared/approval-pattern.md#editable-html-review-page-plan-approvals) rules, generate `generated-docs/epic-plan-review.html` from the (blocker-free) `DECOMPOSITION PROPOSAL` and open it in the external browser:

```bash
start "" "generated-docs/epic-plan-review.html"
```

The page renders the epic list with editable names/goals/dependencies (add / remove / reorder), and resolves the **same** approval as the AUQ below. The user can click **Approve** on the page — it auto-copies `{ decision: "epic-plan", edited, epics: [{ name, goal, dependsOn }] }` for them to paste back — or answer in chat. On script failure, output a one-liner and fall back to the in-chat approval.

Then `AskUserQuestion`:
- **Question:** "Ready to lock in this plan and start building the first epic?"
- **Options:**
  - "Approve" — write the plan + briefs, start the first ready epic
  - "Adjust the plan" — change epics / dependencies / which epic owns what (free-text)
  - "Adjust project setup" — roles / auth / backend / compliance / styling (free-text)
  - "Start over" — interpretation is off; clarify path/approach and re-run intake

**Routing revisions:**
- *Pasted `{ decision: "epic-plan", ... }` from the page* → if `edited: false` (or the user typed `approved`), treat as *Approve*. If `edited: true`, the `epics` array is the user's revised plan — re-invoke `feature-planner` `decompose` with the edited epics/goals/dependencies as `revisionFeedback` so coverage is re-verified, then proceed to Step 9 (re-run 8a first if the edit reopened a blocker). Never write the plan straight from the pasted JSON without the coverage re-check.
- *Adjust the plan* → re-invoke `feature-planner` `decompose` with `revisionFeedback`; re-display 8b (re-run 8a first if the change introduces a blocker).
- *Adjust project setup* → re-invoke `intake-agent` `mode: revise` (target: project.md). If a critical field changed (roles / auth / data-source / compliance), re-run `decompose` so the plan reflects it — and **if that re-run surfaces a blocker, go back through 8a before re-displaying 8b** (a compliance change in particular can introduce a regulatory blocker). The "never approve with an open blocker" rule holds on this path too.
- *Start over* → ask plain text — "What should we change about the path or approach? (e.g., 'switch to guided Q&A', 'roles template is wrong', 'my docs were incomplete')" — then re-run from the relevant step.

Loop until approved.

---

## Step 8.5: Background-Work Check

Only run if `verificationPending == true` (set at Step 0). Otherwise skip.

1. **Wait for `npm install`.** If `backgroundInstallTaskId` is still active, wait for it. Non-zero exit → STOP, surface error, do not commit. **On success, pre-warm the E2E browser:** kick off `(cd web && npm run test:e2e:install)` with `run_in_background: true` — don't wait for it or gate the commit on its exit. It downloads Chromium (~130 MB) during PLAN/BUILD so it's usually ready by the epic-end E2E run instead of stalling there (node_modules exists now, so the pinned Playwright CLI is available). Browser binary only (not `--with-deps`), so it never needs root or a `sudo` prompt. If it's slow or fails, no harm here — the epic-end browser-ready gate ([continue.md](continue.md) § Step B7.0.6) reconciles it.
2. **Run verification in parallel.** Issue all three commands as **separate Bash tool calls in a single response**, each with `run_in_background: true`. Do NOT chain them with `&&` and do NOT call them sequentially across responses — that's the difference between a ~15 s gate and a ~45 s one.
   ```bash
   (cd web && npm run typecheck)
   (cd web && npm run lint)
   (cd web && npm run build)
   ```
   Wait for all three to finish. Any non-zero exit → STOP and surface the failure. All pass → set `verificationPending = false` and continue.

---

## Step 9: On Approval — write the plan to main, start the first epic

The whole plan lands on **main** as drafts; the first ready epic then starts on its branch.

**1. Write each epic's `brief.md`.** Loop `intake-agent` `epic-only` once per epic in the approved plan (decomposition-driven). These are independent files — run them as a parallel Task batch:

```
Agent: intake-agent   (one call per epic)
mode: epic-only
epicSlug: <slug>
epicName: <name>
epicGoal: <goal>
assignedRequirements: <[{ name, text }] — this epic's slice of requirementInventory>
```

Each writes `generated-docs/epics/<slug>/brief.md`.

**2. Write `generated-docs/epic-plan.md`** from the approved proposal — see [§ epic-plan.md format](#epic-planmd-format) below.

**3. Commit project.md + the plan + all briefs to main:**

```bash
git add generated-docs/project.md generated-docs/epic-plan.md generated-docs/epics/ documentation/
# plus any API smoke-test script the connectivity agent wrote (path recorded in project.md §Data Source); git add ignores missing paths
git commit -m "docs(project): project setup + epic plan"
git push origin HEAD   # best-effort; skip silently if no remote
```

Every epic is now a **draft** on main (`brief.md`, no `state.json`). Independent drafts can be planned (`/plan`) or built (`/start`) in parallel from other sessions.

**4. Start the first ready epic.** Pick the first epic whose `dependsOn` is empty (a dependency root — nothing is merged yet, so only deps-free epics are ready). If **no** epic has an empty `dependsOn`, the dependency graph has no root (a cycle, or a mis-set dependency from a manual plan edit) — **STOP and report**: name the epics and their `dependsOn`, and ask the user to fix the graph (every plan needs at least one deps-free epic to start from). Otherwise create the chosen epic's branch and initialise state:

```bash
git checkout -b epic/<firstSlug>
node .claude/scripts/epic-state.js --init --name "<firstName>"   # root epic → no --depends-on
git add generated-docs/epics/<firstSlug>/
git commit -m "docs(<firstSlug>): start epic"
git push -u origin epic/<firstSlug>   # best-effort; skip silently if no remote
```

`epic-state.js --init` resolves the path from the current `epic/*` branch and writes `state.json` at `phase: PLAN`. Verify `"status": "initialised"`; on error (e.g. `state.json already exists`), STOP and report. There is no separate phase-transition step — `state.json` starts at `PLAN` by construction.

### epic-plan.md format

`generated-docs/epic-plan.md` is the human-readable plan + dependency graph + coverage map. It holds **plan data only** — live status (not-started / in-flight / done) is derived from git by `/status` and the dashboard, never written here. It is edited **only in a planning context on main** (Step 9, or `/plan` / `/start` adding a new epic) — never on an epic branch (keeps it conflict-free across concurrent epics; see [epic-branch-concurrency.md §6.2](../policies/epic-branch-concurrency.md#§62-shared-evolving-artifacts)). v1 shape (settle refinements against the first real run):

```markdown
# Epic Plan — <Project Name>

Every epic in this project, what it delivers, and what it builds on. Live status
(not started / in flight / done) is shown by `/status` and the dashboard.

> Plan only — edited during planning on `main`, never on an epic branch.

## Epics

| # | Epic | Delivers | Builds on |
|---|---|---|---|
| 1 | <Name> (`<slug>`) | <one-line goal> | — |
| 2 | <Name> (`<slug>`) | <one-line goal> | <Name> (`<slug-1>`) |
| … |

## Coverage

Everything in the spec is assigned to an epic:

| What you asked for | Epic |
|---|---|
| <readable name> (R1) | <Name> (`<slug>`) |
| <readable name> (R2) | <Name> (`<slug>`) |
| … |

_<N> requirements, all assigned._
```

---

## Step 10: Hand Off to /continue

Tell the user (conversationally, one line):

> "Plan approved and committed. Starting the first epic — moving into planning…"

Then invoke `/continue` via the Skill tool. The handoff is seamless — no user prompt.

`/continue` resolves state via `resolve-state-path.js` from the current `epic/<firstSlug>` branch, sees phase `PLAN`, and drives the stories approval. See [continue.md](./continue.md) for the rest of the flow.

---

## Build the next epic (project.md exists)

`project.md` is on main; `/start` here **builds** the next epic. It never parks — planning happens inline when needed, then BUILD runs through. (To plan an epic *ahead* and park it without building — e.g. in a parallel session while this one builds — use [`/plan`](plan.md).) Run it from `main` or the epic's own workspace; it reuses Step 0 (setup check).

### Step B1: Pick what to build

Read readiness and show the recap per the [shared epic picker](../shared/epic-picker.md) (it owns the data call, the `✓ ▸ ◆ ● ⊘` legend, the `hasPlan: false` fallback, and the up-to-3/ready-first convention). Then `AskUserQuestion` — *"What would you like to build next?"* — with these build-verb options:

- **Already-planned epics** (`status: ready-to-build`) — offer each as *"Build <name> (already planned)"*. These were parked by `/plan`; building one needs no re-planning.
- **Drafts** — offer each as *"Plan & build <name>"* (ordered/labelled per the shared picker).
- **"Set up something new"**.

### Step B2: Cut the epic branch fresh from `main`

Every build branch is cut from the **latest `main`**, whichever kind of epic this is — so a
`ready-to-build` plan parked by [`/plan`](plan.md) (which lives on `main`, not a side branch) comes along
with it and is never stale.

- **Already-planned (`ready-to-build`) chosen** → its stories + `state.json` (at `READY-TO-BUILD`) are
  parked on `main`; no branch exists yet. Cut one fresh:

  ```bash
  git fetch origin
  git checkout -b epic/<slug> origin/main       # no remote: git checkout -b epic/<slug> main
  ```

  Invoke `/continue` — it re-enters at `READY-TO-BUILD`, re-checks the parked plan against this fresh
  `main`, and moves into `BUILD`. **Skip B3.**

- **Draft or new chosen** → the epic is **already chosen at B1**, so skip [`/plan`](plan.md) Step 1's
  picker and set it up for a build-through:
  - **New epic** → gather its inputs as in [`/plan`](plan.md) **Step 2** (describe it, then infer and
    confirm project-level facts + dependencies), then land the plan row + brief on `main` via the
    [§6.1 main-landing write](../policies/epic-branch-concurrency.md#§61-project-level-changes).
  - **Draft** → the brief already exists on `main` and was approved with the epic plan — nothing to land.

  Then create the branch from the latest `main` and initialise state:

  ```bash
  git fetch origin
  git checkout -b epic/<slug> origin/main       # includes any plan row + brief just landed
  node .claude/scripts/epic-state.js --init --name "<epicName>" [--depends-on <dep-slug> ...]
  git add generated-docs/epics/<slug>/
  git commit -m "docs(<slug>): start epic"
  git push -u origin epic/<slug>                # best-effort; skip silently if no remote
  ```

  (No remote: `git checkout -b epic/<slug> main`.) `epic-state.js --init` writes `state.json` at
  `phase: PLAN`; verify `"status": "initialised"`, else STOP and report.

  **If the chosen epic is blocked** (a dependency not yet merged), warn the user before proceeding,
  because unlike `/plan`, `/start` builds **now**: branching from `main` means the dependency's in-flight
  code isn't present, so PLAN/BUILD run against a tree missing the shared model/component/endpoint this
  epic was scoped on. Expect BUILD to **halt** if it hits the missing pieces, and a rebase once the
  dependency merges. Only continue if they confirm; otherwise recommend a `ready` epic, or building the
  dependency first.

### Step B3: Hand off to /continue (build-through)

One line to the user (*"Epic `<slug>` set up. Planning and building now…"*), then invoke `/continue`. It runs the PLAN routine and — because this is `/start`, not `/plan` — takes the **BUILD** exit (`PLAN → BUILD`), building the epic through to EPIC-END. The only difference from `/plan` is the exit: `/start` builds, `/plan` parks.

---

## Notes

- **Phase-context hooks** — `inject-phase-context` provides post-compaction snippets for the long-running phases (`plan`/`build`/`epic-end`); it derives the snippet name from `state.json.phase` and no-ops when none exists. INTAKE runs before the branch exists, so it has no snippet.
- **Continuous flow** — `/start` chains into `/continue` directly once the epic branch is created (cut fresh from `main`, including for a parked `ready-to-build` epic).
- **Plan vs build** — `/start` **builds** (planning inline when an epic isn't parked yet); [`/plan`](plan.md) **plans ahead and parks** an epic at `READY-TO-BUILD` on `main` for `/start` to build later (cutting a fresh branch from `main`), including from a parallel session. One shared PLAN routine ([continue.md → Phase: PLAN](continue.md#phase-plan)); the commands differ only at the exit.
- **State authority** — per-epic `generated-docs/epics/<slug>/state.json` on the epic branch is the source of truth for phase and progress (resolved via `resolve-state-path.js`). `/continue` re-enters at whatever phase it shows.
