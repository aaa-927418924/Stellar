param([int]$ParentPid, [string]$InstallDir, [string]$StagingDir)
$ErrorActionPreference = 'Stop'
$log = Join-Path $StagingDir 'update.log'
try {
    Wait-Process -Id $ParentPid -Timeout 120 -ErrorAction SilentlyContinue
    $files = @('Stellar.exe', 'Stellar.Server.exe')
    foreach ($name in $files) {
        Copy-Item -LiteralPath (Join-Path $InstallDir $name) -Destination (Join-Path $StagingDir "$name.bak") -Force
    }
    try {
        foreach ($name in $files) {
            $target = Join-Path $InstallDir $name
            $source = Join-Path $StagingDir $name
            $done = $false
            for ($i = 0; $i -lt 40; $i++) {
                try {
                    Copy-Item -LiteralPath $source -Destination $target -Force
                    $done = $true
                    break
                } catch { Start-Sleep -Milliseconds 500 }
            }
            if (-not $done) { throw "Cannot replace $name" }
        }
    } catch {
        foreach ($name in $files) {
            Copy-Item -LiteralPath (Join-Path $StagingDir "$name.bak") -Destination (Join-Path $InstallDir $name) -Force
        }
        throw
    }
    Start-Process -FilePath (Join-Path $InstallDir 'Stellar.exe')
    Remove-Item -LiteralPath $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
} catch {
    $_ | Out-String | Set-Content -LiteralPath $log
    Start-Process -FilePath (Join-Path $InstallDir 'Stellar.exe') -ErrorAction SilentlyContinue
}
