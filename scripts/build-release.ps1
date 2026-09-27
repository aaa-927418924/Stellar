$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist/Stellar'
$archive = Join-Path $root 'dist/Stellar-win-x64.zip'
$files = @('Stellar.exe', 'Stellar.Server.exe') | ForEach-Object { Join-Path $dist $_ }
foreach ($file in $files) { if (-not (Test-Path $file)) { throw "Missing $file. Run npm run build:exe and npm run build:window first." } }
Compress-Archive -LiteralPath $files -DestinationPath $archive -Force
Write-Output "Created $archive"
