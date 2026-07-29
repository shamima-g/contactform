# Upgrading

Move an existing project to a newer version of the template.

Run **`/upgrade`** in Claude Code. It brings the workflow machinery up to date, merges the files that mix template and project content, and migrates your workflow state if the model changed — all on a branch, then applies it to your project once you approve. You don't touch files or git yourself.

> **Nothing lands until you approve.** `/upgrade` does everything on a throwaway branch and applies it to your project only after you say yes to a single plain question. That one approval is the checkpoint — there's no diff to read or commands to run.

> **Which version am I on?** The file `template-version.json` at the top of your project records the template version you're on. It's set when you first get the template and updated every time you `/upgrade`.

---

## What `/upgrade` does

1. **Checks it's safe** — refuses on a dirty working tree or mid-epic; runs from `main`.
2. **Picks the target version** and shows you the release highlights.
3. **Updates the template machinery** — agents, commands, scripts, policies, docs — automatically, with no per-file approvals.
4. **Clears out what the new version no longer uses** — old help docs, retired scripts, and workflow files that have been replaced are removed, so you're left with the current set rather than years of leftovers. Only files that came from the template go. Anything you added yourself stays, including your own commands, agents, skills and hooks under `.claude/`, and your local settings. (If your project is older than the version marker, this clean-up is partial — the summary tells you when that's the case.)
5. **Brings across `web/` additions** — new template dependencies and config are *added* to your `package.json` without ever removing what you have. Your app code (`web/src/`, `web/e2e/`, `web/public/`) is untouched. Your `.gitignore` gets any new entries the template expects, with everything you already had left as-is.
6. **Merges the mixed files** — `CLAUDE.md` especially: it updates the template sections (Critical Rules, Policies) and leaves your project-specific content exactly as-is.
7. **Applies the guardrails, and flags them** — changes to `settings.json`, hooks, and CI workflows are applied along with everything else, and called out clearly in the summary.
8. **Migrates workflow state** if the release changed the workflow model (via `/migrate-legacy`).
9. **Verifies, then applies** — runs the tests and quality checks, shows you a plain summary of what changed, and asks once whether to apply it. Say yes and it merges the upgrade into your project for you.

---

## After it runs

- **Approve when ready.** `/upgrade` shows you a plain-language summary of what it did and asks a single yes/no — *apply it to your project?* Say yes and it merges everything into `main` for you; there's nothing to commit or merge by hand. Prefer to wait? Choose to hold off and it stays on the `chore/upgrade-<version>` branch until you ask to apply it.
- **Handle anything it flagged.** Occasionally a release needs a one-off migration (e.g. moving accessibility tests to a new tool). `/upgrade` calls these out with a pointer to the [CHANGELOG](../../../CHANGELOG.md); it won't silently rewrite your tests.

---

## Version-specific notes

### v0.4.x → v1.0.0 (4-phase → branch-per-epic)

The workflow moved from a single four-phase flow to **branch-per-epic**, where each epic is planned, built, and merged on its own branch. `/upgrade` updates the machinery and runs `/migrate-legacy` to convert your project state — a single `workflow-state.json` becomes `project.md` on `main` plus a folder per epic under `generated-docs/epics/`, with any in-progress work on an `epic/<slug>` branch.

**Accessibility tests — nothing to do:** if your project generated accessibility tests under v0.4.x, they use `vitest-axe`. v1.0.0 uses a real-browser `@axe-core/playwright` scan for *new* tests, and `/upgrade` leaves `vitest-axe` in place so your existing tests keep passing untouched. You don't need to change anything.

> **First upgrade to a version that has `/upgrade`?** If your project predates the command, ask Claude Code to fetch and run the latest `/upgrade` once; from then on it updates itself.

---

**Stuck?** See [Troubleshooting](./Troubleshooting.md), or just ask Claude Code — it can walk you through any of this.
