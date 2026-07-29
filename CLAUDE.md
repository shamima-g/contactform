<!-- stadium8-claude: template-dev -->

# CLAUDE.md — Template Development

This is the **dev / source repo** for the Stadium Builder workflow template
(`stadium-software/stadium-8`). It is not an end-user project, and this file is
not the guidance users receive.

**What ships to users** lives in [CLAUDE.user.md](CLAUDE.user.md). On release,
the publish pipeline swaps that file in as the consumer-facing `CLAUDE.md`; this
file is maintainer-only and is discarded on publish.

## What the workflow is for

The whole template exists to do one thing: take a non-developer user's specifications and requirements and turn them into a high-quality, production-ready front-end application. The user describes what they want; the workflow plans it, builds it test-first, and verifies it — without expecting them to read or write code. Every design decision in this repo should serve that goal. When a change makes the path from "user's requirements" to "shipped, working app" shorter, clearer, or more reliable, it's pulling in the right direction; when it adds friction or assumes developer knowledge, it isn't.

## Development principles

- **The workflow is instructions, not code.** `/start`, `/continue`, and the
  agents are prompts Claude executes as the orchestrator — that's where the
  judgment and the capability live. Scripts and hooks exist only for steps that
  need a *guaranteed, deterministic* result (state I/O, git plumbing, gating),
  where a model's variability would be a liability. So express new capability as
  an instruction by default; write a script only when the step must run
  identically every time.
- **Keep the workflow as simple as possible.** Every step, approval, and prompt is
  friction for the user. Add one only when it earns its place; prefer removing
  steps over adding them.
- **Keep user-facing language simple and actionable.** Anything an end user
  reads — slash-command output, prompts, approval questions, `CLAUDE.user.md`, help
  docs — must be plain, direct, and free of dev-speak or unexplained jargon.
  Write for someone who isn't a developer.

## Two kinds of work here

- **Template maintenance** — editing `.claude/`, `.github/`, `.template-docs/`,
  root configs, `CLAUDE.user.md`, or this file. This does **not** go through the
  TDD workflow; don't run `/start`, just make the change. The
  [workflow-guard.ps1](.claude/hooks/workflow-guard.ps1) hook detects this repo
  (via [.release-ignore](.release-ignore), which only the dev repo has) and
  won't push you toward `/start`.
- **Dogfooding** — building a sample app to test the `/start` → INTAKE → PLAN →
  BUILD flow as a user would. This **does** use `/start`. For the most faithful
  test, dogfood the published release repo (`Digiata/Stadium-Builder`) or a `dry_run`
  publish, not the dev arrangement.

## Editing user-facing rules

The numbered Critical Rules and policies users follow are the single source of
truth in [CLAUDE.user.md](CLAUDE.user.md) — change them there, not here.
References to "CLAUDE.md §N" anywhere in the workflow mean those rules. They're
imported at the bottom of this file so they also apply when you dogfood here.

## Releasing

Cut releases with the **`/release`** command (dev repo only): it rolls the CHANGELOG,
stamps the version marker, syncs the `.github/workflows/` files into the release repo
(the publish App can't push them), and creates the GitHub Release — in the right order,
so a release never ships stale CI. That Release triggers
[publish-template.yml](.github/workflows/publish-template.yml): it copies dev →
release (excluding [.release-ignore](.release-ignore) entries), swaps
`CLAUDE.user.md` → `CLAUDE.md`, verifies the result (including that the release repo's
workflows are current), then pushes to `Digiata/Stadium-Builder`. Full process and
where-things-live:
[CONTRIBUTING.md](.template-docs/template-maintainers/CONTRIBUTING.md) and
[TEMPLATE_DEVELOPMENT.md](.template-docs/template-maintainers/TEMPLATE_DEVELOPMENT.md).

---

## Shipped end-user rules (single source of truth)

@CLAUDE.user.md
