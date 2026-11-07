import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedPath, isPrivateIpv4, normalizeConfig, parseArgs, permitted, REMOVED_DIAGNOSTICS,
  removedDiagnostic, runtimeFile, secureSessionCookie, sourceAddress, upstreamHeaders, verifyCertificatePair } from './mobile-https.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureConfig = () => ({ bindAddress: '192.168.1.10', phoneAddress: '192.168.1.20', httpsPort: 8443, certificatePort: 8444,
  certificateFile: '.runtime/mobile-https/server.pem', privateKeyFile: '.runtime/mobile-https/server-key.pem', caFile: '.runtime/mobile-https/gather-dev-ca.crt' });

test('configuration accepts only single RFC1918 IPv4 literals', () => {
  for (const address of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1']) assert.equal(isPrivateIpv4(address), true);
  for (const address of ['0.0.0.0', '127.0.0.1', '169.254.1.1', '172.15.1.1', '172.32.1.1', '8.8.8.8', '192.168.01.1',
    'localhost', 'phone.local', '192.168.1.1/24', '192.168.1.1,192.168.1.2', ' 192.168.1.1', '192.168.1.1:8443', '::1', '::ffff:192.168.1.1', null]) {
    assert.equal(isPrivateIpv4(address), false, String(address));
  }
  for (const field of ['bindAddress', 'phoneAddress']) assert.throws(() => normalizeConfig({ ...fixtureConfig(), [field]: '0.0.0.0' }), /PRIVATE_IPV4/);
  assert.throws(() => normalizeConfig({ ...fixtureConfig(), phoneAddress: fixtureConfig().bindAddress }), /ADDRESSES_MUST_DIFFER/);
});

test('configuration keeps all fields explicit, resolves paths from repository root, and protects existing ports', () => {
  const raw = fixtureConfig(), config = normalizeConfig(raw);
  assert.equal(config.certificateFile, path.resolve(ROOT, raw.certificateFile));
  assert.equal(config.privateKeyFile, path.resolve(ROOT, raw.privateKeyFile));
  assert.equal(config.caFile, path.resolve(ROOT, raw.caFile));
  assert.deepEqual(normalizeConfig(config), config);
  assert.equal(normalizeConfig({ ...raw, httpsPort: 1024 }).httpsPort, 1024);
  for (const httpsPort of [0, 443, 1023, 65536, 8443.5, '8443', 3307, 5173, 8080, null]) assert.throws(() => normalizeConfig({ ...raw, httpsPort }), /PORT_INVALID/);
  assert.throws(() => normalizeConfig({ ...raw, certificatePort: 8443 }), /PORTS_MUST_DIFFER/);
  assert.throws(() => normalizeConfig({ ...raw, typo: true }), /FIELDS_INVALID/);
  const { caFile, ...missing } = raw;
  assert.throws(() => normalizeConfig(missing), /FIELDS_INVALID/);
  for (const invalid of [null, [], 'config']) assert.throws(() => normalizeConfig(invalid), /FIELDS_INVALID/);
});

test('certificate paths cannot escape runtime or alias another certificate role', () => {
  for (const certificateFile of ['server.pem', '../server.pem', '.runtime/../server.pem', '.runtime-other/server.pem', '.runtime', '']) {
    assert.throws(() => normalizeConfig({ ...fixtureConfig(), certificateFile }), /PATH_INVALID|OUTSIDE_RUNTIME/);
  }
  assert.throws(() => normalizeConfig({ ...fixtureConfig(), caFile: fixtureConfig().certificateFile }), /FILES_MUST_DIFFER/);
  assert.throws(() => normalizeConfig({ ...fixtureConfig(), certificateFile: '.runtime/server.pem\n' }), /PATH_INVALID/);
});

test('certificate files must exist, be bounded ordinary files, and reject symlink/junction paths', t => {
  const logs = path.resolve(ROOT, '.runtime/startup-unified-20261107'); mkdirSync(logs, { recursive: true });
  const root = mkdtempSync(path.join(logs, 'transport-unit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, '.runtime'); mkdirSync(runtime);
  const cert = path.join(runtime, 'public.crt'); writeFileSync(cert, 'public fixture');
  assert.equal(runtimeFile(cert, root), cert);
  assert.throws(() => runtimeFile(path.join(root, 'public.crt'), root), /OUTSIDE_RUNTIME/);
  assert.throws(() => runtimeFile(path.join(runtime, 'missing.crt'), root), /FILE_UNAVAILABLE/);
  assert.throws(() => runtimeFile(runtime, root), /OUTSIDE_RUNTIME/);
  const folder = path.join(runtime, 'folder'); mkdirSync(folder);
  assert.throws(() => runtimeFile(folder, root), /FILE_INVALID/);
  const empty = path.join(runtime, 'empty.crt'); writeFileSync(empty, ''); assert.throws(() => runtimeFile(empty, root), /FILE_INVALID/);
  const large = path.join(runtime, 'large.crt'); writeFileSync(large, Buffer.alloc(65537)); assert.throws(() => runtimeFile(large, root), /FILE_INVALID/);
  const outside = path.join(root, 'outside'); mkdirSync(outside); writeFileSync(path.join(outside, 'public.crt'), 'public fixture');
  const linked = path.join(runtime, 'linked');
  symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => runtimeFile(path.join(linked, 'public.crt'), root), /SYMLINK_FORBIDDEN/);
  const internal = path.join(runtime, 'internal'); symlinkSync(folder, internal, process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(path.join(folder, 'public.crt'), 'public fixture');
  assert.throws(() => runtimeFile(path.join(internal, 'public.crt'), root), /SYMLINK_FORBIDDEN/);
});

test('private JSON configuration follows the same runtime and symlink boundary with its own size limit', t => {
  const logs = path.resolve(ROOT, '.runtime/startup-unified-20261107'); mkdirSync(logs, { recursive: true });
  const root = mkdtempSync(path.join(logs, 'config-unit-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, '.runtime'); mkdirSync(runtime);
  const options = { kind: 'CONFIG', maxBytes: 16 * 1024 };
  const config = path.join(runtime, 'config.json'); writeFileSync(config, '{}');
  assert.equal(runtimeFile(config, root, options), config);
  assert.throws(() => runtimeFile(path.join(root, 'config.json'), root, options), /CONFIG_OUTSIDE_RUNTIME/);
  const large = path.join(runtime, 'large.json'); writeFileSync(large, Buffer.alloc(16385));
  assert.throws(() => runtimeFile(large, root, options), /CONFIG_FILE_INVALID/);
  const outside = path.join(root, 'outside'); mkdirSync(outside); writeFileSync(path.join(outside, 'config.json'), '{}');
  const linked = path.join(runtime, 'linked'); symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => runtimeFile(path.join(linked, 'config.json'), root, options), /CONFIG_SYMLINK_FORBIDDEN/);
});

function certificateFixture() {
  const key = {}, publicKey = {}, now = Date.parse('2030-06-01T00:00:00Z');
  const validity = { validFrom: '2030-01-01T00:00:00Z', validTo: '2031-01-01T00:00:00Z' };
  const ca = { ...validity, ca: true, publicKey, checkIssued: value => value === ca, verify: value => value === publicKey };
  const certificate = { ...validity, ca: false, keyUsage: ['1.3.6.1.5.5.7.3.1'], checkIP: value => value === '192.168.1.10' ? value : undefined,
    checkIssued: value => value === ca, verify: value => value === publicKey, checkPrivateKey: value => value === key };
  return { certificate, ca, key, now };
}

test('certificate policy checks both validity windows, IP identity, CA signatures, key and TLS server usage', () => {
  const run = ({ certificate, ca, key, now }, bindAddress = '192.168.1.10') => verifyCertificatePair(certificate, ca, key, bindAddress, now);
  assert.deepEqual(run(certificateFixture()), { certificateValidUntil: '2031-01-01T00:00:00.000Z', certificateIpMatches: true, caValidUntil: '2031-01-01T00:00:00.000Z' });
  assert.throws(() => run(certificateFixture(), '192.168.1.11'), /IP_MISMATCH/);
  for (const [mutate, expected] of [
    [f => f.now = Date.parse('2029-12-31T23:59:59Z'), /CERTIFICATE_NOT_YET_VALID/],
    [f => f.now = Date.parse('2031-01-01T00:00:00Z'), /CERTIFICATE_EXPIRED/],
    [f => f.certificate.validTo = 'invalid', /CERTIFICATE_VALIDITY_INVALID/],
    [f => f.ca.validFrom = '2030-07-01T00:00:00Z', /CA_NOT_YET_VALID/],
    [f => f.ca.validTo = '2030-06-01T00:00:00Z', /CA_EXPIRED/],
    [f => f.ca.ca = false, /CA_MISMATCH/], [f => f.certificate.ca = true, /CA_MISMATCH/],
    [f => f.ca.checkIssued = () => false, /CA_MISMATCH/], [f => f.ca.verify = () => false, /CA_MISMATCH/],
    [f => f.certificate.checkIssued = () => false, /CA_MISMATCH/], [f => f.certificate.verify = () => false, /CA_MISMATCH/],
    [f => f.certificate.checkPrivateKey = () => false, /PRIVATE_KEY_MISMATCH/],
    [f => f.certificate.keyUsage = ['1.3.6.1.5.5.7.3.2'], /SERVER_AUTH_REQUIRED/],
  ]) { const fixture = certificateFixture(); mutate(fixture); assert.throws(() => run(fixture), expected); }
});

test('CLI requires the documented command/config/mode contract and rejects duplicate or unknown options', () => {
  assert.deepEqual(parseArgs(['validate', '--config', '.runtime/mobile.json']), { command: 'validate', configFile: '.runtime/mobile.json', mode: undefined });
  assert.equal(parseArgs(['serve', '--config', 'E:\\private config.json', '--mode', 'https']).mode, 'https');
  assert.equal(parseArgs(['serve', '--mode', 'certificate', '--config', 'config.json']).mode, 'certificate');
  assert.equal(parseArgs(['probe', '--config', 'config.json']).command, 'probe');
  for (const args of [[], ['start'], ['validate'], ['serve', '--config', 'config.json'], ['probe', '--config', 'a', '--mode', 'https'],
    ['serve', '--config', 'a', '--mode', 'http'], ['validate', '--config', 'a', '--config', 'b'], ['validate', '--config', 'a', '--other', 'b'],
    ['validate', '--config'], ['validate', '--config', 'a', 'extra']]) assert.throws(() => parseArgs(args), /CLI_|USAGE_/);
});

function request(overrides = {}) {
  return { rawHeaders: ['Host', '192.168.1.10:8443'], headers: { host: '192.168.1.10:8443' },
    socket: { remoteAddress: '192.168.1.20' }, url: '/', ...overrides };
}

test('Host/source policy permits only the configured phone/local sources and a single exact authority', () => {
  const config = fixtureConfig();
  for (const address of [config.phoneAddress, config.bindAddress, '127.0.0.1', `::ffff:${config.phoneAddress}`]) assert.equal(permitted(request({ socket: { remoteAddress: address } }), config), true);
  for (const address of ['192.168.1.21', '10.0.0.1', '::1', '8.8.8.8', '']) assert.equal(permitted(request({ socket: { remoteAddress: address } }), config), false);
  for (const host of ['localhost:8443', '192.168.1.10', '192.168.1.10:8444', 'invalid.example:8443', '192.168.1.10:8443,invalid']) assert.equal(permitted(request({ headers: { host } }), config), false);
  assert.equal(permitted(request({ rawHeaders: ['Host', '192.168.1.10:8443', 'hOsT', '192.168.1.10:8443'] }), config), false);
  assert.equal(permitted(request({ rawHeaders: [] }), config), false);
  assert.equal(permitted(request(), config, 8443, true), false);
  assert.equal(sourceAddress({}), '');
  const ca = request({ headers: { host: '192.168.1.10:8444' }, url: '/server-key.pem' });
  assert.equal(permitted(ca, config, 8444, false, false), true, 'CA handler can consistently return 404 for any non-CA path');
});

test('private paths fail closed after nested decoding without inspecting query values', () => {
  for (const target of ['/', '/activities/1', '/@vite/client', '/src/main.tsx', '/?token=%not-a-path', '/gather-dev-ca.crt']) assert.equal(allowedPath(target), true, target);
  for (const target of ['/@fs/E:/private', '/%40fs/E:/private', '/%2540fs/E:/private', '/.runtime/amap.json', '/.tools/file',
    '/%2eruntime/file', '/%252eruntime/file', '/server-key.pem', '/ca.crt?download=1', '/SERVER.KEY', '/a.pfx', '/a.cer', '/a.der',
    '/a.p12', '/%252525252540fs/private', '/%zz', '/%5c.runtime/file', '/a%00', '/a%23b', '/a/../src/main.tsx']) assert.equal(allowedPath(target), false, target);
  for (const url of ['//external.example/file', 'https://external.example/', '/a\\b', '/a b', '/a\t', '/a\n']) assert.equal(permitted(request({ url }), fixtureConfig()), false, url);
});

test('all removed diagnostic routes, suffixes, queries and encoded variants remain blocked', () => {
  assert.equal(REMOVED_DIAGNOSTICS.length, 6);
  for (const target of REMOVED_DIAGNOSTICS) {
    assert.equal(removedDiagnostic(target), true, target);
    assert.equal(removedDiagnostic(`${target}?unused=1`), true, target);
  }
  assert.equal(removedDiagnostic('/%67ather-location-check.js'), true);
  assert.equal(removedDiagnostic('/gather-location-sdk-probe.html'), true);
  for (const target of ['/', '/api/maps/config', '/api/me/registrations/1/check-in', '/gather-dev-ca.crt']) assert.equal(removedDiagnostic(target), false);
});

test('upstream headers preserve authority/Origin and strip untrusted forwarding and hop-by-hop headers', () => {
  const headers = { host: '192.168.1.10:8443', origin: 'https://192.168.1.10:8443', cookie: 'session-fixture',
    forwarded: 'for=spoof', 'x-forwarded-host': 'external', 'x-forwarded-for': 'spoof', 'x-gather-source': 'spoof',
    'proxy-authorization': 'fixture', 'proxy-connection': 'keep-alive', 'keep-alive': 'timeout=20', te: 'trailers', trailer: 'x',
    'transfer-encoding': 'chunked', connection: 'Upgrade, x-private', upgrade: 'websocket', 'x-private': 'fixture' };
  assert.deepEqual(upstreamHeaders({ headers }), { host: headers.host, origin: headers.origin, cookie: headers.cookie });
  assert.deepEqual(upstreamHeaders({ headers }, true), { host: headers.host, origin: headers.origin, cookie: headers.cookie, connection: headers.connection, upgrade: 'websocket' });
  assert.equal(headers.forwarded, 'for=spoof', 'the original request is not mutated');
});

test('Session cookies always gain Secure exactly once without changing other cookies', () => {
  assert.equal(secureSessionCookie('JSESSIONID=fixture; Path=/; HttpOnly; SameSite=Lax'), 'JSESSIONID=fixture; Path=/; HttpOnly; SameSite=Lax; Secure');
  assert.equal(secureSessionCookie('JSESSIONID=fixture; Secure; HttpOnly'), 'JSESSIONID=fixture; Secure; HttpOnly');
  assert.equal(secureSessionCookie('JSESSIONID=; Max-Age=0; secure'), 'JSESSIONID=; Max-Age=0; secure');
  assert.equal(secureSessionCookie('OTHER=fixture; HttpOnly'), 'OTHER=fixture; HttpOnly');
});
