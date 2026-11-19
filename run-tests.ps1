# run-tests.ps1 — D3D12 Video Encode Test Suite entry point.
#
# Ensures Node.js >= 22 is available (installs via winget if missing or too
# old), then runs the default driver-validation command:
#
#   node run-tests.mjs --frames 120 --chrome .\chrome_win64\chrome.exe
#                      --l1t3-negative-control
#
# Exit code is forwarded from run-tests.mjs (0 PASS · 1 FAIL · 2 harness
# error · 3 env has no HW encode · 4 Chrome < 158 · 5 negative-control
# failure · 6 L1T3 flag-off leg failure).

$ErrorActionPreference = 'Stop'

function Get-NodeMajorVersion([string]$nodeExe) {
    try {
        $v = (& $nodeExe --version 2>$null).Trim()
        if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
    } catch {
        # Not runnable.
    }
    return 0
}

# 1) Locate an acceptable Node.js (>= 22, for the built-in WebSocket).
$nodeExe = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd -and (Get-NodeMajorVersion $cmd.Source) -ge 22) {
    $nodeExe = $cmd.Source
}

# 2) Missing or too old → install via winget.
if (-not $nodeExe) {
    Write-Host 'Node.js >= 22 not found; installing via winget...'
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Error 'winget is not available on this machine. Install Node.js >= 22 manually and retry.'
        exit 2
    }
    winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Error 'winget install failed (may need an elevated shell).'
        exit 2
    }
    # winget may not update this session's PATH; probe the common locations,
    # then refresh PATH from the registry and retry.
    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )
    foreach ($c in $candidates) {
        if ((Test-Path $c) -and (Get-NodeMajorVersion $c) -ge 22) {
            $nodeExe = $c
            break
        }
    }
    if (-not $nodeExe) {
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                    [Environment]::GetEnvironmentVariable('Path', 'User')
        $cmd = Get-Command node -ErrorAction SilentlyContinue
        if ($cmd -and (Get-NodeMajorVersion $cmd.Source) -ge 22) {
            $nodeExe = $cmd.Source
        }
    }
    if (-not $nodeExe) {
        Write-Error 'Node.js was installed but not found on PATH. Start a new shell or fix PATH and retry.'
        exit 2
    }
}

Write-Host "Using Node: $nodeExe ($(& $nodeExe --version))"

# 3) Clean previous results so the CI artifacts reflect only this run.
$resultsDir = Join-Path $PSScriptRoot 'results'
if (Test-Path $resultsDir) {
    Remove-Item -Path (Join-Path $resultsDir '*') -Recurse -Force -Confirm:$false
    Write-Host "Cleaned results directory: $resultsDir"
}

# 4) Run the driver-validation command. Extra arguments (e.g.
# --exclude-hevc-rext) are passed through to run-tests.mjs.
& $nodeExe "$PSScriptRoot\run-tests.mjs" --frames 120 --chrome ".\chrome_win64\chrome.exe" --l1t3-negative-control @args
exit $LASTEXITCODE
