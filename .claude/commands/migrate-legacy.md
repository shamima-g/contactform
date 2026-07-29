---
description: Migrate a project from a legacy workflow shape (pre-4-phase or 4-phase) to the epic-branch workflow
---

You are migrating a project from a legacy state shape to the current **epic-branch** workflow. Two transforms may apply depending on what the project currently has:

| Detected state | Path | Output |
|---|---|---|
| **Pre-4-phase** — legacy `workflow-state.json` with phases like DESIGN/STORIES/REALIGN | A → B | Normalised to 4-phase, then split to epic-branch |
| **4-phase** — current `workflow-state.json` + `project-brief.md` + `intake-manifest.json` | B | Split to epic-branch |
| **Epic-branch** — `project.md` on main + `generated-docs/epics/` directories | (none) | No migration needed |

After migration completes, legacy paths are deleted. The workflow is single-model from that point.

---

## Step 0: Detect

Probe state with three quick checks:

```bash
test -f generated-docs/project.md && echo "epic-branch" || echo "not-epic-branch"
test -f generated-docs/context/workflow-state.json && echo "has-state" || echo "no-state"
test -f generated-docs/specs/project-brief.md && echo "has-brief" || echo "no-brief"
```

Routing:

- **`epic-branch`** → Tell user: *"Already on epic-branch. Nothing to migrate. Run `/start` to build the next epic, `/plan` to plan one ahead, or `/continue` to resume."* Stop.
- **`has-state` + `has-brief` + not `epic-branch`** → 4-phase or pre-4-phase. Continue to Step 1.
- **Anything else** → Tell user: *"No migratable legacy state found. Run `/start` to begin a new project."* Stop.

---

## Step 1: Path A — normalise to 4-phase (if applicable)

Dry-run the existing transform:

```bash
node .claude/scripts/migrate-legacy-state.js
```

Possible statuses:

- **`no_legacy`** — already on 4-phase. Skip directly to Path B (Step 2).
- **`no_migration_needed`** — same as above; skip to Path B.
- **`legacy_detected`** — pre-4-phase. Continue Path A.

### Path A: summarise + apply

From the dry-run output, present (concisely):

1. **What will change** — translate `changes[]`:
   - `state-rewrite` → "`workflow-state.json` will be rewritten (old → new phase model)"
   - `spec-copy` → "`feature-requirements.md` will be copied to `project-brief.md` with a migration header"
2. **Warnings the user should review** — pull `warnings[]`, grouped:
   - **Missing-evidence warnings** (no test files, no acceptance criteria) — flag for spot-check
   - **Synthesized-field warnings** — usually safe
   - **Dropped-block warnings** — informational

Do NOT print the raw migrated state JSON.

`AskUserQuestion`: *"Apply Path A (pre-4-phase → 4-phase)? A backup is saved to `workflow-state.legacy-backup.json` — `node .claude/scripts/migrate-legacy-state.js --restore` reverts it."*

On apply:

```bash
node .claude/scripts/migrate-legacy-state.js --apply
```

Confirm status is `applied`, then proceed to Path B.

If status is **`skipped`** (a `workflow-state.legacy-backup.json` from a prior run already
exists, so the rewrite was NOT performed to avoid clobbering it without a fresh backup),
the state on disk is unchanged — do **not** proceed to Path B. Tell the user to run
`node .claude/scripts/migrate-legacy-state.js --restore` first if they really mean to
re-migrate, then re-apply.

---

## Step 2: Path B — split to epic-branch

The project is now in 4-phase shape. Path B splits it into the epic-branch layout. The transform is mostly file moves + a brief split via the intake-agent.

### Step 2.1: Read the legacy state

```bash
cat generated-docs/context/workflow-state.json
cat generated-docs/context/intake-manifest.json
```

Extract per-epic info. The legacy state JSON carries only *status* fields — story **content** (title, acceptance criteria, R-IDs) lives in on-disk `generated-docs/stories/epic-<N>-<slug>/` files. Glob that directory for the per-epic dir names:

```
For each epic key N in workflow-state.epics:
  - slug:   the on-disk dir name generated-docs/stories/epic-<N>-<slug>/ with the
            `epic-<N>-` prefix stripped (authoritative); fall back to epic.name
            minus that prefix; last resort `epic-<N>`.
  - status: "complete" if epic.phase is terminal / all stories COMPLETE;
            "in-progress" if N == currentEpic; else "pending".
  - stories: keys of epic.stories{} — each has phase / acceptance / e2eStatus /
             manualVerification (status only), NOT requirement or content metadata.
```

Build the slug↔epic map here; you pass it to `intake-agent` (Step 2.3) and reuse it for state placement + file moves (Step 2.4).

### Step 2.2: Plan the split

Present the plan to the user as conversation text:

```
Migration plan — epic-branch:

Project-level:
  → generated-docs/project.md  (from project-brief.md §2/§3/§4/§5/§10-baseline/§11 + intake-manifest)

Completed epics → main:
  - <slug-1>/  (brief.md + state.json with phase=COMPLETE + stories/ + journal.md slice)
  - <slug-2>/  (...)

In-flight epic → epic/<slug> branch:
  - <slug-N>/  (brief.md + state.json with phase=<current phase> + stories/ + journal.md slice)

Pending epics (not yet built) → main as drafts (brief.md only):
  - <slug-X>/  (brief.md only — a draft; /plan or /start picks it up)

Files deleted after approval:
  - generated-docs/specs/project-brief.md
  - generated-docs/context/  (entire directory)
  - generated-docs/stories/  (replaced by per-epic stories/ in epics/)
```

### Step 2.3: Invoke intake-agent in split-brief mode

```
Agent: intake-agent
mode: split-brief
slugMap: { "<N>": "<slug>", ... }   # from Step 2.1, derived from the on-disk stories/ dir names
legacyArtifacts:
  briefPath: generated-docs/specs/project-brief.md
  manifestPath: generated-docs/context/intake-manifest.json
  workflowStatePath: generated-docs/context/workflow-state.json
  journalPath: generated-docs/context/journal.md
```

The agent writes `generated-docs/project.md` and `generated-docs/epics/<slug>/brief.md` per epic. It returns a `SPLIT SUMMARY` with the slug ↔ epic-N mapping. **The agent does not delete legacy artifacts, write state.json files, or touch git state** — that's this command's job.

### Step 2.4: Generate per-story files + place state.json

The legacy story **content** (title, acceptance criteria, etc.) already lives in on-disk files at `generated-docs/stories/epic-<N>-<slug>/story-<M>-<storySlug>.md`. The legacy `state.json` carries only per-story *status* fields (`phase`, `acceptance`, `e2eStatus`, `manualVerification`) — NOT requirement / route / target metadata. So **move** the existing files; do not regenerate them from state (the rich fields aren't there to regenerate from).

For each epic:

1. **Move the story files** (`git mv` preserves history and bypasses the name-enforcement hook):

   ```bash
   mkdir -p generated-docs/epics/<slug>/stories
   git mv generated-docs/stories/epic-<N>-<slug>/story-*.md generated-docs/epics/<slug>/stories/
   ```

   The legacy `story-<M>-<storySlug>.md` name already matches the new `story-<N>-<slug>.md` convention, so no rename is needed. If a moved file lacks fields a resumed BUILD wants (route, targetFile), leave it — the in-flight epic's agents reconcile on the next story, and completed epics are frozen records.

2. **Synthesize each `state.json.stories["<M>"]` entry from the status fields that exist:** map legacy story `phase` + `manualVerification` → new `status` (`complete` / `in-progress` / `pending` / `halted`), copy `e2eStatus`, set `commit: null` (not recorded — journal a note). Do not invent `cycleNumber` (it's derived).

**Then per category:**

- **Completed** — write `state.json` to `generated-docs/epics/<slug>/state.json` on main with `phase: COMPLETE` and one `stories["<M>"]` entry per legacy story. Moved story files sit alongside on main.
- **In-flight** (`currentEpic`) — `git checkout -b epic/<slug>`, then `node .claude/scripts/epic-state.js --init --name "<epic name>"`. Edit state.json to set the mapped phase + per-story statuses. Moved story files go on the branch.
- **Pending** — move any planned story files and the brief.md to main. **No state.json** — these are drafts; `/plan` or `/start` picks them up.

### Step 2.5: Split the journal

`generated-docs/context/journal.md` has per-epic sections (e.g. `## Epic 1 — <name>`). Split each into `generated-docs/epics/<slug>/journal.md`. The slug comes from the split summary's mapping. Discard the "Implementation Journal — <project>" preamble (project-level narrative now lives in project.md).

### Step 2.6: Approval — user approves the split

Present the resulting file tree concisely:

```
Migration produced:
  generated-docs/project.md                   (project facts)
  generated-docs/epics/<slug-1>/             (complete, on main)
  generated-docs/epics/<slug-2>/             (complete, on main)
  ...
  + branch epic/<slug-N> with state.json + stories
  + draft briefs at <slug-X>/  on main

Files queued for deletion:
  generated-docs/specs/project-brief.md
  generated-docs/context/  (entire dir)
  generated-docs/stories/  (after move)

About to delete legacy paths and commit.
```

`AskUserQuestion`: *"Apply the migration?"*
- *"Apply"* — proceed to Step 2.7.
- *"Let me review first"* — emit *"Look over the new files; re-run /migrate-legacy to apply when ready. Nothing has been deleted yet."* and stop. The user can revert by `git restore` since the writes aren't committed.

### Step 2.7: Commit + cleanup

```bash
# On main: delete legacy paths and commit
git checkout main
rm generated-docs/specs/project-brief.md
rm -rf generated-docs/context/
rm -rf generated-docs/stories/

git add generated-docs/project.md generated-docs/epics/
git rm generated-docs/specs/project-brief.md generated-docs/context/ generated-docs/stories/ -r
git commit -m "chore: migrate to epic-branch workflow"
git push origin main
```

If an `epic/<slug>` branch was created for the in-flight epic, switch to it and push:

```bash
git checkout epic/<slug>
git push -u origin epic/<slug>
```

### Step 2.8: Verify

```
Migration complete.

Project: generated-docs/project.md
Merged epics: <count> on main
In-flight: epic/<slug> (phase=<phase>)
Drafts: <count> awaiting pickup via /start

Run /continue to resume the in-flight epic, or /start to begin a new one.
```

---

## Restore

Path A's restore still works for the 4-phase rewrite:

```bash
node .claude/scripts/migrate-legacy-state.js --restore
```

Path B is **not auto-revertible** — once the legacy paths are deleted and committed, restoring means `git revert <migration-commit>`. Surface this clearly during Step 2.6 so the user understands the commitment before approving.

---

## DO

- Always run Step 0 detection first.
- For Path B, show the migration plan before invoking intake-agent.
- Apply Path A first if pre-4-phase, then Path B on the normalised result.
- Move story files (don't copy) — duplicate copies cause downstream confusion.
- Discard the legacy journal preamble; project-level narrative belongs in project.md.

## DON'T

- Don't delete legacy paths before the user approves at Step 2.6.
- Don't write state.json for pending epics — they're drafts (brief.md only).
- Don't try to recover commit SHAs that weren't recorded in the legacy state — leave `"commit": null` and journal a note.
- Don't re-run Path B if `project.md` already exists; Step 0 catches this.
- Don't generate an `epic-plan.md` — migrated projects intentionally run on the standard view (`/plan` or `/start` picks up drafts; `/status` shows in-flight + merged). Legacy has no dependency graph to populate a plan from; the plan/readiness view is for projects newly planned via `/start` Case A.

## Related commands

- `/start` — build entry point after migration (picks up draft briefs; `/plan` plans them ahead)
- `/continue` — resume the in-flight epic on its branch
- `/status` — confirm post-migration state renders correctly
