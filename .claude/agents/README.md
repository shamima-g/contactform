# Claude Code Agents

Specialised Claude Code agents that support the epic-branch workflow (**INTAKE → PLAN → BUILD → EPIC-END → MANUAL-TEST → COMPLETE-ON-BRANCH → COMPLETE**) for building features in this template.

For the phase model, gates, autonomy policy, and orchestration rules see [WORKFLOWS.md](../WORKFLOWS.md), [agent-autonomy.md](../shared/agent-autonomy.md), and [orchestrator-rules.md](../shared/orchestrator-rules.md). This file is just the agent inventory.

## Live Agents

| Phase | Agent | Description |
|-------|-------|-------------|
| **INTAKE** | intake-agent | Scan `documentation/`, run the project-basics checklist, produce `project.md` (Case A) or the new epic's `brief.md` (a later epic) |
| **INTAKE** | api-connectivity-agent | At end of INTAKE, parse the OpenAPI spec's `securitySchemes`, capture missing auth details, and run a curl smoke test before PLAN begins |
| **PLAN** | feature-planner | Propose stories for the current epic; returns structured proposals for orchestrator approval |
| **BUILD** (on-demand) | design-api-agent | Generate `generated-docs/specs/api-spec.yaml` from `project.md` + the epic's `brief.md` when an API is needed and no user-provided spec exists |
| **BUILD** (on-demand) | design-style-agent | Generate CSS design tokens and a style reference guide from branding requirements in `project.md` |
| **BUILD** (on-demand) | type-generator-agent | Generate TypeScript types and typed endpoint functions from the canonical OpenAPI spec |
| **BUILD** (on-demand) | mock-setup-agent | Generate MSW mock handlers from the OpenAPI spec and wire up browser mock infrastructure |
| **BUILD** (batched up front) | test-generator | Write failing Vitest + React Testing Library tests AND a Playwright spec before implementation — all stories generated in one parallel batch at BUILD start (Step B0.2) |
| **BUILD** (per story) | developer | Implement the story so failing tests pass; reads `project.md` + the epic's `brief.md` as source of truth |
| **EPIC-END** | code-review-runner | Run `/code-review --fix` over the epic diff once, **inside a subagent** so the diff-reasoning stays out of the orchestrator context; apply fixes to the working tree, write findings to a gitignored file, return its path + a status line (orchestrator reads the file, then guards + re-verifies). |
| **EPIC-END** | playwright-runner | Batched-mode: run all the epic's Playwright specs once, write the JSON report to a gitignored file, and return its path + exit code (orchestrator reads the file). Re-invoked in `epic-end-fix` mode for per-story fix cycles. |

Per story under epic-branch, the choreography is `developer → inline light gate (lint + test-quality) → commit` — there is no per-story review agent. Test generation is batched up front (Step B0.2). At epic-end the full `/quality-check` runs inline (Step B7.0), then the `code-review-runner` subagent runs the `/code-review --fix` pass (Step B7.0.5), then `playwright-runner` runs the E2E specs (Step B7.0.6) — all once per epic (Steps B7.0–B7.0.6 in `commands/continue.md`).

---

## Available Agents

### INTAKE

#### 1. Intake Agent

**File:** [intake-agent.md](intake-agent.md)

**Purpose:** First agent of the workflow. Scans `documentation/` for existing material, runs a small project-basics checklist (auth, backend, roles), and produces `project.md`. Has four modes — `produce` (Case A — writes `project.md` only; `feature-planner` `decompose` carves the epics), `epic-only` (the brief writer — Case A loop after the epic-plan approval, and once for a new epic added later), `split-brief` (migration), `revise` (INTAKE-approval rejection).

**When to use:**
- Always runs first when starting a new epic via `/start`
- Automatically invoked by the orchestrator

**Key outputs (mode-dependent):**
- `generated-docs/project.md` (produce / split-brief)
- `generated-docs/epics/<slug>/brief.md` (produce / epic-only / split-brief)

---

#### 2. API Connectivity Agent

**File:** [api-connectivity-agent.md](api-connectivity-agent.md)

**Purpose:** Runs at the end of INTAKE when the brief specifies a real backend. Parses `securitySchemes` from the OpenAPI spec, captures any missing auth details from the user, and runs a curl smoke test before PLAN begins. Catches credential / connectivity problems before BUILD wastes time on them.

**When to use:**
- After `intake-agent` finishes, only when the brief points to a real backend
- Automatically invoked by the orchestrator

---

### PLAN

#### 3. Feature Planner

**File:** [feature-planner.md](feature-planner.md)

**Purpose:** Drives PLAN. Single-mode: proposes 2–8 stories for the current epic by reading `project.md` (inherited facts) and the epic's `brief.md` (this epic's requirements). Returns a structured proposal; the orchestrator presents the stories approval and persists the result.

**Key outputs (after orchestrator persistence):**
- `generated-docs/epics/<slug>/stories/story-<N>-<slug>.md` — one file per story, carrying all metadata (title, summary, requirementIds, roles, route, targetFile, `acceptanceCriteria` with `{id,text,coverage}` tags, manualTestChecklist, isInfrastructureOnly)

---

### BUILD — on-demand artifact generators

These four agents run at the start of BUILD only when their artifact is needed and not already user-provided. `project.md` (§Data Source, §Styling) records which ones are needed.

#### 4. Design API Agent

**File:** [design-api-agent.md](design-api-agent.md)

**Purpose:** Designs a complete OpenAPI specification from `project.md` + the epic's `brief.md` for API-first development. Skipped when a user-provided spec already exists in `documentation/`.

**Key outputs:**
- `generated-docs/specs/api-spec.yaml`

---

#### 5. Design Style Agent

**File:** [design-style-agent.md](design-style-agent.md)

**Purpose:** Formalises styling and branding requirements into CSS design tokens (`:root` / `.dark` in oklch, replacing Shadcn defaults in `globals.css`) plus a style reference guide for things CSS can't express (typography, spacing, motion, accessibility).

**Key outputs:**
- `generated-docs/specs/design-tokens.css`
- `generated-docs/specs/design-tokens.md`

---

#### 6. Type Generator Agent

**File:** [type-generator-agent.md](type-generator-agent.md)

**Purpose:** Generates TypeScript interfaces and typed API endpoint functions from the canonical OpenAPI spec. Eliminates redundant type inference inside BUILD and keeps types consistent across stories and tests. Also re-runs during `/api-mock-refresh` when schema changes are detected.

**Key outputs:**
- `web/src/types/api-generated.ts`
- `web/src/lib/api/endpoints.ts`

---

#### 7. Mock Setup Agent

**File:** [mock-setup-agent.md](mock-setup-agent.md)

**Purpose:** Generates MSW mock handlers from the OpenAPI spec and wires up the browser mock infrastructure, so the BUILD loop can run against deterministic mocked responses when no live backend is available.

---

### BUILD — per-story loop

Test generation runs batched up front for all stories (Step B0.2). Then, for each story, the orchestrator runs: **developer → inline light gate (lint + test-quality) → commit** — no per-story review agent. A light-gate failure triggers a scoped fix cycle (developer → re-run the gate), with a max of 3 cycles before escalation. Playwright is **not** run per story — it runs batched at epic-end (Step B7.0.6, last, against the production build), as do the full `/quality-check` (Step B7.0) and the `/code-review --fix` review pass (Step B7.0.5).

#### 8. Test Generator

**File:** [test-generator.md](test-generator.md)

**Purpose:** Generates failing Vitest + React Testing Library tests AND a Playwright end-to-end spec **before** implementation. The tests encode the acceptance criteria as executable code; the Playwright spec is written here but executed later — batched at epic-end via `playwright-runner`, before the user's manual verification.

**Key outputs:**
- `web/src/__tests__/...` (Vitest)
- `web/e2e/epic-<slug>-story-<N>-<title>.spec.ts` (Playwright)

---

#### 9. Developer

**File:** [developer.md](developer.md)

**Purpose:** Implements exactly one story at a time. Reads `project.md` + the epic's `brief.md` as the source of truth, consumes `prototype-src/` when present, applies the agent autonomy policy, and halts only on always-halt conditions. Makes the failing tests pass using App Router, Shadcn UI, and the project's API client.

---

#### 10. Playwright Runner

**File:** [playwright-runner.md](playwright-runner.md)

**Phase:** EPIC-END (not per-story).

**Purpose:** Runs the epic's Playwright specs once (batched) when the last story is committed, writing the JSON reporter output to a gitignored file (`web/test-results/e2e-epic-<slug>.json`) and returning only that path plus the process exit code. The orchestrator **reads the file** for ground truth (the runner never transcribes results — a haiku model reproducing large JSON inline proved unreliable), attributes each failing spec to its story (via the `epic-<slug>-story-<N>` filename), and drives per-story fix cycles, re-invoking the runner in `epic-end-fix` mode until green or 3-cycle escalation.

---

#### 11. Code-Review Runner

**File:** [code-review-runner.md](code-review-runner.md)

**Phase:** EPIC-END (not per-story).

**Purpose:** Runs `/code-review --fix` over the epic's branch diff once (Step B7.0.5), **inside a Task subagent** so the review's large diff-reasoning is discarded with the subagent's transcript instead of accumulating in — and being re-read from — the orchestrator's session every subsequent turn (a significant, avoidable share of orchestrator token cost). It applies its fixes to the shared working tree, writes findings to a gitignored file (`web/test-results/code-review-epic-<slug>.json`), and returns only that path plus a `REVIEW_STATUS` line. The runner **inherits the orchestrator's model**, so review quality is identical to running it inline — the only change is context isolation, mirroring how `playwright-runner` isolates the E2E output. The orchestrator reads the file, then still owns the two judgments the diff can't make (guarding deliberately-accepted limitations via `git diff`, and re-verifying green by re-running the quality-check), commits, and drives any review→fix cycle.

---

## Workflow at a Glance

1. **INTAKE** — `intake-agent` (`project.md`) → (if backend) `api-connectivity-agent` → `feature-planner` `decompose` (epic plan) → **INTAKE approval: approve `project.md` + epic plan (Case A) or just the epic's `brief.md` (a later epic)**
2. **PLAN** — `feature-planner` (`stories` mode) proposes stories for this epic → **Stories approval: approve stories**
3. **BUILD** — on-demand artifact agents run once at the start (whatever `project.md` flags); `test-generator` batches all stories' tests up front; then per story: `developer` → inline light gate (lint + test-quality) → commit
4. **EPIC-END** — the orchestrator runs the full `/quality-check` suite inline, then the `code-review-runner` subagent runs a `/code-review --fix` pass over the epic diff, then `playwright-runner` runs all the epic's specs once (batched) against the production build; per-story fix cycles on failure
5. **MANUAL-TEST** — user walks the per-story manual checklist (**manual-test approval**)
6. **COMPLETE-ON-BRANCH → COMPLETE** — PR opened, CI, user-approved merge, branch deleted, state frozen on main

Halt conditions live in [agent-autonomy.md](../shared/agent-autonomy.md). Agents proceed autonomously for standard decisions and only halt on the "always halt" categories (security, contract, project-level decisions).

### Quick Quality Check

Outside the BUILD loop, run all 4 gates at any time:

```
/quality-check
```

---

## Persistent State

| File | Created By | Read By |
|------|------------|---------|
| `generated-docs/project.md` | intake-agent (Case A or split-brief) | All agents (project facts) |
| `generated-docs/epics/<slug>/brief.md` | intake-agent (all modes) | All BUILD agents (epic requirements) |
| `generated-docs/epics/<slug>/state.json` | epic-state.js (init) + orchestrator (Edit) | Hooks (resolve-state-path.js), dashboard |
| `generated-docs/epics/<slug>/stories/story-<N>-<slug>.md` | feature-planner (via orchestrator persistence) | test-generator, developer |
| `generated-docs/epics/<slug>/journal.md` | developer (via orchestrator append at commit) | User; dashboard |

State.json lives only on the active `epic/<slug>` branch during the epic's lifecycle. After PR merge it becomes the frozen historical record on main with `phase: COMPLETE`.

---

## Workflow State Management

### Scripts

| Script | Purpose |
|--------|---------|
| `resolve-state-path.js` | Resolves the active `state.json` path from the current git branch (used by hooks and other scripts) |
| `epic-state.js` | `--init` only — creates `state.json` on a fresh `epic/<slug>` branch at `phase: PLAN`. All other mutations are performed by the orchestrator via Edit. |
| `mark-epic-complete.js` | `--slug <slug>` — flips a merged epic's `state.json` from `COMPLETE-ON-BRANCH` to `COMPLETE` on main (a dedicated CLI because Edit's file tracking doesn't survive branch switches) |
| `lib/epic-state.js` | Schema constants (phases, statuses, transition graph) + default-state factory |
| `migrate-legacy-state.js` | Path A of `/migrate-legacy` only (legacy → 4-phase). Slated for deletion with the migration tool. |
| `lib/workflow-helpers.js` | Legacy helpers — used only by `migrate-legacy-state.js`. |

Phase transitions are **not** scripted: the orchestrator advances `state.json.phase` with the `Edit` tool, following the transition graph in `lib/epic-state.js`. The two CLIs above exist only for the cases that must be deterministic with no LLM in the loop (initial state creation, and the post-merge flip on main).

### Verifying script output

`resolve-state-path.js`, `epic-state.js`, and `mark-epic-complete.js` emit JSON — check it before proceeding: `"status": "ok"` / `"initialised"` → proceed; `"status": "error"` → **stop** and report.

### Recovery

State is trivially recoverable — the branch name plus the per-epic `state.json` are the whole story. After a session break, `git checkout epic/<slug>` and re-run `/continue`; inspect with `cat generated-docs/epics/<slug>/state.json` (resolve the path via `resolve-state-path.js`). There is no repair script.

---

## Creating Custom Agents

Model new agents on an existing one (e.g. [developer.md](developer.md) for a per-story actor, [intake-agent.md](intake-agent.md) for a single-call orchestrator-driven agent). The minimum each agent needs:

1. YAML frontmatter with `name`, `description`, `model`, and `tools`
2. Clear purpose and "when to use"
3. Step-by-step workflow
4. DO / DON'T guidelines
5. Example return shape (agents return structured text to the orchestrator — they do not talk to the user directly)

---

## Related Documentation

- [Agent Workflow Guide](../../.template-docs/users/Help/Agent-Workflow-Guide.md) — user-facing workflow walkthrough
- [Project README](../../README.md) — project overview and setup
- [CLAUDE.md](../../CLAUDE.md) — Claude Code configuration for this project
- [Tests Verify User-Observable Behavior](../../CLAUDE.md) — testing principle and policy pointer
