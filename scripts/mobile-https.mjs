import http from 'node:http';
import https from 'node:https';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSecureContext } from 'node:tls';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM = Object.freeze({ hostname: '127.0.0.1', port: 5173 });
const CA_PATH = '/gather-dev-ca.crt';
const CONFIG_FIELDS = ['bindAddress', 'phoneAddress', 'httpsPort', 'certificatePort', 'certificateFile', 'privateKeyFile', 'caFile'];
export const REMOVED_DIAGNOSTICS = Object.freeze(['/gather-location-check', '/gather-location-check.js',
  '/gather-location-check/compare', '/gather-sdk-location-check', '/gather-location-sdk-probe.js',
  '/api/_AMapService/v3/assistant/coordinate/convert']);

function fail(code) { throw new Error(code); }
const report = category => console.error(`Gather mobile HTTPS: ${category}`);
const within = (base, candidate) => { const relative = path.relative(base, candidate); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

export function isPrivateIpv4(value) {
  if (typeof value !== 'string' || isIP(value) !== 4) return false;
  const [first, second] = value.split('.').map(Number);
  return first === 10 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168;
}

export function normalizeConfig(raw, root = ROOT) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).length !== CONFIG_FIELDS.length || CONFIG_FIELDS.some(field => !Object.hasOwn(raw, field))) fail('CONFIG_FIELDS_INVALID');
  if (!isPrivateIpv4(raw.bindAddress) || !isPrivateIpv4(raw.phoneAddress)) fail('CONFIG_PRIVATE_IPV4_REQUIRED');
  if (raw.bindAddress === raw.phoneAddress) fail('CONFIG_ADDRESSES_MUST_DIFFER');
  for (const field of ['httpsPort', 'certificatePort']) {
    if (!Number.isInteger(raw[field]) || raw[field] < 1024 || raw[field] > 65535 || [3307, 8080, 5173].includes(raw[field])) fail('CONFIG_PORT_INVALID');
  }
  if (raw.httpsPort === raw.certificatePort) fail('CONFIG_PORTS_MUST_DIFFER');
  const config = { ...raw };
  const runtime = path.resolve(root, '.runtime');
  for (const field of ['certificateFile', 'privateKeyFile', 'caFile']) {
    if (typeof raw[field] !== 'string' || raw[field].trim() !== raw[field] || !raw[field] || /[\u0000-\u001f\u007f]/.test(raw[field])) fail('CONFIG_CERTIFICATE_PATH_INVALID');
    config[field] = path.resolve(root, raw[field]);
    if (!within(runtime, config[field])) fail('CONFIG_CERTIFICATE_OUTSIDE_RUNTIME');
  }
  if (new Set([config.certificateFile, config.privateKeyFile, config.caFile].map(value => process.platform === 'win32' ? value.toLowerCase() : value)).size !== 3) fail('CONFIG_CERTIFICATE_FILES_MUST_DIFFER');
  return config;
}

export function runtimeFile(filename, root = ROOT, { kind = 'CERTIFICATE', maxBytes = 64 * 1024 } = {}) {
  const runtime = path.resolve(root, '.runtime');
  const target = path.resolve(filename);
  if (!within(runtime, target)) fail(`${kind}_OUTSIDE_RUNTIME`);
  try {
    let current = path.resolve(root);
    for (const segment of path.relative(current, target).split(path.sep)) {
      current = path.join(current, segment);
      if (lstatSync(current).isSymbolicLink()) fail(`${kind}_SYMLINK_FORBIDDEN`);
    }
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) fail(`${kind}_FILE_INVALID`);
    if (!within(realpathSync(runtime), realpathSync(target))) fail(`${kind}_SYMLINK_FORBIDDEN`);
  } catch (error) {
    if (/^CERTIFICATE_|^CONFIG_/.test(error.message)) throw error;
    fail(`${kind}_FILE_UNAVAILABLE`);
  }
  return target;
}

export function verifyCertificatePair(certificate, ca, privateKey, bindAddress, now = Date.now()) {
  for (const [item, prefix] of [[certificate, 'CERTIFICATE'], [ca, 'CA']]) {
    const from = Date.parse(item.validFrom), until = Date.parse(item.validTo);
    if (!Number.isFinite(from) || !Number.isFinite(until) || from >= until) fail(`${prefix}_VALIDITY_INVALID`);
    if (now < from) fail(`${prefix}_NOT_YET_VALID`);
    if (now >= until) fail(`${prefix}_EXPIRED`);
  }
  if (!certificate.checkIP(bindAddress)) fail('CERTIFICATE_IP_MISMATCH');
  if (certificate.ca || !ca.ca || !ca.checkIssued(ca) || !ca.verify(ca.publicKey) ||
      !certificate.checkIssued(ca) || !certificate.verify(ca.publicKey)) fail('CERTIFICATE_CA_MISMATCH');
  if (certificate.keyUsage && !certificate.keyUsage.includes('1.3.6.1.5.5.7.3.1')) fail('CERTIFICATE_SERVER_AUTH_REQUIRED');
  if (!certificate.checkPrivateKey(privateKey)) fail('CERTIFICATE_PRIVATE_KEY_MISMATCH');
  return { certificateValidUntil: new Date(certificate.validTo).toISOString(), certificateIpMatches: true,
    caValidUntil: new Date(ca.validTo).toISOString() };
}

function loadConfiguration(filename, root = ROOT) {
  let raw;
  const configPath = runtimeFile(path.resolve(root, filename), root, { kind: 'CONFIG', maxBytes: 16 * 1024 });
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch { fail('CONFIG_FILE_UNAVAILABLE_OR_INVALID_JSON'); }
  const config = normalizeConfig(raw, root);
  for (const field of ['certificateFile', 'privateKeyFile', 'caFile']) runtimeFile(config[field], root);
  let certificate, ca, privateKey, certificateBytes, keyBytes, caBytes;
  try {
    certificateBytes = readFileSync(config.certificateFile);
    keyBytes = readFileSync(config.privateKeyFile);
    caBytes = readFileSync(config.caFile);
    certificate = new X509Certificate(certificateBytes);
    ca = new X509Certificate(caBytes);
    privateKey = createPrivateKey(keyBytes);
  } catch { fail('CERTIFICATE_OR_KEY_INVALID'); }
  // X509 parsing accepts trailing material; the downloadable file must contain only its public certificate.
  if (!caBytes.equals(ca.raw) && caBytes.toString('utf8').replace(/\r\n/g, '\n').trim() !== ca.toString().trim()) fail('CA_PUBLIC_CERTIFICATE_REQUIRED');
  const certificateState = verifyCertificatePair(certificate, ca, privateKey, config.bindAddress);
  try { createSecureContext({ cert: certificateBytes, key: keyBytes, ca: caBytes, minVersion: 'TLSv1.2' }); }
  catch { fail('CERTIFICATE_TLS_CONTEXT_INVALID'); }
  return { config, certificateBytes, keyBytes, caBytes, result: { ok: true, configPath, ...config, ...certificateState } };
}

export function parseArgs(args) {
  const [command, ...rest] = args;
  if (!['validate', 'serve', 'probe'].includes(command)) fail('USAGE_VALIDATE_SERVE_PROBE_CONFIG');
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index], value = rest[index + 1];
    if (!['--config', '--mode'].includes(flag) || Object.hasOwn(options, flag) || !value || value.startsWith('--')) fail('CLI_OPTIONS_INVALID');
    options[flag] = value;
  }
  if (!options['--config']) fail('CLI_CONFIG_REQUIRED');
  if (command === 'serve' ? !['https', 'certificate'].includes(options['--mode']) : Object.hasOwn(options, '--mode')) fail('CLI_MODE_INVALID');
  return { command, configFile: options['--config'], mode: options['--mode'] };
}

export function sourceAddress(socket) {
  const address = socket.remoteAddress ?? '';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function decodedPath(target) {
  let pathname = target.split('?', 1)[0];
  try { for (let round = 0; round < 4 && pathname.includes('%'); round++) pathname = decodeURIComponent(pathname); }
  catch { return undefined; }
  if (pathname.includes('%') || /[\\#\u0000-\u001f\u007f]/.test(pathname)) return undefined;
  return pathname;
}

export function allowedPath(target) {
  if (target === CA_PATH) return true;
  const pathname = decodedPath(target);
  if (!pathname) return false;
  return !pathname.toLowerCase().split('/').some(segment => ['.', '..', '@fs', '.runtime', '.tools'].includes(segment) ||
    /\.(?:pem|key|p12|pfx|crt|cer|der)$/.test(segment));
}

export function removedDiagnostic(target) {
  const pathname = decodedPath(target);
  return pathname !== undefined && (['/gather-location-check', '/gather-sdk-location-check', '/gather-location-sdk-probe'].some(prefix => pathname.startsWith(prefix)) ||
    pathname === '/api/_AMapService/v3/assistant/coordinate/convert');
}

export function permitted(request, config, port = config.httpsPort, shuttingDown = false, checkPath = true) {
  const hostCount = request.rawHeaders.filter((_, index) => index % 2 === 0).filter(name => name.toLowerCase() === 'host').length;
  return !shuttingDown && [config.phoneAddress, config.bindAddress, '127.0.0.1'].includes(sourceAddress(request.socket)) &&
    hostCount === 1 && request.headers.host === `${config.bindAddress}:${port}` && typeof request.url === 'string' &&
    request.url.startsWith('/') && !request.url.startsWith('//') && !/[\\\u0000-\u0020\u007f]/.test(request.url) && (!checkPath || allowedPath(request.url));
}

export function upstreamHeaders(request, upgrade = false) {
  const headers = { ...request.headers };
  const nominated = String(headers.connection ?? '').split(',').map(value => value.trim().toLowerCase());
  for (const name of Object.keys(headers)) {
    if (name === 'forwarded' || name.startsWith('x-forwarded-') || name.startsWith('x-gather-') ||
        ['proxy-connection', 'proxy-authorization', 'keep-alive', 'te', 'trailer', 'transfer-encoding'].includes(name) ||
        (!upgrade && (name === 'connection' || name === 'upgrade')) || nominated.includes(name) && !(upgrade && name === 'upgrade')) delete headers[name];
  }
  return headers;
}

export function secureSessionCookie(cookie) {
  return /^JSESSIONID=/i.test(cookie) && !/;\s*secure(?:;|$)/i.test(cookie) ? `${cookie}; Secure` : cookie;
}

function responseHeaders(response) {
  const headers = { ...response.headers };
  if (headers['set-cookie']) headers['set-cookie'] = headers['set-cookie'].map(secureSessionCookie);
  const nominated = String(headers.connection ?? '').split(',').map(value => value.trim().toLowerCase());
  for (const name of ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', ...nominated]) delete headers[name];
  return headers;
}

function reply(response, status) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
  response.end(status === 404 ? 'Not found\n' : status === 403 ? 'Forbidden\n' : 'Upstream unavailable\n');
}

function replySocket(socket, status = 403) {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Bad Gateway'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function publicCertificate(response, caBytes, head = false) {
  response.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert',
    'Content-Disposition': 'attachment; filename="gather-dev-ca.crt"', 'Content-Length': caBytes.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(head ? undefined : caBytes);
}

function serve(loaded, mode) {
  const { config, certificateBytes, keyBytes, caBytes } = loaded;
  const port = mode === 'https' ? config.httpsPort : config.certificatePort;
  const sockets = new Set();
  let shuttingDown = false;
  function track(socket) { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; }
  const server = mode === 'https' ? https.createServer({ cert: certificateBytes, key: keyBytes, minVersion: 'TLSv1.2', maxHeaderSize: 16 * 1024 }, handle) :
    http.createServer({ maxHeaderSize: 16 * 1024 }, handle);

  function handle(request, response) {
    if (mode === 'certificate') {
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Connection', 'close');
      // The HTTP listener never maps a URL to a filesystem path or forwards to Vite.
      if (!permitted(request, config, port, shuttingDown, false)) { reply(response, 403); return; }
      if (request.method !== 'GET' || request.url !== CA_PATH) { reply(response, 404); return; }
      publicCertificate(response, caBytes); return;
    }
    if (!permitted(request, config, port, shuttingDown)) { report('request-rejected'); reply(response, 403); return; }
    if (removedDiagnostic(request.url)) { reply(response, 404); return; }
    if (request.url === CA_PATH) {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD', Connection: 'close' }); response.end(); return; }
      publicCertificate(response, caBytes, request.method === 'HEAD'); return;
    }
    // Client headers and paths cannot select the upstream host or port.
    const upstream = http.request({ ...UPSTREAM, method: request.method, path: request.url, headers: upstreamHeaders(request), agent: false }, incoming => {
      if (response.destroyed) { incoming.destroy(); return; }
      response.writeHead(incoming.statusCode ?? 502, responseHeaders(incoming));
      incoming.on('error', () => { report('upstream-response-error'); response.destroy(); });
      incoming.pipe(response);
    });
    upstream.on('socket', track);
    const deadline = setTimeout(() => { report('request-timeout'); upstream.destroy(); if (!response.headersSent) reply(response, 502); else response.destroy(); }, 60_000);
    response.once('finish', () => clearTimeout(deadline));
    response.once('close', () => { clearTimeout(deadline); if (!response.writableEnded) upstream.destroy(); });
    request.once('aborted', () => upstream.destroy());
    request.once('error', () => { report('client-request-error'); upstream.destroy(); });
    upstream.once('error', () => { clearTimeout(deadline); report('upstream-request-error'); if (!response.headersSent && !response.destroyed) reply(response, 502); else response.destroy(); });
    upstream.setTimeout(30_000, () => { report('upstream-timeout'); upstream.destroy(); });
    request.pipe(upstream);
  }

  server.on('connection', socket => {
    track(socket);
    if (![config.phoneAddress, config.bindAddress, '127.0.0.1'].includes(sourceAddress(socket)) || shuttingDown) socket.destroy();
  });
  if (mode === 'https') {
    server.on('secureConnection', socket => { track(socket); socket.on('error', () => report('client-socket-error')); });
    server.on('tlsClientError', () => report('tls-client-error'));
    server.on('upgrade', (request, client, head) => {
      if (!permitted(request, config, port, shuttingDown) || request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket') {
        report('upgrade-rejected'); replySocket(client); return;
      }
      if (removedDiagnostic(request.url) || request.url === CA_PATH) { replySocket(client, 404); return; }
      const upstream = http.request({ ...UPSTREAM, method: 'GET', path: request.url, headers: upstreamHeaders(request, true), agent: false });
      let peer;
      const closePair = () => { upstream.destroy(); peer?.destroy(); client.destroy(); };
      const deadline = setTimeout(() => { report('upgrade-timeout'); closePair(); }, 15_000);
      client.once('close', () => { clearTimeout(deadline); upstream.destroy(); peer?.destroy(); });
      client.once('error', () => { report('upgrade-client-error'); closePair(); });
      upstream.on('socket', track);
      upstream.once('error', () => { clearTimeout(deadline); report('upgrade-upstream-error'); if (peer) closePair(); else replySocket(client, 502); });
      upstream.once('response', response => { clearTimeout(deadline); response.destroy(); report('upgrade-not-accepted'); replySocket(client, 502); });
      upstream.once('upgrade', (response, socket, upstreamHead) => {
        clearTimeout(deadline); peer = track(socket);
        if (client.destroyed || shuttingDown || response.statusCode !== 101) { closePair(); return; }
        socket.once('error', () => { report('upgrade-peer-error'); closePair(); });
        socket.once('close', () => client.destroy());
        const handshake = ['HTTP/1.1 101 Switching Protocols'];
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          const name = response.rawHeaders[index], value = response.rawHeaders[index + 1];
          handshake.push(`${name}: ${name.toLowerCase() === 'set-cookie' ? secureSessionCookie(value) : value}`);
        }
        client.write(handshake.join('\r\n') + '\r\n\r\n');
        if (upstreamHead.length) client.write(upstreamHead);
        if (head.length) socket.write(head);
        for (const endpoint of [client, socket]) endpoint.setTimeout(120_000, () => { report('websocket-idle-timeout'); closePair(); });
        client.pipe(socket); socket.pipe(client);
      });
      upstream.end();
    });
  }
  server.headersTimeout = mode === 'https' ? 15_000 : 5_000;
  server.requestTimeout = mode === 'https' ? 60_000 : 5_000;
  server.keepAliveTimeout = mode === 'https' ? 5_000 : 1_000;
  server.maxHeadersCount = 100;
  server.on('clientError', (_error, socket) => { report('invalid-client-request'); socket.destroy(); });
  server.on('error', () => { report('listener-error'); shutdown(1); });
  function shutdown(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => { process.exitCode = exitCode; });
    for (const socket of sockets) socket.destroy();
    process.exitCode = exitCode;
  }
  process.once('SIGINT', () => shutdown()); process.once('SIGTERM', () => shutdown());
  server.listen(port, config.bindAddress, () => console.log(JSON.stringify({ ok: true, mode, address: config.bindAddress, port })));
}

async function probe({ config, caBytes }) {
  const controller = new AbortController();
  function call(target, certificate = false, host) {
    return new Promise((resolve, reject) => {
      const request = (certificate ? http : https).request({ hostname: config.bindAddress,
        port: certificate ? config.certificatePort : config.httpsPort, path: target, method: 'GET',
        // Keep TLS identity on the configured IP while testing an intentionally invalid HTTP Host.
        ...(certificate ? {} : { ca: caBytes, minVersion: 'TLSv1.2', servername: '' }), signal: controller.signal,
        headers: { Host: host ?? `${config.bindAddress}:${certificate ? config.certificatePort : config.httpsPort}` }, agent: false,
        maxHeaderSize: 16 * 1024 }, response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) request.destroy(new Error('PROBE_RESPONSE_TOO_LARGE')); else chunks.push(chunk); });
        response.once('error', reject);
        response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      });
      const deadline = setTimeout(() => request.destroy(new Error('PROBE_TIMEOUT')), 10_000);
      request.once('close', () => clearTimeout(deadline)); request.once('error', reject); request.end();
    });
  }
  try {
    const tasks = [
      call('/').then(response => { if (response.status !== 200 || !response.headers['content-type']?.includes('text/html')) fail('PROBE_HOME_FAILED'); }),
      call('/api/health').then(response => { let body; try { body = JSON.parse(response.body.toString('utf8')); } catch { fail('PROBE_HEALTH_FAILED'); } if (response.status !== 200 || body.status !== 'UP') fail('PROBE_HEALTH_FAILED'); }),
      ...REMOVED_DIAGNOSTICS.map(target => call(target).then(response => { if (response.status !== 404) fail('PROBE_REMOVED_DIAGNOSTIC_FAILED'); })),
      ...['/@fs/private', '/%40fs/private', '/.runtime/amap.json', '/server-key.pem'].map(target => call(target).then(response => { if (response.status !== 403) fail('PROBE_PRIVATE_PATH_FAILED'); })),
      call('/', false, `invalid.example:${config.httpsPort}`).then(response => { if (response.status !== 403) fail('PROBE_HOST_GUARD_FAILED'); }),
      call(CA_PATH, true).then(response => { if (response.status !== 200 || !response.body.equals(caBytes) || response.headers['content-type'] !== 'application/x-x509-ca-cert') fail('PROBE_CA_DOWNLOAD_FAILED'); }),
      ...['/', '/server-key.pem', '/.runtime/amap.json', `${CA_PATH}?download=1`].map(target => call(target, true).then(response => { if (response.status !== 404) fail('PROBE_CA_ONLY_FAILED'); })),
    ];
    await Promise.all(tasks);
    return { ok: true, tlsVerifiedWithExplicitCa: true, certificateIpMatches: true, frontend: true, apiHealth: true,
      removedDiagnostics: REMOVED_DIAGNOSTICS.length, privatePathsBlocked: true, strictHost: true,
      publicCaDownloadMatches: true, certificateOnlyHttp: true, phoneTrustOrReachabilityVerified: false, businessWrites: 0 };
  } catch (error) {
    if (/^PROBE_[A-Z_]+$/.test(error.message)) throw error;
    fail('PROBE_CONNECTION_OR_TLS_FAILED');
  } finally { controller.abort(); }
}

export async function main(args = process.argv.slice(2)) {
  try {
    const { command, configFile, mode } = parseArgs(args);
    const loaded = loadConfiguration(configFile);
    if (command === 'serve') serve(loaded, mode);
    else console.log(JSON.stringify(command === 'validate' ? loaded.result : await probe(loaded)));
  } catch (error) {
    const code = /^(?:CONFIG|CERTIFICATE|CA|CLI|USAGE|PROBE)_[A-Z_]+$/.test(error.message) ? error.message : 'MOBILE_HTTPS_FAILED';
    console.error(JSON.stringify({ ok: false, error: code })); process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
