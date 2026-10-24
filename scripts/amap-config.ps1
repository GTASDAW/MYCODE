function Protect-GatherMapConfig {
    param([Parameter(Mandatory = $true)][string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Map configuration must be a regular file.'
    }
    $self = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetOwner($self)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($self, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
    }
    # Windows PowerShell can inherit PowerShell 7's module search path. Its
    # Security module may then fail to autoload; Desktop has native ACL APIs.
    if ($PSVersionTable.PSEdition -eq 'Desktop') { [IO.File]::SetAccessControl($item.FullName, $acl) }
    else { Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop }
}

function Get-GatherMapConfig {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 4096) {
        throw 'Map configuration must be a small regular file.'
    }
    $acl = if ($PSVersionTable.PSEdition -eq 'Desktop') { [IO.File]::GetAccessControl($item.FullName) }
        else { Get-Acl -LiteralPath $Path -ErrorAction Stop }
    $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
    if (-not $acl.AreAccessRulesProtected) { throw 'Map configuration requires private file permissions.' }
    foreach ($entry in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($entry.AccessControlType -eq 'Allow' -and $entry.IdentityReference.Value -notin $allowed) {
            throw 'Map configuration permissions are too broad.'
        }
    }
    try { $config = [IO.File]::ReadAllText($item.FullName) | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'Map configuration is not valid JSON.' }
    if (-not $config -or @($config.PSObject.Properties.Name).Count -ne 2 -or
        @($config.PSObject.Properties.Name | Where-Object { $_ -notin @('jsKey', 'securityJsCode') }).Count -ne 0) {
        throw 'Map configuration requires jsKey and securityJsCode only.'
    }
    foreach ($name in @('jsKey', 'securityJsCode')) {
        $value = $config.$name
        if ($value -isnot [string] -or ($value -ne '' -and $value -notmatch '^[A-Za-z0-9_-]{1,128}$')) {
            throw 'Map configuration contains an invalid value.'
        }
    }
    return @{ jsKey = $config.jsKey; securityJsCode = $config.securityJsCode }
}
