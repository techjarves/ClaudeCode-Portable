$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5.1 does not preload System.Net.Http - load it for the
# streaming downloader below (PowerShell 7+ already has it; harmless there).
Add-Type -AssemblyName System.Net.Http
$ProjectRoot = Split-Path $PSScriptRoot -Parent
$Version = '22.23.2'
$Arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -eq 'Arm64') { 'arm64' } else { 'x64' }
$NodeDir = Join-Path $ProjectRoot "engine/node-win32-$Arch"
$NodeExe = Join-Path $NodeDir 'node.exe'

function Get-PortableNodeVersion {
    try {
        if (Test-Path $NodeExe) { return (& $NodeExe --version) }
    } catch {}
    return $null
}

function Invoke-PortableDownload($Url, $Destination, $Label) {
    $attempt = 0
    while ($attempt -lt 3) {
        $attempt++
        if (Test-Path $Destination) { Remove-Item $Destination -Force }
        try {
            $handler = New-Object System.Net.Http.HttpClientHandler
            $handler.AllowAutoRedirect = $true
            $client = New-Object System.Net.Http.HttpClient($handler)
            $client.Timeout = [TimeSpan]::FromMinutes(30)
            $client.DefaultRequestHeaders.UserAgent.ParseAdd('ClaudeCode-Portable/2.0')
            $response = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
            [void]$response.EnsureSuccessStatusCode()
            $total = $response.Content.Headers.ContentLength
            $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            $file = [System.IO.File]::OpenWrite($Destination)
            try {
                $buffer = New-Object byte[] 81920
                $downloaded = [long]0
                $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
                $lastShown = [TimeSpan]::Zero
                while ($true) {
                    $read = $stream.Read($buffer, 0, $buffer.Length)
                    if ($read -le 0) { break }
                    $file.Write($buffer, 0, $read)
                    $downloaded += $read
                    $elapsed = $stopwatch.Elapsed
                    if (($elapsed - $lastShown).TotalMilliseconds -ge 500) {
                        $lastShown = $elapsed
                        $mbDone = [math]::Round($downloaded / 1MB, 1)
                        $speed = if ($elapsed.TotalSeconds -gt 0) { $downloaded / $elapsed.TotalSeconds } else { 0 }
                        $mbps = [math]::Round($speed / 1MB, 2)
                        if ($total -and $total -gt 0) {
                            $mbTotal = [math]::Round($total / 1MB, 1)
                            $pct = [math]::Min(100, [math]::Round($downloaded * 100 / $total))
                            $remaining = $total - $downloaded
                            $eta = if ($speed -gt 0) { [TimeSpan]::FromSeconds($remaining / $speed).ToString('mm\:ss') } else { '--:--' }
                            Write-Host ("`r  {0}: {1}%  ({2} / {3} MB)  {4} MB/s  ETA {5}   " -f $Label, $pct, $mbDone, $mbTotal, $mbps, $eta) -NoNewline
                        } else {
                            Write-Host ("`r  {0}: {1} MB downloaded  {2} MB/s   " -f $Label, $mbDone, $mbps) -NoNewline
                        }
                    }
                }
            } finally {
                $file.Close()
                $stream.Close()
            }
            Write-Host ''
            if ($total -and (Get-Item $Destination).Length -ne $total) { throw 'Downloaded file size does not match the server (interrupted download)' }
            return
        } catch {
            Write-Host ''
            Write-Host ("  Attempt $attempt failed: $($_.Exception.Message)") -ForegroundColor Yellow
            if ($attempt -ge 3) { throw "Download failed after 3 attempts: $Url" }
            Start-Sleep -Seconds 3
        } finally {
            if ($client) { $client.Dispose() }
            if ($response) { $response.Dispose() }
        }
    }
}

$NeedsNode = ((Get-PortableNodeVersion) -ne "v$Version")
if ($NeedsNode) {
    $ArchiveName = "node-v$Version-win-$Arch.zip"
    $Base = "https://nodejs.org/dist/v$Version"
    $Engine = Join-Path $ProjectRoot 'engine'
    New-Item -ItemType Directory -Force -Path $Engine | Out-Null
    try {
        $drive = (Get-Item $ProjectRoot).PSDrive
        if ($drive -and $drive.Free -ne $null) {
            Write-Host ("  Drive {0}: {1} GB free" -f $drive.Name, [math]::Round($drive.Free / 1GB, 1)) -ForegroundColor DarkGray
        }
    } catch {}
    $Archive = Join-Path $Engine $ArchiveName
    Write-Host "Downloading portable Node.js v$Version (~30MB) from nodejs.org..."
    Invoke-PortableDownload "$Base/$ArchiveName" $Archive 'Node.js'
    Write-Host 'Verifying checksum...'
    $Checksums = (Invoke-WebRequest "$Base/SHASUMS256.txt" -UseBasicParsing).Content
    $Expected = $null
    foreach ($line in ($Checksums -split "`n")) {
        if ($line -match '^([a-fA-F0-9]{64})\s+[\* ]?node-v\S+-win-\S+\.zip\s*$' -and $line.Trim().EndsWith(" $ArchiveName")) {
            $Expected = $matches[1].ToLower()
        }
    }
    if (!$Expected -or (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLower() -ne $Expected) {
        Remove-Item $Archive -Force -ErrorAction SilentlyContinue
        throw 'Node.js checksum verification failed - the download was removed, please run START.bat again'
    }
    Write-Host 'Extracting portable Node.js... (one-time setup)'
    $Extracted = Join-Path $Engine "node-v$Version-win-$Arch"
    if (Test-Path $Extracted) { Remove-Item $Extracted -Recurse -Force }
    Expand-Archive -Path $Archive -DestinationPath $Engine -Force
    if (Test-Path $NodeDir) { Move-Item $NodeDir "$NodeDir.previous.$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" }
    Move-Item $Extracted $NodeDir
    Remove-Item $Archive -Force -ErrorAction SilentlyContinue
    $Installed = Get-PortableNodeVersion
    if ($Installed -ne "v$Version") { throw "Portable Node.js verification failed (got '$Installed')" }
    Write-Host "Portable Node.js $Installed ready." -ForegroundColor Green
}
& $NodeExe (Join-Path $ProjectRoot 'tools/launcher.mjs') @args
exit $LASTEXITCODE
