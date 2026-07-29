# Contributing to This Template

This guide is for maintainers of the template repository itself.

For detailed template architecture and maintenance workflows, see [Template Development Guide](TEMPLATE_DEVELOPMENT.md).

## Version Strategy

The template uses [Semantic Versioning](https://semver.org/):

- **MAJOR** (1.0.0): Breaking changes to template structure or patterns
- **MINOR** (0.1.0): New features, components, or workflows
- **PATCH** (0.0.1): Bug fixes, documentation updates, dependency bumps

## Creating a Release

Releases are cut with the **`/release`** command in Claude Code (dev repo only). Make sure
the `## [Unreleased]` notes in [CHANGELOG.md](../../CHANGELOG.md) are complete and pushed to
`main`, then run:

```
/release <version>      # e.g. /release 1.1.0
```

It runs the whole sequence in the correct order, confirming once before anything leaves
your machine:

1. Rolls `[Unreleased]` → `## [X.Y.Z] - YYYY-MM-DD`, stamps
   [template-version.json](../../template-version.json) with `vX.Y.Z`, commits both to `main`, and pushes.
2. **Syncs the workflow files** into your local `Digiata/Stadium-Builder` clone and pushes them —
   the step the publish pipeline can't do (the App has no `workflows` permission) — *before*
   the tag, so the release never ships stale CI.
3. Creates the GitHub Release — tag `vX.Y.Z`, title **`Stadium Builder vX.Y.Z`** — triggering
   [publish-template.yml](../../.github/workflows/publish-template.yml), which mirrors that
   title and those notes onto the release repo.

Release notes are written for the release, not generated: a plain-language intro plus this
version's CHANGELOG entries, because a non-developer audience reads them on the release repo.
`/release` reads your local release-clone path from Claude's memory (per-machine, never
committed); the first run asks for it and saves it.

### Why the workflow sync is separate

The publish pipeline does **not** push `.github/workflows/` to the release repo — the
publishing GitHub App lacks the `workflows` permission, so GitHub rejects those files.
`/release` pushes them from your local clone using your own credentials, before the release
is tagged. The pipeline then **fails** if the release repo's user-facing workflows don't
match the template (the "Verify release-repo workflows are current" gate), so a forgotten
sync is caught rather than silently shipped. Dev-only workflows (`publish-template.yml`,
`template-tests.yml`, `docker-build.yml`) never ship — they're listed in
[.release-ignore](../../.release-ignore).

### Doing it by hand

If you can't use `/release`, replicate its order: roll the CHANGELOG + version marker and
push to `main`; copy the changed user-facing workflow files into the release clone and push
them; then create the GitHub Release, titled `Stadium Builder vX.Y.Z`. **Never skip the
workflow copy** — the publish drift gate will fail the release if you do. (The applier's source repo in `apply-template.js` is
retargeted to the release repo automatically by the publish pipeline — no manual step.)

## PR Labels for Release Notes

Use these labels on PRs for proper categorization:

| Label | Release Category |
|-------|------------------|
| `breaking` | Breaking Changes |
| `enhancement`, `feature` | Features |
| `bug`, `fix` | Bug Fixes |
| `security` | Security |
| `documentation`, `docs` | Documentation |
| `testing`, `test` | Testing |
| `chore`, `maintenance` | Maintenance |
| `ignore-for-release` | Excluded from notes |

## How Consumers Upgrade

Derived projects update by running **`/upgrade`** in Claude Code (there is no CI sync). It invokes [`.claude/scripts/apply-template.js`](../../.claude/scripts/apply-template.js), which:

- Applies an explicit allowlist of template-owned paths (`.claude/` machinery, `.template-docs/users/`, `.github/scripts`, `CHANGELOG.md`) — auto-approved, so no per-file prompts.
- Applies guardrail files (`settings.json`, hooks, `.github/workflows/`) too, but reports them under their own heading so `/upgrade` gives them close attention and surfaces them in its summary.
- **Removes what the template retired**, so a project converges on the template's *shape* rather than only accumulating its new files. Three sweeps, and which one catches a retirement decides how much you have to do by hand:
  - the **owned-tree sweep** — anything the project tracks inside `.claude/`, `.template-docs/` or `.github/scripts/` that the target no longer ships. This is automatic and needs nothing from you, including after a restructure. It judges by **location**, so it stands down in the dirs where a project writes its own files (see `PRUNE_EXEMPT_DIRS` for the list) — there, "not in the template" means "the user wrote it".
  - the **base→target diff** (the base comes from the project's `template-version.json`; the applier reads it itself) — judges by **provenance** (the base shipped this exact path, the target doesn't), which is what lets it reach the exempt dirs and `.github/workflows/` safely. Also automatic, but only for projects carrying a version marker; in a markerless project a retired command or agent just lingers (`BASE_DIFF_ONLY_DIRS` is exactly what's left behind, and the report says so).
  - **`RETIRED_PATHS`** — the hand-maintained backstop, for root files and for markerless projects. Its sibling **`DEV_ONLY_PATHS`** is the same deletion sweep for files the *dev repo* owns and a user project must never carry; those are also never applied, so dogfooding with this repo as the template source doesn't copy them in.
- Merges the mixed files (`CLAUDE.md`, `web/package.json`) with judgment — additions only, never removing the user's content.

The first two sweeps delete only files the project's git **tracks**, so anything untracked — gitignored local state like `.claude/settings.local.json` and `preferences.json`, session logs, agent caches — survives. Where a tracked set can't be determined at all (the project isn't a git repo), they don't run, and the report says so. The named lists are the exception by design: they delete by exact name, tracked or not, which is why they stay short and name only paths a project would never own.

**What updates automatically:** the allowlisted machinery above.

**What the user approves:** a single plain yes/no to apply the finished upgrade. `/upgrade` commits the work and merges it to `main` for them — they don't read a diff or run git. Everything stays on a `chore/upgrade-<tag>` branch until that approval, and guardrail changes and mixed-file merges are called out in the summary.

When you add a new template-owned path, add it to the allowlist in `apply-template.js`: `MACHINERY_PATHS` for auto-applied machinery, or `GUARDRAIL_PATHS` for files that execute or govern permissions. If it lands **outside** the owned trees — `.claude/`, `.template-docs/` and `.github/scripts/` — add its tree to `OWNED_TREES` as well, otherwise nothing can ever retire a file there. Note that this includes anything under `.github/` that isn't `scripts/`: only `.github/workflows/` is covered elsewhere (by the base→target diff). Two suites in `apply-template.tests.js` fail if you miss this, so you'll be told rather than finding out from a user's cluttered repo two releases later: `allowlist invariants` catches an applied path no sweep can reach (including one in a brand-new top-level dir), and `sweep coverage against the real template tree` catches a file shipped under `.claude/`, `.template-docs/` or `.github/` that falls between the lists.

**The applier's CLI is a compatibility surface.** `/upgrade` Step 3 runs the *project's* copy of `apply-template.js`, which is the old version; it fetches the target and hands the run over to the target's applier (`reexecFetchedApplier`), forwarding the arguments it was given. So a new applier is invoked with an **old** release's flags. Add flags freely, but don't remove or rename one without a deprecation window — `parseArgs` ignores unknown flags, so an argument dropped from `showHelp` keeps working, whereas one that is renamed silently stops being honoured. The same hand-over is why an applier fix now takes effect on the upgrade that delivers it rather than the one after.

When you **retire** a path, you usually do nothing: the sweeps handle it. Add a `RETIRED_PATHS` entry only for a root file, or when the stale copy actively misbehaves and must go even from projects too old to have a version marker.

## Related Files

- [CHANGELOG.md](../../CHANGELOG.md) - Version history
- [.github/release.yml](../../.github/release.yml) - Release notes configuration
- [.claude/commands/release.md](../../.claude/commands/release.md) - The `/release` command maintainers run (dev repo only, `.release-ignore`'d)
- [template-version.json](../../template-version.json) - Committed version marker (ships in every release; stamped by the pipeline, updated by the applier)
- [.claude/commands/upgrade.md](../../.claude/commands/upgrade.md) - The `/upgrade` command consumers run
- [.claude/scripts/apply-template.js](../../.claude/scripts/apply-template.js) - Applier the upgrade uses (allowlist of template-owned paths)
- [.github/workflows/publish-template.yml](../../.github/workflows/publish-template.yml) - Publish workflow (dev → release repo)
- [.release-ignore](../../.release-ignore) - Files excluded from publish
- [TEMPLATE_DEVELOPMENT.md](TEMPLATE_DEVELOPMENT.md) - Detailed maintainer guide
