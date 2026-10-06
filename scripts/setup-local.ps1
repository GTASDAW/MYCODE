[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolsDir = Join-Path $projectRoot '.tools'
$javaDir = Join-Path $toolsDir 'java'
$mysqlDir = Join-Path $toolsDir 'mysql'
$previousProgress = $ProgressPreference
$ProgressPreference = 'SilentlyContinue'

function Get-Archive {
    param([string]$Url, [string]$Path, [string]$Sha256)
    if ((Test-Path -LiteralPath $Path) -and (Get-Item -LiteralPath $Path).Length -gt 0) {
        if (-not $Sha256 -or (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -eq $Sha256) {
            Write-Host "Reusing archive: $Path"
            return
        }
        Write-Host 'The cached archive checksum differs; downloading again.'
    }
    $partial = "$Path.download"
    Write-Host "Downloading from $Url"
    Invoke-WebRequest -Uri $Url -OutFile $partial -UseBasicParsing
    if ($Sha256 -and (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $Sha256) {
        throw 'SHA256 verification failed. The archive will not be extracted.'
    }
    Move-Item -LiteralPath $partial -Destination $Path -Force
}

try {
    New-Item -ItemType Directory -Path $toolsDir, $javaDir, $mysqlDir -Force | Out-Null
    $javaInstall = Get-ChildItem -LiteralPath $javaDir -Directory |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin/java.exe') } |
        Select-Object -First 1
    if (-not $javaInstall) {
        try {
            $javaUrl = 'https://aka.ms/download-jdk/microsoft-jdk-21-windows-x64.zip'
            $checksumResponse = Invoke-WebRequest -Uri "$javaUrl.sha256sum.txt" -UseBasicParsing -TimeoutSec 30
            $checksumText = $checksumResponse.Content
            if ($checksumText -is [byte[]]) { $checksumText = [Text.Encoding]::UTF8.GetString($checksumText) }
            $javaChecksum = [regex]::Match([string]$checksumText, '\b[a-fA-F0-9]{64}\b').Value
            if (-not $javaChecksum) { throw 'Microsoft did not return a SHA256 checksum.' }
        } catch {
            Write-Host 'Microsoft download metadata is unavailable; trying official Adoptium metadata.'
            $assetsUrl = 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse'
            $assets = Invoke-RestMethod -Uri $assetsUrl
            $package = @($assets)[0].binary.package
            $javaUrl = $package.link
            $javaChecksum = $package.checksum
            if (-not $javaUrl -or -not $javaChecksum) {
                throw 'Adoptium did not return a JDK download URL and SHA256 checksum.'
            }
        }
        $javaArchive = Join-Path $toolsDir 'jdk21.zip'
        Get-Archive -Url $javaUrl -Path $javaArchive -Sha256 $javaChecksum
        Write-Host 'Extracting JDK 21...'
        Expand-Archive -LiteralPath $javaArchive -DestinationPath $javaDir -Force
        $javaInstall = Get-ChildItem -LiteralPath $javaDir -Directory |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin/java.exe') } |
            Select-Object -First 1
    }
    if (-not $javaInstall) { throw 'JDK extraction completed, but bin/java.exe was not found.' }
    # java -version writes to stderr, which PowerShell 5.1 treats as an error record.
    $previousErrorPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $javaVersion = & (Join-Path $javaInstall.FullName 'bin/java.exe') -version 2>&1 }
    finally { $ErrorActionPreference = $previousErrorPreference }
    if ($LASTEXITCODE -ne 0 -or "$javaVersion" -notmatch 'version "21[\."]') {
        throw "The local Java installation is not JDK 21: $javaVersion"
    }
    Write-Host "JDK ready: $($javaInstall.FullName)"

    $mysqlInstall = Join-Path $mysqlDir 'mysql-8.4.11-winx64'
    if (-not (Test-Path -LiteralPath (Join-Path $mysqlInstall 'bin/mysqld.exe'))) {
        $mysqlArchive = Join-Path $toolsDir 'mysql.zip'
        Get-Archive -Url 'https://cdn.mysql.com/Downloads/MySQL-8.4/mysql-8.4.11-winx64.zip' -Path $mysqlArchive
        Write-Host 'Extracting MySQL 8.4.11...'
        Expand-Archive -LiteralPath $mysqlArchive -DestinationPath $mysqlDir -Force
    }
    if (-not (Test-Path -LiteralPath (Join-Path $mysqlInstall 'bin/mysqld.exe'))) {
        throw 'MySQL extraction completed, but bin/mysqld.exe was not found.'
    }
    Write-Host "MySQL ready: $mysqlInstall"
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        throw 'Node.js is missing. Install Node.js and npm before running start-dev.ps1.'
    }
    Write-Host 'Setup complete. Run: .\scripts\start-dev.ps1'
    Write-Host 'No system PATH changes or Windows services were created.'
} finally {
    $ProgressPreference = $previousProgress
}
