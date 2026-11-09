param(
  [Parameter(Mandatory = $true)][string]$RequestPath
)

# dsh-sidebar-actions: stop (and optionally restart) the desktop app.
#
# Started by the per-user task through launcher.vbs, so it runs outside the
# application's process tree and survives the stop it performs. It stops only
# the shell process named in the request, verifies that it really exited, waits
# for the remaining processes of the same executable name (renderers, host), and
# then starts the executable again with its original command line.
#
# ASCII only: Windows PowerShell 5.1 reads scripts without a BOM as ANSI.

$ErrorActionPreference = 'Continue'

$stateDir = Split-Path -Parent $RequestPath
$log = Join-Path $stateDir 'helper.log'

function Note([string]$message) {
  try {
    if ((Test-Path -LiteralPath $log) -and ((Get-Item -LiteralPath $log).Length -gt 262144)) {
      Move-Item -LiteralPath $log -Destination ($log + '.1') -Force
    }
    Add-Content -LiteralPath $log -Value ((Get-Date).ToString('o') + ' ' + $message)
  } catch { }
}

function Test-Alive([int]$targetId) {
  $process = Get-Process -Id $targetId -ErrorAction SilentlyContinue
  return ($null -ne $process)
}

function Get-ByName([string]$baseName) {
  if ($baseName -eq '') { return @() }
  return @(Get-Process -Name $baseName -ErrorAction SilentlyContinue)
}

Note "helper start pid=$PID request=$RequestPath"

# Give the HTTP response time to reach the page before the app goes away.
Start-Sleep -Milliseconds 900

if (-not (Test-Path -LiteralPath $RequestPath)) {
  Note 'request file is missing'
  return
}

try {
  $request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
} catch {
  Note ("request is unreadable: " + $_.Exception.Message)
  return
}

Remove-Item -LiteralPath $RequestPath -Force -ErrorAction SilentlyContinue

$action = [string]$request.action
$exe = [string]$request.exe
$targetPid = 0
[void][int]::TryParse([string]$request.pid, [ref]$targetPid)

Note "action=$action pid=$targetPid exe=$exe"

if ($exe -eq '' -or $targetPid -le 0) {
  Note 'request is incomplete'
  return
}

$baseName = ''
try { $baseName = [System.IO.Path]::GetFileNameWithoutExtension($exe) } catch { }

$commandLine = ''
$target = Get-Process -Id $targetPid -ErrorAction SilentlyContinue

if ($null -eq $target) {
  Note 'target already gone'
} else {
  # Never stop the wrong process: the image must match, and a child process
  # (a renderer, whose command line carries --type=) is refused.
  $targetPath = ''
  try { $targetPath = [string]$target.Path } catch { }
  if ($targetPath -ne '' -and -not [string]::Equals($targetPath, $exe, [StringComparison]::OrdinalIgnoreCase)) {
    Note "target path mismatch ($targetPath) - aborting"
    return
  }

  try {
    $commandLine = [string](Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction Stop).CommandLine
  } catch {
    Note ("command line unavailable: " + $_.Exception.Message)
  }
  if ($commandLine -match '--type=') {
    Note 'target is a child process, not the shell - aborting'
    return
  }

  Note "stopping $targetPid"
  Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  if (Test-Alive $targetPid) {
    Note 'stop-process did not end the target; trying taskkill'
    & taskkill.exe /F /PID $targetPid 2>&1 | Out-Null
    Start-Sleep -Milliseconds 700
  }
  if (Test-Alive $targetPid) {
    Note 'the target is still running - aborting so no second instance starts'
    return
  }
  Note 'target ended'
}

# Wait until the rest of the application is gone, so the replacement does not
# trip over the single-instance lock.
$deadline = (Get-Date).AddSeconds(25)
$remaining = @()
do {
  Start-Sleep -Milliseconds 250
  $remaining = Get-ByName $baseName
} while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline)

Note ("remaining processes: " + $remaining.Count)

if ($action -ne 'restart') {
  Note 'quit complete'
  return
}

Start-Sleep -Milliseconds 400

$started = $false
if ($commandLine -ne '') {
  try {
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
      -Arguments @{ CommandLine = $commandLine } -ErrorAction Stop
    if ($created.ReturnValue -eq 0) {
      $started = $true
      Note ("replacement started (wmi, pid " + $created.ProcessId + ")")
    } else {
      Note ("wmi create returned " + $created.ReturnValue)
    }
  } catch {
    Note ("wmi create failed: " + $_.Exception.Message)
  }
}

if (-not $started) {
  try {
    Start-Process -FilePath $exe | Out-Null
    $started = $true
    Note 'replacement started (start-process)'
  } catch {
    Note ("start failed: " + $_.Exception.Message)
  }
}

if ($started) {
  Start-Sleep -Seconds 4
  $alive = Get-ByName $baseName
  Note ("replacement processes after 4s: " + $alive.Count)
}
