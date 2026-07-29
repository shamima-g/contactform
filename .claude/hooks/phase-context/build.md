# BUILD Phase Context (post-compaction)

This file is injected by `inject-phase-context.ps1` when the orchestrator session is resumed after auto-compaction. Its job is to restore enough context for `/continue` to pick up cleanly — not to re-document the flow.

**Canonical sources:**
- Phase orchestration → [`commands/continue.md`](../../commands/continue.md) § Phase: BUILD
- Per-story loop (Steps B1–B7) → [`commands/continue.md`](../../commands/continue.md)
- Halt categories + autonomy tiers → [`shared/agent-autonomy.md`](../../shared/agent-autonomy.md)

## Key file paths

- Project facts: `generated-docs/project.md` (inherited from main)
- Epic brief: `generated-docs/epics/<slug>/brief.md`
- State: `generated-docs/epics/<slug>/state.json`
- Story files: `generated-docs/epics/<slug>/stories/story-<N>-<slug>.md`
- Journal: `generated-docs/epics/<slug>/journal.md` (per-epic Tier-2 narrative from developer agent)
- Architecture & reuse registry: `generated-docs/architecture.md` (project-wide; read at story start, edited inline when a reusable surface is added — Tier-3 routing per [agent-autonomy.md](../../shared/agent-autonomy.md#recording-destinations-tier-3-routing))
- Template feedback: `generated-docs/template-feedback.md` (project-wide; template bugs logged for maintainers)
- Tests: `web/src/__tests__/integration/` (Vitest) + `web/e2e/epic-<slug>-story-<N>-<title>.spec.ts` (Playwright spec generated but NOT executed per story — runs at epic-end)

## Sub-state in `state.json`

- `stories["<N>"].status` — `pending | in-progress | complete | halted`
- `stories["<N>"].commit` — SHA after Step B5, null otherwise
- `stories["<N>"].e2eStatus` — `deferred` during BUILD; flips at epic-end to `passed` / `passed-after-fix` / `failed`
- `halt` — `null` or `{ reason, stage, raisedAt, requiresProjectChange? }`

The current story is the one with `status: "in-progress"` (or the lowest-indexed `"pending"` if none in progress).

## Determining current stage after compaction

| Current story status | Test files exist? | Code changes uncommitted? | Current stage |
|---|---|---|---|
| `complete` | — | — | Story committed — advance to next story or transition to `EPIC-END` |
| `in-progress` | No | — | Tests missing from the B0.2 batch — regenerate this story's tests via Step B2 (batch fallback) |
| `in-progress` | Yes | No | Re-run `developer` (Step B3) |
| `in-progress` | Yes | Yes (uncommitted) | Mid-implementation — surface to user; offer revert + restart or manual finish |
| `halted` | — | — | Re-surface `halt` via `AskUserQuestion`, or follow §6.1 flow if `requiresProjectChange: true` |
