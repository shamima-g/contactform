---
description: Upgrade an existing project to a newer version of the Stadium Builder template — updates the workflow machinery, merges the mixed template/project files, performs any needed migrations, and fixes up the result autonomously on a branch, then applies it to main once the user approves.
---

You are upgrading this project to a newer version of the template.

**Run this autonomously.** The user is a non-developer, so handle everything yourself —
**including the git**: mixed-file merges, guardrail updates, config changes, quality-check
failures, and the commit + merge. They get exactly **two** plain yes/no decisions: approve
*starting* the upgrade (Step 1) and approve *applying* it (Step 9) — plus, only if it happens, a
red CI check at 9.4, which is never pushed past silently. Never surface a diff, a
config change, or a git command for them to act on, and halt to ask **only** on a genuine
always-halt condition ([agent-autonomy.md](../shared/agent-autonomy.md) Tier 4) — never for
routine upgrade work. **Never merge to `main` without the Step 9 confirmation.** (Telling them
in plain language what you already handled — the Step 9.2 summary — isn't "surfacing"; that's
the summary's job.)

**Keep it moving and visible.** Before each slow step — cloning the template, installing
dependencies, `/migrate-legacy`, the build — tell the user in one line what's happening
and that it may take a few minutes, so a long run reads as progress, not a hang.

**Batch your investigation.** The upgrade is a long dependency chain, so the main avoidable
cost is round-trips. Prefer one combined command over many small ones — diff *all* flagged
files in a single command, check several paths at once. Don't inspect files one at a time.

**If you have to stop.** Any halt once the branch exists — a non-zero applier exit, a fix loop
that can't reach green, a genuine always-halt condition — must not leave the user stranded on
`chore/upgrade-<tag>` with a part-applied tree (the next `/start` would build on it). Park the
work and put them back on a clean `main`:

```bash
git add -A
git commit -m "chore: incomplete upgrade to <tag> — not applied" || true  # nothing staged if it stopped early
git checkout main
```

Then say in one line what stopped it and that their own project is untouched. This is how a
stop ends — it is not licence to bail out of routine fix work (Step 8).

---

## Step 0: Guard — safe to upgrade?

```bash
git rev-parse --abbrev-ref HEAD
git status --porcelain
test -f template-version.json && echo "stamped" || echo "no-stamp"
```

Proceed only if you're on `main` (default branch) with a clean tree — which also settles the
"no epic mid-BUILD" requirement, since epics live on `epic/<slug>` branches. If either fails,
tell the user the one specific thing to do first (e.g. "finish or shelve the in-flight epic,
then run `/upgrade` again") and stop. A missing version stamp just means this is the first
upgrade — fine (see Step 2).

---

## Step 1: Pick the target version

Find the latest template version. Prefer `gh` (it also gives the release notes); if `gh`
isn't authenticated or installed, fall back to an anonymous tag lookup — the upgrade itself
is fetched by `git`, not `gh`, so it doesn't need `gh` to proceed:

```bash
gh release view --repo stadium-software/stadium-8 --json tagName,name,body 2>/dev/null \
  || git ls-remote --tags --refs --sort=-v:refname https://github.com/stadium-software/stadium-8.git 'v*' | head -1
```

- **`gh` worked** → you have the `<tag>` plus a one-line summary of what it brings.
- **`gh` unavailable, tag lookup worked** → the target `<tag>` is the `refs/tags/<tag>` on
  the printed line. You have no release notes — tell the user the version, that the
  "what's new" details need `gh`, and that the upgrade will apply **locally** at the end
  (no pull request; see Step 9).
- **Both failed** (no network / repo unreachable) → say so plainly and stop; an upgrade
  needs to reach the template repo.

**Already on it?** If Step 0 printed `stamped`, read `template-version.json` (Read tool): if its
`templateRef` already equals `<tag>`, tell the user *"You're already on the latest version
(`<tag>`) — nothing to upgrade."* and **stop here** — don't branch, clone, or commit. Nothing
downstream catches this (the applier re-stamps the marker every run, so there is always
something to commit). Continue past a match only if the user explicitly asks you to re-apply
that version. `no-stamp` → carry on; keep what you read for Step 2.

Get a single go-ahead: `AskUserQuestion` — *"Upgrade this project to `<tag>`? I'll do
everything on a branch, run the checks, and apply it once you give the go-ahead."*

Then create the branch:

```bash
git checkout -b chore/upgrade-<tag>
```

---

## Step 2: The diff base

The **base** is the `templateRef` from the marker you read in Step 1 — the version this project
last applied. **Step 5** needs it to diff the template's own `base → target`, so the `CLAUDE.md`
merge touches only lines the template actually changed. (Step 3's applier reads the marker
itself — nothing to pass.)

No marker: no base, so in Step 5 compare the target template against the project's current
files and be conservative on the mixed files.

---

## Step 3: Apply the template — one deterministic pass

Tell the user you're fetching the template and applying the update (a few seconds), then:

```bash
node .claude/scripts/apply-template.js --ref <tag> --keep-clone --report generated-docs/upgrade-report.md
```

Auto-approved and one pass, so you don't hand-copy anything. It applies **machinery** and
**guardrails**, **prunes retired** files so the project matches the template's *shape*, merges
`.gitignore` and reconciles `web/` **additively** (never overwriting an existing `web/` file,
never touching `web/src|e2e|public`), regenerates `web/package-lock.json` when it changed
`package.json`, and writes the version stamp. It reads the base off `template-version.json`
itself — nothing to pass. Add `--help` for the detail. Its deletions are template-owned files
only and land on the branch like everything else; don't re-check them file by file.

**If this command exits non-zero, STOP** — don't continue to any later step. The most likely
cause is that `package.json` changed but the lockfile couldn't be refreshed (offline / a
version that won't resolve); the report and stderr say exactly what to do (run
`(cd web && npm install)` while online, commit `web/package-lock.json`, re-run). Merging a
branch whose lockfile is out of sync would fail the user's CI — the very bug this guards.
Stopping means the abort above: park the branch and put the user back on `main`.

`--keep-clone` makes it print `TEMPLATE_DIR=<path>` (the fetched template) to stderr —
**reuse that path for every diff/merge in Steps 4–5; do not clone again.** Then read the
report file (`generated-docs/upgrade-report.md`) — it's your work list for Steps 4–5.
Guardrails are already applied; you do **not** hand-apply them or ask the user about them — the
report lists them under their own heading so the Step 9.2 summary can tell the user the settings,
hooks and automated checks changed.

**Then install dependencies in the background — only when they changed.** If the report has a
*package.json additions* section, or `web/node_modules` is missing (`test -d web/node_modules`),
launch this now and let it run through Steps 4–6 (dependencies are final by then): tell the user
in one line, keep the task handle, join it in Step 8. Otherwise skip it, and skip the join — the
installed packages already match the lockfile, and `npm ci` would delete and rebuild
`node_modules` for an identical result.

```bash
(cd web && npm ci)
```

`npm ci`, never `npm install`: it installs from the lockfile without rewriting it, so the
complete lock the applier just wrote survives.

---

## Step 4: `web/` and root config — finish what the applier flagged

The applier already merged `package.json` additions and refreshed `web/package-lock.json`, and
any `npm ci` you launched is installing the packages. Two small things remain:

- **Confirm the lockfile is in sync:** if the report has a *package.json additions* section,
  `web/package-lock.json` should be in this branch's diff alongside `web/package.json`. (A
  refresh that *failed* exits Step 3 non-zero, so it can't reach this step — you're confirming
  the successful case landed, not handling the failure.)
- **Merge any flagged config — in one pass:** if the report's *"changed upstream but left
  untouched"* list is non-empty, diff them **all at once** against the Step 3 clone (the path it
  printed) in a single command, then apply the updates in one edit pass — take the template
  version for files the project hasn't customised, preserve customisation where it exists
  (usually only `next.config.ts`, `tsconfig.json`, or the root `Dockerfile`). If the list is
  empty, skip this.

Never touch `web/src/`, `web/e2e/`, `web/public/`, or root app files like `proxy.ts`.

---

## Step 5: Merge the mixed files (judgment)

Update only the template-owned parts; preserve everything the project added. Do this
yourself — never ask.

- **`CLAUDE.md`** — update the template sections (the numbered **Critical Rules** and the
  **Policies** list) to match the target; leave every project-specific section and edit
  exactly as-is. To see precisely what the template changed, use the Step 2 base and diff
  `base → target` in the Step 3 clone. The fetch is usually a no-op — Step 3 resolved the same
  base and already brought that tag in — and it's cheap either way (a single commit, not a
  re-clone), so just run both:
  ```bash
  git -C <template-dir> fetch --depth 1 --quiet origin "refs/tags/<base>:refs/tags/<base>" 2>/dev/null || true
  git -C <template-dir> diff "<base>" "<tag>" -- CLAUDE.md
  ```
  Substitute `<template-dir>` with the literal path Step 3 printed — it is **not** a live shell
  variable (`$TEMPLATE_DIR` would expand to nothing and `git -C` would fail).
  Apply only those template-section changes. If there's no base marker (or the base tag
  can't be fetched — e.g. the target is a branch, not a tag), compare the target's
  `CLAUDE.md` against the project's and be conservative. If you genuinely can't tell whether
  a section is template or project, **preserve it** and note it in the Step 9 summary as
  handled — do not ask the user.
- **`.gitignore`** — nothing to do: Step 3 already merged it additively; the report lists what
  it added.

---

## Step 6: Migrate workflow state (if the model changed, or you can't tell)

Run `/migrate-legacy` — it converts the project's state on this branch — if the release notes
indicate a workflow-model change, **or** if you have no release notes (Step 1's `gh`-unavailable
path). Don't skip it for not knowing: that path correlates with exactly the older projects that
need it, a missed migration surfaces much later as a workflow that can't read its own state, and
`/migrate-legacy` detects the shape itself and stops when there's nothing to do. Otherwise skip.

Any "nothing to migrate" answer ends this step. Don't relay its *"run `/start` to begin a new
project"* line — mid-upgrade that reads as an instruction to the user, and there isn't one.

---

## Step 7: Leave the user's working code alone

Do **not** rewrite the project's existing code or tests to adopt a new approach, and do
**not** remove a dependency the project still uses. When a release deprecates something
(e.g. `vitest-axe` in v1.0.0), **leave it in place**: keep the dependency installed so the
existing tests keep passing, and let only *new* tests the workflow writes use the new
approach. Rewriting working tests is slow, risks breaking them, and isn't something the
user needs — so don't. It's not a user task either; don't surface it.

---

## Step 8: Verify and self-heal

**First, if you launched `npm ci` in Step 3, join it** — the gates need `node_modules`. Wait for
it, and if it **failed** (a package won't install), fix that before any gate: read its output,
resolve the cause, re-run `(cd web && npm ci)`. A failed install isn't a test failure — don't
run the gates until it's green. If you skipped the install because dependencies didn't change,
there's nothing to join; carry straight on.

Then tell the user you're running the checks (the build can take a few minutes) and run
`(cd web && npm test)` and `/quality-check`. Run each gate **once** and read its combined
output — don't re-run a gate that passed or split one into per-command probes; that's
wasted round-trips.

**If a gate fails, fix it yourself** (bounded loop, up to 3 rounds, like BUILD). Triage a red
**test** in one look — almost every post-upgrade failure is one of these two, so decide fast
rather than investigating: no git history, no re-running to confirm, no proving causation
against the old config.

- **Orphaned template test** — it imports or spawns a file the upgrade *retired* (e.g. a test
  under `web/src/__tests__/scripts/` for a removed `.github/scripts/*.js`). The target is gone,
  so the test is dead — **delete it.**
- **Pre-existing failure** — it only exercises the project's own app code under `web/src/`,
  which the upgrade never touched, so it predates the upgrade — **leave it** (Step 7) and note
  it in the handoff. **First rule out that the upgrade caused it:** if the failure traces to a
  dependency the upgrade bumped or a `web/` config change it merged (rather than the test's own
  app logic), it's a regression to fix.

Anything else is a genuine upgrade regression (lint/type error, behaviour drift) — fix and
re-run. Fix only what a gate actually **fails** on; don't make discretionary changes like
`npm audit fix` for advisories the security gate doesn't block on. Escalate only if you
still can't reach green after real effort **and** it's a genuine always-halt condition — and
when you do, end it the way the abort at the top says: park the branch, put the user back on
a clean `main`, and tell them their project is untouched.

---

## Step 9: Commit, apply, and hand off

The branch now holds the finished upgrade and the checks pass. Commit it, show the user in
plain language what changed, and apply it to `main` on a single confirmation — the same
shape as an epic's PR + merge ([continue.md](continue.md) B7.2). **Do the git yourself;
never ask the user to review a diff or run a git command.**

**9.1 — Commit the upgrade on the branch.** Clear both transient artefacts first — the report
(a work-list for Steps 4–5, not project history) and the Step 3 template clone, which nothing
else deletes, so skipping it strands ~4 MB in the temp dir on every upgrade. Then commit
everything in one commit. Tell the user first that the commit takes a minute or two: the
pre-commit hook scans every changed file for secrets and an upgrade changes dozens, so an
unexplained wait here looks like a hang.

```bash
rm -f generated-docs/upgrade-report.md
rm -rf <template-dir>            # the temp clone Step 3 printed; substitute the literal path
git add -A
git commit -m "chore: upgrade template to <tag>"
```

**9.2 — Show the plain-language summary of what you did:**

```
Upgraded to <tag> on branch chore/upgrade-<tag> — ready to apply.

Handled for you:
  - Brought the workflow files up to date (<N> updated)
  - <Updated the settings, hooks, and automated checks — naming any the update removed | leave this line out when the report's guardrail section says there were no changes>
  - <Cleared out <M> files the newer version no longer uses, so nothing stale is left behind | Cleared out <M> files the newer version no longer uses — a few places couldn't be fully checked because this project hadn't recorded which version it was on, so some old workflow files may remain; use this wording whenever the report's retired-files note says the sweep was partial>
  - Added the new packages and web/ settings the update needs — nothing of yours was removed
  - Updated CLAUDE.md, keeping your own project notes
  - Left your existing working code and tests alone
  - <fixed <thing> so the tests and quality checks pass | tests and quality checks pass>
```

**9.3 — Decide how to apply.** Two ways to land the branch; pick based on what's available:

```bash
git remote -v
gh auth status 2>/dev/null && echo "gh: ok" || echo "gh: unavailable"
```

- **Pull-request path** — use it **only when there's a remote AND `gh: ok`**. It runs CI on
  the change before it lands (worthwhile, since the upgrade touches guardrails and CI).
- **Local path** — use it otherwise (no remote, or `gh` unavailable). Git only, no PR, no
  CI. This is the fallback that keeps `/upgrade` working for users who don't have `gh` set
  up. Tell the user in one line which path you're taking.

**9.4 — Pull-request path only: push, open the PR, wait for CI.**

```bash
git push -u origin chore/upgrade-<tag>
gh pr create --base main --head chore/upgrade-<tag> \
  --title "chore: upgrade template to <tag>" \
  --body "<the 9.2 summary>"
gh pr checks --watch
```

- If a **check fails** (red CI), surface it with `AskUserQuestion` — "Re-run the checks"
  (rerun the failed run with `gh run rerun --failed <run-id>`, taking `<run-id>` from
  `gh pr checks`, then re-watch with `gh pr checks --watch`) or "Diagnose it" (show the
  failing output). Don't push it past a red CI silently.
- If a **`gh` command itself errors** (not authenticated, no permission, etc.), don't stop —
  fall back to the **local path**: tell the user the pull-request route wasn't available and
  continue with the local merge in 9.5.

**9.5 — Confirm, then apply.** `AskUserQuestion`: *"The upgrade is ready and all checks
pass. Apply it to your project (merge into main)?"*

- **"Hold off — I'll apply it later"** → put them back on `main` first (the upgrade is safely
  committed on the branch, so nothing is lost, and leaving them on the upgrade branch would
  make the next `/start` build on it):

  ```bash
  git checkout main
  ```

  Then emit *"The upgrade is committed on `chore/upgrade-<tag>`. Apply it any time by asking me
  to merge that branch."* and stop.
- **"Apply it now"** → merge, then clean up:
  - *Pull-request path:*
    ```bash
    # Use the merge method the repo allows (merge commit, else squash); deletes the branch:
    gh pr merge --merge --delete-branch || gh pr merge --squash --delete-branch
    git checkout main && git pull origin main
    git branch -D chore/upgrade-<tag>
    ```
    If **every** `gh pr merge` method is rejected, merge locally instead — but the branch is
    already pushed and the PR is open, so this fallback must also sync the remote and close
    the PR (a plain local merge would leave `origin/main` behind and the PR dangling):
    ```bash
    git checkout main
    git merge --no-ff -m "chore: upgrade template to <tag>" chore/upgrade-<tag>
    git push origin main
    git push origin --delete chore/upgrade-<tag>   # closes the PR and removes the branch
    git branch -d chore/upgrade-<tag>
    ```
  - *Local path (no remote, or `gh` unavailable):*
    ```bash
    git checkout main
    git merge --no-ff -m "chore: upgrade template to <tag>" chore/upgrade-<tag>
    git branch -d chore/upgrade-<tag>
    ```

**Orchestrator never auto-merges.** Merging to `main` always needs the explicit
confirmation above — the same rule the workflow already follows at epic completion
([continue.md](continue.md) B7.2).

**9.6 — Done:**

```
Upgrade to <tag> applied to main.
```

Then stop.

---

## Rules with no other home

Everything else you need is in the steps above — these three are stated only here:

- **Search scoped source dirs** when you need to check references, never the whole repo (it
  includes `node_modules` and is very slow); prefer ripgrep / the fast search tools.
- **Don't `Write`/`Edit` under `.claude/` for the bulk update** — the applier delivers those
  files auto-approved, and hand-editing them is both prompt-heavy and slow.
- **Don't overwrite `documentation/` or `generated-docs/`** — they're the project's, not the
  template's. (The `web/` exclusions are in Step 4.)

## Related commands

- `/migrate-legacy` — workflow-state migration, invoked from Step 6 when the model changed or
  the release notes weren't available to tell
- `/quality-check` — the verify gate in Step 8
- `/status` — confirm the project renders correctly after upgrading
