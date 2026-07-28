# Weekly brain-vault re-ingest.
#
# The HCP exports that used to live here — customers, jobs, and the price book —
# now run on the AIWA server as the hcp-catalog-sync systemd timer, which also
# exports estimates. They no longer run on this PC and no longer copy anything to
# the server, so nothing in this script needs the deploy key.
#
# What remains is the Obsidian brain vault re-ingest into agent-os memory.
# Scheduled via Windows Task Scheduler — runs every Monday at 6am.

$ProjectDir = "C:\Workspace\Active\grizzly-hcp"
$LogFile    = "$ProjectDir\logs\weekly-sync.log"

New-Item -ItemType Directory -Force -Path "$ProjectDir\logs" | Out-Null
Set-Location $ProjectDir

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    Write-Host $line
    Add-Content $LogFile $line
}

Log "=== Weekly brain-vault re-ingest started ==="

# Re-ingest the Obsidian brain vault into agent-os memory.
# Non-fatal: a failure here logs a warning rather than failing the run.
Log "Re-ingesting brain vault into agent-os memory..."
$AgentOsDir = "C:\Workspace\Infrastructure\agent-os"
Push-Location $AgentOsDir
python scripts/ingest-brain-vault.py 2>&1 | Tee-Object -Append -FilePath $LogFile
if ($LASTEXITCODE -ne 0) { Log "WARN: brain-vault ingest failed (non-fatal)" }
Pop-Location

Log "=== Sync complete ==="
