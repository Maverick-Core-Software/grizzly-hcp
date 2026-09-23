[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'status', 'restart')]
  [string]$Action,

  [Parameter(Position = 1)]
  [ValidateSet('agent', 'detector', 'monitor', 'all')]
  [string]$Target,

  [switch]$DryRun,
  [switch]$Supervisor
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$DataRoot = Join-Path $Root 'data\c0'
$RunRoot = Join-Path $DataRoot 'run'
$LogRoot = Join-Path $DataRoot 'logs'

function Get-C0Apps {
  @(
    [pscustomobject]@{ Name = 'agent'; Entry = 'canary/c0/agent/src/main.ts'; Args = @('start'); Script = Join-Path $Root 'canary\c0\agent\node_modules\tsx\dist\cli.mjs' },
    [pscustomobject]@{ Name = 'detector'; Entry = 'canary/c0/detector/src/index.ts'; Args = @(); Script = Join-Path $Root 'canary\c0\detector\node_modules\tsx\dist\cli.mjs' },
    [pscustomobject]@{ Name = 'monitor'; Entry = 'canary/c0/monitor/index.ts'; Args = @(); Script = Join-Path $Root 'canary\c0\monitor\node_modules\tsx\dist\cli.mjs' }
  )
}

function Get-SelectedApps([string]$RequestedTarget) {
  $apps = Get-C0Apps
  if ($RequestedTarget -eq 'all') { return $apps }
  return @($apps | Where-Object Name -eq $RequestedTarget)
}

function Get-AppPath([object]$App, [string]$Suffix) {
  Join-Path $RunRoot "$($App.Name).$Suffix"
}

function Get-LogPath([object]$App, [string]$Suffix) {
  Join-Path $LogRoot "$($App.Name).$Suffix.log"
}

function Ensure-C0Directories {
  foreach ($path in @($RunRoot, $LogRoot)) {
    if (-not (Test-Path -LiteralPath $path)) { New-Item -ItemType Directory -Path $path -Force | Out-Null }
  }
}

function Read-PidFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $content = (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop).Trim()
  $pidValue = 0
  if (-not [int]::TryParse($content, [ref]$pidValue) -or $pidValue -le 0) { return $null }
  return $pidValue
}

function Write-PidFile([string]$Path, [int]$PidValue) {
  Set-Content -LiteralPath $Path -Value $PidValue -NoNewline -Encoding ascii
}

function Remove-PidFile([string]$Path) {
  if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
}

function Get-ProcessRecord([int]$PidValue) {
  try { return Get-CimInstance Win32_Process -Filter "ProcessId = $PidValue" -ErrorAction Stop } catch { return $null }
}

if ($null -eq ('C0CommandLineTokenizer' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class C0CommandLineTokenizer {
  [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern IntPtr CommandLineToArgvW(string commandLine, out int argumentCount);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr LocalFree(IntPtr memory);

  public static string[] Tokenize(string commandLine) {
    int argumentCount;
    IntPtr argv = CommandLineToArgvW(commandLine, out argumentCount);
    if (argv == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      var result = new string[argumentCount];
      for (var index = 0; index < argumentCount; index++) {
        result[index] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, index * IntPtr.Size)) ?? String.Empty;
      }
      return result;
    } finally {
      LocalFree(argv);
    }
  }
}
'@
}

function ConvertFrom-WindowsCommandLine([string]$CommandLine) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return @() }
  return [C0CommandLineTokenizer]::Tokenize($CommandLine)
}

function Test-C0Path([string]$Actual, [string]$Expected) {
  $normalizedActual = $Actual -replace '/', '\'
  $normalizedExpected = $Expected -replace '/', '\'
  return [string]::Equals($normalizedActual, $normalizedExpected, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-C0ExecutableName([string]$Actual, [string[]]$AllowedNames) {
  $name = [System.IO.Path]::GetFileName($Actual)
  return $AllowedNames -contains $name.ToLowerInvariant()
}

function Test-C0SupervisorCommandLine([object]$App, [string]$CommandLine) {
  $tokens = @(ConvertFrom-WindowsCommandLine $CommandLine)
  if ($tokens.Count -ne 9) { return $false }
  return (Test-C0ExecutableName $tokens[0] @('pwsh.exe', 'powershell.exe')) -and
    $tokens[1] -ceq '-NoProfile' -and $tokens[2] -ceq '-ExecutionPolicy' -and $tokens[3] -ceq 'Bypass' -and $tokens[4] -ceq '-File' -and
    (Test-C0Path $tokens[5] $PSCommandPath) -and $tokens[6] -ceq 'start' -and $tokens[7] -ceq $App.Name -and $tokens[8] -ceq '-Supervisor'
}

function Test-C0ChildCommandLine([object]$App, [string]$CommandLine) {
  $tokens = @(ConvertFrom-WindowsCommandLine $CommandLine)
  $expected = @($App.Script, $App.Entry) + @($App.Args)
  if ($tokens.Count -ne ($expected.Count + 1) -or -not (Test-C0ExecutableName $tokens[0] @('node', 'node.exe'))) { return $false }
  if (-not (Test-C0Path $tokens[1] $App.Script)) { return $false }
  for ($index = 1; $index -lt $expected.Count; $index++) {
    if ($tokens[$index + 1] -cne $expected[$index]) { return $false }
  }
  return $true
}

function Get-C0ProcessAction([object]$App, [ValidateSet('supervisor', 'child')][string]$Role, [object]$Record) {
  if ($null -eq $Record -or [string]::IsNullOrWhiteSpace([string]$Record.CommandLine)) { return 'preserve' }
  $matches = if ($Role -eq 'supervisor') { Test-C0SupervisorCommandLine $App ([string]$Record.CommandLine) } else { Test-C0ChildCommandLine $App ([string]$Record.CommandLine) }
  if ($matches) { return 'kill' }
  return 'preserve'
}

function Test-CanaryProcess([object]$App, [ValidateSet('supervisor', 'child')][string]$Role, [int]$PidValue) {
  return (Get-C0ProcessAction $App $Role (Get-ProcessRecord $PidValue)) -eq 'kill'
}

function Format-Command([object]$App) {
  $arguments = @($App.Script, $App.Entry) + @($App.Args)
  return 'node ' + (($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' ')
}

function ConvertTo-ProcessArguments([string[]]$Arguments) {
  return (($Arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' ')
}

function Write-SupervisorLog([object]$App, [string]$Message) {
  $line = "$(Get-Date -Format o) app=$($App.Name) $Message"
  Add-Content -LiteralPath (Get-LogPath $App 'supervisor') -Value $line -Encoding utf8
}

function Start-Supervisor([object]$App) {
  $supervisorPidPath = Get-AppPath $App 'supervisor.pid'
  $childPidPath = Get-AppPath $App 'pid'
  if ($DryRun) {
    Write-Output "DRYRUN app=$($App.Name) cwd=$Root command=$(Format-Command $App) tz=America/Chicago"
    Write-Output "DRYRUN supervisor_pid=$supervisorPidPath child_pid=$childPidPath out_log=$(Get-LogPath $App 'out') err_log=$(Get-LogPath $App 'err')"
    return
  }
  $existingSupervisor = Read-PidFile $supervisorPidPath
  $existingChild = Read-PidFile $childPidPath
  if ($null -ne $existingSupervisor) {
    if (Test-CanaryProcess $App 'supervisor' $existingSupervisor) { throw "Refusing to start $($App.Name): the expected supervisor is already alive" }
    throw "Refusing to start $($App.Name): supervisor PID metadata is stale or does not identify this exact C0 supervisor"
  }
  if ($null -ne $existingChild) {
    if (Test-CanaryProcess $App 'child' $existingChild) { throw "Refusing to start $($App.Name): the expected child is already alive" }
    throw "Refusing to start $($App.Name): child PID metadata is stale or does not identify this exact C0 child"
  }
  Ensure-C0Directories
  $hostExecutable = if ($PSVersionTable.PSEdition -eq 'Core') { Join-Path $PSHOME 'pwsh.exe' } else { Join-Path $PSHOME 'powershell.exe' }
  $supervisorArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, 'start', $App.Name, '-Supervisor')
  $process = Start-Process -FilePath $hostExecutable -ArgumentList (ConvertTo-ProcessArguments ([string[]]$supervisorArgs)) -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  Write-PidFile $supervisorPidPath $process.Id
  Write-Output "started $($App.Name) supervisor_pid=$($process.Id)"
}

function Invoke-Supervisor([object]$App) {
  Ensure-C0Directories
  $supervisorPidPath = Get-AppPath $App 'supervisor.pid'
  $childPidPath = Get-AppPath $App 'pid'
  Write-PidFile $supervisorPidPath $PID
  $env:TZ = 'America/Chicago'
  $restartTimes = New-Object System.Collections.ArrayList
  $restartCount = 0
  try {
    while ($true) {
      Write-SupervisorLog $App "event=launch restart_count=$restartCount cwd=$Root command=$(Format-Command $App)"
      $startInfo = New-Object System.Diagnostics.ProcessStartInfo
      $startInfo.FileName = 'node'
      $startInfo.Arguments = ConvertTo-ProcessArguments (@($App.Script, $App.Entry) + @($App.Args))
      $startInfo.WorkingDirectory = $Root
      $startInfo.UseShellExecute = $false
      $startInfo.CreateNoWindow = $true
      $startInfo.RedirectStandardOutput = $true
      $startInfo.RedirectStandardError = $true
      $child = New-Object System.Diagnostics.Process
      $child.StartInfo = $startInfo
      if (-not $child.Start()) { throw "Unable to launch $($App.Name) child process" }
      Write-PidFile $childPidPath $child.Id
      $stdout = $child.StandardOutput.ReadToEndAsync()
      $stderr = $child.StandardError.ReadToEndAsync()
      $child.WaitForExit()
      if ($stdout.Result) { Add-Content -LiteralPath (Get-LogPath $App 'out') -Value $stdout.Result -Encoding utf8 }
      if ($stderr.Result) { Add-Content -LiteralPath (Get-LogPath $App 'err') -Value $stderr.Result -Encoding utf8 }
      if ((Read-PidFile $childPidPath) -eq $child.Id) { Remove-PidFile $childPidPath }
      $now = Get-Date
      while ($restartTimes.Count -gt 0 -and $restartTimes[0] -lt $now.AddMinutes(-10)) { $restartTimes.RemoveAt(0) }
      if ($restartTimes.Count -ge 5) {
        Write-SupervisorLog $App "event=give_up restart_count=$restartCount window_seconds=600 exit_code=$($child.ExitCode)"
        break
      }
      [void]$restartTimes.Add($now)
      $restartCount = $restartTimes.Count
      $delay = [Math]::Min(60, 5 * [Math]::Pow(2, $restartCount - 1))
      Write-SupervisorLog $App "event=restart restart_count=$restartCount delay_seconds=$delay exit_code=$($child.ExitCode)"
      Start-Sleep -Seconds $delay
    }
  } finally {
    if ((Read-PidFile $supervisorPidPath) -eq $PID) { Remove-PidFile $supervisorPidPath }
  }
}

function Stop-App([object]$App) {
  $supervisorPidPath = Get-AppPath $App 'supervisor.pid'
  $childPidPath = Get-AppPath $App 'pid'
  $supervisorPid = Read-PidFile $supervisorPidPath
  $childPid = Read-PidFile $childPidPath
  if ($DryRun) {
    Write-Output "DRYRUN app=$($App.Name) stop_supervisor_pid_file=$supervisorPidPath stop_child_pid_file=$childPidPath guard=exact-worktree-command"
    return
  }
  if ($null -ne $supervisorPid) {
    $supervisorAction = Get-C0ProcessAction $App 'supervisor' (Get-ProcessRecord $supervisorPid)
    if ($supervisorAction -eq 'kill') {
      Stop-Process -Id $supervisorPid -Force
      Remove-PidFile $supervisorPidPath
      Write-Output "stopped $($App.Name) supervisor_pid=$supervisorPid"
    } else { Write-Warning "Refusing to stop $($App.Name) supervisor PID: stale metadata does not identify the exact C0 supervisor; PID file retained" }
  }
  if ($null -ne $childPid) {
    $childAction = Get-C0ProcessAction $App 'child' (Get-ProcessRecord $childPid)
    if ($childAction -eq 'kill') {
      & taskkill.exe /PID $childPid /T /F | Out-Null
      Remove-PidFile $childPidPath
      Write-Output "stopped $($App.Name) child_pid=$childPid"
    } else { Write-Warning "Refusing to stop $($App.Name) child PID: stale metadata does not identify the exact C0 child; PID file retained" }
  }
}

function Redact-LogLine([string]$Line) {
  $redacted = $Line -replace '\d{7,}', '[REDACTED-DIGITS]'
  return $redacted -replace '(?i)\b(?:sk-[A-Za-z0-9_-]{16,}|API[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,})\b', '[REDACTED-KEY]'
}

function Get-RestartCount([object]$App) {
  $logPath = Get-LogPath $App 'supervisor'
  if (-not (Test-Path -LiteralPath $logPath)) { return 0 }
  $latest = Get-Content -LiteralPath $logPath | Select-String -Pattern 'restart_count=(\d+)' | Select-Object -Last 1
  if ($null -eq $latest) { return 0 }
  return [int]$latest.Matches[0].Groups[1].Value
}

function Format-ProcessUptime([object]$CreationDate, [datetime]$Now = (Get-Date)) {
  if ($CreationDate -is [datetime]) {
    $started = $CreationDate
  } elseif ([string]::IsNullOrWhiteSpace([string]$CreationDate)) {
    return 'n/a'
  } else {
    $started = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$CreationDate)
  }
  return ($Now - $started).ToString()
}

function Show-AppStatus([object]$App) {
  $supervisorPid = Read-PidFile (Get-AppPath $App 'supervisor.pid')
  $childPid = Read-PidFile (Get-AppPath $App 'pid')
  $runningPid = if ($null -ne $childPid -and (Test-CanaryProcess $App 'child' $childPid)) { $childPid } elseif ($null -ne $supervisorPid -and (Test-CanaryProcess $App 'supervisor' $supervisorPid)) { $supervisorPid } else { $null }
  $uptime = 'n/a'
  if ($null -ne $runningPid) {
    $record = Get-ProcessRecord $runningPid
    if ($null -ne $record) { $uptime = Format-ProcessUptime $record.CreationDate }
  }
  $state = if ($null -ne $runningPid) { 'running' } else { 'stopped' }
  Write-Output "app=$($App.Name) state=$state supervisor_pid=$supervisorPid child_pid=$childPid uptime=$uptime restart_count=$(Get-RestartCount $App)"
  $errPath = Get-LogPath $App 'err'
  if (Test-Path -LiteralPath $errPath) {
    Get-Content -LiteralPath $errPath -Tail 3 | ForEach-Object { Write-Output "err=$(Redact-LogLine $_)" }
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  if ([string]::IsNullOrWhiteSpace($Action) -or [string]::IsNullOrWhiteSpace($Target)) {
    throw 'Usage: c0ctl.ps1 [-DryRun] <start|stop|status|restart> <agent|detector|monitor|all>'
  }
  $apps = @(Get-SelectedApps $Target)
  if ($Supervisor) {
    if ($apps.Count -ne 1) { throw 'Supervisor mode requires one app target' }
    Invoke-Supervisor $apps[0]
    exit $LASTEXITCODE
  }

  foreach ($app in $apps) {
    switch ($Action) {
      'start' { Start-Supervisor $app }
      'stop' { Stop-App $app }
      'status' { Show-AppStatus $app }
      'restart' { Stop-App $app; Start-Supervisor $app }
    }
  }
}
