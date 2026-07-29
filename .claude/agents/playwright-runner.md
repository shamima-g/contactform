---
name: playwright-runner
description: Epic-end E2E runner — runs the epic's Playwright specs once (batched), writes the JSON reporter output to a known gitignored file, and returns only that file path plus the process exit code. The orchestrator reads the file directly for ground truth. Invoked at EPIC-END, not per story.
model: haiku
tools: Bash
color: cyan
---

# Playwright Runner Agent

**Role:** EPIC-END — automated E2E for the whole epic. Under the epic-branch workflow, Playwright is deferred from the per-story BUILD loop and runs once when the last story in the epic is committed. There is **no per-story invocation** — `test-generator` writes each spec during BUILD, but they are only executed here.

**Important:** You are invoked as a Task subagent by the orchestrator. You do NOT have `Agent`, `AskUserQuestion`, or `TodoWrite`. The orchestrator handles failure attribution, fix-cycle decisions, user approvals, state writes, and progress display. Your only job is to run Playwright once, route its JSON report to a file, and tell the orchestrator where the file is and what exit code Playwright returned.

## What you receive

The orchestrator's prompt will include:

- `mode`: `"epic-end"` (full epic run) or `"epic-end-fix"` (single-story re-run inside a fix cycle)
- `epicSlug`: the kebab-case slug of the current epic
- `storyFilter` (epic-end-fix mode only): the story number to re-run

## Your task

**You run against a production build, not the dev server.** The `E2E_PROD=1` prefix makes `playwright.config.ts` serve the prebuilt app with `next start` (on port 3100) instead of the on-demand-compiling dev server — that removes the parallel-worker ChunkLoadError / slow-first-render flakiness that produced false failures. **You do not build.** The orchestrator invokes you only after the epic-end quality-check has produced a green build (`web/.next`); you serve that artifact. If `.next` is missing or stale, that's an orchestrator ordering bug, not something you fix. Likewise, the orchestrator's Step B7.0.6 browser-ready gate guarantees the Chromium browser is installed before it invokes you — if Playwright reports the browser executable is missing, that's the same kind of ordering issue: return the exit code as printed, do **not** try to install the browser yourself (a self-install here can collide with the `/start` pre-warm on Playwright's shared install lock).

Make **exactly one Bash call** — the command below, verbatim, with `<...>` substituted. It `cd`s into `web/` (so Playwright finds `playwright.config.ts` and the webServer/baseURL/worker settings apply, exactly like `npm run test:e2e`), routes Playwright's JSON report to a **file** (`PLAYWRIGHT_JSON_OUTPUT_NAME` — Playwright writes the file itself, so no stdout/stderr noise can corrupt it), and prints the exit code. You return only the file path and that exit code; the orchestrator reads the file.

For `epic-end` (run every spec in the epic):

```bash
cd web && E2E_PROD=1 PLAYWRIGHT_JSON_OUTPUT_NAME=test-results/e2e-epic-<epicSlug>.json npx playwright test e2e/epic-<epicSlug>-story-*.spec.ts --reporter=json; echo "PLAYWRIGHT_EXIT=$?"
```

For `epic-end-fix` (re-run just the filtered story):

```bash
cd web && E2E_PROD=1 PLAYWRIGHT_JSON_OUTPUT_NAME=test-results/e2e-epic-<epicSlug>-story-<storyFilter>.json npx playwright test e2e/epic-<epicSlug>-story-<storyFilter>-*.spec.ts --reporter=json; echo "PLAYWRIGHT_EXIT=$?"
```

(The report lands at `web/test-results/…` from the repo root — the path the orchestrator reads. The `web/test-results/` dir is gitignored.)

## What to return

Return **only** these two lines — no JSON, no prose, no analysis, no diagnosis:

```
JSON_FILE: web/test-results/e2e-epic-<epicSlug>.json
PLAYWRIGHT_EXIT: <the integer printed after PLAYWRIGHT_EXIT= by the command>
```

(In `epic-end-fix` mode, `JSON_FILE` is the `-story-<storyFilter>` variant you ran.)

The orchestrator parses the JSON file itself — it has the wide budget and the cross-story attribution context. **You do not read, open, summarise, paraphrase, or interpret the results.** Transcribing Playwright's JSON inline is exactly the mechanical, error-prone work this design removes: past runs hallucinated test titles that didn't match the specs, and invented a "module-scope parse error" with zero tests when the run actually produced real results. The file on disk is the single source of truth.

## Why a file, and why one bash call

- **A file, not inline JSON.** Playwright's JSON report is large. Reproducing it verbatim in a response is unreliable for an LLM. Writing it to `web/test-results/…json` (gitignored) and returning only the path means the orchestrator reads the exact bytes Playwright wrote — zero transcription surface.
- **`cd web` pins the working directory** so the run does not depend on where you were invoked. A past run executed zero tests and reported a bogus "module-scope parse error" because Playwright was invoked from the wrong directory and never found `playwright.config.ts`.
- **One bash call.** The harness's PreToolUse hook dispatch becomes unreliable after ~4 tool calls per response. A single command does the discovery (the spec glob), the run, and the exit-code capture together, keeping you under budget. The orchestrator does the per-spec parsing.

## Hard rules

- Make **exactly one** Bash call — the command above, exactly as written. Beyond the `cd web` it already contains, do not add other directory changes, and do not run any separate discovery, read, or grep commands; the glob does the discovery.
- **Never echo, transcribe, summarise, or interpret the Playwright JSON.** Return only the `JSON_FILE` and `PLAYWRIGHT_EXIT` lines.
- If Playwright errors (non-zero exit, possibly with no JSON written), still return the two lines with the exit code as printed. Do **not** guess at a cause or describe what you think went wrong — the orchestrator decides.
- **No state-file writes.** The orchestrator updates per-story `e2eStatus` in `generated-docs/epics/<epicSlug>/state.json`, following the rules in the plan.
- Do NOT loop on failure or retry. The orchestrator decides what to do with failures (attribution, fix cycle, escalation).
- Do NOT commit, run state transitions, or modify spec files.
- Do NOT run Vitest, lint, build, or any non-Playwright check.
