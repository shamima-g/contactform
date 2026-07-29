# Agent Autonomy Policy

## Purpose

Halts are the single largest contributor to wall-clock cost in the workflow (~10 halt events × 30–90 min per significant feature in the empirical data). Most of those halts asked the user to decide things that are settled by industry best practice or that BUILD can resolve and report back.

This policy defines a **four-tier decision framework** so BUILD agents only stop the user for genuinely unsafe ground. Lower tiers are recorded — autonomous decisions appear in commit bodies; journal-as-you-go decisions land in the project journal; and Tier-3 records are routed to whichever audience actually needs them (future BUILD agents, the user at the manual-test approval, or template maintainers) — see [Recording destinations](#recording-destinations-tier-3-routing).

The trade-off is explicit: **trade approval-time friction for review-time friction**. The user reviews at natural pauses (epic boundary, feature completion) rather than being interrupted mid-implementation.

This policy is referenced by [`developer.md`](../agents/developer.md) and the BUILD loop in [`continue.md`](../commands/continue.md).

---

## Decision Framework

Four tiers, ordered by user-interruption cost. When in doubt, prefer the **next-more-conservative tier** (e.g., journal-only over autonomous, Tier 3 over journal-only, halt over Tier 3).

| Tier | Default behaviour | Recorded? | When user sees it |
|---|---|---|---|
| **Tier 1 — Autonomous** | Decide, proceed | One-line note in commit body | At commit (git log) |
| **Tier 2 — Journal as you go** | Decide, journal, proceed | Journal entry + commit body | At epic completion (in journal) |
| **Tier 3 — Record for the right audience** | Decide, proceed, record to the audience-appropriate sink | Architecture registry, unverified-assumptions ledger, or template-feedback (by audience) | When that audience next reads it — see [Recording destinations](#recording-destinations-tier-3-routing) |
| **Tier 4 — Halt** | Stop BUILD, ask the user | N/A (user decides) | Immediately, via `AskUserQuestion` |

---

## Tier 1 — Autonomous

Industry-standard, low-blast-radius, easily reverted. Decide and proceed. One-line note in the commit body; no journal entry.

| Category | Examples |
|---|---|
| **Naming & structure** | File names, folder organisation, directory grouping. Use the project conventions visible in the existing codebase. |
| **Test patterns** | Assertion style (`toBe` vs `toEqual` vs `toHaveTextContent`), fixture conventions, `describe`/`it` nesting, test data shape |
| **Common React patterns** | `useState` for local form state, `useEffect` cleanup, error boundaries on async-rendering components, loading skeletons, focus management on mount, `useId` for label/input pairing |
| **Tailwind class organisation** | Class ordering, breakpoint stacking, responsive utility composition |
| **Shadcn component selection** | When multiple fit (`Dialog` vs `Sheet`, `Select` vs `Combobox`), pick the one closest to the use case |
| **Standard accessibility decisions** | ARIA labels for icon-only buttons, `aria-live` regions for async feedback, focus traps in modals, `prefers-reduced-motion` respect |
| **UI defaults** | Default sort order on data grids (most-recent-first or alphabetical), default page size (10/20/25), empty state copy, default loading copy |
| **Standard error handling** | Try/catch around async boundaries, in-app error rendering shapes, "Retry" buttons on transient errors, generic "Something went wrong" copy for unknown failures |
| **Minor refactor** | Renaming a local variable for clarity, extracting a 3-line helper inside the same file, inlining a one-shot constant |
| **Tooling / test-infra friction** | Working around a flaky test runner, clearing a stale cache, a config knob to make tests run reliably — work around it and move on. If the friction is a bug in the **template itself**, also log it (see [template-feedback](#generated-docstemplate-feedbackmd--maintainer-channel)). |
| **Test data values** | Email addresses (`alice@example.com`), names, numbers in fixture data — match anything observable in the epic's `brief.md` Data Model section |

**Recording:** mention in the commit body. Example:

```
feat(<slug>/story-N): add user list page

Decisions:
- Used Shadcn Table over DataTable for simpler sort + pagination needs
- Default sort: last_login desc
- Page size: 20
```

---

## Tier 2 — Journal as you go

Decisions that aren't risky but the user would want to know about post hoc. The developer journals these to `generated-docs/epics/<slug>/journal.md` (the per-epic journal on the active branch) and proceeds. Surfaced briefly in the epic-completion summary.

| Category | Examples |
|---|---|
| **Borderline composition / strategy** | Shared component vs inlining (rule of three), one big component vs several small, validation on submit vs blur, skeleton vs spinner vs nothing for loading, empty/error state design |
| **Factual additions to the brief** | New endpoint discovered during integration, new field needed on an entity, additional enum value, new state value — see [Brief Drift Handling](#brief-drift-handling) below |
| **Naming / shape clarifications** | Brief says `username`, API uses `userName`; brief says number, API has decimal — same intent. Reconcile and journal. |
| **Workflow refinements** | Brief lists 5 steps, prototype shows 4 + an implicit step — record the actual sequence. |

**Journal entry shape** (plain English, user-readable — write it like you'd describe it to a teammate, not like a system log):

```
Brief got a small update: the customer record gained a "preferred_contact" field, discovered while wiring up the list view.
```

```
For the sales table, went with separate components for Header / Rows / Footer (line items needed independent loading state).
```

No `Decisions:` / `Brief updates:` headers in journal entries — those belong in commit bodies. The journal is conversational. The journal is the per-epic **narrative**; durable facts about reusable code do **not** go here — they go in the architecture registry (Tier 3).

---

## Tier 3 — Record for the right audience

Semantic refinements the agent is confident about, reusable surfaces it built, external-boundary uncertainties it couldn't verify, or bugs it hit in the template itself. The agent applies its decision and BUILD continues — **the only open question is who needs the record.** Routing it by audience, instead of dumping everything into one user-facing log, is what keeps the user's review surface signal-dense and gets architecture facts to the agents that actually consume them.

| What you found | Where it goes | Who reads it |
|---|---|---|
| A **reusable surface** (util/component/hook), a **cross-cutting convention**, or **cross-epic debt** | `generated-docs/architecture.md` (the registry) | future BUILD agents, at story start |
| An **external-boundary uncertainty** you couldn't verify — a response/contract shape, a URL/port, a brand value, compliance copy — or a **requirement you interpreted** that the user should confirm | `state.json.epic.unverifiedAssumptions` | the user, at the manual-test approval (B7.1), **before** merge |
| A **bug in the template itself** (tooling, gate scripts, generated scaffolding) found while building | `generated-docs/template-feedback.md`, tagged `[template]` | template maintainers (reviewed after a dogfood run) |

There is no longer a `[review]` tag or an epic-summary "cross-epic notes" dump — each record now has exactly one audience and one home. Tooling/test minutiae that used to land in `[review]` are not Tier 3 at all (Tier 1 commit body, or not recorded).

**Why this matters (the lesson from the benchmark).** The most expensive bug in the corpus — the `Roles[].Pages[]` contract being wrong against the live backend — was recorded as a *confident* `[affects-downstream]` architecture note ("prefer `Pages[]`"). It shipped green and the human caught it only at manual test. Under this model it is an **unverified assumption** ("I'm assuming `Pages[]` is populated — confirm against the real backend"), so it surfaces at the approval *as a question*, not buried in an after-merge log as settled fact. **Litmus test: if you're not certain it matches real-world reality, it's an unverified assumption — not an architecture fact.**

---

## Recording destinations (Tier 3 routing)

### `generated-docs/architecture.md` — the architecture & reuse registry

A project-wide, cumulative registry of what the codebase already provides, so later stories **reuse instead of reinventing**. It is **read at the start of every story** and **edited inline** when a story adds a reusable surface — the same pattern as inline `brief.md` updates: the developer edits the file, the orchestrator stages it at commit time. It is **not** the per-epic journal — no narrative, no history, no dates.

Fixed shape — three sections, nothing else:

```
# Architecture & Reuse Registry
> One line per durable thing. Edit the line when it changes; delete it when the thing is gone.
> No story narrative, no dates, no rationale.

## Shared utilities & components
| Export | Location | Capability |
| ... | ... | ... |

## Conventions
- ...

## Cross-epic debt
- ...
```

**Keep it lean — five rules. The registry is worthless if it bloats past the point of being read at story start:**

1. **One row per durable thing.** A new capability on an existing export is an **edit to its row**, never a new row. (`post()` gaining a params arg *then* Blob support is still one row.)
2. **Registry, not narrative.** No "Story N…", no dates, no rationale prose. If it reads like a journal entry, it does not belong here.
3. **Entry bar.** Only three kinds qualify: a reusable export later stories should consume; a cross-cutting convention; cross-epic debt. Tooling, test infra, one-offs, and speculation ("might be useful later") are excluded by definition.
4. **Delete on removal.** Remove or rename an export and its row goes in the same change. A row pointing at a non-existent export — or a new helper that duplicates an existing row — is a registry-hygiene regression, and a likely finding at the epic-end `/code-review` pass.
5. **Length is a signal.** It must stay short enough to read at story start. A section past ~12 rows, or a file past ~1 screen, is a consolidation signal — usually overlapping utilities that should be merged.

### `state.json.epic.unverifiedAssumptions` — the user's confirm-before-merge ledger

Already floated **first** at the manual-test approval ([continue.md](../commands/continue.md) B7.1) under "⚠️ Check these first." `feature-planner` seeds it; **BUILD agents append to it** whenever they make a call that depends on unverified external reality, or interpret a debatable requirement the user should confirm. This is the single user-facing channel for boundary uncertainty — it replaces the old `[review]` epic-summary callout, which the user saw only *after* merge.

### `generated-docs/template-feedback.md` — maintainer channel

Append-only, repo-global, release-ignored. The agent **works around** the template bug and logs it here — it **never halts** for a template bug. One entry per bug:

```
## [template] <one-line symptom>
- Symptom: <what broke, with the exact error if any>
- Workaround applied: <what the agent did to proceed>
- Suggested fix: <where the template should change>
- Affected: <file / tool / version>
```

(A future opt-in `/report-template-issue` command will file these upstream; for now, consistent logging is the deliverable.)

---

## Tier 4 — Halt

Reserved for genuinely unsafe ground. Stop BUILD and ask the user.

| Category | Examples | Why halt |
|---|---|---|
| **Permissions** | Adding/removing a permission in the roles matrix; changing who can do what | Security-sensitive — silent permission grants are an audit risk |
| **API contracts — modification** | Changing request body shape; adding required fields; renaming endpoints; changing status code semantics | Affects every consumer |
| **API contracts — undocumented usage** | Calling an endpoint, query param, header, or request body shape not documented in the OpenAPI spec (e.g., `?LogId=` when spec only documents `?IsActive=`; adding `LastChangedUser` header when spec doesn't list it; POSTing a body shape that doesn't match the documented request schema) | Contract additions are real architectural decisions that must be made explicitly, not improvised; benchmark shows improvisation is the dominant source of contract drift. Use category `undocumented-endpoint` in the halt return so the orchestrator surfaces the four-option menu in [continue.md](../commands/continue.md) §B3. |
| **New external dependencies** | New npm package; new MCP server; new third-party service | Supply-chain risk, license, bundle size |
| **State management / data fetching library** | Switching from TanStack Query to SWR; adding Redux/Zustand | Cross-cutting; affects every component |
| **Authentication flow** | Changing auth method, adding/removing auth endpoints, modifying session handling | Security-critical; tied to `project.md` §Authentication. Set `requiresProjectChange: true` on the halt block. |
| **Cross-cutting architecture** | Router structure (App Router vs Pages); layout shell shape; middleware behaviour | Affects every story going forward |
| **Project-brief structural contradiction** | A stated requirement is **contradicted** (not refined, clarified, or extended) by what implementation reveals | The brief is the user's signed-off intent |
| **CLAUDE.md / policy contradiction** | Story requires bypassing a documented policy (no eslint-disable, must use Shadcn, etc.) | Policies exist for reasons |
| **Playwright spec missing for a routable story** | Story has `route !== null` but `web/e2e/epic-<slug>-story-<N>-<title>.spec.ts` doesn't exist after `test-generator` runs | Quality-signal failure |

**Note on "project-brief structural contradiction":** this used to cover all brief drift, which produced too many halts. It now covers only **structural contradictions** — cases where what the code needs cannot coexist with what the brief states. Naming clarifications, shape refinements, missing enum values, workflow ordering, ambiguous wording → Tier 2 or Tier 3 (autonomous + record).

**Halt format:**

```
HALT: <one-line description>

Context:
- Story: <epic/<slug>/story-<N>>
- What I was doing: <action>
- Why I stopped: <specific concern>

requiresProjectChange: <true | false>

The user needs to decide:
1. <option A — clearest path forward>
2. <option B — alternative>
3. <option C — escape hatch, e.g., update the brief>

Recommendation: <option N> because <one-line rationale>
```

**`requiresProjectChange` routing.** When the halt proposes a change to project-level facts (`project.md` — roles, auth, data source, compliance, styling, prototype source), set `requiresProjectChange: true`. The orchestrator then resolves it inline per [epic-branch-concurrency.md §6.1](../policies/epic-branch-concurrency.md#§61-project-level-changes) rather than surfacing the halt to the user.

For all other Tier 4 halts (`requiresProjectChange: false`), the orchestrator surfaces the halt verbatim via `AskUserQuestion` and resumes BUILD with the user's answer.

---

## Brief Drift Handling

Implementation regularly surfaces things that aren't in the brief. The drift type determines the tier:

| Drift type | Tier | Behaviour |
|---|---|---|
| **Factual addition** — new endpoint, new field, additional enum value, missing state value | Tier 2 | Update the epic's `brief.md` inline. Journal the change (plain English). Continue. |
| **Naming / shape clarification** — case difference, type refinement, same intent | Tier 2 | Reconcile silently (use what works), journal the reconciliation. Continue. |
| **Wording / scope refinement** — requirement was ambiguous, agent picks an interpretation | Tier 3 | Apply the interpretation. Add it to `unverifiedAssumptions` so the user confirms it at the manual-test approval. |
| **Reusable surface / cross-cutting decision** — built a util/component or set a convention later stories will reuse | Tier 3 | Record it in the architecture registry (`generated-docs/architecture.md`). |
| **Unverifiable external assumption** — a response/contract shape, URL, brand value, or compliance detail you couldn't confirm against reality | Tier 3 | Proceed on the most reasonable assumption. Add it to `unverifiedAssumptions` so it surfaces at the manual-test approval as a question. |
| **Structural contradiction** — what the code needs is incompatible with what the brief states | Tier 4 | Halt. User updates brief or confirms the change. |

The distinction is: **does proceeding break user intent?**

- No, just extends or refines it → Tier 2
- No, but the interpretation might be wrong, or it depends on unverified reality → Tier 3 (route to the right audience)
- Yes — proceeding ships something the user didn't agree to → Tier 4

---

## What's Not Covered Here

Some decisions are made earlier in the workflow and aren't subject to runtime tiering:

- **Roles template selection** — decided at INTAKE; recorded in `project.md` §Roles & Permissions
- **Auth method** — decided at INTAKE; recorded in `project.md` §Authentication
- **Data source** — decided at INTAKE; recorded in `project.md` §Data Source & Backend Integration
- **Compliance domains** — decided at INTAKE; recorded in `project.md` §Compliance
- **Brand colors / typography** — decided at INTAKE; recorded in `project.md` §Styling & Branding (raw hex)

BUILD agents read these and follow them. Disagreement with one of these is Tier 4 ("project-brief structural contradiction").

Note the division of labour: `project.md` holds **stable, INTAKE-authored project facts**; the architecture registry holds **cumulative, BUILD-authored facts about the code**. Both inherit across epics, but they have different authors and cadences — keep them separate.

---

## Updating This Policy

This policy is the starting point. As real usage surfaces patterns:

- **Tier 1 → Tier 2:** if reviewers consistently revert autonomous decisions in a category, promote it to journal-as-you-go.
- **Tier 2 → Tier 3:** if a journal-only category produces problems that aren't caught until later epics, promote it to Tier 3 (record for the right audience).
- **Tier 3 → Tier 4:** if a Tier-3 item turns out to need a pre-implementation decision, promote it to halt.
- **And the reverse:** if a halt category produces only routine answers, demote it. If a Tier-3 category never produces useful follow-up, demote it.

Changes are reviewed during the MVP measurement phase.
