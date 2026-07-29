# Build-report insights prompt

This is the prompt that writes the **“What this means”** panel at the top of the
build report. Everything else in the report is computed straight from your git
history and the workflow's own files — this panel is where the numbers get turned
into a plain-language read on **how effective the build actually was**.

**This prompt is yours to tweak.** Change the wording below to change what the
panel says — make it shorter or longer, shift the focus (cost vs. quality vs.
speed), change the tone, or add a question you always want answered. The report
picks up your edits the next time you run `/build-report`.

---

## Task

Read `generated-docs/build-report-data.json` (the computed metrics), each epic's
`journal.md`, and `generated-docs/template-feedback.md` (the narrative), then
write a short insight summary to `generated-docs/build-report-insights.md`.

Write for **someone evaluating how well the build process performed** — they want
an honest verdict, not a celebration. Plain language; any ratio you cite must be
explained in the same sentence. Base every claim on the data; never invent
numbers or events.

## What to cover (edit freely)

Aim for **4 short sections**, roughly 300–450 words total:

1. **The verdict** — one short paragraph: how long it really took (calendar span
   vs. active build time — note the active figure is a floor estimated from
   commit timing), what it cost when the data has a `costEffort` block (the Rand
   figure), how much the user had to step in (deliberate inputs and
   waiting-on-user time — describe waits as time the process sat idle for input,
   never as the user's working time, which isn't recorded), what got delivered
   (epics, stories, and the size/shape of the codebase), and a one-phrase overall
   verdict on how smoothly it went.

2. **Efficiency read** — 2–4 bullets interpreting the workflow-performance
   numbers. Anchor on: the **first-pass E2E yield** (what share of stories worked
   without a fix cycle, and whether the failures cluster in one epic or spread
   out), the **rework share** (fix commits and the share of changed lines they
   account for — heavy fixing of few lines vs. broad rewrites read very
   differently), and **velocity** (active time per story — call out the epics
   well above or below it and why, using the journals).

3. **Where the time was lost** — 2–4 bullets naming the biggest time-sinks and
   *why* they cost time, drawn from the stumbling blocks and journals. For each,
   say in one sentence whether it was a **workflow/tooling problem** (the process
   fought itself), a **specification gap** (the requirements or backend behaved
   differently than assumed), or an **app-level bug** — that distinction is what
   makes the report comparable across projects.

4. **The pattern & one improvement** — one short paragraph: the recurring root
   cause across this build's friction, whether the open unverified assumptions
   share a theme, and the **single highest-leverage change** — to the workflow,
   the spec, or the testing approach — that would most improve the next build.

## Style

- Markdown only: `##` sub-headings, `-` bullets, `**bold**` for the key phrase in
  a bullet. No top-level `#` heading (the panel supplies its own title).
- No tables, no code blocks, no links.
- Don't restate every number — the metric cards already show them. Interpret:
  say what a number means, whether it's good, and what caused it.

## Output

Write the finished markdown to `generated-docs/build-report-insights.md`. Write
nothing else to that file. Then the report generator injects it automatically.
