# PLAN Phase Context (post-compaction)

This file is injected by `inject-phase-context.ps1` when the orchestrator session is resumed after auto-compaction. Its job is to restore enough context for `/continue` to pick up cleanly — not to re-document the flow.

**Canonical sources:**
- Phase orchestration → [`commands/continue.md`](../../commands/continue.md) § Phase: PLAN
- Single-mode contract → [`agents/feature-planner.md`](../../agents/feature-planner.md)
- Approval pattern → [`shared/approval-pattern.md`](../../shared/approval-pattern.md)

## Key file paths

- Project facts: `generated-docs/project.md` (on main, inherited)
- Epic brief: `generated-docs/epics/<slug>/brief.md` (on this branch — feature requirements for this epic only)
- State: `generated-docs/epics/<slug>/state.json`
- Story files (after stories approved): `generated-docs/epics/<slug>/stories/story-<N>-<slug>.md`

## Determining current stage after compaction

| `stories[*]` in state.json? | Story files written? | Current stage |
|---|---|---|
| Empty `{}` | No | Pre-stories — re-invoke `feature-planner` |
| Populated | Yes | PLAN complete — take the PLAN exit (see below) |
| Populated | No | Mid-write of story files — surface to user; re-invoke `feature-planner` if uncertain |

**This context is auto-injected only on an `epic/<slug>` branch** — `inject-phase-context.ps1` fires for no other branch. `/plan` never runs on an `epic/*` branch (it works in a throwaway `plan/<slug>` worktree and parks on `main`), so if you're seeing this injected, the session is a **build-through** (`/continue` or `/start`) — take the BUILD exit:

- **`/continue` or `/start`** (building through — the injected case) — commit the stories, transition `state.json.phase` to `BUILD`, and proceed into the BUILD loop. See [`commands/continue.md`](../../commands/continue.md) § Phase: PLAN ("On approval") for the commit, then § Phase: BUILD.
- **`/plan`** (planning ahead to park) — applies only if you reached this file from [`commands/plan.md`](../../commands/plan.md) rather than as the injected snippet (a `/plan` session is never on `epic/*`). `/plan` does all its work in a **throwaway worktree** cut from `main` (not this window's tree), so its `brief.md`, `state.json`, and story files live under that worktree, not the paths listed above. Finish per [`commands/plan.md`](../../commands/plan.md) Step 5: set the worktree's `state.json.phase` to `READY-TO-BUILD`, commit, **push it to `main`** (`git push origin HEAD:main`), then remove the worktree — the plan parks on `main` with **no** `epic/<slug>` branch. **Stop; do not build.**

The orchestrator updates `state.json` via Edit; the PLAN "On approval" step persists the story files. If state shows `phase: PLAN` and `stories: {}`, you haven't run `feature-planner` yet for this epic.
