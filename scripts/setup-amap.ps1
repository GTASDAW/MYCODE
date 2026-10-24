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
Initialize-GatherMapConfig -Path $mapConfigPath
Write-Host "Map configuration prepared: $mapConfigPath"
Write-Host 'Edit jsKey/securityJsCode for maps and webServiceKey for nearby check-in, then restart MYCODE. Existing values were preserved.'
