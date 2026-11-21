param(
  [Parameter(Mandatory = $true)][string]$StateDir,
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Archive
)

# dsh-sidebar-actions: install the bridge patch that the host staged for this
# exact application version.
#
# The host builds `patch\app.asar` from the *installed* package and records its
# version, size and hash in `patch\meta.json`. This script runs only while the
# application is stopped, refuses anything that no longer matches, keeps a
# backup of the package it replaces, and writes the bridge marker afterwards.
#
# Exit codes: 0 = installed, 2 = skipped (nothing to do / not applicable),
#             1 = failed.
#
# ASCII only: Windows PowerShell 5.1 reads scripts without a BOM as ANSI.

$ErrorActionPreference = 'Stop'
$log = Join-Path $StateDir 'helper.log'

function Note([string]$message) {
  try {
    if ((Test-Path -LiteralPath $log) -and ((Get-Item -LiteralPath $log).Length -gt 262144)) {
      Move-Item -LiteralPath $log -Destination ($log + '.1') -Force
    }
    Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o') + ' ' + $message)
  } catch { }
}

try {
  $patchDir = Join-Path $StateDir 'patch'
  $metaPath = Join-Path $patchDir 'meta.json'
  $stage = Join-Path $patchDir 'app.asar'
  if (-not (Test-Path -LiteralPath $metaPath)) { exit 2 }
  if (-not (Test-Path -LiteralPath $stage)) { Note 'patch: staged package missing'; exit 2 }
  if (-not (Test-Path -LiteralPath $Archive)) { Note ('patch: installed package missing: ' + $Archive); exit 2 }

  $meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json

  $exeVersion = [string](Get-Item -LiteralPath $Exe).VersionInfo.FileVersion
  if ([string]$meta.version -ne $exeVersion) {
    Note ('patch: staged for ' + $meta.version + ' but the app is ' + $exeVersion + '; skipping')
    exit 2
  }

  $stageSize = (Get-Item -LiteralPath $stage).Length
  if ($stageSize -ne [int64]$meta.stageSize) {
    Note ('patch: staged size ' + $stageSize + ' does not match ' + $meta.stageSize + '; skipping')
    exit 2
  }

  $installedSize = (Get-Item -LiteralPath $Archive).Length
  if ($installedSize -ne [int64]$meta.baseSize) {
    Note ('patch: installed package changed since staging (' + $installedSize + ' vs ' + $meta.baseSize + '); skipping')
    exit 2
  }

  $stageSha = (Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash.ToLower()
  if ($stageSha -ne ([string]$meta.stageSha).ToLower()) {
    Note 'patch: staged package failed its hash check; skipping'
    exit 2
  }

  $backup = Join-Path $patchDir ('backup-' + $exeVersion + '.orig')
  if (-not (Test-Path -LiteralPath $backup)) {
    Copy-Item -LiteralPath $Archive -Destination $backup -Force
  }

  $ok = $false
  for ($i = 0; $i -lt 40; $i++) {
    try {
      Copy-Item -LiteralPath $stage -Destination $Archive -Force -ErrorAction Stop
      if ((Get-Item -LiteralPath $Archive).Length -eq $stageSize) { $ok = $true; break }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }

  if (-not $ok) {
    Note 'patch: could not replace the installed package'
    exit 1
  }

  $marker = Join-Path $env:LOCALAPPDATA 'dsh-restart.bridge'
  try { Set-Content -LiteralPath $marker -Value (Get-Date).ToString('o') -Encoding UTF8 } catch { }

  Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $metaPath -Force -ErrorAction SilentlyContinue

  Note ('patch: installed bridge patch for ' + $exeVersion + ' (' + $stageSize + ' bytes)')
  exit 0
} catch {
  Note ('patch: error ' + $_.Exception.Message)
  exit 1
}
