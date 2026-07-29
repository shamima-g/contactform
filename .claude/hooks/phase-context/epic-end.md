# EPIC-END Phase Context (post-compaction)

This file is injected by `inject-phase-context.ps1` when the orchestrator session is resumed after auto-compaction. Its job is to restore enough context for `/continue` to pick up cleanly — not to re-document the flow.

**Canonical sources:**
- Phase orchestration → [`commands/continue.md`](../../commands/continue.md) § Step B7.0 (epic-end full quality-check), § Step B7.0.5 (`/code-review --fix` via the `code-review-runner` subagent), § Step B7.0.6 (batched Playwright against the production build)
- Batched E2E runner → [`agents/playwright-runner.md`](../../agents/playwright-runner.md) § Your task / What to return
- Code-review runner → [`agents/code-review-runner.md`](../../agents/code-review-runner.md) § Your task / What to return
- Epic-end full quality-check → run inline by the orchestrator via `.claude/scripts/quality-gates.js --auto-fix --json` (continue.md § Step B7.0)

## Key file paths

- State: `generated-docs/epics/<slug>/state.json`
- Playwright specs: `web/e2e/epic-<slug>-story-*.spec.ts`
- E2E results (gitignored, written by `playwright-runner`; **read this for ground truth**): `web/test-results/e2e-epic-<slug>.json` (and `…-story-<N>.json` in fix mode)
- Code-review findings (gitignored, written by `code-review-runner`; **read this for ground truth**): `web/test-results/code-review-epic-<slug>.json`

## What EPIC-END means

All stories are committed. EPIC-END runs three automated sweeps before manual testing, **in order**: (1) the full `/quality-check` suite run inline — its `build` check produces `web/.next`, the production build the E2E sweep serves (Step B7.0); (2) a `/code-review --fix` pass over the epic diff via the `code-review-runner` subagent (keeps the review's diff-reasoning out of the orchestrator context), after which the orchestrator guards over-reaches and re-runs the quality-check to re-verify and refresh the build (Step B7.0.5); then (3) Playwright once across all the epic's specs, run against that production build via `next start` (`E2E_PROD=1`, Step B7.0.6). All three are idempotent — safe to re-run after an interruption.

## Determining current stage after compaction

Playwright now runs **last**, so `e2eStatus` still being `deferred` means the E2E sweep hasn't run yet — not that it's the next thing to start. All three sweeps are idempotent, so when unsure, re-enter at **Step B7.0** and flow through.

| `stories[*].e2eStatus` values | Current stage |
|---|---|
| All still `deferred` | The quality-check / code-review sweeps may not have completed. Re-enter at **Step B7.0** (full quality-check, inline `quality-gates.js`), then **Step B7.0.5** (`/code-review --fix`), then **Step B7.0.6** (Playwright). All idempotent. |
| Some `passed`, some `deferred` | The Playwright sweep (B7.0.6) was interrupted mid-run — re-run **Step B7.0** (refreshes `web/.next`) then re-invoke `playwright-runner` mode `epic-end` (full re-run is cheap; idempotent) |
| Some `failed` | Per-story E2E fix cycle was in progress — re-invoke `developer` for the failing story, re-run **Step B7.0** (re-gate + rebuild), then `playwright-runner` mode `epic-end-fix` with `storyFilter: <N>` |
| All `passed` / `passed-after-fix` | All three sweeps are done — transition `state.json.phase` to `MANUAL-TEST` and proceed to Step B7.1 |
