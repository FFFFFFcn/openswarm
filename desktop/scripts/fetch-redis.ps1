# Downloads the Windows Redis binaries (tporadowski build, BSD licensed)
# into desktop/vendor/redis/. Used both locally and in CI.
$ErrorActionPreference = "Stop"

$version = "5.0.14.1"
$url = "https://github.com/tporadowski/redis/releases/download/v$version/Redis-x64-$version.zip"
$dest = Join-Path $PSScriptRoot "..\vendor\redis"

if (Test-Path (Join-Path $dest "redis-server.exe")) {
    Write-Host "redis-server.exe already present in $dest, skipping download."
    exit 0
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null
$zip = Join-Path ([System.IO.Path]::GetTempPath()) "redis-$version.zip"

Write-Host "Downloading $url ..."
Invoke-WebRequest -Uri $url -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $dest -Force
Remove-Item $zip

if (-not (Test-Path (Join-Path $dest "redis-server.exe"))) {
    throw "redis-server.exe not found after extraction."
}
Write-Host "Redis $version ready in $dest"
