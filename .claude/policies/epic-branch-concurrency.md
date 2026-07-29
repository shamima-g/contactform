# Epic-Branch Concurrency Policy

Rules for concurrent epic work, PR-time conflicts, project-level edits during
in-flight epics, and cross-epic dependencies under the epic-branch workflow.

Referenced by [continue.md](../commands/continue.md), [start.md](../commands/start.md), [plan.md](../commands/plan.md), and [agent-autonomy.md](../shared/agent-autonomy.md).

---

## §6.1 Project-level changes

When the developer agent halts because the story needs a project-level change
(new role, new auth endpoint, new compliance obligation, data-source flip,
styling token, etc.), the change targets `project.md` on `main`, **not** the
epic's `brief.md` or any file on the epic branch. The developer raises a Tier 4
halt with `requiresProjectChange: true` and the proposed edit; the orchestrator
applies it inline so the user sees one approval, not two interruptions.

**Rule:** `project.md` is never edited from an `epic/*` branch — and, more
generally, **shared records on `main` (`project.md`, the `epic-plan.md` plan, and
draft `brief.md` files) are written only by landing a commit on `main`, never by
moving a live session's `HEAD` onto `main`.** Under concurrent sessions each epic
lives in its own git worktree, and git refuses to check out `main` in a second
worktree — so the old "`git checkout main` … edit … `git checkout epic/<slug>`"
dance **fails outright** when another worktree holds `main`. [`/plan`](../commands/plan.md) uses this
same main-landing write for its whole job: it parks an epic's entire plan — plan row, `brief.md`,
stories, and `state.json` at `READY-TO-BUILD` — on `main` from a throwaway worktree, and never creates a
long-lived `epic/<slug>` branch (the build branch is cut fresh from `main` at build time, so the parked
plan can't fall behind).

### The main-landing write (single-developer, default)

Run from the epic session — it never leaves its own branch:

1. Commit or `git stash` any WIP so the working tree is clean.
2. `git fetch origin`, then cut a throwaway worktree from the latest `main` **as a
   new branch** (a new branch, *not* `main` itself, so it can't collide with a
   worktree that already holds `main`):
   ```bash
   git worktree add -b main-change/<slug> ../<tmp> origin/main
   ```
3. Make the edit in `../<tmp>` — the `project.md` change, or the `epic-plan.md` row
   + draft brief. For a project change, surface it first: `AskUserQuestion`:
   *"Apply this project.md change?"* with the diff inline. Options: *"Apply"*,
   *"Edit further"*, *"Cancel — halt back to user"*.
4. Commit in `../<tmp>` (`chore(project): <description>` or `docs(plan): add epic
   <slug>`), then **land it on `main` through the remote** — no local worktree ever
   sits on `main`:
   ```bash
   git push origin HEAD:main
   ```
   If the push is rejected because `main` moved (a concurrent session landed first —
   the step-3 approval window makes this the norm, not the exception), fold it in and
   retry:
   ```bash
   git -C ../<tmp> fetch origin
   git -C ../<tmp> rebase origin/main       # conflicts per §6.2 (e.g. keep both epic-plan.md rows)
   git -C ../<tmp> push origin HEAD:main
   ```
5. Remove the throwaway worktree and its branch:
   ```bash
   git worktree remove ../<tmp> && git branch -D main-change/<slug>
   ```
6. Pick the change up **in place** on the epic branch (`HEAD` never moved):
   ```bash
   git fetch origin && git rebase origin/main        # conflicts per §6.2
   git push --force-with-lease origin epic/<slug>    # if the branch is pushed
   ```
7. `git stash pop` if you stashed. For a project change, re-invoke the developer
   for the halted story (it picks up `project.md`'s new contents); for a `/plan`
   new epic, continue planning.

### Team flow (protected `main`, opt-in)

Step 4 becomes a PR instead of a direct push: keep the `main-change/<slug>` branch,
`git push -u origin <branch>`, `gh pr create`, wait for review/merge, then proceed
from step 5. Teams that protect `main` against direct pushes set
`projectChangesViaPR: true` in `project.md` front-matter.

### Other live sessions pick it up at a checkpoint

A change to `main` doesn't reach the other in-flight sessions until each one
**fetches and rebases**. Every session runs this checkpoint at its natural
boundaries — `/continue` entry, `/plan` after it commits stories, and before
opening a merge PR:

```bash
git fetch origin && git rebase origin/main            # conflicts per §6.2
git push --force-with-lease origin epic/<slug>        # if the branch is pushed — rebase rewrote its SHAs
```

The force-with-lease push is required whenever the branch was already pushed:
the rebase rewrote its commits, so a plain `git push` would be rejected as a
non-fast-forward. `--force-with-lease` still refuses if the remote moved
unexpectedly, so it can't clobber another session. Run the checkpoint only on a
**clean working tree** (commit or stash first) and skip it entirely when there's
no remote or the branch is already current.

When the advance carried a **`project.md`** change the current plan depends on,
surface a one-line note and re-check the affected stories; otherwise rebase
silently and carry on.

### Precondition & fallback

This model integrates through a **shared remote** — the normal setup (epics are
pushed; PRs open via `gh`). **With no remote, concurrent sessions aren't
supported:** fall back to a single session and the plain in-tree edit — keep the
same clean-tree and approval discipline as the main-landing write above, just
land directly on local `main`: `git stash` any WIP first → `git checkout main` →
make the edit → for a project change, get the *"Apply this project.md change?"*
approval → commit → `git checkout epic/<slug> && git rebase main` →
`git stash pop`. Safe only because nothing else holds `main`.

---

## §6.2 Shared evolving artifacts — PR-time conflict resolution

`web/src/app/globals.css` (design tokens), `web/src/mocks/handlers.ts`,
generated `api-spec.yaml`, and any project-wide barrel exports are commonly
touched by multiple epics. At PR-rebase time (during the project-change flow
above OR when opening the epic's own merge PR), conflicts resolve as follows:

| Conflict class | Files | Resolution | Tier |
|---|---|---|---|
| **Additive union** | Different sections of `globals.css`, different handlers in `handlers.ts`, different API paths in `api-spec.yaml`, additions to barrel `index.ts`, new epic rows in `epic-plan.md` | Auto-merge keeping both sides | Tier 1 (autonomous) |
| **Lock-file** | `web/package-lock.json` | Discard both sides of the conflict; run `npm install --prefix web` after the merge; commit the fresh lock | Tier 1 (autonomous) |
| **Same dep, different versions** | `package.json` declaring the same package at different versions | Halt | Tier 4 — coordinate via project.md (the version bump is a project decision) |
| **Source-file conflict** | Anything in `web/src/**` or `web/e2e/**` | Halt | Tier 4 — surface both diffs; user picks |

The orchestrator applies Tier 1 resolutions automatically and commits the
rebase. For Tier 4 conflicts, halt per the standard halt format with both
diffs attached.

### `epic-plan.md` is conflict-free by construction

`generated-docs/epic-plan.md` holds **plan data only** — the epic list, the
dependency graph, and the requirement→epic coverage map. Live status
(not-started / in-flight / done) is **derived from git** by
`collect-dashboard-data.js`, never written into the file. And it is edited
**only in a planning context on `main`** (Case A creating the plan, or `/plan` / `/start`
appending a later epic) — **never on an epic branch.** Consequences:

- Concurrent epic branches never touch it, so they merge back cleanly (one-sided
  changes) — **zero conflicts during concurrent BUILD.**
- The only writes are planning edits on main, which serialise through main.
  Two planning sessions adding *different* epics → additive-union auto-merge
  (new table rows, Tier 1); a semantic clash on the *same* epic's row → Tier 4
  (surface both, user picks). A markdown-list merge is trivial for the orchestrator.

---

## §6.3 Cross-epic dependencies

Dependencies are mostly **known up front**: the Case A decomposition records each
epic's `dependsOn` in `epic-plan.md`, and the readiness view marks an epic
`blocked` until its dependencies merge. A brand-new epic added later (via `/plan` or `/start`) is
the exception — there the orchestrator infers which existing epics it builds on (from the plan and
briefs) and confirms that read with the user, rather than relying on the user to know.

**Recording a dependency + basing the branch:**

1. `epic.dependsOn: ["<slug-A>"]` is recorded in epic B's `state.json` (via
   `epic-state.js --init --depends-on`); the dependency also lives in `epic-plan.md`.
2. **Branch base (v1 default): from `main`.** When every dependency is already
   merged (epic B is `ready`), branching from main is complete — the deps' code
   is on main. When a dependency is still in flight (epic B is `blocked`), the
   recommendation is to start a `ready` epic instead, or wait for the dependency
   to merge; `dependsOn` still enforces merge ordering.
3. **Branch-stacking (advanced, opt-in):** if epic B genuinely needs an in-flight
   dependency's not-yet-merged code, stack it —
   `git checkout epic/<slug-A> && git checkout -b epic/<slug-B>`. Not the default,
   because of the rebase/merge-ordering coupling below.

**Consequences the user should know:**

- A `blocked` epic can't cleanly merge until its dependency merges — surfaced at
  PR-open time and in the readiness view.
- A *stacked* epic B: if `epic/<slug-A>` is rebased (per §6.1), `epic/<slug-B>`
  must rebase too; A must merge before B; if A is abandoned, B must rebase onto
  main (and may break if it relied on A's deliverables — surface as a halt).

The orchestrator reads `epic.dependsOn` from state.json at PR-open time and
emits a one-line check ("Epic <slug-B> depends on epic <slug-A> — waiting for
that PR to merge first").

**Two `dependsOn` records, one authoritative per question.** An epic's
dependencies appear in two places: `epic-plan.md` (drives the *readiness* view —
ready/blocked — and is editable on main) and the started epic's `state.json`
(drives the *merge-ordering* rule above, and is frozen once the epic starts).
They're written from the same decision at start time, so they normally agree.
But editing a **started** epic's row in `epic-plan.md` changes only the readiness
view, not the merge-ordering rule — `state.json` is authoritative for what blocks the
merge. If you need to add or drop a dependency on an epic that has already
started, update its `state.json` (a §6.1 project-change-style edit), not just the
plan; otherwise the dashboard and the PR-open check will disagree.

---

## Out of scope

- **Distributed concurrency** (two devs on two machines simultaneously). The model supports it via git remotes, but coordination tooling — "who else has an in-flight epic right now?" — is not in this policy. Single-user, multi-branch is the target.
- **Cross-epic refactors changing project-wide code from inside an epic.** Project-level *code* lands as part of whatever epic touches it; project-level *config* goes through §6.1.
- **Renaming a merged epic.** Manual. The slug is in the directory name and git history.
- **Abandoning a branch with a dependent in flight.** Surface as a halt; user decides whether the dependent epic rebases to main or also abandons.
