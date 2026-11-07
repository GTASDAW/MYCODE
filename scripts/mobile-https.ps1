[CmdletBinding()]
param(
    [ValidateSet('Start', 'Status', 'Stop')][string]$Action = 'Status',
    [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$script:MobileRoot = Split-Path -Parent $PSScriptRoot
$script:MobileRuntime = Join-Path $script:MobileRoot '.runtime/mobile-https'
$script:MobileScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'mobile-https.mjs'))
$script:MobileStatePath = Join-Path $script:MobileRuntime 'managed-processes.json'
$script:MobileRuleName = 'Gather-Mobile-HTTPS-Managed'
if (-not $ConfigPath) { $ConfigPath = Join-Path $script:MobileRuntime 'config.json' }

function Get-MobileAbsolutePath([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path)) { $Path = Join-Path $script:MobileRoot $Path }
    return [IO.Path]::GetFullPath($Path)
}

function Test-MobilePathEqual([string]$Left, [string]$Right) {
    return [string]::Equals($Left, $Right, [StringComparison]::OrdinalIgnoreCase)
}

function ConvertFrom-MobileCommandLine([string]$CommandLine) {
    # Windows argv quoting: a backslash escapes a quote only after an odd run.
    $result = New-Object 'System.Collections.Generic.List[string]'
    $index = 0
    while ($index -lt $CommandLine.Length) {
        while ($index -lt $CommandLine.Length -and [char]::IsWhiteSpace($CommandLine[$index])) { $index++ }
        if ($index -eq $CommandLine.Length) { break }
        $token = New-Object Text.StringBuilder
        $quoted = $false
        while ($index -lt $CommandLine.Length) {
            $character = $CommandLine[$index]
            if (-not $quoted -and [char]::IsWhiteSpace($character)) { break }
            if ($character -eq '\') {
                $slashes = 0
                while ($index -lt $CommandLine.Length -and $CommandLine[$index] -eq '\') { $slashes++; $index++ }
                if ($index -lt $CommandLine.Length -and $CommandLine[$index] -eq '"') {
                    [void]$token.Append(('\' * [int][Math]::Floor($slashes / 2)))
                    if ($slashes % 2) { [void]$token.Append('"') } else { $quoted = -not $quoted }
                    $index++
                } else { [void]$token.Append(('\' * $slashes)) }
                continue
            }
            if ($character -eq '"') { $quoted = -not $quoted; $index++; continue }
            [void]$token.Append($character)
            $index++
        }
        if ($quoted) { throw '进程命令行引号不完整，拒绝操作。' }
        $result.Add($token.ToString())
    }
    return $result.ToArray()
}

function Assert-MobileRecord($Entry, $State) {
    if ($Entry.mode -cnotin @('https', 'certificate') -or
        -not (Test-MobilePathEqual ([string]$Entry.script) $script:MobileScript) -or
        -not (Test-MobilePathEqual ([string]$Entry.config) ([string]$State.configPath)) -or
        -not (Test-MobilePathEqual ([string]$Entry.executable) ([string]$State.firewall.executable)) -or
        -not [IO.Path]::IsPathRooted([string]$Entry.executable) -or
        [IO.Path]::GetFileName([string]$Entry.executable) -ine 'node.exe' -or
        [string]$Entry.bindAddress -cne [string]$State.snapshot.bindAddress -or
        [string]$Entry.PID -notmatch '^[1-9][0-9]*$') { throw '托管进程记录未知或不完整，未修改状态。' }
    $expectedPort = if ($Entry.mode -ceq 'https') { $State.snapshot.httpsPort } else { $State.snapshot.certificatePort }
    if ([int]$Entry.port -ne [int]$expectedPort) { throw '托管端口记录不一致。' }
    $created = [DateTimeOffset]::Parse([string]$Entry.creationTimeUtc)
    if ($created.Offset -ne [TimeSpan]::Zero) { throw '托管进程创建时间必须为 UTC。' }
}

function Read-MobileState {
    if (-not (Test-Path -LiteralPath $script:MobileStatePath)) { return $null }
    $state = [IO.File]::ReadAllText($script:MobileStatePath) | ConvertFrom-Json
    if ($state.schemaVersion -ne 1 -or -not [IO.Path]::IsPathRooted([string]$state.configPath) -or
        [string]$state.configSha256 -notmatch '^[A-Fa-f0-9]{64}$' -or
        $state.firewall.name -cne $script:MobileRuleName -or $state.firewall.group -cne $script:MobileRuleName -or
        [string]$state.firewall.bindAddress -cne [string]$state.snapshot.bindAddress -or
        [string]$state.firewall.phoneAddress -cne [string]$state.snapshot.phoneAddress -or
        @($state.services).Count -gt 2) { throw '未知托管状态；请保留记录人工检查。' }
    Assert-MobileFirewallScope $state.firewall
    if ((@($state.firewall.ports | Sort-Object) -join ',') -cne ((@([int]$state.snapshot.httpsPort, [int]$state.snapshot.certificatePort) | Sort-Object) -join ',')) {
        throw '托管防火墙端口记录不一致。'
    }
    $modes = @{}
    foreach ($entry in @($state.services)) {
        Assert-MobileRecord $entry $state
        if ($modes.ContainsKey([string]$entry.mode)) { throw '重复托管进程记录。' }
        $modes[[string]$entry.mode] = $true
    }
    return $state
}

function Save-MobileState($State) {
    $temporary = Join-Path $script:MobileRuntime ('managed-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $backup = $temporary + '.bak'
    try {
        [IO.File]::WriteAllText($temporary, ($State | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($true)))
        if (Test-Path -LiteralPath $script:MobileStatePath) { [IO.File]::Replace($temporary, $script:MobileStatePath, $backup) }
        else { [IO.File]::Move($temporary, $script:MobileStatePath) }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup }
    }
}

function Backup-MobileState([string]$Reason) {
    $destination = Join-Path $script:MobileRuntime ($Reason + '-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffff') + '-' + [Guid]::NewGuid().ToString('N') + '.json')
    [IO.File]::Copy($script:MobileStatePath, $destination, $false)
}

function Get-MobileListeners { return @(Get-NetTCPConnection -State Listen -ErrorAction Stop) }

function Get-MobileProcessState($Entry, $Listeners) {
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$Entry.PID) -ErrorAction Stop
    $portListeners = @($Listeners | Where-Object { [int]$_.LocalPort -eq [int]$Entry.port })
    if (-not $process) {
        if ($portListeners.Count) { throw "端口 $($Entry.port) 已由其他进程使用，拒绝操作。" }
        return 'absent'
    }
    $expected = @([string]$Entry.executable, [string]$Entry.script, 'serve', '--config', [string]$Entry.config, '--mode', [string]$Entry.mode)
    $actual = @(ConvertFrom-MobileCommandLine ([string]$process.CommandLine))
    $matching = (Test-MobilePathEqual ([string]$process.ExecutablePath) ([string]$Entry.executable)) -and $actual.Count -eq $expected.Count
    for ($index = 0; $matching -and $index -lt $actual.Count; $index++) {
        if ($index -in @(0, 1, 4)) { $matching = Test-MobilePathEqual $actual[$index] $expected[$index] }
        else { $matching = $actual[$index] -ceq $expected[$index] }
    }
    $created = [DateTimeOffset]::Parse([string]$Entry.creationTimeUtc).UtcDateTime
    if (-not $process.CreationDate -or $process.CreationDate.ToUniversalTime().Ticks -ne $created.Ticks) { $matching = $false }
    if (-not $matching) { throw "PID $($Entry.PID) 身份不匹配（可能已复用），拒绝操作。" }
    foreach ($listener in @($Listeners | Where-Object { [int]$_.OwningProcess -eq [int]$Entry.PID -or [int]$_.LocalPort -eq [int]$Entry.port })) {
        if ([int]$listener.OwningProcess -ne [int]$Entry.PID -or [int]$listener.LocalPort -ne [int]$Entry.port -or
            [string]$listener.LocalAddress -cne [string]$Entry.bindAddress) { throw '托管进程或端口监听范围不匹配，拒绝操作。' }
    }
    if ($portListeners.Count -eq 1) { return 'listening' }
    if ($portListeners.Count -gt 1) { throw '托管端口出现重复监听，拒绝操作。' }
    return 'starting'
}

function Assert-MobileFirewallScope($Scope) {
    foreach ($property in @('bindAddress', 'phoneAddress')) {
        $address = $null
        if (-not [Net.IPAddress]::TryParse([string]$Scope.$property, [ref]$address) -or
            $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
            $address.ToString() -cne [string]$Scope.$property -or
            -not (Test-MobilePrivateIpv4 $address)) {
            throw '防火墙必须使用明确的单个 RFC1918 私网 IPv4 地址。'
        }
    }
    if ($Scope.bindAddress -ceq $Scope.phoneAddress -or @($Scope.ports).Count -ne 2 -or
        [int]$Scope.ports[0] -lt 1024 -or [int]$Scope.ports[0] -gt 65535 -or
        [int]$Scope.ports[1] -lt 1024 -or [int]$Scope.ports[1] -gt 65535 -or [int]$Scope.ports[0] -eq [int]$Scope.ports[1] -or
        [int]$Scope.ports[0] -in @(3307, 8080, 5173) -or [int]$Scope.ports[1] -in @(3307, 8080, 5173) -or
        [string]::IsNullOrWhiteSpace([string]$Scope.interfaceAlias) -or [string]$Scope.interfaceAlias -match '[*?\[\],]' -or
        $Scope.profile -cnotin @('Domain', 'Private', 'Public') -or
        -not [IO.Path]::IsPathRooted([string]$Scope.executable) -or [IO.Path]::GetFileName([string]$Scope.executable) -ine 'node.exe') {
        throw '防火墙作用域记录无效，拒绝放宽范围。'
    }
}

function Test-MobilePrivateIpv4([Net.IPAddress]$Address) {
    $bytes = $Address.GetAddressBytes()
    return $bytes[0] -eq 10 -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or ($bytes[0] -eq 192 -and $bytes[1] -eq 168)
}

function Get-MobileNetworkScope($Config, [string]$Executable) {
    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.IPAddress -ceq $Config.bindAddress -and $_.AddressState -eq 'Preferred' })
    if ($addresses.Count -ne 1) { throw '配置的电脑 IP 已不在当前网卡上；请确认新 IP 后更新配置及证书。' }
    $adapter = Get-NetAdapter -InterfaceIndex $addresses[0].InterfaceIndex -ErrorAction Stop
    $profiles = @(Get-NetConnectionProfile -InterfaceIndex $addresses[0].InterfaceIndex -ErrorAction Stop)
    if ($adapter.Status -ne 'Up' -or $profiles.Count -ne 1) { throw '无法唯一确认当前网卡及网络配置，不修改网络。' }
    $profile = if ([string]$profiles[0].NetworkCategory -eq 'DomainAuthenticated') { 'Domain' } else { [string]$profiles[0].NetworkCategory }
    $scope = [pscustomobject]@{ name = $script:MobileRuleName; group = $script:MobileRuleName; executable = $Executable
        bindAddress = [string]$Config.bindAddress; phoneAddress = [string]$Config.phoneAddress
        ports = @([int]$Config.httpsPort, [int]$Config.certificatePort); interfaceAlias = [string]$adapter.Name; profile = $profile }
    Assert-MobileFirewallScope $scope
    return $scope
}

function Assert-MobileFirewall($Scope) {
    $rules = @(Get-NetFirewallRule -PolicyStore PersistentStore -Name $script:MobileRuleName -ErrorAction SilentlyContinue)
    $groupRules = @(Get-NetFirewallRule -PolicyStore PersistentStore -Group $script:MobileRuleName -ErrorAction SilentlyContinue)
    if (-not $rules.Count -and -not $groupRules.Count) { return $false }
    if ($rules.Count -ne 1 -or $groupRules.Count -ne 1 -or $rules[0].Name -cne $groupRules[0].Name) { throw '专用防火墙名称或组冲突。' }
    $rule = $rules[0]
    if ($rule.Name -cne $Scope.name -or $rule.Group -cne $Scope.group -or [string]$rule.Enabled -ne 'True' -or
        [string]$rule.Direction -ne 'Inbound' -or [string]$rule.Action -ne 'Allow' -or
        [string]$rule.Profile -cne $Scope.profile -or [string]$rule.EdgeTraversalPolicy -ne 'Block') { throw '专用防火墙规则属性不匹配。' }
    $address = @($rule | Get-NetFirewallAddressFilter -ErrorAction Stop)
    $port = @($rule | Get-NetFirewallPortFilter -ErrorAction Stop)
    $application = @($rule | Get-NetFirewallApplicationFilter -ErrorAction Stop)
    $interface = @($rule | Get-NetFirewallInterfaceFilter -ErrorAction Stop)
    $service = @($rule | Get-NetFirewallServiceFilter -ErrorAction Stop)
    $interfaceType = @($rule | Get-NetFirewallInterfaceTypeFilter -ErrorAction Stop)
    $security = @($rule | Get-NetFirewallSecurityFilter -ErrorAction Stop)
    if ($address.Count -ne 1 -or @($address[0].LocalAddress).Count -ne 1 -or @($address[0].RemoteAddress).Count -ne 1 -or
        [string]$address[0].LocalAddress -cne $Scope.bindAddress -or [string]$address[0].RemoteAddress -cne $Scope.phoneAddress -or
        $port.Count -ne 1 -or [string]$port[0].Protocol -notin @('TCP', '6') -or
        (@($port[0].LocalPort | Sort-Object) -join ',') -cne (@($Scope.ports | ForEach-Object { [string]$_ } | Sort-Object) -join ',') -or
        [string]$port[0].RemotePort -ne 'Any' -or [string]$port[0].IcmpType -ne 'Any' -or [string]$port[0].DynamicTarget -ne 'Any' -or
        $application.Count -ne 1 -or -not (Test-MobilePathEqual ([string]$application[0].Program) ([string]$Scope.executable)) -or [string]$application[0].Package -notin @('', 'Any') -or
        $interface.Count -ne 1 -or @($interface[0].InterfaceAlias).Count -ne 1 -or [string]$interface[0].InterfaceAlias -cne $Scope.interfaceAlias -or
        $service.Count -ne 1 -or [string]$service[0].Service -ne 'Any' -or
        $interfaceType.Count -ne 1 -or [string]$interfaceType[0].InterfaceType -ne 'Any' -or
        $security.Count -ne 1 -or [string]$security[0].Authentication -ne 'NotRequired' -or [string]$security[0].Encryption -ne 'NotRequired' -or
        [string]$security[0].OverrideBlockRules -ne 'False' -or [string]$security[0].LocalUser -ne 'Any' -or
        [string]$security[0].RemoteUser -ne 'Any' -or [string]$security[0].RemoteMachine -ne 'Any') {
        throw '专用防火墙过滤器不匹配，未复用或删除规则。'
    }
    return $true
}

function Test-MobileAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try { return (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
    finally { $identity.Dispose() }
}

function Test-MobileUpstream {
    try {
        $upstreamHomeResponse = Invoke-WebRequest -Uri 'http://127.0.0.1:5173/' -UseBasicParsing -TimeoutSec 3 -MaximumRedirection 0
        $health = Invoke-WebRequest -Uri 'http://127.0.0.1:5173/api/health' -UseBasicParsing -TimeoutSec 3 -MaximumRedirection 0
        $content = if ($health.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($health.Content) } else { [string]$health.Content }
        return $upstreamHomeResponse.StatusCode -eq 200 -and $health.StatusCode -eq 200 -and ($content | ConvertFrom-Json).status -ceq 'UP'
    } catch { return $false }
}

function Invoke-MobileNode([string]$Operation, [string]$Path, [string]$Executable) {
    # Native stderr is captured without printing raw exceptions or secret-bearing data.
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $Executable $script:MobileScript $Operation --config $Path 2>&1)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
    if ($code -ne 0) { throw (Get-MobileNodeFailureMessage $Operation ($output -join [Environment]::NewLine)) }
    $result = ($output -join [Environment]::NewLine) | ConvertFrom-Json
    if ($result.ok -ne $true) { throw "移动 HTTPS $Operation 未返回成功。" }
    return $result
}

function Get-MobileNodeFailureMessage([string]$Operation, [string]$Output) {
    $code = 'MOBILE_HTTPS_FAILED'
    if ($Output.Length -le 8192) {
        try {
            $failure = $Output | ConvertFrom-Json
            if ($failure.ok -eq $false -and [string]$failure.error -cmatch '^(?:CONFIG|CERTIFICATE|CA|CLI|USAGE|PROBE)_[A-Z_]+$') { $code = [string]$failure.error }
        } catch { }
    }
    $reason = switch -Regex ($code) {
        '^(CERTIFICATE|CA)_EXPIRED$' { '证书已过期，请重新生成证书后启动'; break }
        '^(CERTIFICATE|CA)_NOT_YET_VALID$' { '证书尚未生效，请检查电脑时间和证书'; break }
        '^CERTIFICATE_IP_MISMATCH$' { '证书不包含配置的电脑 IP，请重新生成匹配证书'; break }
        '^CERTIFICATE_(PRIVATE_KEY|CA)_MISMATCH$' { '证书、私钥或 CA 不匹配'; break }
        'FILE_UNAVAILABLE|FILE_INVALID|INVALID_JSON' { '配置或证书文件缺失、不可读或格式错误'; break }
        '^CONFIG_' { '配置字段、地址、端口或私有文件路径不符合本地约束'; break }
        '^(CERTIFICATE|CA)_' { '证书或私钥校验失败'; break }
        '^PROBE_' { '可信 TLS、专用监听或电脑上游健康检查失败'; break }
        default { '移动 HTTPS 校验失败，请检查本地配置' }
    }
    return "移动 HTTPS $Operation 失败：$reason ($code)。"
}

function Get-MobileCertificateFingerprints($Config) {
    return [pscustomobject]@{ certificate = (Get-FileHash -LiteralPath $Config.certificateFile -Algorithm SHA256).Hash
        privateKey = (Get-FileHash -LiteralPath $Config.privateKeyFile -Algorithm SHA256).Hash
        ca = (Get-FileHash -LiteralPath $Config.caFile -Algorithm SHA256).Hash }
}

function Start-MobileProcess([string]$Mode, $State) {
    $saved = @{}
    foreach ($name in @('AMAP_WEB_SERVICE_KEY', 'AMAP_JS_KEY', 'AMAP_JS_SECURITY_CODE')) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    try {
        $arguments = '"' + $script:MobileScript + '" serve --config "' + $State.configPath + '" --mode ' + $Mode
        $process = Start-Process -FilePath $State.firewall.executable -ArgumentList $arguments -WorkingDirectory $script:MobileRoot -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $script:MobileRuntime ($Mode + '.out.log')) -RedirectStandardError (Join-Path $script:MobileRuntime ($Mode + '.err.log'))
    } finally { foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') } }
    $entry = [pscustomobject]@{ mode = $Mode; executable = [string]$State.firewall.executable; script = $script:MobileScript
        config = [string]$State.configPath; PID = $process.Id; creationTimeUtc = $process.StartTime.ToUniversalTime().ToString('o')
        bindAddress = [string]$State.snapshot.bindAddress; port = $(if ($Mode -ceq 'https') { [int]$State.snapshot.httpsPort } else { [int]$State.snapshot.certificatePort }) }
    $State.services = @($State.services) + @($entry)
    try {
        $identity = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $process.Id) -ErrorAction Stop
        if (-not $identity) { throw '移动 HTTPS 子进程在就绪前退出。' }
        # CIM CreationDate is used for both recording and verification (same precision).
        $entry.creationTimeUtc = $identity.CreationDate.ToUniversalTime().ToString('o')
        Save-MobileState $State
    } catch {
        $startupError = $_
        $cleaned = $false
        try {
            $condition = Get-MobileProcessState $entry @(Get-MobileListeners)
            if ($condition -ne 'absent') { Stop-Process -Id ([int]$entry.PID) -ErrorAction Stop }
            $deadline = [DateTime]::UtcNow.AddSeconds(3)
            do {
                Start-Sleep -Milliseconds 100
                $condition = Get-MobileProcessState $entry @(Get-MobileListeners)
            } while ($condition -ne 'absent' -and [DateTime]::UtcNow -lt $deadline)
            if ($condition -ne 'absent') { throw '子进程仍存在。' }
            $State.services = @($State.services | Where-Object { [int]$_.PID -ne [int]$entry.PID })
            $cleaned = $true
            Save-MobileState $State
        } catch {
            if (-not $cleaned) {
                # Never lose the new handle silently when the primary atomic write fails.
                $emergency = Join-Path $script:MobileRuntime ('emergency-process-' + [Guid]::NewGuid().ToString('N') + '.json')
                try {
                    [IO.File]::WriteAllText($emergency, ($entry | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($true)))
                    Write-Warning "本次新 PID $($entry.PID) 无法安全收尾；应急归属记录：$emergency。请人工核实，禁止盲删。"
                } catch { Write-Warning "本次新 PID $($entry.PID) 无法安全收尾且记录写入失败；模式 $Mode，配置 $($State.configPath)，请人工核实。" }
            }
        }
        throw $startupError
    }
    return $entry
}

function Stop-MobileManaged($State) {
    $listeners = @(Get-MobileListeners)
    foreach ($entry in @($State.services)) { Get-MobileProcessState $entry $listeners | Out-Null }
    foreach ($port in @($State.firewall.ports)) {
        $owners = @($State.services | Where-Object { [int]$_.port -eq [int]$port } | ForEach-Object { [int]$_.PID })
        if (@($listeners | Where-Object { [int]$_.LocalPort -eq [int]$port -and [int]$_.OwningProcess -notin $owners }).Count) { throw '停止预检发现外来端口进程，未停止任何进程。' }
    }
    $hasRule = Assert-MobileFirewall $State.firewall
    if ($hasRule -and -not (Test-MobileAdministrator)) { throw '停止需要管理员权限以移除已核实的专用防火墙规则。' }
    foreach ($entry in @($State.services)) {
        # Recheck immediately before each mutation; any failure leaves the record.
        $condition = Get-MobileProcessState $entry @(Get-MobileListeners)
        if ($condition -ne 'absent') {
            Stop-Process -Id ([int]$entry.PID) -ErrorAction Stop
            $deadline = [DateTime]::UtcNow.AddSeconds(5)
            do {
                Start-Sleep -Milliseconds 100
                $condition = Get-MobileProcessState $entry @(Get-MobileListeners)
            } while ($condition -ne 'absent' -and [DateTime]::UtcNow -lt $deadline)
            if ($condition -ne 'absent') { throw '子进程尚未完全退出；保留记录，未移除防火墙规则。' }
        }
    }
    if ($hasRule) {
        Assert-MobileFirewall $State.firewall | Out-Null
        Remove-NetFirewallRule -PolicyStore PersistentStore -Name $script:MobileRuleName -ErrorAction Stop
        if (Assert-MobileFirewall $State.firewall) { throw '专用防火墙规则仍存在，保留托管记录。' }
    }
    Backup-MobileState 'stopped'
    Remove-Item -LiteralPath $script:MobileStatePath
}

function Show-MobileStatus([string]$Path) {
    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object {
        $_.AddressState -eq 'Preferred' -and (Test-MobilePrivateIpv4 ([Net.IPAddress]::Parse($_.IPAddress)))
    } | ForEach-Object { $_.IPAddress })
    Write-Output ('电脑当前局域网 IPv4：' + ($addresses -join ', '))
    $state = Read-MobileState
    if ($state) {
        Write-Output "托管绑定：$($state.snapshot.bindAddress)；手机允许地址：$($state.snapshot.phoneAddress)"
        Write-Output "原配置：$($state.configPath)"
        if (-not (Test-MobilePathEqual $Path $state.configPath)) { Write-Output '配置路径已变化；请先指定原配置路径 Stop。' }
        elseif (-not (Test-Path -LiteralPath $Path) -or (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -cne $state.configSha256) { Write-Output '配置内容已变化；先以原配置路径 Stop，再 Start。' }
        if ($state.snapshot.bindAddress -notin $addresses) { Write-Output '原绑定 IP 已离开电脑网卡，需要更新 IP 及证书。' }
        Write-Output "证书有效至：$($state.snapshot.certificateValidUntil)"
        if ([DateTimeOffset]::Parse([string]$state.snapshot.certificateValidUntil) -le [DateTimeOffset]::UtcNow) { Write-Output '证书已过期，需要重新生成后启动。' }
        $listeners = @(Get-MobileListeners)
        foreach ($entry in @($state.services)) {
            try { $condition = Get-MobileProcessState $entry $listeners; Write-Output "$($entry.mode) : $condition (PID $($entry.PID), $($entry.bindAddress):$($entry.port))" }
            catch { Write-Output "$($entry.mode) : 归属校验失败，禁止自动操作。" }
        }
        try { $present = Assert-MobileFirewall $state.firewall; Write-Output "精确手机防火墙规则存在：$present" }
        catch { Write-Output '专用防火墙规则不匹配，需要人工检查；未修改规则。' }
    } else { Write-Output '没有新的托管移动 HTTPS 状态。' }
    if (Test-Path -LiteralPath $Path) {
        try {
            $node = (Get-Command node.exe -ErrorAction Stop).Source
            $config = Invoke-MobileNode 'validate' $Path $node
            Write-Output "配置：$($config.bindAddress)；手机允许地址：$($config.phoneAddress)；证书至 $($config.certificateValidUntil)"
        } catch { Write-Output $_.Exception.Message }
    } else { Write-Output '移动 HTTPS 配置不存在。' }
    Write-Output ('电脑上游健康：' + (Test-MobileUpstream))
    Write-Output '手机需与允许地址一致并信任本地 CA；独立 HTTPS 来源需要重新登录。创建或移除规则需要管理员权限。'
}

function Invoke-MobileLifecycle([string]$RequestedAction, [string]$RequestedPath) {
    $path = Get-MobileAbsolutePath $RequestedPath
    if ($path.Contains('"') -or $path -match '[\r\n]') { throw '配置路径包含不支持的字符。' }
    if ($RequestedAction -eq 'Status') { Show-MobileStatus $path; return }
    New-Item -ItemType Directory -Path $script:MobileRuntime -Force | Out-Null
    $lock = [IO.File]::Open((Join-Path $script:MobileRuntime 'managed-processes.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $state = Read-MobileState
        if ($state -and -not (Test-MobilePathEqual $path $state.configPath)) { throw '配置路径变化；请先指定原配置路径 Stop。' }
        if ($RequestedAction -eq 'Stop') {
            if (-not $state) { Write-Output '没有托管移动 HTTPS 服务，无需停止。'; return }
            Stop-MobileManaged $state
            Write-Output '已停止核实的移动 HTTPS 服务及专用防火墙规则；保留证书和配置。'
            return
        }
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        $config = Invoke-MobileNode 'validate' $path $node
        $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        $fingerprints = Get-MobileCertificateFingerprints $config
        if ($state -and $state.configSha256 -cne $hash) { throw '配置内容变化；请先以原配置路径 Stop，再启动新配置。' }
        if ($state -and ($state.certificateFingerprints | ConvertTo-Json -Compress) -cne ($fingerprints | ConvertTo-Json -Compress)) { throw '证书、私钥或 CA 内容变化；请先 Stop，再 Start 加载新证书。' }
        $scope = Get-MobileNetworkScope $config $node
        if ($state -and ($state.firewall | ConvertTo-Json -Compress) -cne ($scope | ConvertTo-Json -Compress)) { throw '网卡、网络配置或 Node 路径变化；请先 Stop。' }
        if (-not (Test-MobileUpstream)) { throw '电脑服务未就绪（5173 首页及 /api/health）；请先启动电脑演示。' }
        $listeners = @(Get-MobileListeners)
        $alive = @()
        foreach ($entry in @($state.services)) {
            if ($null -eq $entry) { continue }
            $condition = Get-MobileProcessState $entry $listeners
            if ($condition -eq 'starting') { throw '已记录进程存在但监听未就绪；先检查日志或 Stop。' }
            if ($condition -eq 'listening') { $alive += $entry }
        }
        foreach ($port in @($scope.ports)) {
            $owners = @($alive | Where-Object { [int]$_.port -eq [int]$port } | ForEach-Object { [int]$_.PID })
            if (@($listeners | Where-Object { [int]$_.LocalPort -eq [int]$port -and [int]$_.OwningProcess -notin $owners }).Count) { throw '移动 HTTPS 所需端口已占用，未操作外来进程。' }
        }
        $hasRule = Assert-MobileFirewall $scope
        if (-not $hasRule -and -not (Test-MobileAdministrator)) { throw '需要管理员 PowerShell 创建仅允许指定手机的精确防火墙规则。' }
        if (-not $state) {
            if ($hasRule) { throw '发现无托管状态的专用规则；请人工核实，拒绝认领。' }
            $state = [pscustomobject]@{ schemaVersion = 1; configPath = $path; configSha256 = $hash; certificateFingerprints = $fingerprints; firewall = $scope; services = @()
                snapshot = [pscustomobject]@{ bindAddress = $config.bindAddress; phoneAddress = $config.phoneAddress; httpsPort = $config.httpsPort
                    certificatePort = $config.certificatePort; certificateValidUntil = $config.certificateValidUntil } }
            Save-MobileState $state
        } elseif ($alive.Count -ne @($state.services).Count) {
            Backup-MobileState 'stale'
            $state.services = @($alive)
            Save-MobileState $state
        }
        try {
            if (-not $hasRule) {
                New-NetFirewallRule -PolicyStore PersistentStore -Name $scope.name -DisplayName $scope.name -Group $scope.group -Enabled True -Direction Inbound -Action Allow `
                    -Protocol TCP -LocalPort $scope.ports -RemotePort Any -LocalAddress $scope.bindAddress -RemoteAddress $scope.phoneAddress `
                    -Program $scope.executable -InterfaceAlias $scope.interfaceAlias -Profile $scope.profile -EdgeTraversalPolicy Block -ErrorAction Stop | Out-Null
                if (-not (Assert-MobileFirewall $scope)) { throw '专用防火墙规则未完成验证。' }
            }
            foreach ($mode in @('https', 'certificate')) {
                if (@($state.services | Where-Object { $_.mode -ceq $mode }).Count) { continue }
                Start-MobileProcess $mode $state | Out-Null
            }
            $ready = $false
            for ($attempt = 0; $attempt -lt 8; $attempt++) {
                try {
                    foreach ($entry in @($state.services)) { if ((Get-MobileProcessState $entry @(Get-MobileListeners)) -ne 'listening') { throw 'not-ready' } }
                    Invoke-MobileNode 'probe' $path $node | Out-Null
                    $ready = $true
                    break
                } catch { if ($attempt -lt 7) { Start-Sleep -Milliseconds 400 } }
            }
            if (-not $ready) { throw '移动 HTTPS 可信 CA 健康探测未通过。' }
            Write-Output "移动 HTTPS 已就绪：https://$($config.bindAddress):$($config.httpsPort)/"
            Write-Output "手机 CA：http://$($config.bindAddress):$($config.certificatePort)/gather-dev-ca.crt"
            Write-Output "仅允许手机 $($config.phoneAddress)；HTTPS 来源需单独登录。"
        } catch {
            # Keep all successfully recorded resources traceable. Never tear down reused resources on a failed retry.
            Write-Warning '启动未完成；请检查托管及可能的应急记录，用 Status 检查并以原配置 Stop。未报告启动成功。'
            throw
        }
    } finally { $lock.Dispose() }
}

# Dot-sourcing exposes deterministic helpers for Windows PowerShell 5.1 tests.
if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-MobileLifecycle $Action $ConfigPath; $global:LASTEXITCODE = 0 }
    catch { $global:LASTEXITCODE = 1; throw }
}
