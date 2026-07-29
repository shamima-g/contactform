# workflow-state.ps1
# Shared helpers for inject-phase-context.ps1, inject-agent-context.ps1, and
# workflow-guard.ps1 under the epic-branch workflow.
#
# State path is resolved by .claude/scripts/resolve-state-path.js — see the
# epic-branch workflow plan for the per-epic state.json shape.

function Get-ProjectRoot {
    param([string]$HookScriptRoot)
    # Walk up from the hook's directory to the nearest ancestor holding a `.claude/` (or
    # `.git/`) marker — mirroring .claude/scripts/lib/project-root.js — so a relocated or
    # nested hook still resolves the repo root instead of silently returning the wrong
    # directory (the old fixed-depth `.Parent.Parent` assumed the hook sat exactly two
    # levels below the root).
    $dir = Get-Item $HookScriptRoot
    while ($null -ne $dir) {
        if ((Test-Path (Join-Path $dir.FullName '.claude')) -or (Test-Path (Join-Path $dir.FullName '.git'))) {
            return $dir.FullName
        }
        $dir = $dir.Parent
    }
    # Fallback: the historical fixed-depth resolve (<root>/.claude/hooks -> <root>).
    return (Get-Item $HookScriptRoot).Parent.Parent.FullName
}

# Resolves the active state file via resolve-state-path.js. Returns a hashtable:
#   @{ Kind = 'epic'|'none'; Branch = '<branch>'; Slug = '<slug>'; Path = '<rel>'; AbsolutePath = '<abs>'; Exists = $true|$false }
# Returns $null on resolver failure.
function Get-StateResolution {
    param([string]$ProjectRoot)
    $script = Join-Path $ProjectRoot '.claude\scripts\resolve-state-path.js'
    try {
        $json = node $script --root $ProjectRoot 2>$null
        if (-not $json) { return $null }
        $obj = $json | ConvertFrom-Json
        if ($obj.status -ne 'ok') { return $null }
        return @{
            Kind         = $obj.kind
            Branch       = $obj.branch
            Slug         = $obj.slug
            Path         = $obj.path
            AbsolutePath = $obj.absolutePath
            Exists       = $obj.exists
        }
    } catch {
        return $null
    }
}

# Reads and parses the per-epic state.json on the current epic/* branch.
# Returns $null when not on an epic branch, when state.json is missing, or on parse error.
# Callers that already hold a resolution (every hook resolves once up front) should
# pass it via -Resolution to avoid a second resolve-state-path.js + git spawn.
function Read-EpicState {
    param([string]$ProjectRoot, $Resolution)
    if (-not $Resolution) { $Resolution = Get-StateResolution -ProjectRoot $ProjectRoot }
    if (-not $Resolution -or $Resolution.Kind -ne 'epic' -or -not $Resolution.Exists) { return $null }
    try {
        return Get-Content $Resolution.AbsolutePath -Raw -ErrorAction Stop | ConvertFrom-Json
    } catch {
        return $null
    }
}

function ConvertTo-RelativePath {
    param([string]$AbsolutePath, [string]$ProjectRoot)
    return $AbsolutePath -replace [regex]::Escape($ProjectRoot + '\'), '' -replace '\\', '/'
}

# Active = on an epic/* branch with state.json present and phase != COMPLETE.
function Test-ActiveWorkflow {
    param($State)
    if (-not $State) { return $false }
    if (-not $State.phase) { return $false }
    if ($State.phase -eq 'COMPLETE') { return $false }
    return $true
}

# Returns the in-progress story key from state.json.stories, or $null.
# The key is returned as-is (a string). Story keys are numeric by convention,
# but a non-numeric key must not crash the hook — `[int]"intro"` is a terminating
# cast error that $ErrorActionPreference='SilentlyContinue' does NOT suppress.
# Returning the string also avoids the falsy-zero trap: a non-empty string "0" is
# truthy in PowerShell, whereas [int]0 is falsy and would read as "no story".
function Get-CurrentStory {
    param($State)
    if (-not $State -or -not $State.stories) { return $null }
    foreach ($prop in $State.stories.PSObject.Properties) {
        if ($prop.Value.status -eq 'in-progress') { return $prop.Name }
    }
    return $null
}

# Returns @{ StoryFile = <relative|null>; TestFile = <relative|null> } for the
# in-progress story on the active epic branch. Story files live at
# generated-docs/epics/<slug>/stories/story-<N>-*.md; integration test files at
# web/src/__tests__/integration/epic-<slug>-story-<N>-* (test-generator.md §47).
function Resolve-StoryAndTestFiles {
    param([string]$ProjectRoot, $State, [string]$Slug)
    $result = @{ StoryFile = $null; TestFile = $null }
    if (-not $State -or -not $Slug) { return $result }

    $storyNum = Get-CurrentStory -State $State
    if (-not $storyNum) { return $result }

    $epicDir = Join-Path $ProjectRoot "generated-docs\epics\$Slug\stories"
    $storyFiles = Get-ChildItem -Path $epicDir -File -Filter "story-$storyNum-*.md" 2>$null
    if ($storyFiles -and $storyFiles.Count -gt 0) {
        $result.StoryFile = ConvertTo-RelativePath -AbsolutePath $storyFiles[0].FullName -ProjectRoot $ProjectRoot
    }

    $testDir = Join-Path $ProjectRoot 'web\src\__tests__\integration'
    $testFiles = Get-ChildItem -Path $testDir -File -Filter "epic-$Slug-story-$storyNum-*" 2>$null
    if ($testFiles -and $testFiles.Count -gt 0) {
        $result.TestFile = ConvertTo-RelativePath -AbsolutePath $testFiles[0].FullName -ProjectRoot $ProjectRoot
    }

    return $result
}
