# Weekly price book sync: pull from HCP, re-index in RAG.
# Register via Task Scheduler (see below) or run manually.

$ProjectDir = "C:\Users\carte\Grizzly-HCP"
$LogFile    = "$ProjectDir\logs\pricebook-sync.log"

New-Item -ItemType Directory -Force -Path "$ProjectDir\logs" | Out-Null

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content $LogFile "`n=== Sync started: $timestamp ==="

Set-Location $ProjectDir

# Export from HCP
npx tsx src/hcp/export-pricebook.ts 2>&1 | Tee-Object -Append -FilePath $LogFile
if ($LASTEXITCODE -ne 0) {
    Add-Content $LogFile "ERROR: export failed — HCP session may have expired. Run: npm run login"
    exit 1
}

# Push to Proxmox for RAG ingest
bash scripts/push-pricebook.sh 2>&1 | Tee-Object -Append -FilePath $LogFile
if ($LASTEXITCODE -ne 0) {
    Add-Content $LogFile "ERROR: push to Proxmox failed"
    exit 1
}

Add-Content $LogFile "=== Sync complete: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="
