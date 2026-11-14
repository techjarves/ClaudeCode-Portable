$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5.1 does not preload System.Net.Http - load it for the
# streaming downloader below (PowerShell 7+ already has it; harmless there).
Add-Type -AssemblyName System.Net.Http
$ProjectRoot = Split-Path $PSScriptRoot -Parent
$Version = '26.13.1'
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
# Claude Code needs Git Bash for its shell tool. A system Git for Windows is
# used as-is; PortableGit is downloaded only when none is installed.
function Find-ExistingGitBash {
    $candidates = @()
    if ($env:CLAUDE_CODE_GIT_BASH_PATH) { $candidates += $env:CLAUDE_CODE_GIT_BASH_PATH }
    $candidates += (Join-Path $ProjectRoot 'engine/git-win-x64/bin/bash.exe')
    $candidates += 'C:\Program Files\Git\bin\bash.exe'
    $candidates += 'C:\Program Files (x86)\Git\bin\bash.exe'
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs/Git/bin/bash.exe') }
    foreach ($command in @(Get-Command git.exe -All -ErrorAction SilentlyContinue)) {
        $dir = Split-Path $command.Source -Parent
        $candidates += (Join-Path $dir 'bash.exe')
        $candidates += (Join-Path $dir '../bin/bash.exe')
        $candidates += (Join-Path $dir '../usr/bin/bash.exe')
        $candidates += (Join-Path $dir '../../bin/bash.exe')
        $candidates += (Join-Path $dir '../../usr/bin/bash.exe')
    }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    return $null
}

$GitBash = Find-ExistingGitBash
if ($GitBash) {
    Write-Host "Git Bash found: $GitBash" -ForegroundColor DarkGray
} else {
    $GitVersion = '2.56.1'
    $GitDir = Join-Path $ProjectRoot 'engine/git-win-x64'
    $GitArchive = Join-Path $ProjectRoot 'engine/PortableGit.7z.exe'
    $GitAsset = if ($Arch -eq 'arm64') { "PortableGit-$GitVersion-arm64.7z.exe" } else { "PortableGit-$GitVersion-64-bit.7z.exe" }
    $GitUrl = "https://github.com/git-for-windows/git/releases/download/v$GitVersion.windows.1/$GitAsset"
    Write-Host 'No system Git for Windows found. Downloading bundled Git Bash (one-time, can take a few minutes)...'
    try {
        Invoke-PortableDownload $GitUrl $GitArchive 'Git for Windows'
        if (Test-Path $GitDir) { Remove-Item $GitDir -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $GitDir | Out-Null
        & $GitArchive "-o$GitDir" '-y' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "PortableGit extraction failed (exit $LASTEXITCODE)" }
        Remove-Item $GitArchive -Force -ErrorAction SilentlyContinue
        $GitBash = Join-Path $GitDir 'bin/bash.exe'
        if (-not (Test-Path $GitBash)) { throw 'PortableGit did not contain bin/bash.exe' }
        Write-Host 'Bundled Git Bash ready.' -ForegroundColor Green
    } catch {
        Write-Host "  Git Bash setup skipped: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host '  The shell tool needs Git Bash; install Git for Windows if Claude Code reports it missing.' -ForegroundColor DarkGray
    }
}

$env:PATH = "$NodeDir;$env:PATH"
& $NodeExe (Join-Path $ProjectRoot 'tools/launcher.mjs') @args
exit $LASTEXITCODE
