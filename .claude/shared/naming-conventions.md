# Generated document naming conventions

This file is the human-readable mirror of [generated-doc-conventions.json](./generated-doc-conventions.json). The JSON is the machine-readable source of truth — it's consumed by the PreToolUse enforcement hook and the repo-wide validator. When you change one, update both.

## Why these rules exist

Every generated document type in this template has exactly one correct filename shape. Drift silently breaks downstream tooling:

- Story files use `story-<N>-<slug>.md` inside `epics/<slug>/stories/`. The parent directory already names the epic, so the filename carries only the story number — naming them `story-<epic>-<story>-<slug>.md` would double-count the epic.
- The epic-end batched Playwright run globs `web/e2e/epic-<slug>-story-*.spec.ts` and attributes each failing spec back to its story by parsing `epic-<slug>-story-<N>-<title>.spec.ts`. The epic **slug** (not a number) and the story number are both required, and the enforcement regex demands the epic segment start with a letter — so `epic-1-story-3-*.spec.ts` is rejected at write time.

## Enforcement

- **Creation-time (hard):** `.claude/hooks/enforce-generated-doc-names.js` runs as a PreToolUse hook on `Write`, `Edit`, and `MultiEdit`. It blocks any new file in `generated-docs/` or `web/e2e/` whose name doesn't match this schema. Existing files on disk are grandfathered — the hook only blocks NEW creations (so agents can still edit historical files with legacy names).
- **On-demand audit:** `node .claude/scripts/validate-generated-doc-names.js` walks the repo and reports any file that doesn't match, regardless of whether it existed before the hook was added.

## The rules

| Document | Directory glob | Filename pattern | Good | Bad |
|---|---|---|---|---|
| Project facts | `generated-docs/` | `^project\.md$` | `project.md` | `project-facts.md` |
| Epic brief | `generated-docs/epics/<slug>/` | `^brief\.md$` | `brief.md` | `epic-brief.md` |
| Epic state | `generated-docs/epics/<slug>/` | `^state\.json$` | `state.json` | `epic-state.json` |
| Epic journal | `generated-docs/epics/<slug>/` | `^journal\.md$` | `journal.md` | `epic-journal.md` |
| Story file | `generated-docs/epics/<slug>/stories/` | `^story-\d+-[a-z0-9-]+\.md$` | `story-3-role-aware-nav.md` | `story-3.md` |
| E2E spec | `web/e2e/` | `^epic-[a-z0-9-]+-story-\d+-[a-z0-9-]+\.spec\.ts$` | `epic-dashboard-overview-story-3-role-aware-nav.spec.ts` | `story-3-role-aware-nav.spec.ts` |

> The epic's `state.json` lives on the `epic/<slug>` branch during the epic's lifecycle and becomes part of main as a frozen historical record after PR merge.

## The epic-context rule

Whether the filename carries the epic identifier depends on whether the parent directory already supplies it:

- **Parent directory is `epics/<slug>/stories/`** → the filename carries the **story number only** (e.g., `story-3-role-aware-nav.md`). The epic is already unambiguous from the `<slug>` directory.
- **Parent directory is flat** (e.g., `web/e2e/`) → the filename carries the **epic slug + story number** (e.g., `epic-dashboard-overview-story-3-role-aware-nav.spec.ts`). Flat directories have no epic context, so the filename supplies it — using the epic **slug**, never a bare epic number.

If you catch yourself writing `story-<epic>-<story>-<slug>.md` inside an `epics/<slug>/stories/` directory, stop — that's the drift pattern the hook exists to prevent.

## Adding a new document type

1. Add an entry to [generated-doc-conventions.json](./generated-doc-conventions.json) with `id`, `writtenBy`, `dirGlob`, `filenamePattern`, `example`, `counterexample`, `rationale`.
2. Add a row to the table above.
3. Run `node .claude/scripts/validate-generated-doc-names.js --verbose` to confirm existing files of that type still match.

The hook and validator both re-read the JSON every invocation — no code changes required when you add a new convention.
