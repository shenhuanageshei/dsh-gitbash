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

  When two DSH instances are running, A2 may false-FAIL: it derives the load
  window from the OLDEST DeepSeek Harness process, which can belong to the
  older instance. Close the old instance and re-run A2.

  The between-snapshot file lives in the temp directory and is removed by the
  after phase, so the plugin directory has no second artefact.

.PARAMETER Phase
  auto (default) = A1 + A2 only; before/after = snapshot and compare.

.PARAMETER PluginRoot
  Plugin directory (defaults to the script's parent's parent).

.PARAMETER ExpectedBashPath
  Expected value of bashPath= in load-ok.txt. When omitted, A2 reads bashPath
  from the gitbash insert row in PatchPath. A2 always requires the bashPath=
  field to be present; equality applies only when the expectation is known:
  non-empty expectation => non-empty AND equal; empty expectation
  (candidate-chain mode) or unknown expectation => presence only, with a hint.

.PARAMETER PatchPath
  Profile patch file used to derive the expected bashPath
  (default: %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml).
  An unreadable file (or a missing gitbash row) skips the equality assert
  (presence only) with a hint.
#>
[CmdletBinding()]
param(
  [ValidateSet('auto', 'before', 'after')]
  [string]$Phase = 'auto',
  [string]$PluginRoot = (Split-Path -Parent (Split-Path -Parent $PSCommandPath)),
  [string]$ExpectedBashPath,
  [string]$PatchPath = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml')
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
foreach ($m in @('lib\index.js', 'lib\resolve.js')) {
  $full = Join-Path $PluginRoot $m
  if (-not (Test-Path $full)) { $syntaxOk = $false; continue }
  node --check $full 2>$null
  if ($LASTEXITCODE -ne 0) { $syntaxOk = $false }
}
Report 'A1' $syntaxOk 'lib modules parse (node --check)'

# A2 - insert row mounted in THIS start (apply() writes load-ok.txt)
#
# 0.2.2 hardening (docs/v0.2-design.md FR-E3): the old 30-minute wall-clock
# window could be refreshed by `node --test` (T13 writes load-ok.txt) and turn
# A2 green without a restart. A2 now also asserts
#   * bashPath= is present AND, when the expected value is known and non-empty
#     (-ExpectedBashPath, else the gitbash insert row in -PatchPath), it is
#     non-empty and equals it. An unreadable patch / no gitbash row (expectation
#     unknown) or a configured empty bashPath (candidate-chain mode) asserts
#     presence only and reports that equality was skipped, and
#   * loaded= falls inside [oldest DeepSeek Harness process StartTime, +10min]
#     (multiple processes: oldest wins; no process found -> FAIL, never PASS).
# With two DSH instances running the oldest process may belong to the older
# instance, so A2 can false-FAIL; close the old instance and re-run.
function Get-GitbashConfigBashPath([string]$patchFile) {
  # $null = patch unreadable / no gitbash bashPath row; "" = candidate-chain.
  if (-not (Test-Path -LiteralPath $patchFile)) { return $null }
  try { $lines = @(Get-Content -LiteralPath $patchFile) } catch { return $null }
  $inGitbash = $false
  foreach ($line in $lines) {
    $idMatch = [regex]::Match($line, '^\s*-\s*id:\s*(\S+)\s*$')
    if ($idMatch.Success) {
      $inGitbash = ($idMatch.Groups[1].Value -eq 'gitbash')
      continue
    }
    if (-not $inGitbash) { continue }
    $pathMatch = [regex]::Match($line, '^\s*bashPath:\s*(.*)$')
    if (-not $pathMatch.Success) { continue }
    $raw = $pathMatch.Groups[1].Value.Trim()
    # YAML inline comment: only whitespace + '#' starts one, so a '#' inside the
    # path itself (e.g. 'C:\Git#1\bin\bash.exe') is preserved.
    $raw = ($raw -replace '\s+#.*$', '').Trim()
    if ($raw -match '^''(.*)''$') { return $Matches[1] }
    if ($raw -match '^"(.*)"$') { return $Matches[1] }
    return $raw
  }
  return $null
}

$marker = Join-Path $PluginRoot 'load-ok.txt'
$errorMarker = Join-Path $PluginRoot 'load-error.txt'
$probeOk = $false
$probeDetail = "missing: $marker"
if (Test-Path -LiteralPath $errorMarker) {
  $probeDetail = "load-error.txt present: $((Get-Content -LiteralPath $errorMarker -Raw).Trim())"
} elseif (Test-Path -LiteralPath $marker) {
  $content = Get-Content -LiteralPath $marker -Raw
  if ($null -eq $content) { $content = '' }
  $content = $content.Trim()
  $ok = $true
  $notes = [System.Collections.Generic.List[string]]::new()

  if ($content -notmatch 'tool=bash') {
    $ok = $false
    $notes.Add('tool=bash missing')
  }

  $loadedMatch = [regex]::Match($content, 'loaded=([^\s]+)')
  $loadedAt = $null
  if ($loadedMatch.Success) {
    try {
      $loadedAt = [System.DateTimeOffset]::Parse(
        $loadedMatch.Groups[1].Value,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::AssumeUniversal
      ).UtcDateTime
    } catch {
      $loadedAt = $null
    }
  }
  if ($null -eq $loadedAt) {
    $ok = $false
    $notes.Add('loaded= missing or unparseable')
  } else {
    $starts = @()
    $harness = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*DeepSeek*Harness*' })
    foreach ($proc in $harness) {
      try { $starts += $proc.StartTime.ToUniversalTime() } catch { }
    }
    if ($starts.Count -eq 0) {
      $ok = $false
      $notes.Add('no DeepSeek Harness process found (load freshness unverifiable)')
    } else {
      $oldest = ($starts | Sort-Object)[0]
      $windowEnd = $oldest.AddMinutes(10)
      $inWindow = ($loadedAt -ge $oldest -and $loadedAt -le $windowEnd)
      if (-not $inWindow) { $ok = $false }
      $notes.Add(('loaded {0:o} window [{1:o}, {2:o}] {3}' -f $loadedAt, $oldest, $windowEnd, $(if ($inWindow) { 'ok' } else { 'OUTSIDE' })))
    }
  }

  # Resolve the expectation FIRST, then decide what to assert:
  #   $null = unknown (patch unreadable / no gitbash row) -> presence only;
  #   ""    = candidate-chain mode                      -> presence only;
  #   value = configured bashPath                       -> presence + non-empty + equal.
  $expected = $null
  $expectedSource = ''
  if (-not [string]::IsNullOrWhiteSpace($ExpectedBashPath)) {
    $expected = $ExpectedBashPath.Trim()
    $expectedSource = '-ExpectedBashPath'
  } else {
    $expected = Get-GitbashConfigBashPath $PatchPath
    if ($null -ne $expected) { $expectedSource = $PatchPath }
  }

  # bashPath= runs until the next key: Windows paths may contain spaces.
  $pathMatch = [regex]::Match($content, 'bashPath=(.*?)(?:\s+sandboxServicesAtApply=|\s*$)')
  $pathPresent = $pathMatch.Success
  $actualPath = if ($pathPresent) { $pathMatch.Groups[1].Value.Trim() } else { '' }
  if (-not $pathPresent) {
    $ok = $false
    $notes.Add('bashPath= field missing')
  } elseif ($null -eq $expected) {
    $notes.Add("skip bashPath equality (cannot read bashPath from $PatchPath)")
  } elseif ($expected.Length -eq 0) {
    $notes.Add('skip bashPath equality (candidate-chain mode: configured bashPath is empty)')
  } elseif ($actualPath.Length -eq 0) {
    $ok = $false
    $notes.Add("bashPath= is empty but configured value is '$expected' ($expectedSource)")
  } elseif ($actualPath -eq $expected) {
    $notes.Add("bashPath matches $expectedSource")
  } else {
    $ok = $false
    $notes.Add("bashPath '$actualPath' != configured '$expected' ($expectedSource)")
  }

  $probeOk = $ok
  $probeDetail = $notes.ToArray() -join '; '
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