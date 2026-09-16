# db-up.ps1 - bring up TimescaleDB, wait for it, migrate, verify.
#
#   .\scripts\db-up.ps1              start + wait + migrate + verify
#   .\scripts\db-up.ps1 -SkipMigrate start + wait + verify only
#   .\scripts\db-up.ps1 -Reset       wipe the volume and rebuild from scratch
#
# Run from the repo root. Requires Docker Desktop to be running.

[CmdletBinding()]
param(
    [switch]$SkipMigrate,
    [switch]$Reset
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    !!  $msg" -ForegroundColor Yellow }

# --- 1. Docker present and running? -----------------------------------------
Write-Step 'Checking Docker'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'docker not found on PATH. Install Docker Desktop: winget install Docker.DockerDesktop'
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker is installed but the daemon is not running. Start Docker Desktop and retry.'
}
Write-Ok 'daemon reachable'

# --- 2. Optional reset -------------------------------------------------------
if ($Reset) {
    Write-Step 'Resetting database volume'
    docker compose down -v
    Write-Ok 'volume removed'
}

# --- 3. Start the container --------------------------------------------------
Write-Step 'Starting TimescaleDB'
docker compose up -d
if ($LASTEXITCODE -ne 0) { throw 'docker compose up failed' }

# --- 4. Wait for the healthcheck --------------------------------------------
Write-Step 'Waiting for the database to accept connections'
$deadline = (Get-Date).AddSeconds(90)
$ready = $false
while ((Get-Date) -lt $deadline) {
    $state = docker inspect --format '{{.State.Health.Status}}' golddb 2>$null
    if ($state -eq 'healthy') { $ready = $true; break }
    if ($state -eq 'unhealthy') { throw 'Container reported unhealthy. Check: docker compose logs db' }
    Start-Sleep -Seconds 2
}
if (-not $ready) { throw 'Timed out after 90s waiting for the database.' }
Write-Ok 'database is healthy'

# --- 5. Confirm the TimescaleDB extension is available ----------------------
Write-Step 'Verifying TimescaleDB extension'
$ext = docker exec golddb psql -U postgres -d gold_terminal -tAc `
    "SELECT default_version FROM pg_available_extensions WHERE name = 'timescaledb';"
if (-not $ext) {
    throw "timescaledb is not available in this image. Got: '$ext'"
}
Write-Ok "timescaledb $ext available"

# --- 6. Apply migrations -----------------------------------------------------
if (-not $SkipMigrate) {
    Write-Step 'Applying migrations'
    # npm.ps1 is blocked by the default execution policy, so shell out to cmd.
    cmd /c "npm run migrate"
    if ($LASTEXITCODE -ne 0) { throw 'migration failed' }
    Write-Ok 'migrations applied'
}

# --- 7. Report ---------------------------------------------------------------
Write-Step 'Migration status'
cmd /c "npm run migrate:status"

Write-Step 'Collector layer check'
python -m collectors.run_all --check

Write-Host "`nDatabase is up. Connection string:" -ForegroundColor Cyan
Write-Host '  postgresql://postgres:123456@localhost:5432/gold_terminal' -ForegroundColor White
Write-Host "`nNext: npm run collect" -ForegroundColor Cyan
