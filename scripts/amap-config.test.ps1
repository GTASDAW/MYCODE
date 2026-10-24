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
if ($config.jsKey -ne '' -or $config.securityJsCode -ne '' -or $config.webServiceKey -ne '') { throw 'Empty configuration changed.' }
$mapTestCount++
$valid = Write-ConfigFixture 'valid.json' '{"jsKey":"public-test-key","securityJsCode":"private-test-code"}'
$config = Get-GatherMapConfig -Path $valid
if ($config.jsKey -ne 'public-test-key' -or $config.securityJsCode -ne 'private-test-code' -or $config.webServiceKey -ne '') { throw 'Configuration values changed.' }
$mapTestCount++
$triple = Write-ConfigFixture 'triple.json' '{"jsKey":"x","securityJsCode":"y","webServiceKey":"server-test-key"}'
$config = Get-GatherMapConfig -Path $triple
if ($config.webServiceKey -ne 'server-test-key' -or $config.jsKey -ne 'x' -or $config.securityJsCode -ne 'y') { throw 'Web Service configuration changed.' }
$mapTestCount++
$blank = Write-ConfigFixture 'blank-web.json' '{"jsKey":"x","securityJsCode":"y","webServiceKey":""}'
if ((Get-GatherMapConfig -Path $blank).webServiceKey -ne '') { throw 'Optional Web Service key must stay disabled.' }
$mapTestCount++
Initialize-GatherMapConfig -Path $valid
$config = Get-GatherMapConfig -Path $valid
if ($config.jsKey -ne 'public-test-key' -or $config.securityJsCode -ne 'private-test-code' -or $config.webServiceKey -ne '' -or
    'webServiceKey' -notin @(([IO.File]::ReadAllText($valid) | ConvertFrom-Json).PSObject.Properties.Name)) { throw 'Legacy upgrade did not preserve the JS pair.' }
$mapTestCount++
$tripleText = [IO.File]::ReadAllText($triple)
Initialize-GatherMapConfig -Path $triple
if ([IO.File]::ReadAllText($triple) -cne $tripleText) { throw 'Existing three-field configuration was rewritten.' }
$mapTestCount++
$fresh = Join-Path $mapTestRoot 'fresh.json'
Initialize-GatherMapConfig -Path $fresh
$config = Get-GatherMapConfig -Path $fresh
if ($config.jsKey -ne '' -or $config.securityJsCode -ne '' -or $config.webServiceKey -ne '') { throw 'Fresh configuration must be blank.' }
$mapTestCount++
foreach ($text in @('{broken', '{}', '{"jsKey":"x","securityJsCode":"y","extra":1}', '{"jsKey":1,"securityJsCode":"y"}', '{"jsKey":"x","securityJsCode":null}', '{"jsKey":"x","securityJsCode":"unsafe&code"}', '{"jsKey":"x","securityJsCode":"y","webServiceKey":null}', '{"jsKey":"x","securityJsCode":"y","webServiceKey":1}', '{"jsKey":"x","securityJsCode":"y","webServiceKey":"unsafe&key"}', '{"jsKey":"x","securityJsCode":"y","webServiceKey":"z","extra":1}')) {
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
