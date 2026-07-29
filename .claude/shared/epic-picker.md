# Epic Picker (shared)

The readiness recap + picker mechanics for choosing the next epic. Used by
[`/start`](../commands/start.md) Step B1 (to **build**) and [`/plan`](../commands/plan.md) Step 1
(to **plan**). Each command supplies its own verb, question wording, options, and routing; this file
owns the parts that must stay **identical** between them, so a change to the legend or the picker
convention is made once.

## Read readiness

```bash
node .claude/scripts/collect-dashboard-data.js --format=json
```

**`hasPlan: true`** — the `plan` array carries every epic with a derived `status` and, for blocked
ones, `waitingOn`:

| Glyph | `status` | Meaning |
|---|---|---|
| ✓ | `done` | Merged to `main` |
| ▸ | `in-flight` | An epic branch is actively being worked |
| ◆ | `ready-to-build` | Planned and parked by `/plan`, waiting to be built |
| ● | `ready` | A draft whose dependencies are all done — startable now |
| ⊘ | `blocked` | A draft still waiting on a dependency (see `waitingOn`) |

Show a one-line recap in that order — `✓ done · ▸ in flight · ◆ planned · ● ready · ⊘ blocked`, with
what each blocked epic waits on — before asking.

**`hasPlan: false`** (migrated / pre-decomposition projects) — no `plan` array; fall back to a scan:
glob `generated-docs/epics/*/brief.md`; a **draft** has no sibling `state.json` **and** no
`epic/<slug>` branch. Offer drafts by their Goal line. A **parked** epic (planned by `/plan`) has a
sibling `state.json` at `READY-TO-BUILD` on `main` but **no** branch — it isn't a draft; offer it as
*already planned* (build via `/start`), not for re-planning.

## Picker convention

`AskUserQuestion` with **up to 3** epic options. Order them: for the command that builds a parked epic
(`/start`), **`ready-to-build` epics first** — offered as "Build `<name>` (already planned)"; then
**ready drafts** (dependencies satisfied → independent, safe to run in parallel from other sessions);
then blocked drafts labelled "(waits on `<name>`)" — plus the command's own "something new" option.
(`/plan` doesn't build, so it lists parked epics in the recap as context only, never as a re-plannable
option.) If more options exist than fit, the prose recap lists them all and the user names one via
"Other".

`in-flight` epics are **resumed** with `git checkout epic/<slug>` → `/continue`, not started here;
`done` epics are context only.
