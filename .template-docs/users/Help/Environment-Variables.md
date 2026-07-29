# Environment Variables

Environment variables are settings that configure your app — things like which server to connect to. They are stored in a file called `.env.local` in the `web/` folder. This file is private to your machine and is never uploaded to GitHub, which makes it a safe place to store sensitive settings.

`.env.local` is created for you automatically when you set up the project. The settings you may need to change are:

---

## `NEXT_PUBLIC_API_BASE_URL`

The address of the backend server your app talks to.

| Environment | Value |
|---|---|
| Development (your machine) | `http://localhost:8042` |
| Production (live site) | The URL your backend team or hosting provider gives you |

## Backend API credentials (only if your backend requires them)

If your backend needs a token or API key, intake captures the variable **names** and adds them as commented placeholders in `.env.local` (for example `NEXT_PUBLIC_API_TOKEN`). Fill in the values on your machine — they are never uploaded to GitHub.

---

**Need more help?** Ask Claude Code: *"How do I configure my environment variables?"*
