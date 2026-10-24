$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'amap-config.ps1')
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    # Reproduce the unavailable Security module without depending on the host's
    # PSModulePath. Permission protection and validation must still work.
    function Get-Acl { throw 'The Security module is unavailable in this test.' }
    function Set-Acl { throw 'The Security module is unavailable in this test.' }
}
$mapTestRoot = Join-Path (Split-Path -Parent $PSScriptRoot) ('.runtime/activity-map/config-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $mapTestRoot -Force | Out-Null
$mapTestCount = 0
function Assert-ConfigRejected {
    param([string]$Path)
    $rejected = $false
    try { Get-GatherMapConfig -Path $Path | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid map configuration was accepted.' }
}
function Write-ConfigFixture {
    param([string]$Name, [string]$Text)
    $path = Join-Path $mapTestRoot $Name
    New-Item -ItemType File -Path $path | Out-Null
    Protect-GatherMapConfig -Path $path
    [IO.File]::WriteAllText($path, $Text, [Text.UTF8Encoding]::new($false))
    return $path
}
if ($null -ne (Get-GatherMapConfig -Path (Join-Path $mapTestRoot 'absent.json'))) { throw 'Missing configuration must stay disabled.' }
$mapTestCount++
$empty = Write-ConfigFixture 'empty.json' '{"jsKey":"","securityJsCode":""}'
$config = Get-GatherMapConfig -Path $empty
if ($config.jsKey -ne '' -or $config.securityJsCode -ne '') { throw 'Empty configuration changed.' }
$mapTestCount++
$valid = Write-ConfigFixture 'valid.json' '{"jsKey":"public-test-key","securityJsCode":"private-test-code"}'
$config = Get-GatherMapConfig -Path $valid
if ($config.jsKey -ne 'public-test-key' -or $config.securityJsCode -ne 'private-test-code') { throw 'Configuration values changed.' }
$mapTestCount++
foreach ($text in @('{broken', '{}', '{"jsKey":"x","securityJsCode":"y","extra":1}', '{"jsKey":1,"securityJsCode":"y"}', '{"jsKey":"x","securityJsCode":null}', '{"jsKey":"x","securityJsCode":"unsafe&code"}')) {
    $path = Write-ConfigFixture ('invalid-' + $mapTestCount + '.json') $text
    Assert-ConfigRejected -Path $path
    $mapTestCount++
}
$large = Write-ConfigFixture 'large.json' (' ' * 4097)
Assert-ConfigRejected -Path $large
$mapTestCount++
$directory = Join-Path $mapTestRoot 'not-a-file'
New-Item -ItemType Directory -Path $directory | Out-Null
Assert-ConfigRejected -Path $directory
$mapTestCount++
# These fixtures contain only declared fake keys and stay in the ignored runtime directory.
Write-Host "Map local configuration: $mapTestCount checks passed."
