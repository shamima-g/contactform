# workflow-guard.ps1
# UserPromptSubmit hook: injects workflow state context on every user prompt
# so Claude can redirect users who attempt development work outside the
# /start and /continue flow.
#
# Resolves state via .claude/scripts/resolve-state-path.js — works on any
# branch, including main (where there's no active epic).
#
# Output: JSON with hookSpecificOutput.additionalContext
# Fail-safe: exits 0 with no output on parse errors or unknown state.
#
# Timeout note: resolving state spawns `node resolve-state-path.js` (which spawns
# git). On a cold/slow box that cold-start can be slow; the hook's timeout in
# settings.json is set generously (10s) so the harness doesn't kill the process
# mid-run — a kill would emit no guard message and let out-of-workflow dev work
# proceed unguarded (fail-open). A resolver that merely *fails* (returns null)
# still falls through to a sensible redirect below; only a hard process-kill is
# unsafe, which the timeout headroom guards against.

$ErrorActionPreference = 'SilentlyContinue'

. (Join-Path $PSScriptRoot 'lib\workflow-state.ps1')

$projectRoot = Get-ProjectRoot -HookScriptRoot $PSScriptRoot
$nodeModulesPath = Join-Path $projectRoot 'web\node_modules'
$projectMd = Join-Path $projectRoot 'generated-docs\project.md'
$legacyState = Join-Path $projectRoot 'generated-docs\context\workflow-state.json'

# Dev-repo sentinel: .release-ignore exists only here (stripped on publish/sync).
$isTemplateDevRepo = Test-Path (Join-Path $projectRoot '.release-ignore')

$devRepoMessage = @"
TEMPLATE-DEV REPO: This is the Stadium Builder template source repo, not an end-user project.
- Template maintenance (.claude/, .github/, scripts, policies, docs, CLAUDE.user.md, the publish/sync pipeline) does NOT go through the TDD workflow. Proceed directly; do NOT redirect to /start.
- Use /start only when dogfooding the end-user experience (building a sample app to exercise the workflow). For a faithful test, prefer the release repo (Digiata/Stadium-Builder) over the dev repo.
"@

$guardMessage = $null

# Dev repo: this is the template source, not an end-user project. Emit the maintenance
# note and skip the /start-redirect branches entirely (.release-ignore exists only here).
if ($isTemplateDevRepo) {
    $guardMessage = $devRepoMessage
}
# --- Branch A: project not set up (dependencies not installed) ---
elseif (-not (Test-Path $nodeModulesPath)) {
    $guardMessage = @"
WORKFLOW GUARD: Project not initialized. Dependencies are not installed.
Action: Redirect to /start — it handles install and prefs as part of Step 0 before INTAKE.
"@
}
# --- Branch B: legacy workflow shape detected (no project.md, but legacy state present) ---
elseif ((-not (Test-Path $projectMd)) -and (Test-Path $legacyState)) {
    $guardMessage = @"
WORKFLOW GUARD: Legacy workflow shape detected.
Action: Redirect to /migrate-legacy to convert this project to the epic-branch workflow.
"@
}
# --- Branches C & D + active epic: resolve state for the current branch ---
else {
    $resolution = Get-StateResolution -ProjectRoot $projectRoot

    # --- Branch C: Not on an epic branch (or no project.md yet) ---
    if (-not $resolution -or $resolution.Kind -ne 'epic') {
        if (Test-Path $projectMd) {
            $guardMessage = @"
WORKFLOW GUARD: No epic in flight. You're not on an epic/* branch.
Action: Redirect to /start to build the next epic, or /plan to plan an epic ahead without building it; or git checkout an existing epic/* branch to resume one.
"@
        } else {
            $guardMessage = @"
WORKFLOW GUARD: No active workflow. No project.md and no epic in flight.
Action: Redirect to /start to begin the TDD workflow.
"@
        }
    }
    # --- Branch D: On an epic branch but state.json missing ---
    elseif (-not $resolution.Exists) {
        $guardMessage = @"
WORKFLOW GUARD: On epic/$($resolution.Slug) but state.json is missing.
Action: Redirect to /start to (re-)initialise the epic state, or check out a different branch.
"@
    }
    else {
        $state = Read-EpicState -ProjectRoot $projectRoot -Resolution $resolution
        if (-not $state) {
            # state.json is present (Exists = $true) but unreadable — corrupt or invalid
            # JSON. Surface it rather than failing open: a silent exit 0 would let
            # untracked dev work proceed on an active epic with no workflow guidance.
            $guardMessage = @"
WORKFLOW GUARD: On epic/$($resolution.Slug) but state.json is present and unreadable (corrupt or invalid JSON).
Action: Inspect and repair generated-docs/epics/$($resolution.Slug)/state.json before continuing — do not start untracked work.
"@
        }
        else {
            $phase = $state.phase
            $slug = $resolution.Slug
            $storyNum = Get-CurrentStory -State $state
            $storyDisplay = if ($storyNum) { $storyNum } else { 'N/A' }
            $epicName = if ($state.epic -and $state.epic.name) { $state.epic.name } else { $slug }

            if ($phase -eq 'COMPLETE-ON-BRANCH') {
                $guardMessage = @"
WORKFLOW GUARD: Epic $slug is complete on branch. PR/merge is pending.
Action: Redirect to /continue to finish the PR + merge, or merge the PR manually.
"@
            }
            elseif ($phase -eq 'COMPLETE') {
                $guardMessage = @"
WORKFLOW GUARD: Epic $slug already complete and merged. You may be on a stale branch.
Action: git checkout main, then /start to build the next epic (or /plan to plan one ahead).
"@
            }
            elseif ($phase -eq 'READY-TO-BUILD') {
                $guardMessage = @"
WORKFLOW GUARD: Epic $slug ($epicName) is planned and parked at READY-TO-BUILD — not building yet.
Action: Redirect to /start (or /continue) to build it now. To plan a different epic in parallel, use /plan in a separate workspace.
"@
            }
            else {
                $guardMessage = @"
WORKFLOW GUARD: Active epic detected.
Phase: $phase | Epic: $slug ($epicName) | Story: $storyDisplay
Action: Redirect to /continue to resume the epic-branch workflow.
"@
            }
        }
    }
}

# --- Output JSON ---
$output = @{
    hookSpecificOutput = @{
        hookEventName = 'UserPromptSubmit'
        additionalContext = $guardMessage
    }
} | ConvertTo-Json -Depth 3

Write-Output $output
exit 0
