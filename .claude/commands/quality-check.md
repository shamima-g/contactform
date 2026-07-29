---
description: Run all 4 quality gates to verify code is ready to commit
model: haiku
---

Run this command immediately — do not read any files first:

```bash
node .claude/scripts/quality-gates.js --auto-fix
```

This single script runs the three automated checks (security, code quality, testing) — together the project's Quality Gates. It auto-fixes formatting and lint issues before checking. (The workflow's INTAKE / stories / manual-test / merge pause points are *approvals*, a separate thing from these quality checks.)

After the script finishes, show the user the summary output and:

- **If all checks passed:** Ask "Have you manually tested the feature? Does it work as expected?" (the manual check — the only one not automated).
- **If any check failed:** Show which check failed, suggest a fix, and offer to help. Re-run the script after fixes.
