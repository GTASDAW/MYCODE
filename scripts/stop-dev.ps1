[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot '.runtime'
$statePath = Join-Path $runtimeDir 'processes.json'
if (-not (Test-Path -LiteralPath $statePath)) {
    Write-Host 'No script-owned process record exists. No processes were stopped.'
    return
}
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$remaining = @{}
foreach ($property in $state.PSObject.Properties) { $remaining[$property.Name] = $property.Value }

function Get-VerifiedProcess {
    param($Entry)
    if (-not $Entry -or -not $Entry.pid) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($Entry.pid)" -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    $workspacePrefix = $projectRoot.TrimEnd('\') + '\'
    if (-not $Entry.marker -or -not ([IO.Path]::GetFullPath([string]$Entry.marker)).StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to stop PID $($Entry.pid): its recorded marker is outside this workspace."
    }
    if (-not $process.ExecutablePath -or -not [string]::Equals($process.ExecutablePath, [string]$Entry.executable, [StringComparison]::OrdinalIgnoreCase) -or
        -not $process.CommandLine -or $process.CommandLine.IndexOf([string]$Entry.marker, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw "Refusing to stop PID $($Entry.pid): executable/command line no longer matches the record."
    }
    $recordedStart = [DateTime]::Parse([string]$Entry.startedAt).ToUniversalTime()
    $actualStart = (Get-Process -Id $Entry.pid).StartTime.ToUniversalTime()
    if ([Math]::Abs(($actualStart - $recordedStart).TotalSeconds) -gt 2) {
        throw "Refusing to stop PID $($Entry.pid): the PID has been reused."
    }
    return $process
}

function Stop-ProcessTree {
    param($Process)
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($Process.ProcessId)" -ErrorAction SilentlyContinue)
    foreach ($child in $children) {
        # npm starts an intermediate `cmd /c vite` with a relative command line.
        # Verified ancestry, start time, executable and npm/Vite arguments identify it.
        $workspaceCommand = $child.CommandLine -and $child.CommandLine.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
        $knownTool = $child.ExecutablePath -and @('cmd.exe', 'node.exe') -contains ([IO.Path]::GetFileName($child.ExecutablePath).ToLowerInvariant())
        $relativeToolCommand = $knownTool -and $child.CommandLine -match '\b(npm(?:-cli\.js|\.cmd)?|vite(?:\.js|\.cmd)?)\b'
        # Hidden console processes can own the Windows console host as a direct child.
        # Admit only the exact system conhost.exe, with the same ancestry/time checks.
        $consoleHostPath = Join-Path ([Environment]::GetFolderPath('System')) 'conhost.exe'
        $verifiedConsoleHost = $child.ExecutablePath -and [string]::Equals($child.ExecutablePath, $consoleHostPath, [StringComparison]::OrdinalIgnoreCase)
        $validAncestry = $child.CreationDate -ge $Process.CreationDate
        if ($validAncestry -and ($workspaceCommand -or $relativeToolCommand -or $verifiedConsoleHost)) {
            Stop-ProcessTree -Process $child
        } else {
            throw "Refusing to stop PID $($Process.ProcessId): child PID $($child.ProcessId) could not be verified."
        }
    }
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($Process.ProcessId)" -ErrorAction SilentlyContinue
    if (-not $current) { return }
    if ($current.CreationDate -ne $Process.CreationDate -or $current.ExecutablePath -ne $Process.ExecutablePath -or $current.CommandLine -ne $Process.CommandLine) {
        throw "Refusing to stop PID $($Process.ProcessId): it changed during shutdown."
    }
    try { Stop-Process -Id $current.ProcessId -ErrorAction Stop }
    catch {
        # A child/console shutdown may have already terminated the parent.
        if (Get-Process -Id $current.ProcessId -ErrorAction SilentlyContinue) { throw }
    }
}

foreach ($name in @('frontend', 'backend', 'mysql')) {
    if (-not $remaining.ContainsKey($name)) { continue }
    $entry = $remaining[$name]
    try {
        $process = Get-VerifiedProcess -Entry $entry
        if ($process) {
            if ($name -eq 'mysql') {
                $expectedServer = Join-Path $projectRoot '.tools/mysql/mysql-8.4.11-winx64/bin/mysqld.exe'
                $expectedConfig = Join-Path $runtimeDir 'mysql.ini'
                if (-not [string]::Equals($process.ExecutablePath, $expectedServer, [StringComparison]::OrdinalIgnoreCase) -or
                    -not [string]::Equals([string]$entry.marker, $expectedConfig, [StringComparison]::OrdinalIgnoreCase)) {
                    throw 'MySQL executable/config do not match this workspace. It was left running.'
                }
                $configPattern = '(?:^|\s)--defaults-file(?:=|\s+)(?:"' + [regex]::Escape($expectedConfig) + '"|' + [regex]::Escape($expectedConfig) + ')(?=\s|$)'
                if ($process.CommandLine -notmatch $configPattern) { throw 'MySQL --defaults-file does not exactly match. It was left running.' }
                $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 3307 -ErrorAction SilentlyContinue |
                    Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0') })
                if ($listeners.Count -eq 0 -or @($listeners | Where-Object { $_.OwningProcess -ne $entry.pid }).Count -gt 0) {
                    throw 'IPv4 port 3307 is not owned by the recorded MySQL PID. No shutdown command was sent.'
                }
                $mysqlAdmin = Join-Path $projectRoot '.tools/mysql/mysql-8.4.11-winx64/bin/mysqladmin.exe'
                $savedPassword = $env:MYSQL_PWD
                try {
                    $env:MYSQL_PWD = 'local_mysql_root_password'
                    & $mysqlAdmin --protocol=TCP --host=127.0.0.1 --port=3307 --user=root shutdown
                    if ($LASTEXITCODE -ne 0) { throw 'MySQL graceful shutdown failed. It was left running.' }
                    Wait-Process -Id $entry.pid -Timeout 30 -ErrorAction SilentlyContinue
                    if (Get-Process -Id $entry.pid -ErrorAction SilentlyContinue) { throw 'MySQL is still shutting down. Retry stop-dev.ps1 later.' }
                } finally { $env:MYSQL_PWD = $savedPassword }
            } else { Stop-ProcessTree -Process $process }
            Write-Host "Stopped $name (PID $($entry.pid))."
        } else { Write-Host "$name was already stopped." }
        $remaining.Remove($name)
    } catch {
        Write-Warning $_.Exception.Message
    }
}
$remaining | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding UTF8
if ($remaining.Count -gt 0) {
    throw "Shutdown was incomplete: $($remaining.Keys -join ', '). Their process records were preserved. Review the warnings and retry stop-dev.ps1."
}
Write-Host 'Other applications and database files were left untouched.'
