# Getting Started Guide

Complete step-by-step guide to set up and start building with this template.

---

## Prerequisites

Before you begin, ensure you have:

- Node.js 22 or later and npm installed
- Git installed
- VSCode (recommended) with [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)
- GitHub account (for cloning template)

**Check versions:**
```bash
node --version    # Should be v22 or higher
npm --version
git --version
```

---

## Step 1: Create Your Project

### Option A: GitHub Web UI (Easiest)

1. Go to the template repository on GitHub
2. Click **"Use this template"** button (top right)
3. Enter your project name
4. Choose visibility (Public/Private)
5. Click **"Create repository"**
6. Clone your new repo:
   ```bash
   git clone https://github.com/your-username/your-project.git
   cd your-project
   ```

### Option B: GitHub CLI

```bash
# Install GitHub CLI: https://cli.github.com/
gh auth login

# Create from template
gh repo create my-project \
  --template username/template-repo \
  --private \
  --clone

cd my-project
```

---

## Step 2: Install Dependencies

```bash
(cd web && npm install)
```

This takes 2–5 minutes. When it finishes, your environment is fully configured — nothing else needed.

---

## Step 3: Start the App

```bash
(cd web && npm run dev)
```

Open http://localhost:3000 in your browser. You should see the template running.

---

## Where Things Live

Your project has three key folders:

```
project-root/
├── documentation/    # Optionally place your feature descriptions here before starting
├── web/              # The AI builds your app here — you don't need to edit this directly
└── generated-docs/   # Auto-generated progress tracking — created as the workflow runs
```

Everything else is managed automatically.

The `documentation/` folder is optional — you can drop a feature description there before running `/start`, or just type `/start` and describe what you want to build in the chat. If you have an OpenAPI spec or sample data, place those here too, for example:

```
documentation/
├── my-feature.md      # Describe your feature in plain language
├── api.yaml           # Your OpenAPI spec (if your feature calls a backend API)
└── sample-data.json   # Optional: example data for context
```

---

## Step 4: Start Building

Open Claude Code in VSCode and type:

```
/start
```

Claude Code will ask you about what you want to build, then handle the planning, coding, testing, and quality checks for you. At key points it will pause and ask for your approval before moving on.

**Useful commands while building:**

| Command | What it does |
|---------|-------------|
| `/status` | Shows where you are in the current workflow |
| `/continue` | Picks up where you left off after an interruption |
| `/plan` | Plans the next epic ahead and parks it, ready to build later — you can even run it in a separate session while one epic builds |
| `/dashboard` | Opens a visual overview of your project's progress |
| `/build-report` | Opens a visual report of how the build went — effort, cost, and what was built |
| `/quality-check` | Runs all quality checks and shows the current status |

---


## Receiving Template Updates

When you want to pull in the latest template improvements, run `/upgrade` in Claude Code — it brings the workflow machinery up to date on a branch and applies it once you approve, and never overwrites your app code. See the [Upgrading Guide](./Help/Upgrading.md) for details.

---

## Getting Help

Ask Claude Code directly for help with your project, or browse the [Help Center](./Help/) for reference guides and common issues.

---

**Ready to build something?** Type `/start` in Claude Code and let's go!
