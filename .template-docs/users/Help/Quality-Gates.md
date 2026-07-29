# Quality Gates

Quality gates are automatic checks that verify your app is working correctly. Most run in the background without you needing to do anything — but some require you to review changes manually.

Run `/quality-check` in Claude Code at any time to see the current status of all gates.

---

## Overview

| Gate | What It Checks | Automated? | Your Action |
|------|----------------|------------|-------------|
| **1. Functional** | Features work as intended | No | Review manually |
| **2. Security** | No vulnerabilities or exposed secrets | Mostly | POPIA compliance review |
| **3. Code Quality** | Code is valid, consistent, and builds correctly | Yes | None |
| **4. Testing** | All tests pass | Yes | None |

---

## When Gates Run

Gates run automatically at two points:

- **While an epic is built** — Claude Code runs a fast subset of the gates on each story as it's implemented, then the full set once at the end of the epic, before asking you to review the feature in your browser.
- **When code is pushed** — GitHub Actions runs gates automatically on every push and pull request to main.

---

## Gate 1: Functional

**What it checks:** That features work as specified and the app behaves correctly for users.

This gate is entirely manual — there are no automated checks. Review any change that adds or modifies a feature as part of your manual review.

---

## Gate 2: Security

**What it checks:** That no secrets (passwords, API keys, tokens) have been accidentally included in the code, that your dependencies have no known serious vulnerabilities, and that the app follows security best practices.

Most of this runs automatically. When your feature handles personal data, you are responsible for reviewing it for POPIA compliance as part of your manual review.

**Dependency vulnerabilities.** This gate scans the third-party packages your app ships to users. A **Critical** or **High** vulnerability fails the gate — the same way on a pull request or a direct push. **Medium** and **Low** ones are reported but don't fail it. When the gate fails, the report names the package and the advisory and tells you how to fix it. You can then ask Claude Code to fix it for you — usually by updating the dependency.

**When there's no fix yet.** Sometimes a serious advisory has no fix available yet from the package's authors. To stop that one advisory from failing every run, record a **time-boxed exception** in `web/dependency-audit-exceptions.json`. The advisory you name is allowed through until the date you set; every other vulnerability still fails the gate as usual. Because the file is part of your code, each exception shows up in pull requests for your team to review.

If this file isn't in your `web` folder yet, just create it — a missing file simply means "no exceptions".

Add an entry under `advisories`, using the advisory id from the gate's report as the key (for example, `GHSA-1234-abcd-5678`):

```json
{
  "advisories": {
    "GHSA-1234-abcd-5678": {
      "reason": "No upstream fix yet; not reachable in our usage. Tracking: <link>",
      "expires": "2026-09-01"
    }
  }
}
```

- **reason** — why the advisory is temporarily allowed. This appears in the report.
- **expires** — the date the exception ends, written as `YYYY-MM-DD`. After this date the advisory fails the gate again unless you renew the exception.

Use exceptions sparingly: they're for the rare case where no fix exists yet, not a way to hide advisories you could fix by updating the package.

---

## Gate 3: Code Quality

**What it checks:** That the code is valid TypeScript, passes linting rules, is consistently formatted, and the app builds without errors.

This gate is fully automated. If it fails, ask Claude Code to fix the issues.

---

## Gate 4: Testing

**What it checks:** That all automated tests pass.

This gate is fully automated. If it fails, ask Claude Code to investigate and fix the failing tests.

---

**Need more help?** Run `/quality-check` in Claude Code or ask for specific guidance.
