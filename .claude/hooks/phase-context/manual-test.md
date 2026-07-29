# MANUAL-TEST Phase Context (post-compaction)

This file is injected by `inject-phase-context.ps1` when the orchestrator session is resumed after auto-compaction. Its job is to restore enough context for `/continue` to pick up cleanly — not to re-document the flow.

**Canonical sources:**
- Phase orchestration → [`commands/continue.md`](../../commands/continue.md) § Step B7.1
- Per-story manual checklists → each story file's manual-test section

## Key file paths

- State: `generated-docs/epics/<slug>/state.json`
- Story files: `generated-docs/epics/<slug>/stories/story-<N>-<slug>.md` (carry the manual-test checklist)
- Journal: `generated-docs/epics/<slug>/journal.md`

## What MANUAL-TEST means

Epic-end Playwright has passed; every story's `e2eStatus` is `passed` / `passed-after-fix`. The user is now walking each story's manual checklist before the PR is opened. This is a **gate** — the orchestrator never advances past it on the user's behalf.

## Determining current stage after compaction

| Signal | Current stage |
|---|---|
| Approval not yet presented | Present the per-story manual checklists (Step B7.1), then call `AskUserQuestion` for the manual-test approval |
| User answered "All good" / "Skip for now" | Transition `state.json.phase` to `COMPLETE-ON-BRANCH` (record any skip in the journal) and proceed to Step B7.2 |
| User reported a failure | Transition `state.json.phase` back to `BUILD`, fix via `developer` + the inline light gate (B6), then walk back through the epic-end full quality-check (B7.0), the review pass (B7.0.5), and Playwright (B7.0.6) before re-displaying this approval |
