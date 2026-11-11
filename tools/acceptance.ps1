<#
.SYNOPSIS
  dsh-gitbash mechanical acceptance checks (A1-A4).

.DESCRIPTION
  A1 (syntax) and A2 (load-marker freshness) run every time. A3/A4 need a *plugin*
  invocation in between, so they run as two phases:

    1) pwsh -File tools\\acceptance.ps1 -Phase before
    2) ask the agent to run one command through the bash tool (e.g. uname -s)
    3) pwsh -File tools\\acceptance.ps1 -Phase after

  Only -Phase after can print ACCEPTANCE: PASS. auto/before print
  ACCEPTANCE: INCOMPLETE, so a half-run never looks like a green gate.

  The between-snapshot file lives in the temp directory and is removed by the
  after phase, so the plugin directory has no second artefact.

.PARAMETER Phase
  auto (default) = A1 + A2 only; before/after = snapshot and compare.

.PARAMETER PluginRoot
  Plugin directory (defaults to the script's parent's parent).

.PARAMETER ProbeMaxAgeMinutes
  A2 accepts load-ok.txt only if written within this window and names tool=bash.
#>
[CmdletBinding()]
param(
  [ValidateSet('auto', 'before', 'after')]
  [string]$Phase = 'auto',
  [string]$PluginRoot = (Split-Path -Parent (Split-Path -Parent $PSCommandPath)),
  [int]$ProbeMaxAgeMinutes = 30
)

$ErrorActionPreference = 'Stop'
$fail = 0
$baselineFile = Join-Path $env:TEMP 'dsh-gitbash-acceptance.json'

function Report([string]$id, [bool]$ok, [string]$detail) {
  $tag = if ($ok) { 'PASS' } else { 'FAIL'; }
  if (-not $ok) { $script:fail++ }
  '{0,-4} {1,-4} {2}' -f $tag, $id, $detail
}

function Snapshot {
  $dirs = @(Get-ChildItem -Path $env:TEMP -Directory -Filter 'dsh-*' -ErrorAction SilentlyContinue).Count
  $qualifier = Split-Path -Qualifier $env:TEMP
  $driveName = $qualifier.TrimEnd(':')
  $free = $null
  try { $free = (Get-PSDrive -Name $driveName -ErrorAction Stop).Free } catch { $free = $null }
  [ordered]@{ tmpDirs = $dirs; freeBytes = $free; drive = $qualifier; at = (Get-Date).ToString('o') }
}

# A1 - syntax
$syntaxOk = $true
foreach ($m in @('lib\\index.js', 'lib\\resolve.js')) {
  $full = Join-Path $PluginRoot $m
  if (-not (Test-Path $full)) { $syntaxOk = $false; continue }
  node --check $full 2>$null
  if ($LASTEXITCODE -ne 0) { $syntaxOk = $false }
}
Report 'A1' $syntaxOk 'lib modules parse (node --check)'

# A2 - insert row mounted in THIS start (apply() writes load-ok.txt)
$marker = Join-Path $PluginRoot 'load-ok.txt'
$errorMarker = Join-Path $PluginRoot 'load-error.txt'
$probeOk = $false
$probeDetail = "missing: $marker"
if (Test-Path $errorMarker) {
  $probeDetail = "load-error.txt present: $((Get-Content $errorMarker -Raw).Trim())"
} elseif (Test-Path $marker) {
  $age = (Get-Date) - (Get-Item $marker).LastWriteTime
  $content = (Get-Content $marker -Raw).Trim()
  $probeOk = $age.TotalMinutes -le $ProbeMaxAgeMinutes -and $content -match 'tool=bash'
  $probeDetail = "age $([math]::Round($age.TotalMinutes, 1)) min (limit $ProbeMaxAgeMinutes); $content"
}
Report 'A2' $probeOk $probeDetail

switch ($Phase) {
  'before' {
    Snapshot | ConvertTo-Json | Set-Content -Path $baselineFile -Encoding utf8
    ''
    "Baseline written: $baselineFile"
    'Next: run one command through the agent bash tool, then run -Phase after.'
  }
  'after' {
    if (-not (Test-Path $baselineFile)) {
      Report 'A3' $false 'no baseline: run -Phase before first'
      Report 'A4' $false 'no baseline'
    } else {
      $before = Get-Content $baselineFile -Raw | ConvertFrom-Json
      $after = Snapshot
      $deltaDirs = [int]$after.tmpDirs - [int]$before.tmpDirs
      if ($null -eq $before.freeBytes -or $null -eq $after.freeBytes) {
        Report 'A4' $false 'free bytes unavailable on the temp drive (inconclusive, treated as FAIL)'
      } else {
        $deltaMb = [math]::Round(([double]$before.freeBytes - [double]$after.freeBytes) / 1MB, 1)
        Report 'A4' ($deltaMb -lt 50) "free-space delta: $deltaMb MB (expected < 50)"
      }
      Report 'A3' ($deltaDirs -le 0) "new temp dirs: $deltaDirs (expected <= 0)"
      Remove-Item $baselineFile -Force -ErrorAction SilentlyContinue
    }
  }
  default {
    ''
    'A3/A4 need a plugin invocation between snapshots:'
    '  pwsh -File tools\\acceptance.ps1 -Phase before'
    '  -> run one command through the agent bash tool'
    '  pwsh -File tools\\acceptance.ps1 -Phase after'
  }
}

''
if ($Phase -ne 'after') {
  'ACCEPTANCE: INCOMPLETE (A1/A2 only)'
  exit 2
}
if ($fail -eq 0) { 'ACCEPTANCE: PASS'; exit 0 } else { "ACCEPTANCE: FAIL ($fail)"; exit 1 }