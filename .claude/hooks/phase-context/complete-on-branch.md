# COMPLETE-ON-BRANCH Phase Context (post-compaction)

This file is injected by `inject-phase-context.ps1` when the orchestrator session is resumed after auto-compaction. Its job is to restore enough context for `/continue` to pick up cleanly — not to re-document the flow.

**Canonical sources:**
- Phase orchestration → [`commands/continue.md`](../../commands/continue.md) § Step B7.2 (B7.2.1–B7.2.7)
- Final state transition → [`scripts/mark-epic-complete.js`](../../scripts/mark-epic-complete.js)

## Key file paths

- State: `generated-docs/epics/<slug>/state.json`
- Journal: `generated-docs/epics/<slug>/journal.md`

## What COMPLETE-ON-BRANCH means

The manual-test approval passed; all work is committed on `epic/<slug>`. What remains is PR + merge: push, open the PR, wait for CI, get user-approved merge, clean up the branch, then flip state to `COMPLETE` on main. The orchestrator **never auto-merges** — merge is a user-approved step.

## Determining current stage after compaction

| Signal | Current stage |
|---|---|
| `git remote -v` empty | No remote — emit "epic is complete on the local branch; merge to main manually" and end `/continue` (B7.2.1) |
| Branch not pushed / no PR open | Push and open the PR (B7.2.1–B7.2.2) |
| PR open, CI pending | Wait for CI; on failure offer fix-or-force (B7.2.3) |
| CI green, merge not confirmed | Call `AskUserQuestion` for the user-approved merge (B7.2.4) |
| PR merged on main | On main, run `node .claude/scripts/mark-epic-complete.js --slug <slug>` to flip `phase` → `COMPLETE` (check the JSON `status`), commit, then summarise (B7.2.5–B7.2.7) |

`phase` stays `COMPLETE-ON-BRANCH` until the merge lands and `mark-epic-complete.js` flips it to `COMPLETE` on main.
