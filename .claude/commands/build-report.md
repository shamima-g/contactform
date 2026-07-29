---
description: Build report - how long the app took, what it cost, how efficiently it was built, where time was lost, and what was produced, as a visual page. Optional audience argument ("stakeholders") for a client-facing delivery report.
argument-hint: "[audience]"
---

You are producing the **build report**: a visual, interactive retrospective of how
this application came together — how long it took (calendar time vs. actual active
build time), what it cost (exact token/cost figures from the session logs), how
efficiently the workflow ran (first-pass test yield, rework share, velocity per
story), how much the user had to step in (deliberate inputs, and how long the
process sat waiting for their input), what got
produced (code, components, tests), where time was lost, and the stumbling blocks
along the way. It opens in the browser like `/dashboard`. This is **display-only**
— do not modify workflow state, run tests, or resume the workflow.

The report has two layers:

- **Metrics, timeline, build flow (story swimlanes & parallelism), cost & user
  involvement, workflow performance, quality-gate history, codebase stats,
  per-epic effort, stumbling blocks, data quality** —
  computed deterministically from git history, the workflow's own files
  (`state.json`, `journal.md`, `template-feedback.md`, tracked files under
  `web/`), the session-log cost data, and the quality-gate run log. You don't
  write these; the generator does.
- **A “What this means” insight panel** — a short plain-language read on the data that
  you write by following an editable prompt. This is the only part you author.

## Step 0: Pick the audience

The command takes an optional audience argument: `$ARGUMENTS`

| Audience (argument) | Page | Insight prompt to follow | Insight output file |
|---|---|---|---|
| *(empty)* or `maintainer` | `generated-docs/build-report.html` — the full benchmark: workflow performance, codebase stats, timeline, stumbling blocks | `.claude/prompts/build-report-insights.md` | `generated-docs/build-report-insights.md` |
| `stakeholders` | `generated-docs/build-report-stakeholders.html` — a client-facing delivery report: what shipped, quality evidence, what's next; no internal machinery | `.claude/prompts/build-report-insights.stakeholders.md` | `generated-docs/build-report-insights-stakeholders.md` |

Anything else → tell the user the valid audiences and **stop**. Use the chosen
audience's files in every step below; pass `--audience stakeholders` to the
generator when that audience is chosen (omit the flag for the default).

## Step 0.5 (maintainer only): Team name — ask once

Read `generated-docs/report-meta.json`. If it exists with a `team` value, use it
and move on. If not, ask the user (via `AskUserQuestion`, one question): *"Which
team or group name should appear on this report? (It makes reports from different
teams comparable side by side.)"* — offer a **Skip** option; they can type a name
via *Other*. If they give a name, write `{"team": "<name>"}` to
`generated-docs/report-meta.json`; if they skip, write `{"team": null}` so they
aren't asked again. Skip this step entirely for the stakeholders audience.

## Step 0.7 (maintainer only): Refresh the cost & effort data

The cost/effort panel comes from the `/build-report-cost` data file. Refresh it —
best-effort, never blocking:

1. Get the USD→ZAR rate: `curl -s --max-time 15 "https://open.er-api.com/v6/latest/USD"`
   and extract `ZAR`. If the fetch fails, proceed without `--rate` (the report
   will use a placeholder rate and say so).
2. Run the generator:

```bash
node .claude/skills/build-report-cost/generate-build-cost-report.mjs --rate=<ZAR_RATE>
```

It auto-flags report/analysis sessions (including this one, when it began with
`/build-report`) and excludes them from the totals — note any it lists as
`postDeliverySessionsExcluded` for Step 5. If the script fails (no transcripts on
this machine, no epics yet), **continue anyway** — the report still renders and
its Data quality section will state that cost data is missing. For a deeper
cost breakdown or manual session exclusions, point the user at `/build-report-cost`.
Skip this step entirely for the stakeholders audience (that report shows no cost).

## Step 1: Generate the metrics + collect the data

```bash
node .claude/scripts/generate-build-report-html.js --collect [--audience stakeholders]
```

Read the JSON it prints:

- If `status` is `no_project` → tell the user there's no project yet and suggest `/start`. **Stop.**
- If `status` is `legacy_detected` → suggest `/migrate-legacy`. **Stop.**
- If the script fails to run → report the actual error and suggest checking that the
  scripts exist under `.claude/scripts/`. **Stop.**
- If `status` is `ok` → the metrics HTML and `generated-docs/build-report-data.json`
  are written. Continue.

## Step 2: Write the insight panel (follow the editable prompt)

Read the **chosen audience's insight prompt** (see the Step 0 table) and follow it
exactly. That prompt is the user's to tweak, so treat its current wording as the
instruction — don't substitute your own structure. It tells you what to read
(`generated-docs/build-report-data.json` plus the epic journals and, for the
maintainer report, `generated-docs/template-feedback.md`) and which file to write
the summary to.

Ground every statement in the data — never invent numbers or events. Write for
someone who owns the app but doesn't read code.

## Step 3: Regenerate so the insight panel is included

```bash
node .claude/scripts/generate-build-report-html.js --collect [--audience stakeholders]
```

The generator picks up the audience's insight file automatically and renders it as
the top panel. (If the user asked for metrics only, run this with `--no-insights`
instead and skip Step 2.)

## Step 4: Open it in the browser

Open the chosen audience's page (the `html` path the generator printed), e.g.:

```bash
start "" "generated-docs/build-report.html"
```

## Step 5: Confirm

Tell the user the report is open, and give them a **two-line** spoken summary of the
headline (active build time vs. calendar span, estimated AI cost in ZAR when available,
epics/stories delivered, the first-pass E2E yield, and the single biggest time-sink).
If Step 0.7 excluded post-delivery sessions, mention it in one clause. For the
stakeholders audience, summarise delivery + verification
instead (features delivered, checks passed, what's still to come). Then mention they
can reshape the written insight any time by editing the audience's prompt file (Step 0
table) and re-running the command.

## DO

- Report errors to the user — this is synchronous, they triggered it explicitly.
- Base the insight panel only on the computed data and the journals/feedback.
- Open the browser after the second generation pass.

## DON'T

- Modify workflow state, run tests, or resume the workflow — display-only.
- Invent metrics, durations, or events not present in the data.
- Rewrite the insight prompt's structure — follow it as the user has it.
- Show raw JSON to the user.

## Related Commands

- `/status` — text workflow progress
- `/dashboard` — live project dashboard
- `/quality-check` — run the quality gates
