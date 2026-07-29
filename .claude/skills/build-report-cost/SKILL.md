---
name: build-report-cost
description: Generate the build cost report — ground-truth data from the logs (ZAR cost, tokens, cache efficiency, tool activity, sub-agent fan-out, model mix per epic, deliberate user inputs, waiting-on-user time) and open it in the browser. No estimated AI-busy durations.
---

You are generating the **build cost report**: a self-contained HTML page breaking down the workflow by phase and epic using **only data recorded verbatim in the session logs** — cost in ZAR, token usage, cache-hit rate, tool-call activity, sub-agent fan-out, fix-cycle (rework) counts, model mix, questions asked, deliberate user inputs (typed / commands / manual-test submissions / interruptions), and waiting-on-user time.

**This report deliberately contains NO AI-busy/elapsed time estimates.** Transcripts only timestamp events, so any "AI-active / idle / elapsed" figure has to be reconstructed from inter-event gaps with arbitrary caps — it is not trustworthy and previous versions of this report caused repeated confusion. Do not add such columns back. The **one** duration family the report does show is **waiting-on-user**, because it is anchored on well-defined event pairs (an AskUserQuestion tool call → its recorded answer; end of AI output → the next deliberate user input) with gaps over 10 minutes split out as stalls. Everything else shown (tokens, API-call counts, per-model attribution, cache read/write split, tool-call counts, sub-agent spawns, question and user-input counts) is exact. Cost is derived from the exact token counts at list API prices.

Everything the skill needs lives in this folder:

- `generate-build-cost-report.mjs` — reads the Claude Code session transcripts for this project and the per-epic `createdAt` timestamps in `generated-docs/epics/<slug>/state.json` (the epic-branch time-bucket boundaries), then renders the template into `generated-docs/reports/build-cost.html` (and writes the raw numbers to `build-cost-data.json` — which `/build-report` also reads for its Cost & user involvement panel).
- `build-cost-report-template.html` — the report page (data is injected at the `/*__DATA__*/` marker).

**The only inputs are the session transcripts** under `~/.claude/projects/<project-slug>/` **and the per-epic `state.json` files** under `generated-docs/epics/`. Do not read, grep, or include anything under `.claude/logs/` (hook/workflow log files) as a data source.

## Step 1: Get the current USD→ZAR exchange rate

```bash
curl -s --max-time 15 "https://open.er-api.com/v6/latest/USD"
```

Extract the `ZAR` value from the response. If the fetch fails, ask the user for the rate (or proceed with the script's placeholder and tell them the ZAR figures use a placeholder rate — the report page lets them correct it live).

## Step 2: Decide which sessions to exclude

The script includes **every** session transcript for this project by default — including sibling worktree transcript directories (git-worktree variants of the project path), which it finds automatically. It also **auto-flags post-delivery reporting sessions** (any session whose first command is `/build-report`, `/build-report-cost`, `/build-report-effort`, or `/dashboard` — plus their pre-1.3 names in older transcripts — including the current one when it was started that way): their cost is rolled up as a separate line item and excluded from the build totals, so you don't need to exclude those by hand.

You still need `--exclude` for conversations the auto-flag can't catch — sessions *about* the project that didn't start with a report command:

```bash
ls ~/.claude/projects/<project-slug>/*.jsonl
```

(The script prints the slug-derived path if you get it wrong; it is the project's absolute path with every non-alphanumeric character replaced by `-`.)

For any session you don't recognise, peek at its first user message:

```bash
grep -o '"type":"text","text":"[^"]\{0,100\}' <session>.jsonl | head -3
```

- **Include**: `/start` / `/continue` sessions, gate Q&A, side questions about the app itself.
- **Exclude**: analysis conversations that started with free text (like this one, if the user typed a question rather than a report command — it will be the most recently modified transcript and its first message matches the user's current request), and anything unrelated to the workflow.
- After the run, the script's summary lists which sessions it auto-flagged as post-delivery. Show that list to the user and confirm it's right; to force one back into the build totals, re-run with `--keep=<id>`.

## Step 3: Run the generator

```bash
node .claude/skills/build-report-cost/generate-build-cost-report.mjs --rate=<ZAR_RATE> --exclude=<id1>,<id2>
```

The script prints a compact summary JSON (bucket count, total cost, cache-hit %, top tools, per-agent cost). Watch for:

- `WARNING: unknown models ...` — a model appeared that isn't in the script's `PRICING` table. Look up its real pricing (the `claude-api` skill has the current price table), add an entry to `PRICING` in the script (id → input/output prices + display name), and re-run. Do **not** ship a report with silently mispriced models without telling the user.
- An error that no epics were found under `generated-docs/epics/` — the workflow hasn't created an epic yet; tell the user there is nothing to report on yet.
- `WARNING: skipped epic(s) with no valid epic.createdAt` — an epic's state file is missing/malformed its timestamp, so its activity is left out. Mention it if it appears.

## Step 4: Open the report

```bash
start "" "generated-docs/reports/build-cost.html"
```

## Step 5: Summarise for the user

Give a short summary in chat, drawing only on the exact figures: total cost in ZAR (and USD), cache-hit rate, the most expensive phase/epic, deliberate user inputs and total waiting-on-user time, the tool profile, and one or two notable patterns (e.g. sub-agent fan-out, fix-cycle rework on a particular epic, the orchestrator's share of spend, a mid-run model switch). List any auto-flagged post-delivery sessions and their separate cost. Mention that the exchange rate is editable on the page itself.

## Methodology notes (do not silently change these)

- **Everything is ground truth.** Token counts, API-call counts, per-model attribution, cache read/write split, tool-call counts, sub-agent spawn counts, question counts, and deliberate-user-input counts are all read verbatim from the transcripts. Nothing is estimated. **Do not reintroduce active/idle/elapsed duration metrics for AI work** — they are reconstructed from timestamp gaps and are unreliable; that was the whole reason this report replaced the old cost/time report.
- **Waiting-on-user is the one measured duration**, and only between well-defined anchors: *approval waits* run from an `AskUserQuestion` tool call to its recorded `tool_result`; *other waits* run from the end of the previous transcript event to the next deliberate user input. Gaps over the stall threshold (10 minutes) are counted and totalled separately as stalls — never summed into waits. An interruption is not a wait (the AI was mid-generation). **Permission-prompt waits cannot be measured** — they aren't recorded in transcripts and are indistinguishable from tool runtime; the report says so rather than guessing.
- **Deliberate user inputs use transcript hygiene.** Transcripts record harness events as user-role messages; the script counts only entries a person produced — free-text typed messages, slash-command invocations, manual-test checklist submissions (`{"decision": "manual-test-results"…}`), and `[Request interrupted by user]` interruptions — each as its own category. Tool results, `<task-notification>`/`<ide_…>` events, and `isMeta` entries are excluded. Never report raw user-role message counts as "user prompts".
- **Post-delivery reporting is excluded from build totals.** Sessions whose first deliberate input is `/build-report`, `/build-report-cost`, `/build-report-effort`, or `/dashboard` (or their pre-1.3 names) are auto-flagged; their tokens/cost appear as a separate line item so report generation doesn't pollute cross-project comparison. `--keep=<id>` overrides the flag.
- **Sibling worktree transcript directories are included automatically** (directory names extending the project slug) — epics built in parallel git worktrees log there, and skipping them silently drops those epics.
- **Time buckets are epic-level.** A leading "INTAKE & setup" window, then one window per epic running from that epic's `createdAt` to the next epic's `createdAt` (the last epic open-ended). Granularity is epic-level because the epic-branch state records no per-story timestamps (stories carry only `status`/`commit`/`e2eStatus`) — per-agent/model breakdowns within each window still come from the transcripts. **Caveat:** contiguous `createdAt` windows assume epics were built sequentially; if two epics ran in parallel on separate branches, activity in the overlap is attributed to the earlier epic's window.
- **Dedup.** Streamed assistant snapshots repeat the same message id; both usage records and `tool_use` blocks are de-duplicated by message id before counting, so calls/tokens/tool-counts aren't inflated. `<synthetic>` assistant messages (no real usage) are skipped.
- **Cost** is computed from the exact token counts at list API prices (cache reads 0.1× input, cache writes 1.25×/2× for 5m/1h TTL). If the user is on a subscription, figures are the API-equivalent value of the compute, not cash spend — say so if asked.
- **Cache-hit rate** = `cacheRead / (input + cacheRead + cacheWrite)` — the share of input context served from cache. High is good (10× cheaper than fresh input).
- **Tool activity** counts every `tool_use` block across the orchestrator **and** all sub-agents, by tool name. The Edit-to-Write ratio is a churn signal.
- **Sub-agent fan-out** counts distinct sub-agent instances per bucket per `agentType` (from each sub-agent transcript's `.meta.json`). The **orchestrator** is the single continuous main session, so it has no instance count. **Fix cycles** = `playwright-runner instances − 1` for a bucket — at epic granularity the batched Playwright pass runs once per EPIC-END, so each extra run means the epic bounced back to BUILD for fixes. (`developer`/`test-generator` can't be used for this here — at epic level they run once *per story*, so their counts would conflate story count with rework.)
- **Epic subtotals** in each group header are aggregated **per contiguous group-segment** (walking buckets in order, starting a new segment when the group changes), **not by group name** — keep the segment-based aggregation.
- **Questions asked** = `AskUserQuestion` tool calls in main sessions, counted as individual questions (`input.questions.length`), with the dialog count kept alongside.
- **Epic/group collapsing** is on the main table: each group header is a clickable toggle (▸ caret) that hides or shows the rows beneath it (tied by a `data-gi` index). Groups are expanded by default.
