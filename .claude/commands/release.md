---
description: Cut a template release (maintainers only) — rolls the CHANGELOG, stamps the version marker, syncs workflow files into the local release clone, and creates the GitHub Release that triggers the publish pipeline, all in the correct order.
---

You are cutting a new release of the Stadium Builder template. **This command is for template
maintainers and runs only in the dev repo (`stadium-software/stadium-8`).** It is
`.release-ignore`'d and never ships to users.

## Why this command exists

The publish pipeline ([publish-template.yml](../../.github/workflows/publish-template.yml))
cannot push `.github/workflows/` to the release repo — the publishing GitHub App has no
`workflows` permission, so GitHub rejects those files. They must be synced into the
release repo out-of-band, **before** the release is tagged, or the tagged release ships
stale CI. This command does that sync (using *your* push credentials, which the App
lacks) and then creates the release — in one ordered flow, so there's no manual gap.

The publish pipeline now **fails** if the release repo's workflows are stale (the
"Verify release-repo workflows are current" gate), so skipping this sync is caught, not
silently shipped.

**Confirm once, then it runs.** Everything up to the confirmation in Step 4 is local and
reversible. After you confirm, the command pushes to two repos and creates a release —
all outward-facing. Do not perform any push, `git commit` on a remote-tracked branch, or
`gh release create` before that confirmation.

---

## Step 0: Guard — is this a safe place to release from?

```bash
test -f .release-ignore && echo "dev-repo: yes" || echo "dev-repo: no"
git rev-parse --abbrev-ref HEAD
git status --porcelain
git fetch origin --quiet && git rev-list --left-right --count origin/main...HEAD
```

Proceed only if: `.release-ignore` exists (this is the dev repo — **stop** if not, this
command must never run in the Digiata release repo), you're on `main`, the working tree is
clean, and you're not behind `origin/main`. If any check fails, tell the maintainer the
one thing to fix (e.g. "commit or stash your changes first") and stop.

---

## Step 1: Version and release-repo location

**Version.** Use `$ARGUMENTS` if given (e.g. `1.1.0`); otherwise ask the maintainer for
the target version. Validate it as `MAJOR.MINOR.PATCH`. The tag is `v<version>` (e.g.
`v1.1.0`). Confirm the tag doesn't already exist:

```bash
git tag -l "v<version>"
gh release view "v<version>" --repo stadium-software/stadium-8 --json tagName 2>/dev/null || echo "no-release"
```

If the tag or release already exists, stop and say so.

**Release-repo path.** This is your **local clone of `Digiata/Stadium-Builder`**. Its path is
machine-specific and must never be committed, so it lives in your memory (a `reference`
memory — *Release repo location*). Use that path. If it isn't in your context, ask the
maintainer for the absolute path to their local `Digiata/Stadium-Builder` clone, then **save it
to memory** so future releases don't ask again.

Verify the clone is real and points at the release repo:

```bash
git -C "<release-repo-path>" remote -v
```

The `origin` must be `Digiata/Stadium-Builder`. If the path is missing or points elsewhere,
stop and ask the maintainer to fix it.

---

## Step 2: Ready both repos

```bash
# Dev repo (here) is already guarded in Step 0.
# Release clone: sync to a clean main.
git -C "<release-repo-path>" fetch origin --quiet
git -C "<release-repo-path>" checkout main
git -C "<release-repo-path>" pull --ff-only
git -C "<release-repo-path>" status --porcelain
```

The release clone must end on a clean `main`. If it has local changes, stop and ask the
maintainer to deal with them — don't discard their work.

Then read the top of [CHANGELOG.md](../../CHANGELOG.md) and confirm the `## [Unreleased]`
section holds the notes for this release. If `[Unreleased]` is empty, ask whether to
continue (a release with no user-facing notes is usually a mistake).

---

## Step 3: Prepare local changes (reversible — no pushes yet)

**a. Roll the CHANGELOG.** Edit [CHANGELOG.md](../../CHANGELOG.md): rename the current
`## [Unreleased]` heading to `## [<version>] - <today's date, YYYY-MM-DD>` (keep all its
entries in place), and insert a fresh, empty `## [Unreleased]` above it. Use today's date.

**b. Stamp the version marker.** Write [template-version.json](../../template-version.json)
at the repo root:

```json
{
  "templateRef": "v<version>",
  "appliedAt": "<current UTC time, ISO 8601>",
  "source": "release"
}
```

This keeps the dev repo's marker honest; the publish pipeline re-stamps the same value
into the shipped copy from the tag, so the two always agree.

**c. Work out the workflow sync.** Compare the dev repo's user-facing workflows against
the release clone. **User-facing** = every file in `.github/workflows/` **except** the
dev-only ones excluded by [.release-ignore](../../.release-ignore) — currently
`publish-template.yml`, `template-tests.yml`, and `docker-build.yml`. (Check
`.release-ignore` if unsure; keep this list in step with it.)

```bash
# Show which user-facing workflows differ / are new / were removed.
for f in .github/workflows/*.yml; do
  name=$(basename "$f")
  case "$name" in publish-template.yml|template-tests.yml|docker-build.yml) continue ;; esac
  if [ ! -f "<release-repo-path>/.github/workflows/$name" ]; then
    echo "NEW: $name"
  elif ! cmp -s "$f" "<release-repo-path>/.github/workflows/$name"; then
    echo "CHANGED: $name"
  fi
done
# Removed: a user-facing workflow the release clone has but dev no longer does.
for f in "<release-repo-path>"/.github/workflows/*.yml; do
  name=$(basename "$f")
  case "$name" in publish-template.yml|template-tests.yml|docker-build.yml) continue ;; esac
  [ -f ".github/workflows/$name" ] || echo "REMOVED: $name"
done
```

Note the NEW / CHANGED / REMOVED lists for the confirmation. If all three are empty, the
workflows are already current — you'll skip the workflow commit in Step 5.

**d. Compose the release notes.** These become the GitHub Release body, and the publish
pipeline mirrors them verbatim onto the release repo — where a **non-developer audience**
reads them. Write for that audience. Do **not** use `--generate-notes`: it emits a bare
"What's Changed" PR list plus a commit-compare link (empty when changes land as direct
commits), which is exactly the unreadable result this step exists to avoid.

Build the body in two parts and write it to a temporary file **outside the repo** (so it's
never committed — use your scratchpad or temp dir):

1. **A one- or two-sentence plain-language intro** summarising what this release is about,
   drafted from the CHANGELOG entries. Match the house voice — read the last couple of
   release bodies (`gh release view <tag> --repo stadium-software/stadium-8`, e.g. `v1.0.0`)
   for the established style.
2. **This version's CHANGELOG section** — the `### Added / Changed / Fixed / …` entries you
   rolled in step a, copied verbatim. Drop the `## [<version>] - <date>` heading itself; the
   release title already carries the version.

You'll show the intro in the Step 4 summary for approval before anything is pushed.

---

## Step 4: Confirm — the single gate for all outward actions

Show the maintainer a compact summary and get one explicit go-ahead (`AskUserQuestion`):

```
Release v<version>

  CHANGELOG   [Unreleased] → [<version>] - <date>  (<N> entries)
  Version     template-version.json → v<version>
  Workflows   sync to release clone: <NEW/CHANGED/REMOVED lists, or "already current">
  Title       Stadium Builder v<version>
  Notes       <the drafted intro, verbatim> + this version's CHANGELOG entries

On confirm I will, in order:
  1. Commit CHANGELOG + version marker on dev main and push
  2. Sync workflow files into the release clone, commit and push to Digiata/Stadium-Builder
  3. Create GitHub Release "Stadium Builder v<version>" on stadium-software/stadium-8 (triggers publish)
```

Only proceed on an explicit yes. If declined, leave the local edits in place (uncommitted)
and stop so the maintainer can adjust.

---

## Step 5: Execute (only after confirmation)

**a. Commit and push the dev changes:**

```bash
git add CHANGELOG.md template-version.json
git commit -m "chore(release): prepare v<version>"
git push origin main
```

**b. Sync workflow files into the release clone**, then commit and push — **skip this
whole step if Step 3c found nothing to change:**

```bash
# Copy NEW + CHANGED user-facing workflows across (repeat per file):
cp ".github/workflows/<name>" "<release-repo-path>/.github/workflows/<name>"
# Delete any REMOVED ones:
rm -f "<release-repo-path>/.github/workflows/<removed-name>"

git -C "<release-repo-path>" add .github/workflows
git -C "<release-repo-path>" commit -m "ci: sync workflows for v<version>"
git -C "<release-repo-path>" push origin main
```

**c. Create the GitHub Release** from the notes file you composed in Step 3d (this triggers
the publish pipeline):

```bash
gh release create "v<version>" \
  --repo stadium-software/stadium-8 \
  --title "Stadium Builder v<version>" \
  --notes-file "<path-to-notes-file>"
```

The title is always `Stadium Builder v<version>` — the product name, not a bare tag. The
publish pipeline mirrors this title verbatim onto the release repo, so both channels match.

If `gh` isn't authenticated or the push is rejected, report the exact error and stop —
don't retry blindly. A failed `gh release create` after the pushes landed is fine to
re-run once the cause is fixed (the tag won't exist yet).

---

## Step 6: Hand off

Tell the maintainer, plainly:

```
Released v<version>.

  - Dev main: CHANGELOG rolled + version marker stamped, pushed.
  - Release repo: workflows synced (<summary>), pushed to Digiata/Stadium-Builder.
  - GitHub Release v<version> created — the publish pipeline is running now.

The pipeline will verify the workflows are current, publish the template to
Digiata/Stadium-Builder, stamp template-version.json = v<version>, tag the release repo, and
mirror the release notes. Watch it under Actions → "Publish to Release Repo".
```

Then stop.

---

## DO

- Run only in the dev repo (Step 0 guard); read the release-repo path from memory.
- Keep everything reversible until the Step 4 confirmation; do all pushes/release
  creation only after the maintainer's explicit yes.
- Sync **all** user-facing workflows (add, update, and delete), excluding the dev-only set.
- Write release notes for a non-developer audience from the CHANGELOG (intro + this
  version's entries); never fall back to `--generate-notes`.
- Report exact errors from `git push` / `gh` and stop — never retry blindly.

## DON'T

- Don't run this in the Digiata release repo, or push the dev-only workflows to it.
- Don't create the release before the workflow sync — the ordering is the whole point.
- Don't discard uncommitted work in either repo; stop and ask instead.
- Don't hardcode or commit the release-repo path anywhere in this repo — it's per-machine.

## Related

- [publish-template.yml](../../.github/workflows/publish-template.yml) — the pipeline this
  release triggers (and its workflow-drift gate)
- [CONTRIBUTING.md](../../.template-docs/template-maintainers/CONTRIBUTING.md) — full
  release process
- [.release-ignore](../../.release-ignore) — what stays in the dev repo (the dev-only
  workflow list lives here)
