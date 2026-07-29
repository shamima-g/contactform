---
description: Open visual dashboard - generates HTML and opens in browser
---

You are refreshing the visual project dashboard. This is a **synchronous, blocking** command — the user expects to see the result or an error message.

## Step 1: Generate the HTML Dashboard

```bash
node .claude/scripts/generate-dashboard-html.js --collect
```

If the script fails:
- Report the error to the user
- Suggest `/status` as a text-based fallback
- **Stop — do not proceed**

If the script returns `"status": "ok"`:
- Note the output path (default: `generated-docs/dashboard.html`)
- Proceed to Step 2

## Step 2: Open in Default Browser

```bash
start "" "generated-docs/dashboard.html"
```

This opens the HTML file in the user's default browser using the `file://` protocol. No server, no port, no conflicts with the dev server.

## Step 3: Confirm Success

Display:

```
Dashboard opened in your default browser.

It auto-refreshes every 10 seconds — leave it open and it stays current as the workflow progresses.
```

If the user already has the dashboard open from a previous `/dashboard` call, the existing browser tab will pick up changes on its next auto-refresh cycle. They don't need to re-run `/dashboard` unless the tab was closed.

## Fallback

If the generator script fails (e.g., missing dependencies), fall back to the text dashboard:

```bash
node .claude/scripts/collect-dashboard-data.js --format=text
```

Display the pre-formatted text output inline and append:
*"HTML dashboard generation failed — showing text dashboard instead."*

## DO

- Report errors to the user (this is synchronous, not fire-and-forget)
- Open the browser after generating
- Suggest `/status` as a fallback

## DON'T

- Swallow errors silently — the user triggered this explicitly
- Start a server — the file:// protocol works fine
- Modify workflow state — this is display-only
- Run tests or resume workflow — that's for `/continue`

## Related Commands

- `/status` - Text-based workflow progress (terminal only)
- `/continue` - Resume workflow from current position
- `/quality-check` - Run all quality gates
