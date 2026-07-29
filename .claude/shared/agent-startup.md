# Agent Startup (shared)

All workflow agents follow the same startup choreography. Referenced from individual agent files; the agent supplies only its own sub-task list.

## 1. Initialize the progress display

Call `TodoWrite` with your sub-task list (defined per call in your own agent file). Prefix each sub-task `content` (and `activeForm`) with `"    >> "` so they render as nested items.

The orchestrator owns the macro phase TodoWrite (PLAN / BUILD / EPIC-END / MANUAL-TEST / …) and updates it directly at each transition — subagents neither build nor re-emit it. There is no base-list script to call. Phase-started tracking is implicit: the orchestrator sets `state.json.phase` (via Edit) when it transitions, so the first agent in a phase has nothing to mark.

## 2. Per-call sub-task rules

- Each agent defines a sub-task list per call (Call A / Call B / etc.) in its own file.
- Only add sub-tasks for **your current call**. Sub-tasks from a prior call should already be `"completed"`.
- Start your sub-tasks as `"pending"`. As you progress, mark the active one `"in_progress"` and completed ones `"completed"`.

---

**File operations:** Use `Read` / `Grep` / `Glob` / `Write` / `Edit` for file work — including inspecting installed packages under `node_modules/`. Reserve Bash for `node` *scripts* (not `node -e`), `git`, and `ls`. Do NOT use `find`, `sed`, `awk`, `cat`, `head`, `tail`, `wc`, `python3`, `perl`, `cut`, or `grep` via Bash, and never use an interpreter to read, modify, or inspect files or packages — `node -e` / `python3 -c` / `find -exec` / `perl -i` / `sed -i` (use `Edit`/`Write` to change a file — never `node -e "fs.writeFileSync(...)"` or `perl -i`/`sed -i`). Inline / in-place code execution is never auto-approved. Full policy: [`.claude/policies/file-operations.md`](../policies/file-operations.md).

**Running dev tools:** Run the project's npm scripts from `web/` in a subshell — `(cd web && npm run <script>)` for tsc/eslint/build/etc. and `(cd web && npm test -- <pattern>)` for Vitest — all auto-approved. The `( … )` runs the command in `web/` (so `web/vitest.config.ts` and the `@/` alias resolve) while leaving the shell's cwd at the repo root. Never run these from the repo root: a bare `npx vitest` loads no `web/vitest.config.ts` (the `@/` alias breaks) and `npm --prefix web test` crashes Vitest 4's worker pool at collection ("No test suite found" on Windows/Node 24 — see `generated-docs/template-feedback.md`). Playwright is the same: `(cd web && npm run test:e2e -- <args>)`. Pass Node flags inside the subshell (`(cd web && NODE_OPTIONS=… npm test)`); a direct `node ./node_modules/<tool>/…` call is NOT auto-approved.

**Canonical dirs live at the repo root — never under `web/`.** `generated-docs/` and `.claude/` belong at the project root only. Two rules keep them there: (1) never leave the shell parked in `web/` — the bash CWD persists across calls, so a stray bare `cd web` makes a later relative write land in `web/generated-docs/` (always use the **subshell** form `(cd web && …)` for commands that must run in `web/` — the parentheses scope the `cd` to that one command and never move the persistent cwd); (2) when writing artifacts, prefer the repo-root-relative path (`generated-docs/…`) or an absolute path. The workflow scripts self-anchor to the repo root via [`lib/project-root.js`](../scripts/lib/project-root.js), so you never pass `--root`. A PreToolUse guard blocks writes that nest a canonical dir under `web/`, but don't rely on it — get the path right.

**AskUserQuestion:** Subagents cannot call `AskUserQuestion` — return findings to the orchestrator instead.
