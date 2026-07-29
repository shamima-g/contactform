# Template Development Guide

For maintainers of the template repository itself. Release process, version strategy, and PR labels live in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Philosophy

The workflow exists for end-users, not maintainers. Optimise for:

- **Minimal friction** — interrupt the user only at deliberate approvals
- **Speed** — agents run in parallel where they can; the BUILD loop owns its own retries
- **Reliability** — quality gates are binary; no rationalised failures
- **Resilience** — `/continue` resumes from any phase via the per-epic `state.json` on the `epic/<slug>` branch
- **Pleasantness** — the user should enjoy interacting with the workflow

When evaluating a change, ask: does this make the user's experience better, or does it add a step to defend the workflow against itself?

---

## Local repo hygiene (template developers only)

The workflow guard and `generated-docs/` exist for end-users. As a template developer you don't commit your own generated artefacts.

Add these to your local `.git/info/exclude` (a per-clone ignore file that is never committed):

```
.specstory/history/
generated-docs/
```

The workflow guard hook fires on every `UserPromptSubmit`. In this dev repo it detects `.release-ignore` and emits a template-dev note instead of redirecting to `/start`, so maintenance prompts aren't pushed into the TDD workflow. (In user repos `.release-ignore` is absent, so it redirects as intended.) Only use `/start` here when dogfooding a sample app.

---

## Where things live

> **Two CLAUDE.md files:** `CLAUDE.md` here is maintainer guidance (dev repo only); `CLAUDE.user.md` is what users get. The publish pipeline swaps `CLAUDE.user.md` in as the release `CLAUDE.md`. Edit user-facing rules in `CLAUDE.user.md`.

```
├── .claude/
│   ├── agents/        # Agent definitions (see .claude/agents/README.md)
│   ├── commands/      # Slash commands (/start, /continue, /status, ...)
│   ├── hooks/         # PreToolUse / UserPromptSubmit / SessionStart hooks
│   ├── policies/      # Cross-cutting policies (auth, testing, file ops, ...)
│   ├── scripts/       # epic-state.js, resolve-state-path.js, quality-gates.js, scan-doc.js, ...
│   └── WORKFLOWS.md   # The epic-branch workflow reference
├── web/               # Next.js frontend (your app; only additive updates via /upgrade)
├── documentation/     # User-provided specs read during INTAKE (read-only)
├── generated-docs/    # Workflow outputs (briefs, specs, state, dashboards)
├── .github/           # CI workflows + scripts
└── .template-docs/    # This guide and the user-facing help centre
```

---

## Modifying the workflow

Quality gates catch broken code; they don't catch a broken hook, a regressed agent prompt, or a slash command that no longer runs cold. When you change anything under `.claude/`, smoke-test the surface that changed.

| Surface             | What it does                         | Smoke test                                                              |
| ------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| `.claude/agents/`   | Agent prompts and tool grants        | `/start` on a minimal feature; watch the agent's step land correctly    |
| `.claude/commands/` | Slash command bodies                 | Invoke the command from a cold session (no prior context)               |
| `.claude/hooks/`    | React to harness events              | Trigger the real event the hook fires on — `/start` alone won't do it   |
| `.claude/policies/` | Referenced inline from agent prompts | Grep for referencing files; re-run those agents                         |
| `.claude/scripts/`  | Called by hooks and commands         | Run directly first (`node .claude/scripts/foo.js`), then via its caller |

For orchestrator-path changes (per-epic `state.json`, `/continue` resumption, phase transitions) also pause mid-BUILD and resume — confirm the right step re-fires.

### After a dogfood run, read `generated-docs/template-feedback.md`

BUILD agents log bugs they hit in the **template itself** — a misbehaving gate script, generated scaffolding that breaks, version drift — to `generated-docs/template-feedback.md` (they work around the bug and keep going; they never halt for it). This is our primary channel for template defects surfaced under real use, so **check it after every dogfood/benchmark run** and triage the entries into fixes. Each entry carries the symptom, the workaround the agent applied, a suggested fix, and the affected file/version. The file is `.release-ignore`'d, so it never ships to end users. (Routing rationale: [agent-autonomy.md § Recording destinations](../../.claude/shared/agent-autonomy.md#recording-destinations-tier-3-routing).)

### Keep bash permission prompts low

User permission prompts are the loudest friction in the workflow. Every new bash command an agent runs is a potential prompt. Before adding one:

1. Check [`.claude/hooks/bash-permission-checker.js`](../../.claude/hooks/bash-permission-checker.js) for the existing allowlist
2. If it's a recurring command, extend the allowlist so agents don't trip on it
3. Prefer Read / Edit / Write / Glob / Grep over shelling out — those don't require bash permission

---

## Design decisions

### 1. BFF as the encouraged auth path

**Decision:** When the brief specifies authentication, the BFF pattern is the encouraged path. The template documents the endpoint contract and Next.js integration shape but does not ship the BFF runtime itself.

**Rationale:**

- Tokens stay in HttpOnly cookies server-side — XSS can't exfiltrate them
- The client bundle ships no auth library
- CSRF is handled by `SameSite=Strict` cookies
- The backend enforces auth uniformly across all API consumers

Full security best-practices and integration shape live in [bff-auth-pattern.md](../../.claude/policies/bff-auth-pattern.md).

### 2. Vitest + Playwright split

**Decision:** Vitest + React Testing Library for unit/integration tests (jsdom), Playwright for end-to-end browser specs. One Playwright spec per routable story is mandatory — see the **Every Story Needs a Playwright Spec** rule in [CLAUDE.user.md](../../CLAUDE.user.md).

**Rationale:**

- Vitest: fast, ESM-native, integrates with the Vite ecosystem
- Playwright: catches runtime issues that mocked tests can't (real navigation, real browser auth flows, redirects, middleware)

The full Vitest-vs-Playwright-vs-manual split lives in [testing-policy.md](../../.claude/policies/testing-policy.md).

### 3. Per-story commits

**Decision:** BUILD commits after each story passes its automated checks (the per-story light gate — `lint` + `test-quality`, run inline by the orchestrator; the developer already ran the full Vitest suite + typecheck), not in one batch at the end of the epic. The user's manual verification is not per story — it happens once per epic at the manual-test approval (Decision 4).

**Rationale:**

- Small, atomic commits make review and rollback straightforward
- A failed story doesn't block already-completed stories from landing
- The dashboard and `/status` reflect real per-story progress

### 4. Post-epic user manual testing

**Decision:** After every epic the workflow halts at a manual-test approval before moving on.

**Rationale:** Mock-based tests can't tell you the page feels right, that the network actually wires through, or that copy reads sensibly to a human. One user interaction per epic catches the class of bugs that only surface in a real browser against a real backend — cheap to pay, expensive to skip.

---

## Template update boundary

Derived projects pull updates by running **`/upgrade`**, which invokes [`.claude/scripts/apply-template.js`](../../.claude/scripts/apply-template.js). It applies an explicit allowlist of template-owned paths (`.claude/` machinery, `.template-docs/users/`, `.github/scripts`, `CHANGELOG.md`), reports guardrail files (`settings.json`, hooks, `.github/workflows/`) separately so `/upgrade` can name them in its summary, prunes what the template retired, and merges the mixed files (`CLAUDE.md`, `web/package.json`) with judgment. The user's app — `web/src/`, `web/e2e/`, `web/public/` — is never touched.

Practical implication: changes to the allowlisted machinery land in every derived project on their next `/upgrade`. Treat them with that blast radius in mind — and note that this cuts both ways: **deleting** or **moving** a machinery file also lands everywhere, because the applier prunes retired files rather than leaving them to pile up. The allowlist lives in `apply-template.js` (`MACHINERY_PATHS` for auto-applied machinery, `GUARDRAIL_PATHS` for the guardrails `/upgrade` names in its summary, `OWNED_TREES` for the trees that get swept) — see [CONTRIBUTING.md](CONTRIBUTING.md#how-consumers-upgrade) for which list a new or retired path belongs in.

### Version marker

Every project carries a committed [`template-version.json`](../../template-version.json) at its root — `{ templateRef, appliedAt, source }`. It's a *shipped, committed* file (not a generated one), so it's present in a fresh clone, survives a hand-done file-copy upgrade, and gives `/upgrade` a precise diff base. Three writers keep it accurate: the publish pipeline stamps it from the release tag (for first-time/manual users), the applier rewrites it on every `/upgrade`, and `/release` sets it on the dev repo when cutting a release — all with the same value, so they never disagree. The dev repo commits the last released tag as a placeholder; the pipeline overwrites it at publish.

### Cutting a release

Releases are cut with `/release` (dev repo only, `.release-ignore`'d), which orders the CHANGELOG roll, version stamp, workflow sync into the local release clone, and GitHub Release creation so the release never ships stale CI. Full process: [CONTRIBUTING.md](CONTRIBUTING.md).
