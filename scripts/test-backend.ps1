[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $projectRoot 'backend'
$javaInstall = Get-ChildItem -LiteralPath (Join-Path $projectRoot '.tools/java') -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin/java.exe') } | Select-Object -First 1
if (-not $javaInstall) { throw 'JDK 21 not found. Run .\scripts\setup-local.ps1 first.' }
$wrapper = Join-Path $backendDir 'mvnw.cmd'
if (-not (Test-Path -LiteralPath $wrapper)) { throw 'backend/mvnw.cmd is missing.' }
$envNames = @('JAVA_HOME', 'PATH', 'TEST_DB_URL', 'TEST_DB_USERNAME', 'TEST_DB_PASSWORD')
$savedEnvironment = @{}
foreach ($name in $envNames) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:JAVA_HOME = $javaInstall.FullName
    $env:PATH = (Join-Path $javaInstall.FullName 'bin') + ';' + $env:PATH
    $env:TEST_DB_URL = 'jdbc:mysql://127.0.0.1:3307/activity_platform_test?characterEncoding=UTF-8&connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true'
    $env:TEST_DB_USERNAME = 'activity'
    $env:TEST_DB_PASSWORD = 'activity_dev_password'
    Write-Host 'Testing against the dedicated activity_platform_test database on port 3307.'
    Write-Host 'Start local MySQL first with .\scripts\start-dev.ps1.'
    Push-Location $backendDir
    try {
        & $wrapper test
        if ($LASTEXITCODE -ne 0) { throw 'Backend tests failed. See backend/target/surefire-reports.' }
    } finally { Pop-Location }
} finally {
    foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
}
