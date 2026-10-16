import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { argumentsOf, outputRoot, rejectSymlinkAncestors } from './frontend-loading-core.mjs';

const HASHED_ASSET = /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

export function createProductionServer({ dist, backendPort = 8080 }) {
  const root = path.resolve(dist);
  rejectSymlinkAncestors(root);
  assert(existsSync(path.join(root, 'index.html')), 'Production index.html is missing');
  assert(Number.isInteger(backendPort) && backendPort > 1024 && backendPort <= 65535, 'Invalid local backend port');
  return http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); }
    catch { response.writeHead(400, { 'Cache-Control': 'no-store' }); response.end('Bad request\n'); return; }
    if (pathname.startsWith('/api/')) {
      const headers = { ...request.headers, host: `127.0.0.1:${backendPort}`, 'x-gather-client-ip': request.socket.remoteAddress ?? '127.0.0.1' };
      // No forwarded chain supplied by the browser is used as client identity by the backend.
      const proxy = http.request({ host: '127.0.0.1', port: backendPort, path: request.url, method: request.method, headers }, upstream => {
        response.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.pipe(response);
      });
      proxy.on('error', () => { if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end('Local API unavailable\n'); });
      request.on('aborted', () => proxy.destroy()); request.pipe(proxy); return;
    }
    const segments = pathname.split('/');
    if (segments.some(segment => segment.startsWith('.') || segment.includes('\\') || segment.includes('\0'))) {
      response.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end('Not found\n'); return;
    }
    let file = path.join(root, pathname);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(404); response.end('Not found\n'); return; }
    let missing = !existsSync(file) || !statSync(file).isFile();
    if (pathname.startsWith('/assets/') && missing) {
      response.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end('Asset not found\n'); return;
    }
    if (missing) file = path.join(root, 'index.html');
    // Refuse symlinks within a controlled dist, including a file link to unrelated data.
    let checked = file;
    while (checked !== root) {
      if (lstatSync(checked).isSymbolicLink()) { response.writeHead(404); response.end('Not found\n'); return; }
      checked = path.dirname(checked);
    }
    const bytes = readFileSync(file);
    const cache = file === path.join(root, 'index.html') ? 'no-cache' : HASHED_ASSET.test(pathname) ? 'public, max-age=31536000, immutable' : undefined;
    // nginx's repository configuration has gzip disabled: transfer raw bytes here too.
    response.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': bytes.length,
      ...(cache ? { 'Cache-Control': cache } : {}) });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = argumentsOf(process.argv.slice(2), ['variant', 'port', 'output-root']);
  const variant = options.variant ?? 'after';
  assert(['baseline', 'after'].includes(variant), 'Server variant must be baseline or after');
  const port = Number(options.port ?? (variant === 'baseline' ? 5184 : 5185));
  assert([5184, 5185].includes(port), 'Use the dedicated 127.0.0.1 loading ports 5184 or 5185');
  const output = outputRoot(options['output-root']);
  const server = createProductionServer({ dist: path.join(output, variant, 'dist') });
  server.on('error', error => { process.stderr.write(`Production server failed: ${error.code ?? error.name}\n`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => process.stdout.write(`${variant} production server listening at http://127.0.0.1:${port}\n`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
