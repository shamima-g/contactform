# Shared Orchestrator Rules

These rules apply to both `/start` and `/continue` orchestrators. Both commands MUST follow everything in this file.

The unit of work is the epic. Each epic runs on its own `epic/<slug>` branch through **PLAN → BUILD → EPIC-END → MANUAL-TEST → COMPLETE-ON-BRANCH → COMPLETE**; project-level INTAKE runs once (via `/start`) before the first epic.

## Voice (mandatory)

Apply [tone-guide.md](../agents/tone-guide.md) for all user-facing text — knowledgeable colleague, "I" and "we" (never third-person agent references), lead with what's solid, frame gaps as next steps.

**Plain language (mandatory):** users are often non-developers. Strip technical jargon from acceptance criteria checklists, manual verification prompts, quality gate summaries, and status updates. Say "the app builds correctly" not "TypeScript compilation succeeded with zero diagnostics"; say "You should see a loading spinner" not "Verify the isLoading state renders the Skeleton component."

## User Questions (mandatory)

`AskUserQuestion` does NOT work inside Task subagents — it auto-resolves silently. Therefore, when a subagent returns with an unanswered question or needs user input relayed, YOU (the orchestrator) must use `AskUserQuestion` to present it to the user. Never relay questions as plain text output. This applies to all approval requests, clarifications, and choices throughout the workflow.

**Open-ended prompt exception:** When ONLY a free-text response is required (e.g., a project description or elevator pitch during INTAKE onboarding), use a plain-text prompt instead of `AskUserQuestion`. This avoids forcing the user to pick from predefined options when the answer is inherently open-ended.

## User Approval Policy (CRITICAL)

**NEVER auto-approve on behalf of the user.** When an agent returns with work that needs approval:

1. **Output the proposed content as regular conversation text** — the user must see it.
2. **Then** call `AskUserQuestion` for explicit approval.
3. **Only proceed** after receiving the user's actual response.

A subagent's return is visible to you but **invisible to the user** — if the content lives only in the agent's return, you have NOT displayed it yet.

**Self-check before every `AskUserQuestion` call:** *"Does my most recent assistant text include the full content the user is being asked to approve — verbatim?"* If no, output the payload first, then call AUQ.

This applies at the approvals in the workflow:

- INTAKE approval — at end of INTAKE: `project.md` + the epic plan (Case A, two-step: clear blockers → approve) or just the epic's `brief.md` (a later epic)
- Stories approval — at end of PLAN (one per epic)
- Manual-test approval at end of MANUAL-TEST
- User-approved merge at end of COMPLETE-ON-BRANCH

**Fallback if the agent return is empty or unclear:** read the file the agent wrote (e.g., the project brief) and construct the summary yourself before calling AUQ.

**Anti-pattern:** calling AUQ with "Does this look right?" without first outputting what "this" refers to.

## Context Management Policy

The workflow chains continuously through PLAN → BUILD → EPIC-END → MANUAL-TEST → COMPLETE-ON-BRANCH per epic. State authority lives in `generated-docs/epics/<slug>/state.json` on the active `epic/<slug>` branch; `/continue` re-enters at whatever phase state shows.

**Post-compaction safety net:** If auto-compaction fires, the `inject-phase-context.ps1` hook automatically restores workflow state via `additionalContext`. The hook resolves the active state.json via `resolve-state-path.js` and loads the matching `.claude/hooks/phase-context/<phase>.md` (`plan.md`, `build.md`, `epic-end.md`). This covers both orchestrator and subagent sessions.

## Dashboard Update Policy

The HTML dashboard (`generated-docs/dashboard.html`) mirrors `state.json`. Keep it fresh with one rule:

> **Whenever you write `state.json` — a story status change or a phase transition — your immediate next action is to regenerate the dashboard.**

```bash
node .claude/scripts/generate-dashboard-html.js
```

This reads per-epic state across branches — using the **working tree** for the checked-out epic, so an in-progress story shows immediately rather than lagging a commit behind — and rewrites the HTML (~100ms). The browser auto-refreshes every 10 seconds via `<meta http-equiv="refresh">`, so an open dashboard reflects the change within 10s. The output is gitignored; regenerating never touches a commit.

**Non-blocking:** if the script fails, log a one-line warning and continue. A dashboard failure must never halt the workflow.

### Reliability — deliberate redundancy

Centralising this on the orchestrator alone proved unreliable: during long, bash-heavy turns the step gets skipped and the dashboard freezes. So ownership is **distributed on purpose**:

- The **`developer` agent** regenerates at the end of its turn (the in-story "building" signal).
- The **orchestrator** regenerates at every state write it owns: story start (B1), story commit (B5), phase transitions, gates, manual-test resolution, and merge. The B5 commit step bundles the regen into the same command block, so the dashboard advances on every story commit even when nothing else fires.

This belt-and-suspenders is intentional — not duplication to be tidied away.

**The `/dashboard` command (user-triggered) is the exception** — it also opens the HTML in the browser. See `.claude/commands/dashboard.md`.

## Git Commit & Push Authorization (mandatory)

The user chose how Claude should handle git commits and pushes during `/start` Step 0; the choice is stored in `.claude/preferences.json` as `git.autoApproveCommit` and `git.autoApprovePush` (booleans). **This preference is the single source of truth for whether to ask before committing/pushing — honor it on every occurrence, not just the first.**

**Load it once per command:** at the start of `/start` and `/continue`, read `.claude/preferences.json` into `gitPrefs`. If the file is missing or unreadable, **default both to ask** (treat as `false`).

**Before every designated `git commit …`:**

- `gitPrefs.git.autoApproveCommit === true` → commit directly, no prompt.
- otherwise → `AskUserQuestion` first (plain language, e.g. *"Ready to save this as a commit?"* → *Commit now* / *Not yet*) and commit only if the user approves.

**Before every designated `git push …`:**

- `gitPrefs.git.autoApprovePush === true` → push directly, no prompt. `git push origin HEAD` pushes whatever branch the user is on (works for `main`, an epic branch, or a spike).
- otherwise → `AskUserQuestion` first (e.g. *"Ready to push \<what\> to \<branch\>?"* → *Push now* / *Skip*) and push only if the user approves.

`AskUserQuestion` is asked fresh every time (never cached or "remembered"), so this is how *"ask before commit/push"* is honored on every occurrence — do **not** rely on the harness permission dialog for this, and do **not** skip the ask on the basis of a previous approval. On push failure, report the error and stop — don't retry.

**Designated commit/push points** (each gated by the rule above): the INTAKE-approval commit + push, each PLAN-approval commit + push, each story commit + push during BUILD, the epic-end quality auto-fix commit + push (when the epic-end full quality-check's `--auto-fix` changes files), the PR branch push (`git push -u origin epic/<slug>`), and the merge-to-main commit + push.

## Generated Document Names

Every AI-generated document under `generated-docs/` and every E2E spec under `web/e2e/` has exactly one correct filename shape. The machine-readable source of truth is [.claude/shared/generated-doc-conventions.json](./generated-doc-conventions.json); the human-readable mirror is [.claude/shared/naming-conventions.md](./naming-conventions.md).

The PreToolUse hook `.claude/hooks/enforce-generated-doc-names.js` runs on every `Write`/`Edit`/`MultiEdit` and blocks new files whose names don't match. Existing files on disk are grandfathered. Run `node .claude/scripts/validate-generated-doc-names.js` to audit the whole tree before a commit.

**The epic-context rule** (memorize this): when the parent directory already identifies the epic (`generated-docs/epics/<slug>/stories/`), the filename carries **only the story number** — `story-3-role-aware-nav.md`. When the parent directory is flat (`web/e2e/`), the filename carries the **epic slug + story number** — `epic-dashboard-overview-story-3-role-aware-nav.spec.ts` (the epic slug, never a bare epic number). Full rules in [naming-conventions.md](./naming-conventions.md). Adding a new document type requires adding an entry to the JSON schema; no code changes needed.

## Scoped Call Pattern

Interactive agents are invoked using scoped calls — focused Task invocations separated by orchestrator-driven `AskUserQuestion` prompts. Agents return structured results; the orchestrator handles all user communication.

**Key rules for every scoped call:**

- Tell the agent which call it is, when applicable (e.g., "This is the produce call — write the brief")
- Tell the agent what NOT to do (e.g., "Do NOT commit. Do NOT use AskUserQuestion.")
- After the agent returns, the orchestrator owns the next step (display results, ask user, launch next call)
- Use **camelCase** for all structured-return field names and scoped-call prompt fields — consistent across all structured returns

**Per-phase call patterns:**

| Agent | Phase | Calls | User interaction |
|-------|-------|-------|-------------------------------|
| `intake-agent` | INTAKE | produce / epic-only / split-brief / revise | 3-question checklist + INTAKE approval |
| `api-connectivity-agent` | INTAKE | spec analysis + smoke test (conditional) | None |
| `feature-planner` | PLAN | stories (single-mode) | Story-list approval per epic |
| `test-generator` | BUILD | Vitest + Playwright, batched across all stories at BUILD start (parallel; Playwright spec generated, not run) | None |
| `developer` | BUILD | implement | Halts on always-halt categories per [agent-autonomy.md](./agent-autonomy.md); `requiresProjectChange: true` routed via §6.1 |
| `playwright-runner` | EPIC-END | `mode: epic-end` for batched run; `mode: epic-end-fix` for per-story fix cycles | Halts via orchestrator on persistent failure |

See the phase-specific orchestrator files for the full call prompts: [`/start`](../commands/start.md) (INTAKE) and [`/continue`](../commands/continue.md) (PLAN and BUILD).

## Halt Handling

When any BUILD agent returns a `HALT` block (per [agent-autonomy.md](./agent-autonomy.md)):

1. Surface the halt block **verbatim** to the user
2. Use `AskUserQuestion` with the options the agent suggested (plus the implicit "Other" affordance for free-text)
3. Capture the user's decision
4. Resume the appropriate BUILD step with the decision passed as additional context

**Halt persistence:** populate the `halt` object in `state.json` via Edit so `/continue` after a session break re-surfaces the halt rather than blindly re-running BUILD.

## Project + Brief Are The Source of Truth

`project.md` (project facts) and the epic's `brief.md` (this epic's requirements) together override template code per the **Project Brief Overrides Template Code** rule in [CLAUDE.md](../../CLAUDE.md). This is baked into `developer` and `test-generator`; the orchestrator does **not** re-inject it on every call. Structural contradictions halt per [agent-autonomy.md](./agent-autonomy.md) Tier 4.

## Commit Policy

Whether to ask the user before each commit/push is governed by [§Git Commit & Push Authorization](#git-commit--push-authorization-mandatory) — apply that gate at every commit and push below.

Create commits at every logical point:

- After INTAKE: `project.md` to main (Case A only); `brief.md` to the new epic branch
- After PLAN: per-story `story-<N>-<slug>.md` files + state.json on the epic branch
- After each story commit during BUILD on the epic branch
- After batched Playwright at EPIC-END (state.json updates only)
- After the epic-end full quality-check, when `--auto-fix` changed files: `chore(<slug>): apply epic-end quality auto-fixes`
- After manual-test approval resolves (state.json updates only)
- On PR merge: branch deleted; state.json on main lands with `phase: COMPLETE`

### Commit Message Format (Conventional Commits)

All commit messages MUST follow the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specification:

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

**Description** must be lowercase, imperative mood ("add", not "added" or "adds"), and not end with a period.

**Allowed types:**

| Type | When to use |
|------|-------------|
| `feat` | New user-facing functionality (story implementation) |
| `fix` | Bug fix |
| `docs` | Documentation-only changes (INTAKE and PLAN artifacts) |
| `refactor` | Code restructuring with no behaviour change |
| `test` | Adding or updating tests only |
| `chore` | Housekeeping — copying artifacts, config changes, dependency updates |

**Scope conventions by workflow phase:**

| Phase | Scope | Example |
|-------|-------|---------|
| INTAKE | `intake` | `docs(intake): approve project brief` |
| PLAN | `plan` | `docs(plan): epic list approved` / `docs(plan): stories for epic 1 — auth` |
| BUILD (story commit) | `<slug>/story-N` | `feat(auth-shell/story-2): add user profile page` |

**Story commits (BUILD phase)** use `feat`, `fix`, or `refactor` depending on the story's nature, scoped `<slug>/story-N` — `<slug>` is the epic branch slug and the `story-N` token is what the PR-body builder greps (`git log … --grep="feat(<slug>/story-"`) to map each commit back to its story. This exact shape is load-bearing: a `feat(epic-N): …` form would drop every story SHA from the PR body.

```
feat(auth-shell/story-2): add user profile page

- Implemented: profile card, avatar upload, edit form
- Tests: all passing
- Quality gates: all passing
- Manual verification: passed | auto-skipped (component only) | skipped

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

**Breaking changes** are indicated by appending `!` after the scope or by adding a `BREAKING CHANGE:` footer:

```
feat(auth-shell/story-3)!: replace legacy auth with OAuth2
```

## Script Execution Verification

The state scripts (`resolve-state-path.js`, `epic-state.js --init`, `mark-epic-complete.js`) output JSON. Always verify the result before proceeding:

1. `"status": "ok"` / `"initialised"` = success, proceed
2. `"status": "error"` = **STOP**, report the error to the user

**Troubleshooting / recovery:**

- Inspect current state: `cat generated-docs/epics/<slug>/state.json` (resolve the path with `node .claude/scripts/resolve-state-path.js`).
- Recover after a session break: `git checkout epic/<slug>` and re-run `/continue`. The branch name + per-epic `state.json` are the source of truth — there is no separate repair step.

## TodoWrite Progress Display

The orchestrator maintains the TodoWrite list directly — there is no generator script. Emit the macro phases for the current epic with the active one `in_progress`:

> PLAN → BUILD → EPIC-END → MANUAL-TEST → COMPLETE-ON-BRANCH (plus the per-story items during BUILD).

Update it as each agent returns and at every phase transition, so the user has a current visual of progress.
