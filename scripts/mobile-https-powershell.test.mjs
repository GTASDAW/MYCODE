import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'scripts', 'mobile-https.ps1');
const quote = value => `'${value.replaceAll("'", "''")}'`;

test('firewall accepts unpackaged Win32 defaults and rejects package or security scope changes', {
  skip: process.platform !== 'win32' && 'Windows PowerShell 5.1 is required',
}, () => {
  const command = `
$ErrorActionPreference = 'Stop'
. ${quote(source)} -ConfigPath ${quote(join(root, '.runtime', 'mobile-https', 'config.json'))}
$script:Scope = [pscustomobject]@{name='Gather-Mobile-HTTPS-Managed';group='Gather-Mobile-HTTPS-Managed';executable='E:\\node.js\\node.exe';bindAddress='192.168.31.35';phoneAddress='192.168.34.13';ports=@(8443,8444);interfaceAlias='Ethernet';profile='Private'}
$script:Package = ''
$script:LocalUser = 'Any'
$script:DynamicTarget = 'Any'
function Get-NetFirewallRule { param($PolicyStore,$Name,$Group,$ErrorAction); [pscustomobject]@{Name='Gather-Mobile-HTTPS-Managed';Group='Gather-Mobile-HTTPS-Managed';Enabled='True';Direction='Inbound';Action='Allow';Profile='Private';EdgeTraversalPolicy='Block'} }
function Get-NetFirewallAddressFilter { param([Parameter(ValueFromPipeline=$true)]$Rule); process { [pscustomobject]@{LocalAddress=@('192.168.31.35');RemoteAddress=@('192.168.34.13')} } }
function Get-NetFirewallPortFilter { param([Parameter(ValueFromPipeline=$true)]$Rule); process { [pscustomobject]@{Protocol='TCP';LocalPort=@('8443','8444');RemotePort='Any';IcmpType='Any';DynamicTarget=$script:DynamicTarget} } }
function Get-NetFirewallApplicationFilter { param([Parameter(ValueFromPipeline=$true)]$Rule); process { [pscustomobject]@{Program=$script:Scope.executable;Package=$script:Package} } }
function Get-NetFirewallInterfaceFilter { param([Parameter(ValueFromPipeline=$true)]$Rule); process { [pscustomobject]@{InterfaceAlias='Ethernet'} } }
function Get-NetFirewallServiceFilter { param([Parameter(ValueFromPipeline=$true)]$Rule); process { [pscustomobject]@{Service='Any'} } }
function Get-NetFirewallInterfaceTypeFilter { param([Parameter(ValueFromPipeline=$true)]$Rule); process { [pscustomobject]@{InterfaceType='Any'} } }
function Get-NetFirewallSecurityFilter { param([Parameter(ValueFromPipeline=$true)]$Rule); process { [pscustomobject]@{Authentication='NotRequired';Encryption='NotRequired';OverrideBlockRules='False';LocalUser=$script:LocalUser;RemoteUser='Any';RemoteMachine='Any'} } }
foreach ($package in @('', $null, 'Any')) {
  $script:Package = $package
  if (-not (Assert-MobileFirewall $script:Scope)) { throw 'Unpackaged Win32 rule was rejected.' }
}
function Expect-FirewallRejected {
  $rejected = $false
  try { Assert-MobileFirewall $script:Scope | Out-Null } catch { $rejected = $true }
  if (-not $rejected) { throw 'Changed firewall scope was accepted.' }
}
$script:Package = 'specific-appx-package'
Expect-FirewallRejected
$script:Package = ''
$script:LocalUser = 'D:(A;;CC;;;S-1-1-0)'
Expect-FirewallRejected
$script:LocalUser = 'Any'
$script:DynamicTarget = 'ProximityApps'
Expect-FirewallRejected
Write-Output 'firewall-win32-regression=passed'
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /firewall-win32-regression=passed/);
});

test('upstream health executes under Windows PowerShell with byte-array JSON and protected host variables', {
  skip: process.platform !== 'win32' && 'Windows PowerShell 5.1 is required',
}, () => {
  const command = `
$ErrorActionPreference = 'Stop'
. ${quote(source)} -ConfigPath ${quote(join(root, '.runtime', 'mobile-https', 'config.json'))}
$originalHome = $HOME
function Invoke-WebRequest {
  param($Uri,[switch]$UseBasicParsing,$TimeoutSec,$MaximumRedirection)
  if ($Uri -ceq 'http://127.0.0.1:5173/') { return [pscustomobject]@{StatusCode=200;Content='<html></html>'} }
  if ($Uri -ceq 'http://127.0.0.1:5173/api/health') { return [pscustomobject]@{StatusCode=200;Content=[Text.Encoding]::UTF8.GetBytes('{"status":"UP"}')} }
  throw 'Unexpected upstream address.'
}
if (-not (Test-MobileUpstream)) { throw 'Ready byte-array health response was rejected.' }
if ($HOME -cne $originalHome) { throw 'Protected HOME variable changed.' }
Write-Output 'upstream-runtime-regression=passed'
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /upstream-runtime-regression=passed/);
  assert.doesNotMatch(readFileSync(source, 'utf8'), /\$(?:home|codex_home)\s*=/i);
});

test('mobile lifecycle remains Windows PowerShell 5.1 compatible and fail closed with injected host facts', {
  skip: process.platform !== 'win32' && 'Windows PowerShell 5.1 is required',
}, () => {
  const temporary = mkdtempSync(join(root, '.runtime', 'mobile-lifecycle-test-'));
  try {
    const bytes = readFileSync(source);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'Chinese Windows PowerShell source requires UTF-8 BOM');
    const fixture = join(temporary, 'test.ps1');
    const script = `
$ErrorActionPreference = 'Stop'
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile(${quote(source)}, [ref]$null, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
. ${quote(source)}
$script:MobileRuntime = ${quote(temporary)}
$script:MobileStatePath = Join-Path $script:MobileRuntime 'managed-processes.json'
$script:Checks = 0
function Check($Actual, $Expected, $Message) {
    if ($Actual -cne $Expected) { throw $Message }
    $script:Checks++
}
function Reject([scriptblock]$Run, [string]$Message) {
    $failed = $false
    try { & $Run | Out-Null } catch { $failed = $true }
    if (-not $failed) { throw $Message }
    $script:Checks++
}
$script:Scope = [pscustomobject]@{ name='Gather-Mobile-HTTPS-Managed'; group='Gather-Mobile-HTTPS-Managed'; executable='C:\\Program Files\\nodejs\\node.exe'; bindAddress='192.168.31.35'; phoneAddress='192.168.34.13'; ports=@(8443,8444); interfaceAlias='Wi-Fi'; profile='Private' }
$script:State = [pscustomobject]@{ schemaVersion=1; configPath='E:\\private mobile\\config.json'; configSha256=('A' * 64); firewall=$script:Scope; services=@(); snapshot=[pscustomobject]@{bindAddress='192.168.31.35'; phoneAddress='192.168.34.13'; httpsPort=8443; certificatePort=8444; certificateValidUntil='2030-01-01T00:00:00Z'} }
$script:Entry = [pscustomobject]@{ mode='https'; executable=$script:Scope.executable; script=$script:MobileScript; config=$script:State.configPath; PID=12345; creationTimeUtc='2026-11-07T00:00:00.1234560Z'; bindAddress='192.168.31.35'; port=8443 }
$script:State.services = @($script:Entry)
$script:Process = [pscustomobject]@{ ExecutablePath=$script:Entry.executable; CommandLine=('"' + $script:Entry.executable + '" "' + $script:Entry.script + '" serve --config "' + $script:Entry.config + '" --mode https'); CreationDate=[DateTime]::Parse($script:Entry.creationTimeUtc).ToUniversalTime() }
$script:Listener = [pscustomobject]@{ LocalAddress='192.168.31.35'; LocalPort=8443; OwningProcess=12345 }
function Get-CimInstance { param($ClassName,$Filter,$ErrorAction); return $script:Process }
Assert-MobileFirewallScope $script:Scope
Check ((ConvertFrom-MobileCommandLine $script:Process.CommandLine).Count) 7 'Complete quoted argv was not preserved.'
Check (Get-MobileProcessState $script:Entry @($script:Listener)) 'listening' 'Expected owner rejected.'
$savedCommand = $script:Process.CommandLine
$script:Process.CommandLine += ' --extra'
Reject { Get-MobileProcessState $script:Entry @($script:Listener) } 'Additional argument was accepted.'
$script:Process.CommandLine = $savedCommand.Replace(' --mode https', ' --mode certificate')
Reject { Get-MobileProcessState $script:Entry @($script:Listener) } 'Wrong mode was accepted.'
$script:Process.CommandLine = $savedCommand.Replace('config.json', 'config.json.bak')
Reject { Get-MobileProcessState $script:Entry @($script:Listener) } 'Lookalike config was accepted.'
$script:Process.CommandLine = $savedCommand
$script:Process.CreationDate = $script:Process.CreationDate.AddTicks(10)
Reject { Get-MobileProcessState $script:Entry @($script:Listener) } 'Reused PID creation time was accepted.'
$script:Process.CreationDate = [DateTime]::Parse($script:Entry.creationTimeUtc).ToUniversalTime()
$script:Listener.LocalAddress = '0.0.0.0'
Reject { Get-MobileProcessState $script:Entry @($script:Listener) } 'Wildcard listener was accepted.'
$script:Listener.LocalAddress = '192.168.31.35'
$script:Listener.OwningProcess = 54321
Reject { Get-MobileProcessState $script:Entry @($script:Listener) } 'Foreign port owner was accepted.'
$script:Listener.OwningProcess = 12345
$script:SavedProcess = $script:Process
$script:Process = $null
Reject { Get-MobileProcessState $script:Entry @($script:Listener) } 'Absent PID with foreign listener was accepted.'
Check (Get-MobileProcessState $script:Entry @()) 'absent' 'Stale record did not remain identifiable.'
$script:Process = $script:SavedProcess
Check (Get-MobileProcessState $script:Entry @()) 'starting' 'Owned nonlistener could not be traced.'
$script:Scope.phoneAddress = 'Any'
Reject { Assert-MobileFirewallScope $script:Scope } 'Broad phone scope accepted.'
$script:Scope.phoneAddress = '192.168.34.13'
$script:Scope.phoneAddress = '8.8.8.8'
Reject { Assert-MobileFirewallScope $script:Scope } 'Public IP accepted.'
$script:Scope.phoneAddress = '192.168.34.13'
$script:Scope.ports = @(5173,8444)
Reject { Assert-MobileFirewallScope $script:Scope } 'PC service port accepted.'
$script:Scope.ports = @(443,8444)
Reject { Assert-MobileFirewallScope $script:Scope } 'Privileged port accepted.'
$script:Scope.ports = @(8443,8444)
$script:Scope.phoneAddress = $script:Scope.bindAddress
Reject { Assert-MobileFirewallScope $script:Scope } 'Phone and PC same address accepted.'
$script:Scope.phoneAddress = '192.168.34.13'
$script:Scope.interfaceAlias = '*'
Reject { Assert-MobileFirewallScope $script:Scope } 'Wildcard interface accepted.'
$script:Scope.interfaceAlias = 'Wi-Fi'
Save-MobileState $script:State
Check (Read-MobileState).services.Count 1 'Atomic state roundtrip failed.'
$script:State.services = @($script:Entry, $script:Entry)
Save-MobileState $script:State
Reject { Read-MobileState } 'Duplicate state record accepted.'
$script:State.services = @($script:Entry)
Save-MobileState $script:State
Check (@(Get-ChildItem -LiteralPath $script:MobileRuntime -Filter '*.tmp').Count) 0 'Atomic temporary file leaked.'

# Inject all firewall filters; no OS firewall or process mutation occurs.
$script:Rule = [pscustomobject]@{Name='Gather-Mobile-HTTPS-Managed';Group='Gather-Mobile-HTTPS-Managed';Enabled='True';Direction='Inbound';Action='Allow';Profile='Private';EdgeTraversalPolicy='Block'}
$script:Address = [pscustomobject]@{LocalAddress=@('192.168.31.35');RemoteAddress=@('192.168.34.13')}
$script:Port = [pscustomobject]@{Protocol='TCP';LocalPort=@('8443','8444');RemotePort='Any';IcmpType='Any';DynamicTarget='Any'}
function Get-NetFirewallRule { param($PolicyStore,$Name,$Group,$ErrorAction); return $script:Rule }
function Get-NetFirewallAddressFilter { param([Parameter(ValueFromPipeline=$true)]$Rule); process { $script:Address } }
function Get-NetFirewallPortFilter { param([Parameter(ValueFromPipeline=$true)]$Rule); process { $script:Port } }
function Get-NetFirewallApplicationFilter { param([Parameter(ValueFromPipeline=$true)]$Rule); process { [pscustomobject]@{Program=$script:Scope.executable;Package='Any'} } }
function Get-NetFirewallInterfaceFilter { param([Parameter(ValueFromPipeline=$true)]$Rule); process { [pscustomobject]@{InterfaceAlias='Wi-Fi'} } }
function Get-NetFirewallServiceFilter { param([Parameter(ValueFromPipeline=$true)]$Rule); process { [pscustomobject]@{Service='Any'} } }
function Get-NetFirewallInterfaceTypeFilter { param([Parameter(ValueFromPipeline=$true)]$Rule); process { [pscustomobject]@{InterfaceType='Any'} } }
function Get-NetFirewallSecurityFilter { param([Parameter(ValueFromPipeline=$true)]$Rule); process { [pscustomobject]@{Authentication='NotRequired';Encryption='NotRequired';OverrideBlockRules='False';LocalUser='Any';RemoteUser='Any';RemoteMachine='Any'} } }
Check (Assert-MobileFirewall $script:Scope) $true 'Exact firewall rejected.'
$script:Address.RemoteAddress = @('192.168.34.13','192.168.34.14')
Reject { Assert-MobileFirewall $script:Scope } 'Additional remote address accepted.'
$script:Address.RemoteAddress = @('192.168.34.13')
$script:Rule.EdgeTraversalPolicy = 'Allow'
Reject { Assert-MobileFirewall $script:Scope } 'Edge traversal accepted.'
$script:Rule.EdgeTraversalPolicy = 'Block'
$script:Port.LocalPort = @('8443-8444')
Reject { Assert-MobileFirewall $script:Scope } 'Firewall port range accepted.'
$script:Port.LocalPort = @('8443','8444')

# Stop must finish every ownership precheck before the first mutation.
$script:BadEntry = [pscustomobject]@{ mode='certificate'; executable=$script:Entry.executable; script=$script:Entry.script; config=$script:Entry.config; PID=54321; creationTimeUtc=$script:Entry.creationTimeUtc; bindAddress=$script:Entry.bindAddress; port=8444 }
$script:State.services = @($script:Entry, $script:BadEntry)
$script:StopCount = 0
function Stop-Process { param($Id,$ErrorAction); $script:StopCount++; throw 'Never reached.' }
function Get-MobileListeners { return @($script:Listener) }
Reject { Stop-MobileManaged $script:State } 'Stop accepted a mismatched second service.'
Check $script:StopCount 0 'Stop mutated before all prechecks.'
Check ((Get-MobileNodeFailureMessage 'validate' '{"ok":false,"error":"CERTIFICATE_IP_MISMATCH"}').Contains('CERTIFICATE_IP_MISMATCH')) $true 'Safe Node code hidden.'
Check ((Get-MobileNodeFailureMessage 'validate' 'sensitive raw failure').Contains('sensitive')) $false 'Raw stderr leaked.'

# A failed first persistence must stop only the new, fully verified child.
$script:State.services = @()
$script:Process = $script:SavedProcess
$script:StopCount = 0
function Start-Process {
    param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,[switch]$PassThru,$RedirectStandardOutput,$RedirectStandardError)
    foreach ($name in @('AMAP_WEB_SERVICE_KEY','AMAP_JS_KEY','AMAP_JS_SECURITY_CODE')) {
        if ([Environment]::GetEnvironmentVariable($name,'Process')) { throw 'Map key inherited by child.' }
    }
    return [pscustomobject]@{Id=12345;StartTime=$script:Process.CreationDate}
}
function Save-MobileState { param($State); throw 'Injected disk write failure.' }
function Stop-Process { param($Id,$ErrorAction); $script:StopCount++; $script:Process = $null }
function Get-MobileListeners { return @() }
$savedTestKey = [Environment]::GetEnvironmentVariable('AMAP_WEB_SERVICE_KEY','Process')
try {
    [Environment]::SetEnvironmentVariable('AMAP_WEB_SERVICE_KEY','isolated-local-test-key','Process')
    Reject { Start-MobileProcess 'https' $script:State } 'Failed persistence reported success.'
    Check ([Environment]::GetEnvironmentVariable('AMAP_WEB_SERVICE_KEY','Process')) 'isolated-local-test-key' 'Parent map environment was not restored.'
} finally { [Environment]::SetEnvironmentVariable('AMAP_WEB_SERVICE_KEY',$savedTestKey,'Process') }
Check $script:StopCount 1 'Failed persistence left new known child alive.'
Check $script:State.services.Count 0 'Stopped new child remained in memory.'
Write-Output ('mobile-lifecycle-checks=' + $script:Checks)
`;
    writeFileSync(fixture, `\ufeff${script}`, 'utf8');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture], {
      cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /mobile-lifecycle-checks=\d+/);
  } finally {
    // The uniquely created test directory contains only this test's injected state.
    rmSync(temporary, { recursive: true, force: true });
  }
});
