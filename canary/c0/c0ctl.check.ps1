$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script = Join-Path $PSScriptRoot 'c0ctl.ps1'
$dryRun = & $script -DryRun start all | Out-String
$expected = @(
  "node `"$(Join-Path $root 'canary\c0\agent\node_modules\tsx\dist\cli.mjs')`" `"canary/c0/agent/src/main.ts`" `"start`"",
  "node `"$(Join-Path $root 'canary\c0\detector\node_modules\tsx\dist\cli.mjs')`" `"canary/c0/detector/src/index.ts`"",
  "node `"$(Join-Path $root 'canary\c0\monitor\node_modules\tsx\dist\cli.mjs')`" `"canary/c0/monitor/index.ts`""
)
foreach ($command in $expected) {
  if (-not $dryRun.Contains($command)) { throw "Dry-run command does not match the ecosystem entry: $command" }
}
if ([regex]::Matches($dryRun, '(?m)^DRYRUN app=.* cwd=').Count -ne 3 -or -not $dryRun.Contains("cwd=$root")) { throw 'Dry-run must report the worktree cwd for each app' }
$source = Get-Content -LiteralPath $script -Raw
if ($source -match '(?i)\bpm2\s+') { throw 'c0ctl must not invoke PM2' }
if ($source -notmatch 'Read-PidFile' -or $source -notmatch 'Test-C0SupervisorCommandLine' -or $source -notmatch 'Test-C0ChildCommandLine' -or $source -notmatch "-eq 'kill'") { throw 'stop must use exact supervisor and child command-line guards' }
$stopDryRun = & $script -DryRun stop agent | Out-String
if (-not $stopDryRun.Contains('stop_supervisor_pid_file=') -or -not $stopDryRun.Contains('guard=exact-worktree-command')) { throw 'stop dry-run must identify only PID-file targets protected by the exact command guard' }
. $script
$agent = Get-C0Apps | Where-Object Name -eq 'agent' | Select-Object -First 1
$expectedSupervisor = '"C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe" "-NoProfile" "-ExecutionPolicy" "Bypass" "-File" "' + $script + '" "start" "agent" "-Supervisor"'
$expectedChild = '"node" "' + $agent.Script + '" "' + $agent.Entry + '" "start"'
if (-not (Test-C0SupervisorCommandLine $agent $expectedSupervisor)) { throw 'the quoted live supervisor command must satisfy the exact identity guard' }
if (-not (Test-C0ChildCommandLine $agent $expectedChild)) { throw 'the quoted live child command must satisfy the exact identity guard' }
$unquotedSupervisor = 'pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "' + $script + '" start agent -Supervisor'
$unquotedChild = 'node "' + $agent.Script + '" "' + $agent.Entry + '" start'
if (-not (Test-C0SupervisorCommandLine $agent $unquotedSupervisor)) { throw 'unquoted exact supervisor tokens must remain accepted' }
if (-not (Test-C0ChildCommandLine $agent $unquotedChild)) { throw 'unquoted exact child tokens must remain accepted' }
$slashNormalizedChild = '"node" "' + ($agent.Script -replace '\\', '/') + '" "' + $agent.Entry + '" "start"'
if (-not (Test-C0ChildCommandLine $agent $slashNormalizedChild)) { throw 'the tsx path separator normalization must remain accepted' }
if (Test-C0SupervisorCommandLine $agent 'powershell.exe -Command "Write-Output canary/c0"') { throw 'a substring-only supervisor fixture must not match' }
if (Test-C0ChildCommandLine $agent ('"node" "' + ($agent.Script -replace [regex]::Escape($root), 'C:\other-worktree') + '" "' + $agent.Entry + '" "start"')) { throw 'a different checkout child fixture must not match' }
if (Test-C0ChildCommandLine $agent ($expectedChild + ' "extra"')) { throw 'an extra child argument must not match' }
if (Test-C0SupervisorCommandLine $agent ('"pwsh.exe" "-NoProfile" "-ExecutionPolicy" "Bypass" "-File" "' + $script + '" "start" "detector" "-Supervisor"')) { throw 'a different app supervisor fixture must not match' }
if (Test-C0ChildCommandLine $agent ('"python.exe" "' + $agent.Script + '" "' + $agent.Entry + '" "start"')) { throw 'a different child executable must not match' }
$unreadable = [pscustomobject]@{ CommandLine = $null }
$substringOnly = [pscustomobject]@{ CommandLine = 'powershell.exe -Command "Write-Output canary/c0"' }
$matchingChild = [pscustomobject]@{ CommandLine = $expectedChild }
if ((Get-C0ProcessAction $agent 'child' $unreadable) -ne 'preserve') { throw 'an unreadable command line must leave the PID metadata untouched' }
if ((Get-C0ProcessAction $agent 'child' $substringOnly) -ne 'preserve') { throw 'a substring-only command line must not reach a kill API' }
if ((Get-C0ProcessAction $agent 'child' $matchingChild) -ne 'kill') { throw 'the exact current child command must remain killable' }
$now = [datetime]'2026-09-22T12:00:00'
$started = [datetime]'2026-09-22T11:00:00'
if ((Format-ProcessUptime $started $now) -ne '01:00:00') { throw 'status uptime must accept CIM DateTime values' }
$dmtf = [System.Management.ManagementDateTimeConverter]::ToDmtfDateTime($started)
if ((Format-ProcessUptime $dmtf $now) -ne '01:00:00') { throw 'status uptime must accept DMTF CreationDate values' }
Write-Output 'c0ctl.check OK'
