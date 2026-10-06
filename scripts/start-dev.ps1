[CmdletBinding()]
param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot '.runtime'
$statePath = Join-Path $runtimeDir 'processes.json'
$mysqlHome = Join-Path $projectRoot '.tools/mysql/mysql-8.4.11-winx64'
$mysqlExe = Join-Path $mysqlHome 'bin/mysql.exe'
$mysqlServer = Join-Path $mysqlHome 'bin/mysqld.exe'
$backendDir = Join-Path $projectRoot 'backend'
$frontendDir = Join-Path $projectRoot 'frontend'
$configPath = Join-Path $runtimeDir 'mysql.ini'
$vitePath = [IO.Path]::GetFullPath((Join-Path $frontendDir 'node_modules/vite/bin/vite.js'))
[xml]$pom = Get-Content -LiteralPath (Join-Path $backendDir 'pom.xml') -Raw
$artifactName = [string]$pom.project.build.finalName
if (-not $artifactName) { $artifactName = "$($pom.project.artifactId)-$($pom.project.version)" }
$jarPath = [IO.Path]::GetFullPath((Join-Path $backendDir "target/$artifactName.jar"))
$javaInstall = Get-ChildItem -LiteralPath (Join-Path $projectRoot '.tools/java') -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin/java.exe') } | Select-Object -First 1
if (-not $javaInstall -or -not (Test-Path -LiteralPath $mysqlServer)) {
    throw 'Local JDK/MySQL not found. Run .\scripts\setup-local.ps1 first.'
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm.cmd was not found in PATH.' }
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$javaExe = Join-Path $javaInstall.FullName 'bin/java.exe'
$state = @{}
if (Test-Path -LiteralPath $statePath) {
    $oldState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    foreach ($property in $oldState.PSObject.Properties) { $state[$property.Name] = $property.Value }
}

function Save-State { $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding UTF8 }
function Test-Port {
    param([int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connection = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $connection.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($connection)
        return $true
    } catch { return $false } finally { $client.Dispose() }
}
function Wait-Port {
    param([int]$Port, [int]$Seconds = 90)
    for ($attempt = 0; $attempt -lt $Seconds; $attempt++) {
        if (Test-Port $Port) { return }
        Start-Sleep -Seconds 1
    }
    throw "Port $Port did not become ready. Check logs under $runtimeDir."
}
function Wait-Http {
    param([string]$Url, [int]$Seconds = 90)
    for ($attempt = 0; $attempt -lt $Seconds; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return }
        } catch { }
        Start-Sleep -Seconds 1
    }
    throw "$Url did not become ready. Check logs under $runtimeDir."
}
function Record-Process {
    param([string]$Name, $Process, [string]$Executable, [string]$Marker)
    $state[$Name] = @{ pid = $Process.Id; executable = $Executable; marker = $Marker; startedAt = $Process.StartTime.ToUniversalTime().ToString('o') }
    Save-State
}
function Assert-PortOwner {
    param([int]$Port, [string]$Executable, [string]$Argument, [string]$ExpectedPath)
    # Match the endpoint used by Test-Port and HTTP/MySQL clients, never ::1.
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0') })
    if ($listeners.Count -eq 0) { throw "No IPv4 listener could be verified on port $Port." }
    $verifiedOwner = $null
    foreach ($listener in $listeners) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
        $matches = $false
        if ($owner.CommandLine -and [string]::Equals($owner.ExecutablePath, $Executable, [StringComparison]::OrdinalIgnoreCase)) {
            $tokens = @([regex]::Matches($owner.CommandLine, '(?:"([^"]*)"|([^\s"]+))') |
                ForEach-Object { if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value } })
            for ($index = 0; $index -lt $tokens.Count; $index++) {
                $candidate = $null
                if ($Argument -eq 'script') { $candidate = $tokens[$index] }
                elseif ($tokens[$index] -eq $Argument -and $index + 1 -lt $tokens.Count) { $candidate = $tokens[$index + 1] }
                elseif ($tokens[$index].StartsWith("$Argument=", [StringComparison]::OrdinalIgnoreCase)) {
                    $candidate = $tokens[$index].Substring($Argument.Length + 1)
                    # --defaults-file="path with spaces" is split into two tokens by the tokenizer.
                    if (-not $candidate -and $index + 1 -lt $tokens.Count) { $candidate = $tokens[$index + 1] }
                }
                if ($candidate -and [IO.Path]::IsPathRooted($candidate)) {
                    try {
                        $resolvedCandidate = [IO.Path]::GetFullPath($candidate.Replace('/', '\'))
                        if ([string]::Equals($resolvedCandidate, $ExpectedPath, [StringComparison]::OrdinalIgnoreCase)) { $matches = $true }
                    } catch { }
                }
            }
        }
        if (-not $matches) { throw "Port $Port is occupied by an unverified process. No action will be taken against it." }
        $verifiedOwner = $owner
    }
    return $verifiedOwner
}
function Invoke-LocalSql {
    param([string]$Sql, [string]$Password)
    $savedPassword = $env:MYSQL_PWD
    $savedPreference = $ErrorActionPreference
    try {
        $env:MYSQL_PWD = $Password
        $ErrorActionPreference = 'Continue'
        $result = $Sql | & $mysqlExe --protocol=TCP --host=127.0.0.1 --port=3307 --user=root --batch --skip-column-names 2>&1
        $success = $LASTEXITCODE -eq 0
        return @{ success = $success; output = "$result" }
    } finally {
        $env:MYSQL_PWD = $savedPassword
        $ErrorActionPreference = $savedPreference
    }
}

# Verify every occupied IPv4 endpoint before initializing or provisioning anything.
if (Test-Port 3307) { Assert-PortOwner -Port 3307 -Executable $mysqlServer -Argument '--defaults-file' -ExpectedPath $configPath | Out-Null }
if (Test-Port 8080) { Assert-PortOwner -Port 8080 -Executable $javaExe -Argument '-jar' -ExpectedPath $jarPath | Out-Null }
if (Test-Port 5173) { Assert-PortOwner -Port 5173 -Executable $nodeExe -Argument 'script' -ExpectedPath $vitePath | Out-Null }
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

$envNames = @('JAVA_HOME', 'PATH', 'DB_URL', 'DB_USERNAME', 'DB_PASSWORD', 'PORT')
$savedEnvironment = @{}
foreach ($name in $envNames) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:JAVA_HOME = $javaInstall.FullName
    $env:PATH = (Join-Path $javaInstall.FullName 'bin') + ';' + $env:PATH
    $env:DB_URL = 'jdbc:mysql://127.0.0.1:3307/activity_platform?characterEncoding=UTF-8&connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true'
    $env:DB_USERNAME = 'activity'
    $env:DB_PASSWORD = 'activity_dev_password'
    $env:PORT = '8080'

    if (Test-Port 3307) {
        Assert-PortOwner -Port 3307 -Executable $mysqlServer -Argument '--defaults-file' -ExpectedPath $configPath | Out-Null
        Write-Host 'Reusing MySQL on 127.0.0.1:3307. Existing data will be preserved.'
    } else {
        $dataDir = Join-Path $runtimeDir 'mysql-data'
        New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
        $mysqlBase = $mysqlHome.Replace('\', '/')
        $mysqlData = $dataDir.Replace('\', '/')
        $errorLog = (Join-Path $runtimeDir 'mysql-error.log').Replace('\', '/')
        @"
[mysqld]
basedir="$mysqlBase"
datadir="$mysqlData"
port=3307
bind-address=127.0.0.1
mysqlx=OFF
character-set-server=utf8mb4
collation-server=utf8mb4_0900_ai_ci
default-time-zone='+00:00'
log-error="$errorLog"
"@ | Set-Content -LiteralPath $configPath -Encoding ASCII
        if (-not (Test-Path -LiteralPath (Join-Path $dataDir 'mysql'))) {
            if (@(Get-ChildItem -LiteralPath $dataDir -Force).Count -gt 0) {
                throw "The data directory is non-empty but has no mysql system database: $dataDir. It will not be reset."
            }
            Write-Host 'Initializing a new local MySQL data directory...'
            $initialization = Start-Process -FilePath $mysqlServer -ArgumentList @("--defaults-file=`"$configPath`"", '--initialize-insecure') -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $runtimeDir 'mysql-init.out.log') -RedirectStandardError (Join-Path $runtimeDir 'mysql-init.err.log')
            if ($initialization.ExitCode -ne 0) { throw 'MySQL initialization failed. Check .runtime/mysql-error.log.' }
        }
        $mysqlProcess = Start-Process -FilePath $mysqlServer -ArgumentList @("--defaults-file=`"$configPath`"", '--console') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDir 'mysql.out.log') -RedirectStandardError (Join-Path $runtimeDir 'mysql.err.log')
        Record-Process -Name 'mysql' -Process $mysqlProcess -Executable $mysqlServer -Marker $configPath
        Wait-Port -Port 3307
        $mysqlListener = Assert-PortOwner -Port 3307 -Executable $mysqlServer -Argument '--defaults-file' -ExpectedPath $configPath
        if ($mysqlListener.ProcessId -ne $mysqlProcess.Id) {
            if ($mysqlListener.ParentProcessId -ne $mysqlProcess.Id -or $mysqlListener.CreationDate.ToUniversalTime() -lt $mysqlProcess.StartTime.ToUniversalTime()) {
                throw 'The MySQL listener is not the process started by this script or its verified direct child.'
            }
        }
        # MySQL on Windows may keep a monitor parent and serve TCP from its child.
        Record-Process -Name 'mysql' -Process (Get-Process -Id $mysqlListener.ProcessId) -Executable $mysqlServer -Marker $configPath
    }
    $rootPassword = 'local_mysql_root_password'
    $rootCheck = Invoke-LocalSql -Sql 'SELECT 1;' -Password $rootPassword
    if (-not $rootCheck.success) {
        $initialCheck = Invoke-LocalSql -Sql 'SELECT 1;' -Password ''
        if (-not $initialCheck.success) {
            throw 'Cannot authenticate as the local MySQL root account. Existing data/passwords will not be reset.'
        }
        $passwordChange = Invoke-LocalSql -Sql "ALTER USER 'root'@'localhost' IDENTIFIED BY '$rootPassword';" -Password ''
        if (-not $passwordChange.success) { throw "Could not set the initial root password: $($passwordChange.output)" }
    }
    $provision = Invoke-LocalSql -Password $rootPassword -Sql @"
CREATE DATABASE IF NOT EXISTS activity_platform CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS activity_platform_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS 'activity'@'localhost' IDENTIFIED BY 'activity_dev_password';
CREATE USER IF NOT EXISTS 'activity'@'127.0.0.1' IDENTIFIED BY 'activity_dev_password';
GRANT ALL PRIVILEGES ON activity_platform.* TO 'activity'@'localhost';
GRANT ALL PRIVILEGES ON activity_platform_test.* TO 'activity'@'localhost';
GRANT ALL PRIVILEGES ON activity_platform.* TO 'activity'@'127.0.0.1';
GRANT ALL PRIVILEGES ON activity_platform_test.* TO 'activity'@'127.0.0.1';
"@
    if (-not $provision.success) { throw "Database provisioning failed: $($provision.output)" }

    if (Test-Port 8080) {
        Assert-PortOwner -Port 8080 -Executable $javaExe -Argument '-jar' -ExpectedPath $jarPath | Out-Null
        Write-Host 'Reusing the backend on port 8080.'
    } else {
        if (-not $SkipBuild) {
            $wrapper = Join-Path $backendDir 'mvnw.cmd'
            if (-not (Test-Path -LiteralPath $wrapper)) { throw 'backend/mvnw.cmd is missing.' }
            Push-Location $backendDir
            try {
                & $wrapper -DskipTests package
                if ($LASTEXITCODE -ne 0) { throw 'Backend build failed.' }
            } finally { Pop-Location }
        }
        if (-not (Test-Path -LiteralPath $jarPath)) { throw "The backend jar does not exist: $jarPath. Run again without -SkipBuild." }
        $backendProcess = Start-Process -FilePath $javaExe -ArgumentList @('-jar', "`"$jarPath`"", '--server.address=127.0.0.1') -WorkingDirectory $backendDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDir 'backend.out.log') -RedirectStandardError (Join-Path $runtimeDir 'backend.err.log')
        Record-Process -Name 'backend' -Process $backendProcess -Executable $javaExe -Marker $jarPath
    }
    Wait-Http -Url 'http://127.0.0.1:8080/api/health'
    Assert-PortOwner -Port 8080 -Executable $javaExe -Argument '-jar' -ExpectedPath $jarPath | Out-Null

    if (Test-Port 5173) {
        Assert-PortOwner -Port 5173 -Executable $nodeExe -Argument 'script' -ExpectedPath $vitePath | Out-Null
        Write-Host 'Reusing the frontend on port 5173.'
    } else {
        if (-not (Test-Path -LiteralPath (Join-Path $frontendDir 'node_modules/vite'))) {
            Push-Location $frontendDir
            try {
                & npm.cmd ci
                if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
            } finally { Pop-Location }
        }
        $npmPath = (Get-Command npm.cmd).Source
        $npmCommand = '""{0}" --prefix "{1}" run dev -- --host 127.0.0.1 --port 5173 --strictPort"' -f $npmPath, $frontendDir
        $frontendProcess = Start-Process -FilePath $env:ComSpec -ArgumentList "/d /s /c $npmCommand" -WorkingDirectory $frontendDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDir 'frontend.out.log') -RedirectStandardError (Join-Path $runtimeDir 'frontend.err.log')
        Record-Process -Name 'frontend' -Process $frontendProcess -Executable $env:ComSpec -Marker $frontendDir
    }
    Wait-Http -Url 'http://127.0.0.1:5173'
    Assert-PortOwner -Port 5173 -Executable $nodeExe -Argument 'script' -ExpectedPath $vitePath | Out-Null
    Write-Host 'Ready: http://127.0.0.1:5173'
    Write-Host 'Accounts: admin / Admin123! ; demo / Demo123!'
    Write-Host "Logs: $runtimeDir"
    Write-Host 'Stop only script-owned processes: .\scripts\stop-dev.ps1'
} finally {
    foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
}
