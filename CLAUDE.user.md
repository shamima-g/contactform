<!-- stadium8-claude: user -->
<!-- Workflow-user guidance. In the template dev repo this file is CLAUDE.user.md;
     the publish pipeline ships it to the release repo as CLAUDE.md. Edit this
     file to change what end users see. -->

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Template repository** for building frontend applications with:

- Next.js 16 (App Router) + React 19 + TypeScript 5 (strict)
- Tailwind CSS 4 + Shadcn UI
- Vitest + React Testing Library
- Production-ready API client for OpenAPI-defined REST endpoints

Users clone this template and use Claude Code to generate features, components, and API integrations.

## Repository Structure

```
project-root/
├── .claude/          # Claude Code config
├── web/              # Next.js frontend
├── documentation/    # Feature specs, OpenAPI specs, and sample datasets
└── generated-docs/   # Auto-generated progress tracking
```

## Architecture Quick Reference

### Directory Structure (`web/`)

- `e2e/` - Playwright specs
- `src/__tests__/` - Vitest integration tests
- `src/app/` - Next.js App Router pages
- `src/components/` - Reusable React components
- `src/lib/api/` - API client and endpoint functions
- `src/lib/validation/` - Zod schemas
- `src/types/` - TypeScript definitions

### Key Patterns

- **Path alias:** Use `@/` for imports (maps to `web/src/`)
- **Server components by default:** Add `"use client"` only when needed
- **App Router:** Pages go in `app/`, not `pages/`

## Development Commands

The npm scripts live in `web/`. Run each **in a subshell** — `(cd web && <command>)` — so it runs in `web/` while leaving your shell at the project root, where `generated-docs/`, `.claude/`, and git resolve (the bash tool's CWD persists across calls, so never leave it parked in `web/`). The subshell also sidesteps a Vitest 4 crash: `npm --prefix web test` from the root fails to collect tests on some platforms (Windows + Node 24).

```bash
npm run dev          # Dev server (http://localhost:3000)
npm run build        # Production build
npm run lint         # Linting
npm test             # Vitest (append `-- path/to/file.test.tsx` for one file)
npm run test:quality # Test-quality gate (must pass)
npm run test:e2e     # Playwright E2E (auto-starts dev server)
```

So each command runs as `(cd web && <command>)` — e.g. `(cd web && npm test)`.

## Workflow Commands (Claude Code)

```
/start                # Build an epic — new project: installs deps, runs INTAKE, builds the first epic; existing project: builds the next (a parked epic, or a draft/new one planned inline). Chains into /continue
/plan                 # Plan the next epic ahead and park it ready to build, without building it — safe to run in a separate session while another epic is building
/continue             # Drive PLAN, BUILD, EPIC-END, MANUAL-TEST, and the PR/merge flow for the current epic
/status               # Show current workflow progress
/dashboard            # Open visual dashboard in browser
/build-report         # Open a visual build report — effort, cost, workflow performance, what was built, where time was lost (add "stakeholders" for a client-facing delivery report)
/build-report-cost    # Deeper cost detail behind that report — spend, tokens and models per epic, and how long the build waited on you
/build-report-effort  # How long and how much each screen took to build, grouped by kind of screen (list, form, detail…) — useful for sizing the next piece of work
/quality-check        # Run all 4 quality gates
/upgrade              # Update this project to a newer template version — applies on a branch, merges on your approval
/migrate-legacy       # Migrate a project from pre-4-phase or 4-phase to the epic-branch workflow
```

**Epic-branch workflow:** the unit of work is the epic. Each epic lives on its own `epic/<slug>` branch with state at `generated-docs/epics/<slug>/state.json`. Phases per epic: PLAN → BUILD → EPIC-END → MANUAL-TEST → COMPLETE-ON-BRANCH → COMPLETE. An epic can also be planned ahead and parked at READY-TO-BUILD (between PLAN and BUILD) by `/plan`, for `/start` to build later. The project-level facts (roles, auth, data source, compliance, styling) live in `generated-docs/project.md` on main and inherit across all epics. See [.claude/WORKFLOWS.md](.claude/WORKFLOWS.md) for the user-facing workflows.

## Critical Rules

### 1. Use Shadcn UI Primitives

For UI primitives (buttons, dialogs, inputs, cards, etc.), use Shadcn components. Install any not already present with the Shadcn CLI:

```bash
(cd web && npx shadcn add <component> --yes)
```

This uses the `shadcn` version pinned in `web/package.json` (not a moving `@latest`), so generated output stays stable across builds.

This writes the primitive to `web/src/components/ui/`.

Build custom components by **composing** Shadcn primitives — don't hand-roll equivalents from raw HTML + Tailwind.

### 2. Use the API Client

All API calls must use `web/src/lib/api/client.ts`. Never call `fetch()` directly in components.

```typescript
import { get, post, put, del } from '@/lib/api/client';
export const getUsers = () => get<User[]>('/v1/users');
export const createUser = (data: CreateUserRequest) =>
  post<User>('/v1/users', data);
```

### 3. API Spec & Backend Errors

**Never assume there's no backend.** OpenAPI specs may live in `documentation/` (user-provided) or `generated-docs/specs/api-spec.yaml` (canonical, produced during BUILD). Prefer the canonical when both exist.

INTAKE captures connectivity config (base URL, auth header, env vars, smoke-test status) in `generated-docs/project.md` (§Data Source & Backend Integration), plus a re-runnable smoke-test script under the same project facts. BUILD reads these as authoritative — don't re-derive.

**Never dismiss API errors** (404, 500, connection refused, etc.). Report the actual error, reference the spec, ask the user — don't guess. Likely causes: backend not running, endpoint not implemented, path/method mismatch, or no backend for this project.

### 4. No Error Suppressions

**Never use suppression directives:**

- `// eslint-disable` / `// eslint-disable-next-line`
- `// @ts-expect-error` / `// @ts-ignore` / `// @ts-nocheck`

Fix errors properly. Suppressions hide problems and accumulate technical debt.

### 5. Quality Gates Are Binary

Report actual exit codes truthfully. Never rationalize failures as "expected" or "acceptable." Let the user decide whether to proceed.

### 6. Project Brief Overrides Template Code

`project.md` (stable project facts) and the current epic's `brief.md` (this epic's requirements) together are the source of truth — not the starter-template code this repo was scaffolded from. When they conflict, **replace** the template code rather than extending or nesting on top of it (e.g., if the project specifies a different provider stack than the template's root layout, replace the wrapper — don't wrap yours inside).

### 7. Test Quality Counts

`/quality-check` must pass before commit. Its testing gate scans test files for anti-patterns — even in `.skip`'d / `.todo` tests, and during TDD red phases. Tests are code; treat them with the same care as production.

### 8. TDD Workflow Enforcement

**Development work goes through the TDD workflow.** When the user asks you to build, create, add, change, fix, or implement anything — including casual phrasings like "make it look nice" or "tweak the header" — follow the `Action:` line the `workflow-guard.ps1` hook injects at the top of every prompt (typically a redirect to `/start` or `/continue`).

**Not a development request** (don't redirect): questions about how things work; reading or explaining existing code; running `/status` / `/dashboard` / `/build-report` (or `/build-report-cost` / `/build-report-effort`) / `/quality-check`; git operations; conversation during an active `/start` or `/continue` flow.

**When in doubt, redirect.** Better to enter the workflow and discover the request is small than to write untracked code outside it.

### 9. Every Story Needs a Playwright Spec

Every routable story must have a Playwright spec at `web/e2e/epic-<slug>-story-<N>-<title>.spec.ts` with at least one live `test()` block. Non-routable stories still get a spec file, but each `test()` calls `test.fixme()` in its body with a one-line reason comment. `test.fixme()` is forbidden on routable specs — `test-generator` self-validates this before returning, and the epic-end batched Playwright run routes any drift through the per-story fix cycle.

### 10. Prefer Dedicated Tools Over Bash

Use `Read` / `Grep` / `Glob` / `Edit` / `Write` for file content — never `cat`, `head`, `tail`, `grep`, `find`, `sed`, `awk`, `python`, `wc`, `cut`. Bash is for running things (`node`, `npm`, `npx`, `git`, `ls`) and for piping their output when it's long. See [.claude/policies/file-operations.md](.claude/policies/file-operations.md).

### 11. Tests Verify User-Observable Behavior

Tests verify **user-observable behavior**, not implementation. Conventions, the Vitest/Playwright/manual split, anti-patterns, budgets, and `test.fixme()` policy live in [.claude/policies/testing-policy.md](.claude/policies/testing-policy.md) — the single source of truth.

## Policies

- [Authentication Intake](.claude/policies/authentication-intake.md) — auth options are presented explicitly during INTAKE; never inferred or skipped
- [BFF Auth Pattern](.claude/policies/bff-auth-pattern.md) — security and Next.js integration shape for BFF auth stories
- [Compliance Intake](.claude/policies/compliance-intake.md) — compliance domains are surfaced as a blocking question during INTAKE
- [Styling Centralisation](.claude/policies/styling-centralisation.md) — all colours/fonts/spacing reference tokens in `globals.css`; no hex literals in components
