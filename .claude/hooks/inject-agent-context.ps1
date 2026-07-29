# inject-agent-context.ps1
# SubagentStart hook: reinforces workflow state in subagent sessions.
# Fires when any BUILD/PLAN/INTAKE agent starts (see settings.json matcher for the canonical list).
#
# Injects: epic slug, phase, current story (~5-10 lines).
# Lightweight - just state coordinates so the subagent knows what to work on.
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

$files = Resolve-StoryAndTestFiles -ProjectRoot $projectRoot -State $state -Slug $resolution.Slug
$storyNum = Get-CurrentStory -State $state
$epicName = if ($state.epic -and $state.epic.name) { $state.epic.name } else { $resolution.Slug }
$projectMdRel = 'generated-docs/project.md'
$briefRel = "generated-docs/epics/$($resolution.Slug)/brief.md"

# --- Build context ---
$context = @"
## Workflow State
- Branch: $($resolution.Branch)
- Epic: $($resolution.Slug) ($epicName)
- Phase: $($state.phase)
- Story: $(if ($storyNum) { $storyNum } else { 'N/A (epic-level phase)' })
- Project facts: $projectMdRel
- Epic brief: $briefRel
"@

if ($files.StoryFile) {
    $context += "`n- Story file: $($files.StoryFile)"
}
if ($files.TestFile) {
    $context += "`n- Test file: $($files.TestFile)"
}

# --- Output JSON ---
$output = @{
    hookSpecificOutput = @{
        hookEventName = 'SubagentStart'
        additionalContext = $context
    }
} | ConvertTo-Json -Depth 3

Write-Output $output
exit 0
