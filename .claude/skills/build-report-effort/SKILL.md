---
name: build-report-effort
description: Generate the build-effort report — how long and how much each story cost to build, grouped by screen type (listing / form / record action / detail / auth / export), from the workflow's own per-story timestamps and token logs. Opens it in the browser.
---

You are generating the **build-effort report**: a self-contained HTML page that answers "roughly how many minutes and how many tokens does each *kind* of screen take to build?" — a listing page vs a create/edit form vs a record action, etc. It is built entirely from data the workflow already records, so it needs no manual instrumentation.

**Two ground-truth inputs, same as `/build-report-cost`:**

- **Time** — each story's `startedAt` → `completedAt` in `generated-docs/epics/<slug>/state.json`. This is the per-story BUILD window (test generation + implementation + that story's E2E); it excludes PLAN, epic-end, manual test and PR.
- **Token cost** — every assistant message (orchestrator **and** sub-agents) under `~/.claude/projects/<project-slug>/`, bucketed into the story window containing its timestamp, priced with the shared table in `.claude/scripts/lib/report-core.mjs` (list API prices; cache read 0.1×, write 1.25×/2×).

Story **titles** (and therefore the screen-type classification) come from the Playwright spec filenames `web/e2e/epic-<slug>-story-<N>-<title>.spec.ts`.

Everything the skill needs lives beside this file plus the shared core:

- `generate-build-effort.mjs` — reads the inputs above, buckets tokens per story, classifies by screen type, and writes `generated-docs/reports/build-effort.html` and `build-effort-data.json`.
- `.claude/scripts/lib/report-core.mjs` — the shared pricing table + transcript reader (also intended to back `/build-report-cost`).

## Step 1 (optional): exchange rate

The report shows USD by default. To also show ZAR, fetch the rate and pass it with `--rate`:

```bash
curl -s --max-time 15 "https://open.er-api.com/v6/latest/USD"
```

## Step 2: decide which sessions to exclude

Like `/build-report-cost`, the script reads **every** session transcript for the project. Sessions that are *about* the project rather than part of the build — analysis chats, `/build-report`/`/dashboard`/`/build-report-cost` runs — should be excluded so they don't inflate the overhead/total figures:

```bash
ls ~/.claude/projects/<project-slug>/*.jsonl
```

Pass the unrelated ones with `--exclude=<id1>,<id2>`. (Per-story cost is unaffected — those sessions fall outside story windows — but the totals are cleaner without them.)

## Step 3: run the generator

```bash
node .claude/skills/build-report-effort/generate-build-effort.mjs --rate=<ZAR_RATE> --exclude=<id1>,<id2>
```

The script prints a compact summary JSON: stories, median minutes/story, per-type medians, in-story vs overhead cost, fully-loaded cost/story. Watch for:

- **`costComplete: false` + `WARNING: no sub-agent transcripts found` / low coverage** — the project's sub-agent token logs weren't captured (e.g. an older log format), so per-story cost can't be reconstructed. The report renders **time-only** and says so. Do **not** present token-cost figures in this case; report build time and tell the user cost was unavailable.
- **`WARNING: unknown models priced as Opus 4.8`** — a model appeared that isn't in `report-core.mjs`'s `PRICING`. Look up its real price (the `claude-api` skill has the table), add it to `PRICING` in `report-core.mjs`, and re-run.
- **No epics / no dated stories** — the workflow hasn't produced stories with start/complete timestamps yet; tell the user there is nothing to report.

## Step 4: open the report

```bash
start "" "generated-docs/reports/build-effort.html"
```

## Step 5: summarise for the user

Give a short summary from the exact figures: median minutes and cost per story, the per-screen-type rule-of-thumb (which kinds are cheap vs expensive), and the **marginal vs fully-loaded** split — only ~⅓ of spend typically lands inside story windows; the rest is workflow scaffolding (INTAKE, PLAN, epic-end E2E + fixes, PR/merge). Use the marginal figure for sizing a screen and the fully-loaded figure for budgeting a project.

## Methodology notes (do not silently change these)

- **Ground truth only.** Time from `state.json`; tokens/cost from transcripts via the shared reader; deduped by message id; `<synthetic>` messages skipped. Nothing is estimated.
- **Cost completeness is coverage-based.** Cost is treated as trustworthy only when sub-agent transcripts exist **and** most stories (≥60%) have token records bucketed into them. Below that it degrades to time-only rather than publishing wrong dollar figures — this is the correct behaviour for older/partial logs, not a bug.
- **Overhead** = spend outside all story windows (INTAKE, PLAN, epic-end, PR, orchestrator context between stories). Reported separately; the "fully-loaded per story" figure divides the whole total by story count.
- **Classification is title-based**, first-match-wins, from the `TAXONOMY` table at the top of the script — never the epic slug (an epic named `…-export` must not tag its listing stories as Export). Tune the taxonomy there.
- **Single project, directional.** Small n per screen type (often 1–5). These firm up as more projects are measured; per-story rows are emitted to `build-effort-data.json` so a future cross-project pooling step can accumulate them.
- **AI build effort only.** Excludes human review / manual-test wall-time and permission-prompt waits (not recorded in transcripts).
