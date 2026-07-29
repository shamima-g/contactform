# Changelog

All notable changes to this template will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`/build-report-effort`** — how long and how much each screen took to build, grouped by kind of screen (list, form, detail, record action, sign-in, export). It uses the timings and token records the workflow already keeps, so there's nothing to switch on, and it's the report to open when you want to size the next piece of work.

### Changed

- **The reports now share one name, so they're easy to find together.** Typing `/build-report` shows the whole family: `/build-report` (the visual retrospective), `/build-report-cost` and `/build-report-effort`. **`/workflow-insights` is now `/build-report-cost`** — same report, clearer name: spend, tokens, models and waiting-on-you time per epic. All three are now listed in the command reference instead of two of them only appearing in the `/` menu. The page it writes moved to `generated-docs/reports/build-cost.html`; `/upgrade` clears the old one out.

## [1.2.0] - 2026-07-28

### Added

- **`/plan` command** — plan the next epic ahead and park it ready to build, without starting the build. It runs the full planning step (breaks the epic into stories and gets your approval) and then stops, leaving the epic ready for `/start` to pick up and build later. Because it's safe to run in a separate window while another epic is building, one person can plan the next piece of work while the current one is still being built — or two people can work in parallel. Everything git-related is automatic: it plans against the latest version of your project and parks the finished plan where it can't go stale, without disturbing any build in progress.

### Changed

- **Lighter CI usage.** The automated quality checks now skip a couple of unnecessary runs: pushing a further change to a pull request stops the checks already running for the earlier version, and commits that don't touch the app's code (such as the internal progress-tracking commit at the end of each epic) no longer start a check run. Together these help a project use fewer GitHub Actions minutes.

- **Simpler Shadcn component setup.** Adding Shadcn UI components (buttons, dialogs, and the like) no longer needs an extra background helper to be running — the workflow now uses the standard Shadcn command-line tool that comes with your project. That's one less thing to start up, and it always uses the exact version pinned to your project.

### Fixed

- **From your next upgrade onward, `/upgrade` consistently clears out template files a newer version no longer uses.** Before, the tidy-up covered a fixed set of folders only, so leftovers could linger — old help pages, retired scripts, and duplicate checks that made every pull request run twice. Empty folders go too. None of your own work is touched: your commands, agents, skills and hooks stay, as does anything that only lives on your machine. Nothing extra to review — it's in the same summary and single approval as the rest of the upgrade.

- **An upgrade now uses the *new* version's updating machinery, not your current one's.** `/upgrade` fetches the version you're moving to and hands the work over to it. Before, it ran the copy already in your project, so improvements to the updater itself arrived a release late.

- **`/upgrade` now keeps your `.gitignore` current.** It adds the entries the new version expects and never touches or reorders yours. That's what keeps files meant to stay on your machine — your local settings, session logs — from being committed by accident.

- **The browser download for end-of-epic tests no longer stalls the workflow.** The one-time Chromium download (~130 MB) these tests need now runs automatically in the background while planning and building carry on, so it's usually ready in time instead of pausing everything at the end. If it's still downloading when the tests are due, the workflow waits for that one download rather than getting stuck or starting a second, competing one — and it no longer asks for admin rights, which could silently hang it on Linux. A new [Troubleshooting](.template-docs/users/Help/Troubleshooting.md) entry covers installing it by hand, the one-time Linux system-library step, and avoiding a re-download on a fresh VM.

## [1.1.0] - 2026-07-14

### Added

- **`/upgrade` command** — brings an existing project up to a newer template version in one guided step: it updates the workflow machinery, adds new dependencies without removing yours, merges `CLAUDE.md` (template sections only — your project-specific content is preserved), migrates the workflow state via `/migrate-legacy` when the model changed, and verifies — all on a branch, then applies it to your project on a single approval (it does the commit and merge for you).
- **Template version marker.** Every project now records which template version it's on in a `template-version.json` file at its root — present from the moment you get the template and kept current on each `/upgrade`, so the version is always knowable (and `/upgrade` can tell exactly what changed).
- **`/build-report`** — a visual retrospective of how your app came together, opened in your browser: how long it took (calendar time vs. actual build time), what it cost, how efficiently it was built, how much you had to step in, what got produced (code, components, tests), and where time was lost. Add `stakeholders` (`/build-report stakeholders`) for a client-facing delivery report that shows what shipped and the quality evidence, without the internal build machinery.

### Changed

- **Reports no longer describe user-side metrics as "human effort".** The build report and workflow-insights report now label only what the logs actually prove — deliberate user inputs (counts) and time the process sat waiting for input — and state explicitly that the user's working time is not recorded, so no human-vs-AI effort split can be derived. The measurements themselves are unchanged.

### Removed

- **The CI Template Sync.** The GitHub Actions sync workflow, its `TEMPLATE_SYNC_PAT` setup, and the `.templatesyncignore` config are gone — `/upgrade` replaces them with a guided, in-session upgrade that also handles the parts sync couldn't: workflow files, the mixed `CLAUDE.md`, and the 4-phase → branch-per-epic state migration.

### Fixed

- **The quality check no longer mistakes a crashed test run for failing tests.** The end-of-epic check used to run your tests at the same time as the production build, and on Windows the two could fight for the machine and crash the test runner as it started up — making a healthy epic look like it had failing tests. It now runs the tests on their own, right after the build, so nothing competes with them, with an automatic single re-run as a safety net if a rare crash ever still slips through.

## [1.0.0] - 2026-07-09

### Added

- **Approve plans and manual-test results in your browser.** PLAN and the manual-test check now open a review page that lays out the story list or the test checklist visually, so you can read and approve without working through the chat.
- **Rebuilt dashboard** — a simplified view of live progress across every epic at once (in-flight and merged). Open it with `/dashboard`.
- **Up-front epic planning.** When you start a new project, the workflow breaks your whole spec into all of its epics, maps the dependencies between them, and checks that every requirement is covered — before any building starts — so you approve the shape of the work first.
- **Production deployment support** — a ready-to-use Docker setup, a build check in CI, and step-by-step docs for deploying the generated app.
- **`/workflow-insights`** — a per-epic report of what the build actually cost: tokens, spend, which models ran, and how much work each part of the workflow did.

### Changed

- **New branch-per-epic workflow.** Work is now organised around *epics* (a group of related stories). Each epic is built on its own branch and merged with a pull request once it's done and you've signed off. The facts you set once — roles, sign-in, data source, styling, compliance — carry across every epic automatically, so you never re-answer them. `/start` begins an epic and `/continue` takes it through plan → build → your final manual check → merge. Because each epic is self-contained on its own branch, epics stay independent and can be split across branches (for example, two people on two epics at once).
- **Upgrade an existing project to the new workflow.** `/migrate-legacy` converts a project built on an older workflow shape — including the previous 4-phase model — over to branch-per-epic, moving your project facts and completed epics into the new layout so you don't have to start over.
- **Faster builds.** Per-story checks were slimmed down and the full quality suite now runs once at the end of an epic instead of repeatedly, removing a lot of redundant re-runs.
- **Leaner CI/CD.** The automated quality checks now run only on pull requests and pushes to `main`, and each run is faster (shared dependency caching, a single Node version, and fewer gates) — so each project spends far fewer GitHub Actions minutes.
- **The security gate is far more accurate.** It now blocks only on real, server-side problems and no longer trips over safe code — pagination dropdowns, download helpers, sign-in/sign-out routes, and pages already behind a sign-in guard are no longer flagged. Compliance obligations (such as POPIA) are still raised with you at the start and stay on the review checklist; they're just no longer a code scan that could block you by mistake.
- **Accessibility and time-based behaviour are tested in a real browser.** Accessibility checks (contrast, layout, focus order) and anything time-driven (session timeouts, countdowns, debounced inputs) now run in a real browser via Playwright, which catches issues the previous in-memory checks couldn't see.

### Removed

- **The Lighthouse performance gate.** It's been dropped from the quality gates — it was a recurring source of CI trouble, and performance is better assessed on the actual deployed app.
- **Built-in session logging.** Claude Code already keeps a full transcript of every session, so the workflow no longer writes its own log files or attaches them to commits.

### Fixed

- **Finishing an epic no longer gets stuck.** Completing an epic now reliably opens the pull request, merges it, and cleans up the branch, instead of occasionally stalling partway through.
- **Fewer false test failures at the end of an epic.** End-of-epic browser tests now run against a real production build, which removes the timing races that used to fail tests for reasons that weren't actually bugs.
- **Security checks now run on Windows.** A path-handling bug had caused two security checks to be silently skipped on Windows; they now run everywhere.

### Security

- **CI now blocks serious dependency vulnerabilities.** Known Critical/High advisories in production dependencies fail the security gate — with the same verdict whether you run `/quality-check` locally or in CI — and secret scanning now runs on every push, not just on pull requests.

## [0.4.1] - 2026-06-03

### Changed

- Fewer permission prompts during the workflow: the bash permission hook now auto-approves more safe, read-only command shapes — including Vitest and quality-gate test runs and `sed -n '<range>p'` as a pipeline filter — while the deny rules were hardened so code-execution forms (`node -e`, `find -exec`, `npm install`, moving source files) still prompt by design.

### Added

- `journal.js` helper script that routes workflow decision-journal reads and writes through an auto-approved command, removing a recurring permission prompt at story commits and epic boundaries.

### Fixed

- Corrected the `vitest-axe` matcher import in the test-generator template (it used the old jest-axe API), which had caused generated accessibility tests to fail.

### Removed

- Unused `bcryptjs` / `@types/bcryptjs` dependency from the web template — password hashing happens in the backend under the BFF auth pattern, so the frontend never needs it. Trims the default install.

## [0.4.0] - 2026-06-01

### Added

- `/migrate-legacy` command to upgrade a pre-4-phase `workflow-state.json` to the current INTAKE/PLAN/BUILD/COMPLETE model; `/continue` auto-routes to it when it detects a legacy state file.
- Backend API connectivity check during INTAKE — captures base URL, auth header, and environment variables, runs a smoke test, and saves a re-runnable `api-smoke-test.sh` plus connectivity config to the intake manifest for BUILD to treat as authoritative.
- `/api-status`, `/api-go-live`, and `/api-mock-refresh` commands for managing the switch between mock and live API backends, with `/api-go-live` gated on a passing smoke test.
- Deployment guide covering how to ship the generated application.
- Requirements traceability matrix and coverage tracking across stories.
- Compliance and regulatory screening surfaced as a blocking question during INTAKE.
- Testing-strategy overhaul: an INTAKE probe for available test tooling, coverage tags, a manual-test approval at each epic boundary, and a hard stop when an endpoint would be invented rather than specified.
- `/continue` can now extend an already-completed feature with new epics.
- Publish pipeline that mirrors each GitHub release into the public release repository.

### Changed

- **Workflow simplification:** collapsed the 9-phase model (INTAKE / DESIGN / SCOPE / STORIES / REALIGN / TEST-DESIGN / WRITE-TESTS / IMPLEMENT / QA) into 4 phases (INTAKE / PLAN / BUILD / COMPLETE) with 1–2 user approvals and an agent-driven BUILD loop. See `.claude/WORKFLOWS.md`.
- INTAKE produces a single `project-brief.md` artifact (replaces the FRS / assumptions split).
- BUILD agents apply a four-tier autonomy policy (`agent-autonomy.md`) and halt only for genuinely unsafe ground.
- `/start` now chains directly into `/continue` after the INTAKE approval — no `/clear` boundaries anywhere in the flow, and setup is inlined into `/start`.
- Subagents are tiered by model — Opus for planning and coding, Sonnet for most agents, Haiku for mechanical generators.
- Template sync now uses a personal access token and runs manual-only, opening a self-healing "action required" issue when it can't run.
- Template documentation reorganized into separate `users/` and `template-maintainers/` folders and rewritten in plain language for non-developer users.
- Authentication follows a Backend-for-Frontend (BFF) pattern, replacing the client-side NextAuth/RBAC scaffold.

### Removed

- Agents `intake-brd-review-agent`, `design-wireframe-agent`, `design-roles-agent`, `prototype-review-agent`, `spec-compliance-watchdog`, `test-designer` — folded into `intake-agent`, `test-generator`, or eliminated.
- Per-story Markdown files; story metadata now lives in `workflow-state.json` with a per-epic overview file for visibility.
- The `/setup` command (folded into `/start`) and the NextAuth/RBAC scaffold (replaced by the BFF auth pattern).

### Fixed

- Numerous permission-hook fixes so routine read-only and QA commands are auto-approved (quoted paths with spaces, git global options, multi-path/glob reads, and subshell pipelines).
- Lighthouse performance gate no longer fails with a Chrome interstitial error in CI (defaults to mock-API mode).
- Resolved npm audit vulnerabilities in dependencies.

### Security

- Authentication moved server-side via the BFF pattern, replacing the client-side RBAC scaffold.

## [0.3.0] - 2026-03-25

Released without a curated changelog entry. See the
[v0.3.0 release notes](https://github.com/stadium-software/stadium-8/releases/tag/v0.3.0)
and the git history for details.

## [0.2.0] - 2026-01-05

### Added

- `/status` command with visual workflow progress indicators showing current phase and completed steps
- `/continue` command for resuming interrupted TDD workflows with automatic state detection
- Design Wireframe agent for creating wireframes before story planning
- `/start` command now executes TDD workflow one epic at a time (Plan → Test → Implement → Review → Verify → Commit/PR per epic)
- Performance gate (Gate 5) with Lighthouse CI integration
- PR comment reporting for all quality gates (Security, Code Quality, Testing, Performance)
- Security scanning for hardcoded secrets (API keys, AWS keys, tokens) in PR checks
- Template update sync system with weekly workflow for receiving upstream changes
- Auto-fix step in quality-gate-checker (runs lint:fix, format, audit fix before reporting failures)
- Plain-language error explanations in quality-gate-checker for non-developer users
- Workflow state tracking to all agents for `/status` visibility
- Session logging now works in both CLI and VSCode extension

### Changed

- Quality gates now enforce strict binary pass/fail (no conditional passes or rationalized failures)
- Agents must present actual status and options to user instead of auto-approving failures
- Improved non-developer user experience with clearer documentation and error messages

### Fixed

- Ensure linting and tests are run before submitting story PRs
- Ensure design-wireframe-agent commits wireframes to prevent data loss
- Exclude bcrypt hashes from hardcoded secrets scan (false positives)
- Add detailed tracing to hardcoded secrets scan for debugging
- Run npm audit fix for dependency security updates
- Remove unused tasks folder

### Security

- Enhanced PR quality gates with regex scanning for hardcoded secrets
- PR comments now report security scan results

## [0.1.0] - 2025-12-12

### Added

- Initial template release
- Next.js 16 with App Router
- React 19 with TypeScript 5 strict mode
- Tailwind CSS 4 with Shadcn UI integration
- Production-ready API client with error handling
- Role-Based Access Control (RBAC) system
- Input validation with Zod schemas
- Toast notification system
- Quality Gates CI/CD workflow (Security, Code Quality, Testing)
- Claude Code agents for TDD workflow (feature-planner, test-generator, developer, code-reviewer, quality-gate-checker)
- Progress tracking system (auto-generated PROGRESS.md)
- Template sync workflow for receiving updates

### Security

- RBAC with role hierarchy (Admin, Power User, Standard User, Read Only)
- Server-side and API route protection helpers
- XSS prevention with HTML sanitization
- Input validation schemas for common patterns
