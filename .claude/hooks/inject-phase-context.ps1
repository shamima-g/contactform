# inject-phase-context.ps1
# Post-compaction hook: restores workflow instructions after auto-compaction.
# Fires via SessionStart (matcher: "compact") in the orchestrator session.
#
# Reads per-epic state.json (resolved via resolve-state-path.js) and injects:
#   Tier 1 - Workflow coordinates (always)
#   Tier 2 - Orchestration rules (not in CLAUDE.md, lost on compaction)
#   Tier 3 - Recency reinforcement (observed drift points)
#   Phase-specific process steps from phase-context/*.md
#
# Output: JSON with hookSpecificOutput.additionalContext
# Fail-safe: exits 0 with no output when not on an active epic branch.

$ErrorActionPreference = 'SilentlyContinue'

. (Join-Path $PSScriptRoot 'lib\workflow-state.ps1')

$projectRoot = Get-ProjectRoot -HookScriptRoot $PSScriptRoot
$resolution = Get-StateResolution -ProjectRoot $projectRoot
if (-not $resolution -or $resolution.Kind -ne 'epic' -or -not $resolution.Exists) { exit 0 }

$state = Read-EpicState -ProjectRoot $projectRoot -Resolution $resolution
if (-not (Test-ActiveWorkflow $state)) { exit 0 }

$phaseContextDir = Join-Path $PSScriptRoot 'phase-context'
$files = Resolve-StoryAndTestFiles -ProjectRoot $projectRoot -State $state -Slug $resolution.Slug
$storyNum = Get-CurrentStory -State $state

$totalStories = 0
if ($state.stories) { $totalStories = ($state.stories.PSObject.Properties | Measure-Object).Count }
$completeStories = 0
if ($state.stories) {
    $completeStories = ($state.stories.PSObject.Properties |
        Where-Object { $_.Value.status -eq 'complete' } |
        Measure-Object).Count
}

$epicName = if ($state.epic -and $state.epic.name) { $state.epic.name } else { $resolution.Slug }

# --- Tier 1: Workflow coordinates ---
$coordinates = @"
## Current Workflow Position
- Epic: $($resolution.Slug) ($epicName)
- Branch: $($resolution.Branch)
- Phase: $($state.phase)
- Story: $(if ($storyNum) { "$storyNum of $totalStories ($completeStories complete)" } else { "N/A (epic-level phase)" })
"@

if ($files.StoryFile) {
    $coordinates += "`n- Story file: $($files.StoryFile)"
}
if ($files.TestFile) {
    $coordinates += "`n- Test file: $($files.TestFile)"
}

# --- Tier 2: Orchestration rules (not in CLAUDE.md, lost on compaction) ---
$orchestration = @"

## Orchestration Rules (post-compaction recovery)

### Phase Model
PLAN -> BUILD -> EPIC-END -> MANUAL-TEST -> COMPLETE-ON-BRANCH -> COMPLETE.
An epic may also be parked at READY-TO-BUILD (between PLAN and BUILD) when planned ahead via /plan; /start or /continue then builds it.
State authority lives in generated-docs/epics/<slug>/state.json on the active epic/* branch.
Project-level facts (roles, auth, data source, compliance, styling) live in generated-docs/project.md on main.

### Approvals
1. INTAKE approval -- end of INTAKE: approve project.md + epic plan (first project) or just the epic brief.md (a later epic).
2. Stories approval -- end of PLAN: approve the stories for this epic.
3. Manual-test approval -- end of MANUAL-TEST: approve before opening the PR.
4. User-approved merge -- end of COMPLETE-ON-BRANCH: orchestrator never auto-merges.
The workflow chains continuously between approvals.

### Agent Autonomy
The BUILD agent (developer) resolves standard decisions itself and halts only for categories in .claude/shared/agent-autonomy.md ("Always halt"): permission changes, API contract changes, new dependencies, state/data-fetching library swaps, auth flow changes, cross-cutting architecture, project.md contradictions, CLAUDE.md policy contradictions, missing Playwright spec for a routable story.

Halts that propose changes to project.md include requiresProjectChange: true; the orchestrator routes those through the .claude/policies/epic-branch-concurrency.md §6.1 project-change flow instead of surfacing to the user.

### User Approval Policy
Output proposed content as conversation text BEFORE calling AskUserQuestion. Never auto-approve on the user's behalf.
"@

# --- Tier 3: Recency reinforcement (observed drift points) ---
$reinforcement = @"

## Quality Reminders
- the orchestrator runs a light gate inline per story (--checks lint,test-quality); the developer already ran full Vitest + typecheck
- the full /quality-check suite (build, TypeScript, full Vitest, security) runs once at epic-end, inline (Step B7.0), then a /code-review --fix pass via the code-review-runner subagent (Step B7.0.5) — invoke the runner, do not run /code-review inline — before E2E and manual testing
- Playwright runs once at epic-end, last, against the production build the quality-check produced (Step B7.0.6), not per story
"@

# --- Phase-specific snippet ---
# Snippet file is named after the lowercased phase (e.g. BUILD -> build.md).
$phaseSnippet = ''
if ($state.phase) {
    $snippetFile = Join-Path $phaseContextDir "$($state.phase.ToLower()).md"
    try {
        $phaseSnippet = "`n" + (Get-Content $snippetFile -Raw -ErrorAction Stop).TrimEnd()
    } catch {
        # Snippet missing or unreadable — leave $phaseSnippet empty.
    }
}

# --- Build final context ---
$context = ($coordinates + $orchestration + $reinforcement + $phaseSnippet).TrimEnd()

# --- Output JSON ---
$output = @{
    hookSpecificOutput = @{
        hookEventName = 'SessionStart'
        additionalContext = $context
    }
} | ConvertTo-Json -Depth 3

Write-Output $output
exit 0
