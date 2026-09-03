param(
  [switch]$Live,
  [switch]$Full,
  [switch]$Build
)

$ErrorActionPreference = "Stop"

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeCandidates = @(
  $(if ($nodeCommand) { $nodeCommand.Source }),
  (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"),
  (Join-Path $env:ProgramFiles "nodejs\node.exe")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

$nodeExecutable = $nodeCandidates | Select-Object -First 1
if (-not $nodeExecutable) {
  throw "Node.js was not found. Install Node.js 22 or newer, then reopen PowerShell."
}

$runnerArguments = @()
if ($Live) { $runnerArguments += "--live" }
if ($Full) { $runnerArguments += "--full" }
if ($Build) { $runnerArguments += "--build" }

& $nodeExecutable (Join-Path $PSScriptRoot "run.mjs") @runnerArguments
exit $LASTEXITCODE
