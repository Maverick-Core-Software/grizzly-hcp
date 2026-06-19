# Weekly full sync: pull customers, jobs, and price book from HCP → re-index all in RAG.
# Scheduled via Windows Task Scheduler — runs every Monday at 6am.

$ProjectDir = "C:\Users\carte\Grizzly-HCP"
$LogFile    = "$ProjectDir\logs\weekly-sync.log"

New-Item -ItemType Directory -Force -Path "$ProjectDir\logs" | Out-Null
Set-Location $ProjectDir

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    Write-Host $line
    Add-Content $LogFile $line
}

Log "=== Weekly HCP → RAG sync started ==="

# 1. Export customers
Log "Exporting customers..."
npx tsx src/hcp/export-customers.ts 2>&1 | Tee-Object -Append -FilePath $LogFile
if ($LASTEXITCODE -ne 0) { Log "ERROR: customer export failed"; exit 1 }
bash scripts/push-customers.sh 2>&1 | Tee-Object -Append -FilePath $LogFile
if ($LASTEXITCODE -ne 0) { Log "ERROR: customer push failed"; exit 1 }

# 2. Export jobs (all statuses — scheduled, completed, in progress)
Log "Exporting jobs..."
npx tsx src/hcp/export-jobs.ts 2>&1 | Tee-Object -Append -FilePath $LogFile
if ($LASTEXITCODE -ne 0) { Log "ERROR: jobs export failed"; exit 1 }
bash scripts/push-jobs.sh 2>&1 | Tee-Object -Append -FilePath $LogFile
if ($LASTEXITCODE -ne 0) { Log "ERROR: jobs push failed"; exit 1 }

# 3. Export price book (services + materials)
Log "Exporting price book..."
npx tsx src/hcp/export-pricebook.ts 2>&1 | Tee-Object -Append -FilePath $LogFile
if ($LASTEXITCODE -ne 0) { Log "ERROR: price book export failed"; exit 1 }
bash scripts/push-pricebook.sh 2>&1 | Tee-Object -Append -FilePath $LogFile
if ($LASTEXITCODE -ne 0) { Log "ERROR: price book push failed"; exit 1 }

Log "=== Sync complete ==="
