# .claude Directory

Claude Code configuration and extensions for this project.

## Layout

```
.claude/
├── settings.json           # Shared project settings (committed)
├── settings.local.json     # User-specific overrides (git-ignored)
├── agents/                 # Custom subagents that drive INTAKE / PLAN / BUILD
├── commands/               # Slash commands (/start, /continue, /status, etc.)
├── hooks/                  # PreToolUse / UserPromptSubmit / SessionStart hooks
├── policies/               # Cross-cutting policies referenced by agents
├── shared/                 # Shared snippets (agent-startup, orchestrator-rules, etc.)
├── scripts/                # Node helpers (epic-state, resolve-state-path, quality-gates, etc.)
└── templates/              # Document templates (project.md)
```

For the workflow itself, see [WORKFLOWS.md](WORKFLOWS.md) and the orchestrator commands at [commands/start.md](commands/start.md) and [commands/continue.md](commands/continue.md).

## Settings Hierarchy

Highest precedence first:

1. Enterprise managed settings (Windows: `C:\ProgramData\ClaudeCode\managed-settings.json`)
2. Command-line arguments
3. `.claude/settings.local.json` (project-local, git-ignored)
4. `.claude/settings.json` (project-shared, committed)
5. `~/.claude/settings.json` (user-global)

To override locally, create `.claude/settings.local.json`. Example — disable hooks for your environment only:

```json
{
  "hooks": {}
}
```

## What to Commit

✅ **DO commit:**
- `settings.json` — shared project configuration
- `agents/`, `commands/`, `hooks/`, `policies/`, `shared/`, `templates/`, `scripts/`

❌ **DON'T commit:**
- `settings.local.json` — personal preferences
- `.env` files with secrets

## Resources

- Claude Code docs: https://code.claude.com/docs
- Hooks: https://code.claude.com/docs/en/hooks.md
- Settings: https://code.claude.com/docs/en/settings.md
- Project instructions: [../CLAUDE.md](../CLAUDE.md)
