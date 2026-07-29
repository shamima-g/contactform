# The `documentation/` Folder

This is where you put anything that describes **what you want to build**. Claude Code reads this folder during Intake — the first stage of the workflow — and uses whatever it finds to produce a project brief for your approval.

You don't need to put anything here. If the folder is empty, Claude Code will just ask you questions when you run `/start`. But the more you provide, the less you'll have to answer in chat.

---

## What to Put Here

Anything you have. Claude Code recognises and uses these kinds of files automatically:

| What | Why it helps |
|---|---|
| **A feature description** (any `.md` file) | The main thing — tells Claude Code what you want built and who it's for |
| **An OpenAPI spec** (`.yaml` / `.json` containing `openapi:` or `swagger:`) | Locks in the real endpoints your backend exposes, so Claude Code uses your actual API shape instead of guessing |
| **Sample data** (any `.json` / `.csv`) | Helps Claude Code understand the shape of your data |
| **Wireframes** (in a `wireframes/` subfolder) | Reference for layout and screen flow |
| **Brand or styling notes** | Logo files, colour palettes, fonts, a `tokens.css` file — anything that defines the look and feel |
| **A signed-off prototype** | See [Working from a Prototype](#working-from-a-prototype) below |

File names and folder structure don't matter — Claude Code scans the whole folder. The `documentation/` folder is read-only during the workflow; Claude Code never modifies what you put here.

---

## A Simple Feature Description

If you're starting from scratch, the easiest thing is one markdown file describing your feature in plain language. Here's an example:

```markdown
# User Profile Page

A page where signed-in users can view and edit their profile.

## What users should be able to do

- View their name, email, and profile picture
- See when their account was created
- Edit their name and profile picture inline (no separate edit page)
- Get a confirmation message after saving changes

## Things to keep in mind

- Changing email address should require re-verification
- Use a card layout
- Accessible from the main navigation menu
```

That's enough for Claude Code to produce a useful project brief. You can be more detailed if you like — include user stories, acceptance criteria, edge cases, or anything else you think matters — but you don't have to.

---

## If You Have a Backend

Put your OpenAPI spec in this folder (any name ending `.yaml` or `.json` will be detected). Claude Code uses it as the source of truth for endpoints, request/response shapes, and authentication — so the generated code calls your real API, not invented endpoints.

If your spec defines authentication (`securitySchemes`), Claude Code will run a quick connection test against your backend at the end of Intake to catch credential or URL problems before any code is written.

---

## Working from a Prototype

If you've already built a signed-off prototype with a separate tool, you can import it instead of writing a fresh spec. Run `/start` and pick the **"I have a prototype repo to import"** option — Claude Code will ask for the path to your prototype repo and `import-prototype.js` will copy the relevant artifacts into this folder for you.

**What gets imported:**

| From the prototype repo | Into `documentation/` |
|---|---|
| `genesis/genesis.md` | `genesis.md` (requirements anchor) |
| `genesis/source-manifest.md` | `source-manifest.md` |
| `input/*.yaml` or `*.json` (OpenAPI) | top level |
| `input/*.md` | top level |
| `designs/tokens.css` | `tokens.css` |
| `designs/project.pen` | `project.pen` |
| `prototype/src/` | `prototype-src/` |
| `prototype/.build-manifest.json` | `build-manifest.json` |
| `_bmad-output/implementation-artifacts/` | `implementation-artifacts-index.md` (summary) |

Most checklist questions will be pre-filled from your prototype's genesis file — you just confirm or adjust.

---

## What Happens Next

After you run `/start`, Claude Code reads this folder, asks a few short questions to fill in any gaps, and produces a project brief summarising what it understood. You review and approve the brief, and the workflow continues into planning and building.

For the full walkthrough, see the [Agent Workflow Guide](../.template-docs/users/Help/Agent-Workflow-Guide.md).

---

## Tips

- **Start small.** A few paragraphs is plenty for a first feature. You can refine as you go.
- **Be specific where it matters.** "Users can filter results by date" is more useful than "Users can search".
- **Include an API spec if you have one.** It saves a lot of back-and-forth.
- **You can always change your mind.** Claude Code will re-read this folder if you ask it to.

Need help? Ask Claude Code: *"How do I describe my feature for the workflow?"*
