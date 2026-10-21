# Starts the whole project: Docker Desktop (if needed) + docker compose.
# Docker Desktop on this machine crashes on start because it cannot remove stale
# unix-socket files left by a previous run (Windows reports "The file cannot be
# accessed by the system"). WSL can delete them, so we clean them before starting.
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\start.ps1
param([switch]$Detach)

Set-Location $PSScriptRoot

function Test-Docker {
    docker info *> $null
    return $LASTEXITCODE -eq 0
}

if (-not (Test-Docker)) {
    Write-Host "Docker is not running. Cleaning stale sockets and starting Docker Desktop..." -ForegroundColor Yellow
    Get-Process "Docker Desktop", "com.docker.backend", "com.docker.build" -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3

    $local = "/mnt/c" + ($env:LOCALAPPDATA.Substring(2) -replace '\\', '/')
    wsl.exe -u root -- sh -c "rm -f '$local/Docker/run/'* '$local/docker-secrets-engine/engine.sock'"

    Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    $deadline = (Get-Date).AddMinutes(3)
    while (-not (Test-Docker)) {
        if ((Get-Date) -gt $deadline) {
            Write-Host "Docker did not start in 3 minutes. Check the Docker Desktop window." -ForegroundColor Red
            exit 1
        }
        Start-Sleep -Seconds 3
    }
    Write-Host "Docker is ready." -ForegroundColor Green
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
