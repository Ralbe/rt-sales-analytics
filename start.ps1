# Запуск проекта после установки и запуска Docker Desktop.
param([switch]$Detach)

Set-Location $PSScriptRoot
$ErrorActionPreference = 'Stop'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host 'Install Docker Desktop, start it and run this script again.' -ForegroundColor Yellow
    exit 1
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Start Docker Desktop, wait until it is ready and run this script again.' -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path .env)) { Copy-Item .env.example .env }

$port = 8080
$portLine = Select-String -Path .env -Pattern '^HTTP_PORT=(\d+)' | Select-Object -First 1
if ($portLine) { $port = $portLine.Matches[0].Groups[1].Value }
Write-Host "Starting the stack. App: http://localhost:$port   API docs: http://localhost:$port/api/docs" -ForegroundColor Green
if ($Detach) {
    docker compose up --build -d
} else {
    docker compose up --build
}
exit $LASTEXITCODE
