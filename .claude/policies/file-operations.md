# File Operations Policy

**Scope:** All workflow agents and orchestrators.

This policy governs **file content** — use `Read` / `Grep` / `Glob` / `Edit` / `Write` rather than Bash. Piping the output of `node` / `npm` / `npx` / `git` through `| tail` / `| grep` / `| head` is allowed: those are streams, not files.

## Allowed Bash

| Category | Examples | Notes |
|----------|----------|-------|
| **Node scripts** | `node .claude/scripts/...`, `node web/...`, `node generated-docs/...` | Includes `scan-doc.js` for file metadata. Inline `node -e "<code>"` is NOT a script — it's never auto-approved |
| **Dev tools** | `(cd web && npm test)`, `(cd web && npm run lint)`, `node_modules/.bin/tsc` | Pass Node memory/V8 flags inside the subshell via `NODE_OPTIONS='--max-old-space-size=256'` (e.g. `(cd web && NODE_OPTIONS=… npm test)`) — NOT a direct `node ./node_modules/vitest/vitest.mjs` call (not auto-approved) |
| **Git** | `git add`, `git commit`, `git push`, `git status` | Only when the agent's instructions call for it |
| **Directory listing** | `ls` | For quick directory checks |

## Directory Creation

The `Write` tool auto-creates parent directories — you do **not** need to `mkdir` before writing a file. The only time you need to create a directory from Bash is when the next step is a heredoc, `chmod`, or another non-`Write` operation that requires the directory to exist.

When you do need it, use `mkdir -p <path>` **literally** — the auto-approver recognizes the bash form. Do not translate it to PowerShell (`if (!(Test-Path …)) { New-Item -ItemType Directory … }`) even on Windows; the auto-approver does not recognize native PowerShell cmdlets and the user will be prompted.

## Use Dedicated Tools Instead

| Instead of... | Use... | Why |
|---------------|--------|-----|
| `cat`, `head`, `tail` | `Read` tool with `offset`/`limit` | Returns line numbers, handles all encodings, supports partial reads |
| `grep`, `rg` | `Grep` tool | Regex support, glob filtering, multiple output modes |
| `find`, `find … -exec` | `Glob` tool | Fast pattern matching, sorted by modification time. `-exec` runs arbitrary commands and is never auto-approved — use `Glob` to locate, then `Read`/`Grep` to inspect |
| `wc -l` | `scan-doc.js` | Returns `.lines` field with total line count |
| `sed -n` | `Read` tool with `offset`/`limit` | Read specific line ranges without Bash |
| `awk` | `Read` + `Grep` tools | No file analysis needs require awk |
| `python3 -c`, `node -e` | `Read`/`Grep`/`Glob`/`Edit`/`Write` or `scan-doc.js` | Never read, modify, or inspect files/packages through a language interpreter — e.g. `node -e "require('pkg/package.json')"` (Read/Grep `node_modules/pkg/` instead) or `node -e "fs.writeFileSync(...)"` to edit a file (use `Edit`/`Write`). Inline `-e`/`-c` code execution is never auto-approved |
| `cut`, `perl` | `Read`/`Grep` tools | Dedicated tools handle all text extraction needs |
| `perl -i`, `sed -i` (in-place edit) | `Edit` / `Write` tools | In-place interpreter edits (e.g. `perl -0pi -e "s/.../.../" file`) are arbitrary code execution and never auto-approved — use `Edit` for find/replace |
