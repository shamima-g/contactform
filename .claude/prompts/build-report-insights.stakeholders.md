# Build-report insights prompt — stakeholders

This is the prompt that writes the **“What this means”** panel at the top of the
**stakeholder delivery report** (`/build-report stakeholders`). Everything else on
that page is computed from the project's own records — this panel is where the
numbers become a plain-language account a client or sponsor can act on.

**This prompt is yours to tweak.** Change the wording below to change what the
panel says — shift the emphasis (scope vs. quality vs. timeline), change the tone,
or add a question your stakeholders always ask. The report picks up your edits the
next time you run `/build-report stakeholders`.

---

## Task

Read `generated-docs/build-report-data.json` (the computed metrics) and each
epic's `journal.md`, then write a short summary to
**`generated-docs/build-report-insights-stakeholders.md`**.

Write for **a client or sponsor who owns this application but doesn't read code
and doesn't know the build process**. No jargon at all — no "epics", "stories",
"E2E", "commits" or tool names; say "feature areas", "capabilities", "automated
browser tests", and so on. Be honest and concrete; never oversell. Base every
claim on the data; never invent numbers or events. Internal build friction
(tooling problems, rework) stays out of this panel unless it changed what was
delivered.

## What to cover (edit freely)

Aim for **3 short sections**, roughly 200–300 words total:

1. **What you're getting** — one short paragraph: the capabilities now working,
   described in product terms (what a user can now do), how much of the planned
   scope that covers, and the effort it took (calendar span and active build
   time — note the active figure is a conservative floor).

2. **How much you can trust it** — 2–3 bullets on the quality evidence: the
   automated tests that run before every release (and what kind of thing they
   catch), the hands-on human verification against the real system and its
   result, and — honestly — anything that could **not** be verified yet and why,
   including what the flagged open assumptions mean in practice.

3. **What happens next** — one short paragraph: the planned capability not yet
   built, any items deferred until it lands, and anything the stakeholder
   themselves should look at or decide.

## Style

- Markdown only: `##` sub-headings, `-` bullets, `**bold**` for the key phrase in
  a bullet. No top-level `#` heading (the panel supplies its own title).
- No tables, no code blocks, no links.
- Short sentences. Every number gets its plain-language meaning in the same
  sentence.

## Output

Write the finished markdown to
`generated-docs/build-report-insights-stakeholders.md`. Write nothing else to
that file. Then the report generator injects it automatically.
