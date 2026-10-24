[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'amap-config.ps1')
$mapProjectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$mapRuntime = Join-Path $mapProjectRoot '.runtime'
if (-not (Test-Path -LiteralPath $mapRuntime)) { New-Item -ItemType Directory -Path $mapRuntime | Out-Null }
$directory = Get-Item -LiteralPath $mapRuntime -Force
if (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The workspace runtime directory must not be a link.'
}
$mapConfigPath = Join-Path $mapRuntime 'amap.json'
$created = -not (Test-Path -LiteralPath $mapConfigPath)
if ($created) { New-Item -ItemType File -Path $mapConfigPath | Out-Null }
Protect-GatherMapConfig -Path $mapConfigPath
if ($created) {
    [IO.File]::WriteAllText($mapConfigPath, "{`n  `"jsKey`": `"`",`n  `"securityJsCode`": `"`"`n}`n", [Text.UTF8Encoding]::new($false))
}
Get-GatherMapConfig -Path $mapConfigPath | Out-Null
Write-Host "Map configuration prepared: $mapConfigPath"
Write-Host 'Edit jsKey and securityJsCode locally, then restart MYCODE. Existing values were preserved.'
