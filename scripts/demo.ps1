[CmdletBinding()]
param(
    [ValidateSet('Start', 'Status', 'Stop')][string]$Action = 'Start',
    [switch]$SkipBuild,
    [switch]$DesktopOnly,
    [string]$MobileConfigPath
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $MobileConfigPath) { $MobileConfigPath = Join-Path $projectRoot '.runtime/mobile-https/config.json' }
elseif (-not [IO.Path]::IsPathRooted($MobileConfigPath)) { $MobileConfigPath = Join-Path $projectRoot $MobileConfigPath }
$MobileConfigPath = [IO.Path]::GetFullPath($MobileConfigPath)
$mobileScript = Join-Path $PSScriptRoot 'mobile-https.ps1'
$mobileStatePath = Join-Path $projectRoot '.runtime/mobile-https/managed-processes.json'

function Test-DemoEndpoint {
    param([string]$Url, [switch]$Health)
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5 -MaximumRedirection 0
        if ($response.StatusCode -ne 200) { return $false }
        $content = if ($response.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($response.Content) } else { [string]$response.Content }
        if ($Health) { return (($content | ConvertFrom-Json).status -eq 'UP') }
        return $content.Contains('id="root"')
    } catch { return $false }
}

function Show-DesktopStatus {
    $frontendUp = Test-DemoEndpoint -Url 'http://127.0.0.1:5173'
    $backendUp = Test-DemoEndpoint -Url 'http://127.0.0.1:8080/api/health' -Health
    $proxyUp = Test-DemoEndpoint -Url 'http://127.0.0.1:5173/api/health' -Health
    Write-Host ('前端可用: {0}；后端/数据库健康: {1}；接口代理: {2}' -f $frontendUp, $backendUp, $proxyUp)
    if ($frontendUp -and $backendUp -and $proxyUp) {
        Write-Host '电脑入口: http://127.0.0.1:5173'
        return $true
    }
    Write-Warning '电脑服务未就绪，请运行 scripts/demo.ps1；启动失败时查看 .runtime/backend.out.log、backend.err.log 和 frontend.err.log。'
    return $false
}

function Invoke-MobileLifecycle {
    param([string]$MobileAction)
    & $mobileScript -Action $MobileAction -ConfigPath $MobileConfigPath
    if ($LASTEXITCODE -ne 0) { throw '手机HTTPS未就绪，请按上方诊断处理；电脑服务保持运行。' }
}

Push-Location $projectRoot
try {
    switch ($Action) {
        'Start' {
            & (Join-Path $PSScriptRoot 'start-dev.ps1') -SkipBuild:$SkipBuild
            if (-not (Show-DesktopStatus)) { throw '电脑服务健康检查未通过。' }
            if ($DesktopOnly) {
                Write-Host '已选择仅电脑，手机HTTPS保持原状。'
            } elseif (Test-Path -LiteralPath $MobileConfigPath -PathType Leaf) {
                Invoke-MobileLifecycle -MobileAction 'Start'
            } elseif (Test-Path -LiteralPath $mobileStatePath) {
                throw '存在手机托管记录，但私有配置缺失。请恢复原配置，并运行 scripts/mobile-https.ps1 -Action Status 查看。'
            } else {
                Write-Host '电脑已就绪；手机HTTPS尚未配置。'
                Write-Host '复制 scripts/mobile-https.config.example.json 到 .runtime/mobile-https/config.json，按 docs/local-demo.md 填写。'
            }
            Write-Host '后端重启后需要重新登录。查看状态: scripts/demo.ps1 -Action Status'
        }
        'Status' {
            $desktopReady = Show-DesktopStatus
            if (-not $DesktopOnly -and ((Test-Path -LiteralPath $MobileConfigPath) -or (Test-Path -LiteralPath $mobileStatePath))) {
                Invoke-MobileLifecycle -MobileAction 'Status'
            } elseif (-not $DesktopOnly) {
                Write-Host '手机HTTPS尚未配置，见 docs/local-demo.md。'
            }
            if (-not $desktopReady) { throw '电脑服务健康检查未通过。' }
        }
        'Stop' {
            if (-not $DesktopOnly -and (Test-Path -LiteralPath $mobileStatePath)) { Invoke-MobileLifecycle -MobileAction 'Stop' }
            & (Join-Path $PSScriptRoot 'stop-dev.ps1')
        }
    }
} finally { Pop-Location }
