# Approval Pattern

Shared display-then-ask-then-revise pattern used by the INTAKE and stories approvals (and any future approval that signs off a generated document). Both use the same shape — the caller fills in three parameters and any approval-specific branches.

## Parameters Each Caller Provides

| Parameter | Description | Example (INTAKE approval) | Example (stories approval) |
|---|---|---|---|
| `<approval_name>` | Short label for AUQ headers | "Approve project + plan" (Case A) / "Approve brief" (a later epic) | "Approve stories" |
| `<artifact_path>` | Path to the file(s) under review | `generated-docs/project.md` + the epic plan (Case A) or the epic's `generated-docs/epics/<slug>/brief.md` (a later epic) | `generated-docs/epics/<slug>/stories/` (per-story files written on approval) |
| `<summary_template>` | Inline template for the summary text shown to the user | see the INTAKE-approval summary in `start.md` | see the stories-approval summary in `continue.md` |
| `<revise_call>` | Subagent prompt for applying free-text or direct-edit revisions | `intake-agent` revise (project.md / brief); Case A **plan** edits go to `feature-planner` `decompose` | `feature-planner` with `revisionFeedback` |

> **Case A's INTAKE approval extends this pattern.** It approves `project.md` **+ the epic plan**, so it adds a blocker-clearing pre-step and a plan-specific option set (Approve / Adjust the plan / Adjust project setup / Start over) on top of the display-then-ask-then-revise shape below. The two-step flow is specified in [`start.md` §8](../commands/start.md); follow it there rather than the base options when running Case A.
| `<bounce_back?>` | Optional — extra disposition that routes to a different approval | n/a | n/a |

---

## The Pattern

### Step 1 — Display the summary (MANDATORY)

Output `<summary_template>`, populated with the agent's return data, as **regular conversation text** *before* calling `AskUserQuestion`. Never embed the summary inside the question text.

> **Critical:** The user cannot approve what they haven't seen. If the agent's return summary is empty or unclear, read `<artifact_path>` directly and construct the summary yourself. Explicit display is mandatory — this is the most-violated step.

End the summary text with a single line: ``The full document is at `<artifact_path>`. Take a look before approving.``

### Step 2 — Ask for approval (ONLY after step 1 text is output)

Call `AskUserQuestion`:
- header: `"<approval_name>"`
- question: caller-specific (e.g., "Does this match what you intend to build?")
- options (3 base + 1 optional bounce-back):
  - `"Approve all"` — description: caller-specific approval action
  - `"I have small changes"` — description: `"I'll describe deltas in my next message"`
  - `"Let me edit the file directly"` — description: ``"I'll open <artifact_path> and edit it"``
  - *(stories approval only)* `"Start over"` or `"The underlying assumption is wrong"` — see Bounce-Back below

### Step 3 — Branch on the response

- **Approve all** → proceed past the approval.

- **I have small changes** → ask plain-text: `"Describe your changes — I'll apply them and show you the diff before committing."` Launch `<revise_call>` with the user's feedback. After it returns, display the diff (`git diff <artifact_path>`) and re-ask: ``"Look right?"`` (`AskUserQuestion`: `"Yes, approve"` / `"More changes"` / `"Let me edit the file directly"`).
  - "Yes, approve" → proceed past the approval
  - "More changes" → loop once more (2-round cap, then force-route to "Let me edit the file directly")
  - "Let me edit the file directly" → see next branch

- **Let me edit the file directly** → tell the user: ``"Open <artifact_path>, make your edits, and tell me when you're done."`` Wait for the user to signal "done". Re-read the file, display the diff, run `<revise_call>` with a "user edited directly — re-read and validate" hint. Re-display the updated summary; re-ask: `"Approve"` / `"More changes"`. Loop until approved.

- **(Bounce-back, if defined)** → see Bounce-Back below.

Loop the branches above until the user approves. Then exit the approval.

---

## Free-Text Revision Cap

The free-text delta loop is capped at **2 rounds**. If the user is still not approving after round 2, force-route to "Let me edit the file directly" — at that point the contradictions are too dense for the agent to resolve from prose alone.

## Bounce-Back (stories approval only)

When the user's revision at PLAN is "the underlying brief is wrong" rather than "the epic/story wording is wrong", route the revision back to INTAKE instead of re-running the planner:

1. Display: ``"Got it — let's fix the brief. I'll re-open the epic's `brief.md` (or `project.md` if the issue is project-level) so you can correct it, and we'll regenerate the stories once the change is in."``
2. Re-enter the INTAKE approval with the user's feedback as input to `intake-agent` revise mode.
3. After the INTAKE re-approval, regenerate the epic/story proposal via `feature-planner` and re-enter the stories approval.

---

## Editable HTML Review Page (plan approvals)

At **both plan approvals** — the **epic-plan approval** ([`start.md` §8b](../commands/start.md), on `main`) and the per-epic **stories approval** ([`continue.md` §P2](../commands/continue.md), on the `epic/<slug>` branch) — in addition to the in-chat summary, generate a **self-contained, editable HTML review page** and open it in the external browser. This is the user's preferred way to review and approve a plan.

**Rules:**

1. **Only show what the user needs to decide at this approval.** Render *just* the artifact under approval — the epic list (epic-plan approval) or the one epic and its stories (stories approval). Do **not** render completed epics or epics that haven't been planned yet. Carry minimal roadmap context in a one-line header pill (e.g. `Epic 3 of 4 · Epics 1–2 complete`), nothing more. The page is a focused decision surface, not a dashboard. (For the whole-project view, that's what `/dashboard` is for.)
2. **Everything under approval is editable in place.** For the **epic-plan approval**: epic names, goals, and dependencies, with per-epic **Remove**, reorder (drag handle **and** ↑/↓ buttons), and **+ Add an epic**. For the **stories approval**: story titles, plain summaries, each acceptance criterion, manual-test lines, spec gaps, and non-goals are `contenteditable`; provide per-story **Remove**, **Split** (clone the story into two — "part 1"/"part 2" — so the user can trim each half to its own scope when a story is too big, without coming back to chat), reordering via **both** a drag handle (HTML5 drag-and-drop) **and** ↑/↓ buttons — offer both, since drag-only drops keyboard/screen-reader accessibility and precise single-step moves — and an **+ Add a story** control. Reordering must renumber the items and be reflected in the approval payload's array order. Editable fields should read as **plain text** at rest — the edit affordance (subtle outline/background) appears only on hover/focus, so the page looks like a document, not a form. Use plain, user-facing language (the planner's Translation Rule already produced it) — no coverage tags, requirement IDs, `targetFile`, or other implementation jargon on the page. Show each story's scope as a plain cue — e.g. "New screen" / "Updates the Transactions page" — plus its roles, **not** the raw route/URL (the real route still travels in the approval payload for the build).

   **Lead with goals; collapse the detail.** The default view shows the epic goal and each item's goal (title + plain summary) — nothing more. Acceptance criteria, manual tests, spec gaps, and non-goals go **inside a collapsed `<details>` disclosure** per story (still editable when expanded), so the page reads as a short list of goals, not a wall of criteria. The user expands detail only if they want it.
3. **A static page cannot write back to the workflow files.** The **Approve** button **auto-copies** the (possibly-edited) plan JSON to the clipboard on click (showing a "paste into chat" confirmation — no separate copy step; a download/"copy again" remains as fallback). If the user made no edits they can simply type `approved` in chat. Payload shape:
   - **Epic-plan approval:** `{ decision: "epic-plan", edited, epics: [{ name, goal, dependsOn: [] }] }` — array order is the plan order.
   - **Stories approval:** `{ decision: "stories", edited, epic, name, summary, stories: [{ title, plainSummary, acceptanceCriteria: [], manualTestChecklist: [] }], nonGoals, designChoices }`.

   The orchestrator reads the pasted JSON (or the in-chat approval) and persists exactly as it would after an in-chat "Approve all" — the epic-plan approval re-invokes `feature-planner` `decompose` when epics/deps changed then writes `epic-plan.md` + briefs; the stories approval writes the per-story files + `state.json`. State that round-trip in the page footer so the user knows what Approve does.
4. **Surface only the design decisions that genuinely need the user.** When the plan contains an either/or the user should own, render a **"Design choices"** section — each decision a radio group with the **recommended option first (pre-selected)** and a short **live preview**. Capture selections into the approval payload under `designChoices`.

   Apply a strict inclusion test before showing anything — **omit a decision if either is true:**
   - **You're ≥80% sure of the right answer.** Just pick it and apply it as a default; don't ask.
   - **It's answerable from the prototype / brief / design system / sample data.** Follow that source; don't ask.

   What's left — genuinely open, consequential, and *not* resolved by any source (often a spec gap with no prototype screen) — is the only thing worth a radio. If that set is empty, show no design section at all. Don't manufacture choices, don't pad with formatting nuances the design system already governs, and don't re-ask things consistency with an earlier epic already settles. Briefly tell the user (in chat or a one-line page note) which defaults you applied and their source, so the silence is transparent, not hidden. Selections left untouched mean "recommended default"; the developer implements whatever the user picked.

   **Show a real, rendered example of each option, not just a label.** Build a small live mockup per option — using realistic sample data and the already-applied format defaults (e.g. an actual mini table with the real interaction wired up: click-to-expand, popover, drawer) — so the user can *see and try* the difference before choosing. A one-word preview string isn't enough for a decision that genuinely needs attention; if it were that obvious you'd have defaulted it.

5. **The page supplements, not replaces, the approval.** Still output the in-chat summary (Step 1) and keep the `AskUserQuestion` path available — the HTML page and the pasted-JSON / typed-`approved` reply resolve the same approval. Revision and edit-directly branches (Step 3) are unchanged; a user can also just edit on the page and re-approve. Open it in the **external browser** (`start "" "<path>"`), not the VS Code Simple Browser — the embedded webview blocks clipboard-copy and downloads, and can't be auto-opened.

When the user approves, fold any `designChoices` into the per-story context the developer receives (and, if a choice resolves a spec gap or sets a cross-epic convention, record it in the epic's `brief.md` — or `project.md` for a project-wide convention — so later epics stay consistent).

Write each page **co-located with the artifact it reviews** — regenerable, so git-ignored (see `.gitignore`), never committed:

- **Epic-plan approval** (on `main`, before any epic branch exists) → `generated-docs/epic-plan-review.html` (alongside `epic-plan.md`).
- **Stories approval** (on the `epic/<slug>` branch) → `generated-docs/epics/<slug>/stories-review.html` (the same folder as that epic's `brief.md`).

Then open it with `start "" "<path>"`.

## Manual-Test Check-off Page (manual-test approval)

At the **manual-test approval** ([`continue.md` §B7.1](../commands/continue.md)), present the epic's manual tests as an **HTML check-off page opened in the external browser — always, instead of an in-chat checklist.** The page is a self-contained file in that epic's folder: `generated-docs/epics/<slug>/manual-tests.html` (the same folder as the epic's `brief.md`). It's regenerable, so it's git-ignored (see `.gitignore`).

**The page must:**

1. **List every manual test as a tick-box** the user checks when it passes. **Comments are the exception, not the rule — never render a comment box by default** (an always-visible textarea per test wastes vertical space on the passing majority). Instead give each test a quiet, always-present **"✎ Add a note"** control that reveals a comment field on demand (focus it on open; once it has text keep it open; offer a "× remove" to collapse and clear). The note works in both states: a **failure** is "leave the test unticked + add a note saying what you saw", and a passing-but-odd test can carry a note too. Keep the affordance always reachable (visually muted, but a real focusable button — not hover-only — since it's the failure-reporting path on touch/keyboard). Status logic: ticked → **Pass** (a note just annotates it); unticked + note → **Fail**; unticked + no note → **To do**. Show a live tally (passed / failed / to-do) and a "Mark all passed" shortcut. **Pre-tick from prior results:** when regenerating the page after a fix cycle, the orchestrator passes `state.json.epic.manualTestResults` — render every test whose prior result was `passed: true` **already ticked**, so the user re-verifies only the tests the fix affected (which the orchestrator leaves unticked) rather than the whole list. On the first display there are no prior results, so all tests start unticked.
2. **Lead with the check-these-first ledger.** When `state.json.epic.unverifiedAssumptions` is non-empty, render those items **first**, above the per-story checklist, under a `⚠️ Check these first` heading — they're the real-backend assumptions the automated tests couldn't verify, so they're the highest-value checks. Omit the heading when the array is empty.
3. **Make testing as frictionless as possible** — this is the priority:
   - An **"Open the app"** button (the app's local URL) and one-click-copy test credentials, plus a one-line "not running? start with `npm --prefix web run dev`" hint. **Make each login easy to spot — the role is the thing the tester acts on.** Render each credential as a distinct, clearly-clickable chip (not sentence text) where the **role name is the prominent, bold, color-coded label** (a small leading colour dot per role helps), with the **email demoted to muted secondary text** and a copy icon; give each role its own accent so the two are tellable apart at a glance. Don't let the logins blend into the header prose.
   - **Order tests to minimise persona-switching.** Group all same-role tests together and put the single sign-out/sign-in for another role in **one** section at the end — never make the user log in and out repeatedly. **Consolidate repeated negative checks** ("role X can't see Y") into one short section rather than repeating them per story.
   - Each test is one crisp *do this → expect that* line in plain language.
   - **Attach a test's setup or shortcut to the test(s) it applies to — never float it in a page-level block.** When a test needs setup to be practical (e.g. shortening the idle-timeout env vars so the tester isn't waiting 15 minutes), put that instruction on the test it belongs to (inside a per-test `<details>` / its "✎ note"), not in a detached banner above the checklist where the reader has to connect it to the right test. **When several tests share the same setup** — e.g. *every* idle- and session-timeout check (the warning appears, the warning copy reads well, "Stay signed in", auto-sign-out, the 8-hour cap) needs those same shortened thresholds — state it **once**, on the first test that needs it, and have the rest point to it (e.g. "needs the same setup as the test above") rather than repeating the full instruction on each. **Where the values or steps are already documented canonically — `web/.env.example`, the story file, the e2e spec — point the tester there rather than restating them**, so the hint can't drift from its source.
4. **Hand results back** via a **Done** button that **auto-copies** the results JSON to the clipboard on click (showing a "paste into chat" confirmation — no separate copy step; download/"copy again" as fallback): `{ decision: "manual-test-results", epic, allPassed, summary, failed: […], results: [{ story, test, passed, comment }] }`. If everything passed, the user can simply type `all passed`. (Static page can't write to disk — same review-and-hand-back round-trip as the plan page; state it on the page.)

**Orchestrator handling of the result:** `allPassed: true` (or `all passed`) → mark the epic manual-test passed and transition to `COMPLETE-ON-BRANCH`. Otherwise → route each `failed` item (its `comment` + `story`) through the existing [§B7.1 fix-cycle integration](../commands/continue.md), re-presenting the page after the fix. Skip the page only for infrastructure-only stories / legacy epics, as today.

Open it with `start "" "<path>"` in the **external browser** (clipboard-copy/download don't work in the VS Code Simple Browser).

## Visual Style (all review pages — plan-review AND manual-test)

Review pages should feel **inviting to read, not draining**. Apply this look-and-feel to every generated review page:

- **Light, calm, airy** — light background, dark slate text, one calm accent colour, soft white cards with generous whitespace, a gentle hover-lift, and a subtle shadow. Avoid dense dark walls of uniform text.
- **Give a sense of momentum** — a short header that frames where the user is (e.g. "Final epic — the home stretch", a small N-of-M progress bar, and a one-line "by the end, users can …"). Make finishing feel close, not endless.
- **Self-contained** — inline CSS/JS, no external assets/CDNs, works opened straight from disk in the external browser.

When the user refines the feel, carry the change here so it applies to future pages rather than living only in one generated file.

## Why This Is Shared

Both approvals run near-identical display-then-ask loops with copy-pasted boilerplate. Differences are in summary content and revise-call identity — both clean parameters. Centralising the pattern prevents drift (e.g., one approval gaining a 3rd revision round while the other stays at 2) and keeps the user-facing flow uniform.
