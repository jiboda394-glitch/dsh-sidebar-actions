param(
  [Parameter(Mandatory = $true)][string]$TaskName,
  [Parameter(Mandatory = $true)][string]$Launcher,
  [string]$Log = ''
)

# dsh-sidebar-actions: make sure the per-user helper task exists, points at the
# current launcher, and runs at the highest privilege this process may grant.
# Running as Limited when the app itself is elevated makes the helper unable to
# stop it, so an elevated caller registers "Highest" and a filtered caller stays
# with "Limited" (which still matches a non-elevated app).
# Idempotent: it exits 0 when the task already has the right action and level.
# ASCII only: Windows PowerShell 5.1 reads scripts without a BOM as ANSI.

$ErrorActionPreference = 'Stop'

function Note([string]$message) {
  if ($Log -eq '') { return }
  try {
    if ((Test-Path -LiteralPath $Log) -and ((Get-Item -LiteralPath $Log).Length -gt 262144)) {
      Move-Item -LiteralPath $Log -Destination ($Log + '.1') -Force
    }
    Add-Content -LiteralPath $Log -Value ((Get-Date).ToString('o') + ' ' + $message)
  } catch { }
}

try {
  $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
  if (-not (Test-Path -LiteralPath $wscript)) { throw 'wscript.exe not found' }
  if (-not (Test-Path -LiteralPath $Launcher)) { throw "launcher not found: $Launcher" }

  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $isAdmin = $false
  try {
    $isAdmin = ([System.Security.Principal.WindowsPrincipal]::new($identity)).IsInRole(
      [System.Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { }
  $levels = @('Limited')
  if ($isAdmin) { $levels = @('Highest', 'Limited') }

  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -ne $existing) {
    $current = @($existing.Actions)[0]
    $currentLauncher = [string]$current.Arguments
    $currentLevel = [string]$existing.Principal.RunLevel
    $actionMatches = ($current.Execute -match 'wscript') -and ($currentLauncher -like ('*' + $Launcher + '*'))
    if ($actionMatches -and $levels -contains $currentLevel) {
      Note "task $TaskName is already current ($currentLevel)"
      exit 0
    }
    Note "task $TaskName needs an update (action ok: $actionMatches, level: $currentLevel)"
  }

  $action = New-ScheduledTaskAction -Execute $wscript -Argument ('"' + $Launcher + '"')
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddYears(20)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew

  $registered = $false
  foreach ($level in $levels) {
    try {
      $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel $level
      Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
        -Principal $principal -Force | Out-Null
      Note "task $TaskName registered ($level) for $Launcher"
      $registered = $true
      break
    } catch {
      Note ("register as " + $level + " failed: " + $_.Exception.Message)
    }
  }

  if (-not $registered) { throw 'no privilege level could be registered' }
  exit 0
} catch {
  Note ("task ensure failed: " + $_.Exception.Message)
  exit 1
}
