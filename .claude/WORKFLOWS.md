# AI-Driven Development Workflows

Quick reference for common workflows in this template.

The unit of work is the **epic**. Each epic lives on its own `epic/<slug>` branch and runs through these phases: **PLAN → BUILD → EPIC-END → MANUAL-TEST → COMPLETE-ON-BRANCH → COMPLETE** (the last is the frozen historical record on main). An epic can also be planned ahead and parked at **READY-TO-BUILD** (between PLAN and BUILD) by `/plan`, for `/start` to build later. Project-level facts (roles, auth, data source, compliance, styling) live in `generated-docs/project.md` on main and inherit across all epics.

---

## Workflow 1: Starting a New Project (first epic)

**Scenario:** You just created a new project from this GitHub template.

```bash
# 1. Create from template
Click "Use this template" on GitHub → Name your project → Create

# 2. Clone and open
git clone https://github.com/your-username/your-new-project.git
cd your-new-project
code .  # Opens in VSCode

# 3. Initialize
# In Claude Code chat, type:
/start
# This handles npm install, captures git prefs (whether to auto-approve or
# ask before each commit/push — honored every time), runs INTAKE (Case A): produces
# project.md, breaks your spec into all its epics with a dependency graph and a
# coverage check (the INTAKE approval), writes each epic's brief + epic-plan.md to main, then
# starts the first epic on its epic/<slug> branch and chains into /continue.
# The other epics wait as drafts you can pick up later (and run in parallel).
```

### Expected Timeline

- **Setup:** 2–5 minutes
- **First epic:** depends on complexity (3–8 stories at ~5–15 min each with AI assistance)

---

## Workflow 2: Planning or building the next epic

**Scenario:** Your project has `project.md` on main. You want the next epic — either build it now, or plan it ahead (e.g. in a second session while another epic builds).

**Build it now** — `/start` is the build entry point:

```bash
git checkout main && git pull       # or check out / create the epic's own workspace
/start
# /start offers any already-planned (parked) epic to build, plus drafts and "something
# new". A parked epic's build branch is cut fresh from main (its plan lives there) and
# built; a draft/new one is set up (intake if new, project-facts checklist, dependencies)
# and built through — planning its stories inline, then BUILD. Chains into /continue.
```

**Plan it ahead** — `/plan` gets an epic build-ready without building it, so you can queue work up. Just open a **fresh Claude Code window** on the same project and run it — safe to do while another epic's BUILD is underway in another window:

```bash
/plan
# /plan picks a draft or intakes a new epic, breaks its stories down, gets your approval,
# and parks the epic at READY-TO-BUILD on main — then stops. Later, /start builds it,
# cutting a fresh branch from main. You manage none of the git: /plan does its work in a
# temporary worktree in the background, so it never disturbs a build in another window.
```

### What `/plan` does

1. **Sets up its own background workspace** — all its git work happens in a temporary worktree cut from `main`, so it never touches the window you ran it in (safe alongside a build in another window; nothing for you to set up or clean up)
2. **Picks the epic** — an existing draft, or a brand-new one (epic-only intake, project-facts checklist, dependencies)
3. **Breaks the stories down** and gets your approval (the same stories approval a build uses)
4. **Parks it at `READY-TO-BUILD` on `main`** and stops — no build starts; `/start` picks it up later, cutting a fresh branch from `main`

---

## Workflow 3: Resuming Interrupted Work

**Scenario:** Session closed mid-epic, or auto-compaction fired.

```bash
# Ensure you're on the epic branch (or check it out)
git checkout epic/<slug>

# In Claude Code chat, type:
/continue
```

`/continue` reads `generated-docs/epics/<slug>/state.json` via `resolve-state-path.js`, determines the current phase, and re-enters at the appropriate step.

### What `/continue` shows

```
Resuming: phase=BUILD, currentStory=3 (in-progress)
```

If state is missing on an `epic/<slug>` branch, `/continue` surfaces a clear message and suggests `/start` to (re-)initialise.

---

## Workflow 4: Validate Before Commit

`/quality-check` runs all 4 quality gates (security, code quality, testing) outside the BUILD loop. Useful for ad-hoc validation.

```bash
/quality-check
```

Inside the workflow, the orchestrator runs a light gate inline per story (lint + test-quality — the developer already ran Vitest + typecheck), then runs this same full 5-gate suite inline once at epic-end, followed by a `/code-review --fix` pass over the epic diff, before manual testing.

---

## Workflow 5: Open the Dashboard

```bash
/dashboard
```

Opens `generated-docs/dashboard.html` in the browser. Shows in-flight epics (one per `epic/*` branch) and merged epics (recorded on main). The view spans all branches via `git show <branch>:<path>`, so every epic is visible regardless of which branch is currently checked out.

---

## Workflow 6: Open the Build Report

```bash
/build-report
```

Opens `generated-docs/build-report.html` in the browser — a retrospective of how the app came together: calendar span vs. actual active build time (git commits clustered into work sessions), **workflow performance** (first-pass E2E yield, rework share of commits and changed lines, active time per story, manual-check pass rate), **what was built** (lines of code by layer, components, routes, test counts, dependencies added), per-epic effort/churn and manual-test outcomes, and the stumbling blocks that cost time (read from `generated-docs/template-feedback.md` and each epic's `state.json`). All figures are derived from git history and files the workflow already writes, so the report reads the same every run.

The top **“What this means”** panel is written by following `.claude/prompts/build-report-insights.md` — an **editable prompt**. Tweak that file to change the report's focus, length, or tone; the change takes effect next run. Run `/build-report` any time — it's read-only and never touches workflow state.

**`/build-report stakeholders`** produces a second, client-facing page (`generated-docs/build-report-stakeholders.html`): what was delivered in product language, the quality evidence (automated tests + hands-on checks), and what's still to come — with the internal machinery (rework, churn, tooling friction) left out. It has its own editable insight prompt at `.claude/prompts/build-report-insights.stakeholders.md`.

---

## Workflow 7: Migrate a Legacy Project

**Scenario:** Your project was built under a pre-epic-branch workflow shape.

```bash
/migrate-legacy
```

Detects whether the project is pre-4-phase or 4-phase and runs the appropriate transform. After migration, `project.md` lives on main, each completed epic has a directory under `generated-docs/epics/`, and the in-flight epic (if any) is on a fresh `epic/<slug>` branch. See [commands/migrate-legacy.md](commands/migrate-legacy.md) for the full flow.

---

## Phase Model — At a Glance

| Phase | Driven by | Approval | Lives where |
|---|---|---|---|
| **INTAKE** (pre-branch) | `/start`, `/plan` | INTAKE approval — project.md + epic plan (first project) or a single epic's brief.md (a later epic) | First project: `project.md` + `epic-plan.md` + every epic's brief.md on main, then the first epic's branch. A later epic: brief.md on main, then the new branch |
| **PLAN** | `/continue`, `/plan`, `/start` | Stories approval — approve stories | `state.json` on the epic branch (via `/plan`: in its background worktree, then landed on `main`) |
| **READY-TO-BUILD** (parked) | `/plan` parks here; `/start` cuts a fresh branch from `main` and leaves | None — the stories approval already happened in PLAN | `state.json` on `main` (no branch until build) |
| **BUILD** | `/continue` | None — autonomous per-story loop | Per-story commits on the epic branch |
| **EPIC-END** | `/continue` | None — the full `/quality-check` suite, then a `/code-review --fix` pass, then batched Playwright against the production build, each with a fix cycle | `state.json.stories[*].e2eStatus` updated |
| **MANUAL-TEST** | `/continue` | Manual-test approval | Per-epic checklists |
| **COMPLETE-ON-BRANCH** | `/continue` | User-approved merge | PR to main; branch deleted on merge |
| **COMPLETE** | (on main, after merge) | — | Frozen historical record under `generated-docs/epics/<slug>/` |

**BUILD:** `test-generator (Vitest ∥ Playwright)` runs batched up front for all stories, then a per-story loop of `developer` → inline light gate (lint + test-quality) → commit. The full `/quality-check`, `/code-review --fix`, and Playwright (against the production build) all run once at epic-end, in that order, not per story. Fix cycle on a gate failure, max 3.

The full orchestration lives in [commands/start.md](commands/start.md) and [commands/continue.md](commands/continue.md). The agents are inventoried in [agents/README.md](agents/README.md).

---

## Halt Conditions

Agents halt only for the "Tier 4" categories defined in [agent-autonomy.md](shared/agent-autonomy.md). When a halt fires, the orchestrator surfaces it verbatim via `AskUserQuestion` — except when `requiresProjectChange: true`, in which case the orchestrator routes through the [§6.1 project-change flow](policies/epic-branch-concurrency.md#§61-project-level-changes) and re-invokes the developer once the project edit is merged to main.

---

## Concurrent Work

Two devs / two epics → two `epic/*` branches. No shared state file. The PR-time conflict policy in [epic-branch-concurrency.md §6.2](policies/epic-branch-concurrency.md#§62-shared-evolving-artifacts--pr-time-conflict-resolution) handles additive-union merges for shared artifacts (design tokens, mock handlers, api-spec). Cross-epic dependencies use standard git topic-branch stacking — see [§6.3](policies/epic-branch-concurrency.md#§63-cross-epic-dependencies).

---

## Command Reference

| Command | When to use | What it does |
|---|---|---|
| `/start` | Build an epic | First project: INTAKE + build the first epic. Existing: build the next (a parked epic, or a draft/new one planned inline). Chains into `/continue` |
| `/plan` | Plan the next epic ahead | Picks/intakes an epic, breaks its stories down, parks it at `READY-TO-BUILD` — no build. Safe to run in a parallel session |
| `/continue` | Resume work or continue after `/start`'s INTAKE | Drives PLAN → BUILD → EPIC-END → MANUAL-TEST → COMPLETE-ON-BRANCH for the current branch |
| `/status` | Check progress | Shows phase + story progress for the current branch |
| `/quality-check` | Ad-hoc validation | Runs all 4 quality gates outside BUILD |
| `/dashboard` | Open visual dashboard | View across all epic branches + merged epics |
| `/build-report` | Retrospective after (or during) a build | Effort, workflow performance, codebase stats, per-epic breakdown, stumbling blocks — as a visual page. `/build-report stakeholders` → client-facing delivery report |
| `/build-report-cost` | Deeper cost detail than the build report shows | Spend, tokens, models and waiting-on-you time per epic, read straight from the session logs |
| `/build-report-effort` | Sizing the next piece of work | Time and cost per story, grouped by kind of screen (list, form, detail…) |
| `/migrate-legacy` | Convert a legacy-shape project | Pre-4-phase or 4-phase → epic-branch |

---

## Pro Tips

- **New project:** `/start` handles everything. Dependencies install in the background while you answer the intake checklist.
- **Next epic:** `/start` to build it now, or `/plan` to plan it ahead and park it — either way project facts inherit (no full intake re-run).
- **Plan while building:** open a fresh Claude Code window on the same project and run `/plan` to plan the next epic while the current one builds — `/plan` isolates its own work in a background worktree, so the two windows don't interfere and there's nothing for you to set up or clean up.
- **Concurrent work:** different `epic/*` branches are independent. Two epics' BUILD loops don't interfere.
- **Project changes mid-epic:** the developer halts with `requiresProjectChange: true`; the orchestrator handles the project.md edit on main, then resumes the epic. The user sees one approval, not two.
- **Dashboard:** spans all branches via `git show`, so leaving it open on main shows in-flight + merged.

---

## Troubleshooting

### "I ran `/start` but nothing happened"

- Check that Claude Code extension is active
- Look for the command prompt response
- Try `(cd web && npm install)` manually

### "I want to abandon the current epic"

- `git checkout main && git branch -D epic/<slug>` (delete locally)
- `git push origin --delete epic/<slug>` (delete remote, if pushed)
- Run `/start` to build the next epic (or `/plan` to plan one ahead)

### "BUILD halted on something I didn't expect"

- Tier 4 halts only fire on security/contract/project-level decisions
- The halt message includes options — pick one or describe a different path
- BUILD resumes after your decision

### "I see merge conflicts at PR time"

- Most are additive (different sections of globals.css, different handlers) — the orchestrator auto-resolves these per §6.2
- Source-file or same-dep-different-version conflicts halt for user decision; the halt block surfaces both diffs

### "My project predates epic-branch"

- Run `/migrate-legacy` — it detects the legacy shape and walks through the transform
- Path A (pre-4-phase → 4-phase) chains into Path B (4-phase → epic-branch) automatically
- See [commands/migrate-legacy.md](commands/migrate-legacy.md)

---

**Questions?** Type `/help` or just ask Claude directly.
