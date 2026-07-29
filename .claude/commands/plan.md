---
description: Plan the next epic ahead — break its stories down, get your approval, and park it ready to build without starting the build. Safe to run in a separate session while another epic is building.
---

Plan the next epic and park it **ready to build**. `/plan` runs the full PLAN routine — story breakdown
and stories approval — then stops at `READY-TO-BUILD`; `/start` builds it later.

**One window, one command.** Open a fresh Claude Code window and type `/plan`; everything git-related is
automatic. It does all its work in a **throwaway worktree cut from the latest `main`** and parks the
finished plan back **on `main`**, never a side branch. The plan lives on `main`, so it can never go stale;
no `epic/<slug>` branch is created here (`/start` cuts one fresh from `main` at build time). Running `/plan`
never disturbs a build in another window.

**Read and follow all rules in [orchestrator-rules.md](../shared/orchestrator-rules.md).**

## Step 0: Check the workspace is safe

1. **Don't interleave with an active flow.** If you're invoked mid-flow — an in-progress `/start` or
   `/continue` (intake, plan, or build) is already underway in *this* session — don't start planning here.
   Tell the user, plainly: *"I'm in the middle of \<what\> right now. Open a fresh Claude Code window on this
   project and run `/plan` there — it'll plan the next epic without disturbing this work."* — then resume
   your prior work (e.g. re-surface the approval you were waiting on).

2. **Project must exist.** If `generated-docs/project.md` is missing, there's nothing to plan against yet →
   tell the user, plainly: *"There's no project set up yet — run `/start` to set it up and build the first
   feature."* Stop.

3. **Otherwise, just proceed.** `/plan` never touches this window's branch or working tree — it reads
   readiness through git and writes only inside the Step-3 worktree. Don't ask the user where to plan,
   offer to switch branches, or set up a second folder. (Needs a shared remote — see the
   [No-remote note](#notes).)

## Step 1: Pick the epic to plan

Read readiness and show the recap per the [shared epic picker](../shared/epic-picker.md) (it owns the
data call, the `✓ ▸ ◆ ● ⊘` legend, the `hasPlan: false` fallback, and the up-to-3/ready-first
convention). A startable *draft* is a `ready` or `blocked` epic. Then `AskUserQuestion` with these
plan-verb options:

- **Question:** "Which epic would you like to plan next?"
- **Options:** the draft epics (ordered/labelled per the shared picker), plus "Plan a new one".
- `ready-to-build` epics are **already planned** — offer them for context only ("already planned; run
  `/start` to build"), not for re-planning.

Routing:
- **Draft chosen** → set `epicSlug`/`epicName`; take its `dependsOn` + `status` from the plan.
  Its brief already exists on `main` (approved with the epic plan) — skip to **Step 3** unless the user
  asks for changes.
- **Plan a new one** (or no drafts) → Step 2.

## Step 2: Capture a brand-new epic

*(New-epic path only. A chosen draft already has its inputs — skip to Step 3.)*

1. **Describe it.** Ask as plain text: *"What's the next epic, and what does it deliver?"* Capture as
   `epicDescription`; derive `epicSlug` (kebab-case) and `epicName`.

2. **Infer the setup, then confirm it.** Don't interrogate the user — read `generated-docs/project.md`
   (project facts) plus `generated-docs/epic-plan.md` and the existing briefs (the other epics) to work
   out two things:

   - **Project-level facts.** Decide whether this epic fits within the existing roles, auth, backend,
     compliance, and styling, or whether it *implies* a change to any of them (a new role, a new auth
     endpoint, a new compliance obligation, etc.). Most epics fit. Capture the set you judge **unchanged**
     as `projectChangesUnchanged`.
   - **Dependencies.** Decide which in-flight or planned epics (from Step 1) this one builds on, from the
     plan and briefs — the shared data models, endpoints, or screens it clearly sits on top of. The user
     often won't know reliably, so lead with your own read. Record the slugs as `dependsOn`
     (see [§6.3](../policies/epic-branch-concurrency.md#§63-cross-epic-dependencies)).

   Present the guess as regular text — one or two plain sentences, e.g. *"This looks like it fits your
   current setup (same roles, auth, backend, compliance, styling) and builds on **\<epic\>** because it
   needs its \<thing\>. I'll plan it against those unless you tell me otherwise."* — then a single
   `AskUserQuestion`, *"Have I got that right?"*, with:
   - **"Yes, plan it"** *(Recommended)* — proceed with the inferred facts + dependencies.
   - **"Dependencies are different"** — free-text which epics it really builds on; update `dependsOn`.
   - **"A project fact changes"** — one of roles/auth/backend/compliance/styling needs to change → go to 3.

   (The auto-`"Other"` affordance covers any other correction.)

3. **If a project-level fact really does change.** That's a **project-level** change — it belongs on
   `project.md`, which `/plan` does not edit. Tell the user, plainly, that changing a project fact (roles,
   auth, backend, compliance, styling) is a `/start` step and should be done there, then either plan this
   epic against the facts as they stand or stop so they can run `/start` first. This keeps `/plan` a pure
   planning action that only ever *adds* a new epic to `main`.

## Step 3: Open the background worktree and lay down the plan skeleton

Everything from here writes into a **throwaway worktree** cut from the latest `main`, never this window's
working tree. Refresh first: `git fetch origin`.

**Clear any leftover from an interrupted earlier run for *this* epic.** A crash between creating the
worktree and Step 5's teardown can leave a `plan/<epicSlug>` branch (and its directory), which would
collide with the `git worktree add` below.

```bash
git rev-parse --verify --quiet plan/<epicSlug>   # exit 0 ⇒ leftover branch exists; non-zero ⇒ none
```

- **None** → *Create the worktree*.
- **Leftover exists** → decide by whether its work already reached `main`:

  ```bash
  git merge-base --is-ancestor plan/<epicSlug> origin/main   # 0 ⇒ contained (safe); 1 ⇒ unsaved
  ```

  - **Contained (0)** — the earlier run landed its plan on `main`; the branch/directory are just cruft.
    Remove them (one plain line — *"cleaning up leftovers from an interrupted run"*) and *Create the
    worktree*:

    ```bash
    git worktree remove --force ../<project>-plan-<epicSlug> 2>/dev/null || git worktree prune
    git branch -D plan/<epicSlug>
    ```

  - **Not contained (1)** — interrupted **before** saving to `main`, so this branch holds the *only* copy of
    that work. **Don't delete it.** STOP and `AskUserQuestion` — *"A previous attempt to plan “<epicName>”
    was interrupted before it was saved. What would you like to do?"*:
    - **"Pick up where it left off"** — adopt the existing worktree as the working area (skip *Create the
      worktree*); read its `generated-docs/epics/<epicSlug>/state.json` + story files to find where it
      stopped (the [PLAN stage table](../hooks/phase-context/plan.md#determining-current-stage-after-compaction))
      and continue from there through Step 4 → Step 5.
    - **"Discard it and start fresh"** — run the two cleanup commands above, then *Create the worktree*.
    - **"Cancel"** — stop and leave everything untouched.

**Create the worktree** (skip if you chose *Pick up where it left off*; post a brief "setting up…"):

```bash
git worktree add -b plan/<epicSlug> ../<project>-plan-<epicSlug> origin/main
```

`../<project>-plan-<epicSlug>` is the throwaway directory (removed in Step 5); `plan/<epicSlug>` is the
throwaway branch that only carries the commit to `main`. Run every command below against it with
`git -C ../<project>-plan-<epicSlug> …` (git plumbing) or with the worktree path as the workspace root (file
writes).

**New-epic path only** — write the epic's records into the worktree:

1. **Land the plan row.** Add a row to the worktree's `generated-docs/epic-plan.md` Epics table for this
   epic (slug, name, goal, `dependsOn`).
2. **Write the brief.** Invoke `intake-agent` `mode: epic-only`, passing `workspaceRoot` so it writes into
   the worktree (not the session root):

   ```
   mode: epic-only
   workspaceRoot: ../<project>-plan-<epicSlug>
   epicSlug: <kebab-slug>
   epicName: <human name>
   epicDescription: <free text from Step 2>
   projectChangesUnchanged: <subset of [roles, auth, backend, compliance, styling]>
   ```

   Writes `<worktree>/generated-docs/epics/<epicSlug>/brief.md`; returns a `BRIEF SUMMARY`.
3. **Brief approval.** Follow the [Approval Pattern](../shared/approval-pattern.md) with `<artifact_path>` =
   the epic's `brief.md` in the worktree. Revise via `intake-agent` `revise` (target: brief, same
   `workspaceRoot`). Loop until approved.

**Both paths** — initialise state in the worktree at `phase: PLAN`:

```bash
node .claude/scripts/epic-state.js --init \
  --root ../<project>-plan-<epicSlug> --branch epic/<epicSlug> \
  --name "<epicName>" [--depends-on <dep-slug> ...]
```

`--branch epic/<epicSlug>` makes it write `generated-docs/epics/<epicSlug>/state.json` (the canonical
build-branch path) even though the worktree's own branch is `plan/<epicSlug>`. Verify
`"status": "initialised"`; on error, STOP, tear the worktree down (Step 5's teardown), and report.

**Blocked epic (a dependency not yet merged):** planning ahead is fine (planning needs no code), but **tell
the user the trade-off** — it can't merge until its dependency merges, and building it later may need a
rebase (surfaced at build/PR time). With that confirmed, continue; `dependsOn` still enforces merge
ordering.

## Step 4: Break the stories down (shared PLAN routine)

Run the PLAN routine's story generation + approval exactly as documented in
[continue.md → Phase: PLAN](continue.md#phase-plan): `feature-planner` in `stories` mode (point its
`brief`/`project` reads at the worktree — `../<project>-plan-<epicSlug>/generated-docs/…`), the editable
stories review page, and the stories approval.

**Run only continue.md's "On approval" persistence actions** (everything *before* the `PLAN → BUILD`
transition), writing into the **worktree**: the per-story files and the `state.json.stories`,
`epic.introducesSharedSurface`, and `epic.unverifiedAssumptions` fields. **Do not** run its remaining
"On approval" steps (the transition to `BUILD`, the commit, and "proceed to BUILD") — `/plan` transitions,
commits, and parks in Step 5 instead.

## Step 5: Park it on `main` — the `/plan` exit

Stories are approved and in the worktree; nothing's committed yet. Land the whole plan on `main` and
clean up:

1. Transition the worktree's `state.json.phase` from `PLAN` to **`READY-TO-BUILD`** via Edit — *not*
   `BUILD`. (This is the one place `/plan` diverges from continue.md's PLAN "On approval".)

2. Commit the plan in the worktree:

   ```bash
   git -C ../<project>-plan-<epicSlug> add generated-docs/
   git -C ../<project>-plan-<epicSlug> commit -m "docs(plan): plan epic <epicSlug> (ready to build)"
   ```

3. **Land it on `main` through the remote** — never checks out `main` here:

   ```bash
   git -C ../<project>-plan-<epicSlug> push origin HEAD:main
   ```

   If the push is rejected because `main` moved (a concurrent merge landed), fold it in and retry. Two
   `/plan` sessions each append a row to the `## Epics` table in `epic-plan.md`, so the rebase may stop
   there — resolve it as a [§6.2](../policies/epic-branch-concurrency.md#§62-shared-evolving-artifacts--pr-time-conflict-resolution)
   Tier-1 additive-union (keep **both** rows, fix the `#` numbering), then continue and push:

   ```bash
   git -C ../<project>-plan-<epicSlug> fetch origin
   git -C ../<project>-plan-<epicSlug> rebase origin/main   # conflicts per §6.2 — keep both rows, renumber
   git -C ../<project>-plan-<epicSlug> push origin HEAD:main
   ```

4. **Bring local `main` up to date** so `/status` and the dashboard show the parked epic (the collector
   reads the local `main` ref):

   ```bash
   git fetch origin main:main          # if THIS window happens to be on main, use: git merge --ff-only origin/main
   ```

5. **Tear down the worktree** — the user never sees it:

   ```bash
   git worktree remove --force ../<project>-plan-<epicSlug> || git worktree prune
   git branch -D plan/<epicSlug>
   ```

6. Regenerate the dashboard so the parked epic shows as *planned · ready to build*:

   ```bash
   node .claude/scripts/generate-dashboard-html.js
   ```

7. Tell the user, plainly, and **stop** — do **not** chain into building:

   > *“<epicName>” is planned and parked on `main`, ready to build. When you want to build it, run
   > `/start` and pick it — it'll cut a fresh branch from the current `main`, so your plan is never out of
   > date. Planning another epic? Just open a new window and run `/plan` again.*

## Notes

- **No remote → single-session fallback.** This concurrency model needs a shared remote. Without one,
  concurrent planning + building isn't supported (Step 0) — run a single session and substitute local git
  for every `origin` operation in Steps 3 and 5: cut the worktree from local `main`
  (`git worktree add -b plan/<epicSlug> ../<project>-plan-<epicSlug> main`); read readiness and the leftover
  check against `main`, not `origin/main`; skip every `git fetch`/`push`; and land the plan with
  `git branch -f main plan/<epicSlug>` (a fast-forward, since the worktree was cut from `main`). Per
  [§6.1](../policies/epic-branch-concurrency.md#§61-project-level-changes).
- **Where the build branch comes from.** `/plan` creates no long-lived `epic/<slug>` branch — the plan
  lives on `main` and rides forward with every merge, so it can't go stale. `/start` cuts that branch fresh
  from `main` at build time and re-checks the plan against it (see [start.md](start.md) Step B2 →
  [continue.md → Phase: READY-TO-BUILD](continue.md#phase-ready-to-build)).
- **State authority.** A parked epic's `state.json` at `READY-TO-BUILD` lives on `main`. When `/start`
  builds it, the fresh `epic/<slug>` branch's `state.json` becomes the source of truth and moves into
  `BUILD`.
