# Troubleshooting

Common issues and what to do about them. For most errors, the fastest fix is to copy the error message and ask Claude Code directly.

---

## Setup Issues

### "Module not found" errors or missing dependencies

If you see import errors after cloning the project, ask Claude Code:

> "I'm seeing module not found errors. Can you fix my dependencies?"

### Port 3000 is already in use

Another process is using port 3000. Ask Claude Code:

> "Port 3000 is already in use. Can you free it up?"

### `.env.local` not loading

Check the following:

- [ ] File is named exactly `.env.local` (not `.env.local.txt` or `.env`)
- [ ] File is inside the `web/` folder (same level as `package.json`)
- [ ] Dev server was restarted after the file was created or changed
- [ ] Variable names are spelled correctly (they are case-sensitive)

See [Environment Variables](./Environment-Variables.md) for more detail.

### Dev server won't start or keeps crashing

Ask Claude Code:

> "My dev server won't start. Here's the error: [paste error]"

---

## Build and Test Issues

Build errors, TypeScript errors, failing tests, and lint warnings are handled automatically by Claude Code through the quality gate process.

If you see one of these errors:
1. Run `/quality-check` in Claude Code to get a full status report
2. Or paste the error directly into Claude Code and ask it to fix it

See [Quality Gates](./Quality-Gates.md) for more detail on what each gate checks.

### End-of-epic browser tests: the Chromium download is slow or stuck

At the end of each epic, Claude Code runs **browser tests** that open your app in a real browser. The first time, this needs a one-time copy of Chromium (~130 MB), which Claude Code downloads **automatically in the background** when you first run `/start` — so it's usually ready by the time the tests run.

If it seems stuck:

- **No progress bar,** so a working download can look frozen. It runs in the background — keep working while it finishes.
- **Stuck at 100%?** The download is done; it's now **unpacking** the browser and fetching a second, smaller browser file — neither shows progress, so on a VM it can look frozen for a few minutes (give it up to five). **Don't cancel it partway** — a half-finished install leaves a lock that makes the next attempt stall immediately, the usual reason it seems stuck "every time." If it never finishes:
  - **Linux (most VMs):** usually the second download blocked by a company network/proxy — set the proxy (below) and check for free disk space. If an earlier attempt was cancelled, clear the cache with `rm -rf ~/.cache/ms-playwright` and reinstall.
  - **Windows:** usually antivirus scanning each unpacked file — add `%USERPROFILE%\AppData\Local\ms-playwright` to your antivirus exclusions (or pause it for the one install), then reinstall.
  - Then bake the result into your VM snapshot so you never repeat it.
- **To install it yourself:**
  ```bash
  cd web && npx playwright install chromium
  ```
- **Linux — installs but won't launch** (error mentions a missing library like `libnss3.so`)? The browser needs some system libraries once, which needs admin rights:
  ```bash
  cd web && sudo npx playwright install-deps chromium
  ```
- **Behind a proxy?** Point at it and re-run: `export HTTPS_PROXY=http://your-proxy:port` (macOS/Linux) or `$env:HTTPS_PROXY="http://your-proxy:port"` (Windows PowerShell).
- **Fresh VM each time?** The browser lives outside your project folder, so a new VM re-downloads it. Install once and bake it into your VM image/snapshot.

There's no web page to download the browser from — the command above **is** the official installer. Full details: [Playwright browsers documentation](https://playwright.dev/docs/browsers).

---

## Quality Gate Failures

### Security vulnerabilities (Gate 2)

Ask Claude Code:

> "npm audit is showing vulnerabilities. Can you fix them?"

Claude Code will assess each one and fix what can be safely resolved.

### Pre-commit check blocking a commit (Gate 3)

The commit was blocked because a code quality check didn't pass. Ask Claude Code:

> "My commit is being blocked by pre-commit checks. Can you fix the issues?"

---

## Getting Help

For any error not covered here:

1. Copy the full error message
2. Ask Claude Code: *"I'm getting this error: [paste error]. What's wrong and how do I fix it?"*

Claude Code has access to your full codebase and all documentation and can diagnose most issues directly.
