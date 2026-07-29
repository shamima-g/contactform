---
description: Show current workflow progress - displays which phase you're in and what's completed
model: haiku
---

You are showing a developer their current position in the TDD workflow. This is display-only - do not take any action.

## Step 1: Collect and Display Status

Run the data collection script with text output:

```bash
node .claude/scripts/collect-dashboard-data.js --format=text
```

Display the script's output **as-is** to the user. The script produces pre-formatted terminal output including:

- Project name
- In-flight epics: one line per `epic/*` branch with phase, story progress, and halt indicator
- Merged epics: most recent first, with completion date and story count

## Error Handling

If the script returns `no_project`:
- Display that message
- Suggest `/start` to begin the workflow

If the script returns `legacy_detected`:
- Display the message
- Suggest `/migrate-legacy` to convert to the epic-branch workflow

If the script fails to run:
- Check if the script exists: `.claude/scripts/collect-dashboard-data.js`
- Report the error

## Phase Descriptions

If the user needs clarification, explain phases in plain language:

| Phase | Description |
|-------|-------------|
| PLAN | Proposing stories for the current epic (stories approval) |
| READY-TO-BUILD | Stories planned and approved via `/plan`, parked on `main` and waiting — building hasn't started (run `/start` to build it; it cuts a fresh branch from `main`) |
| BUILD | Tests batched up front, then per-story loop: developer → inline light gate → commit |
| EPIC-END | Full /quality-check, then /code-review --fix, then batched Playwright against the production build — each with a fix cycle |
| MANUAL-TEST | User walks through per-story manual checklists |
| COMPLETE-ON-BRANCH | PR + CI + user-approved merge to main |
| COMPLETE | Frozen historical record on main after merge |

## DO

- Display the script output as-is (no reformatting needed)
- Keep output concise
- Always suggest next action (`/continue` or `/start`)

## DON'T

- Take any action (this is display-only)
- Run tests (that's for `/continue` to do)
- Resume or launch agents
- Show raw JSON to the user
- Reformat the script's text output — it's already formatted

## Related Commands

- `/continue` - Resume workflow from current position
- `/start` - Start TDD workflow from beginning
- `/dashboard` - Open visual dashboard
- `/quality-check` - Run all quality gates
