import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { afterContract, argumentsOf, assetInventory, BASELINE_REVISION, buildContract, byteSizes, eagerGraph,
  LAZY_MODULES, outputRoot, PROJECT_ROOT, relativeModule, sourceDigest, verifyMeasurementArtifacts } from './frontend-loading-core.mjs';
import { createProductionServer } from './frontend-loading-server.mjs';
import { runLoadingSample } from './frontend-loading-sample.mjs';

const TABLE = 'node_modules/antd/es/table/InternalTable.js';
const PRIVATE = 'src/pages/AdminPrivate.tsx';
function fixture() {
  const eager = { file: 'assets/index-12345678.js', imports: [], dynamicImports: [], isEntry: true, isDynamicEntry: false,
    facadeModule: 'src/main.tsx', modules: ['src/main.tsx', 'src/pages/ActivitiesPage.tsx', 'src/Layout.tsx', 'src/provider.ts'] };
  const chunks = [eager, ...LAZY_MODULES.map((module, index) => ({ file: `assets/page${index}-12345678.js`, imports: [], dynamicImports: [],
    isEntry: false, isDynamicEntry: true, facadeModule: module, modules: [module, ...(module.includes('AdminDashboard') ? [PRIVATE, TABLE] : [])] }))];
  return { baselineRevision: BASELINE_REVISION, lockSha256: 'lock', nodeVersion: process.version, viteVersion: '8.3.2', buildParameters: { minify: true },
    manifest: { 'index.html': { file: eager.file, isEntry: true, css: ['assets/index-12345678.css'] } }, chunks,
    modules: [{ id: 'src/main.tsx', imports: ['src/pages/ActivitiesPage.tsx', 'src/Layout.tsx'], dynamicImports: LAZY_MODULES },
      { id: 'src/Layout.tsx', imports: ['src/provider.ts'], dynamicImports: [] },
      ...LAZY_MODULES.map(module => ({ id: module, imports: module.includes('AdminDashboard') ? [PRIVATE, TABLE] : [], dynamicImports: [] }))],
    assets: [{ file: eager.file, type: 'js', rawBytes: 100, gzipBytes: 50 }, { file: 'assets/index-12345678.css', type: 'css', rawBytes: 20, gzipBytes: 15 }] };
}
function temp(t) {
  const runtime = path.join(PROJECT_ROOT, '.runtime'); mkdirSync(runtime, { recursive: true });
  const root = mkdtempSync(path.join(runtime, 'frontend-loading-test-'));
  t.after(() => { assert(root.startsWith(runtime + path.sep)); rmSync(root, { recursive: true, force: true }); });
  return root;
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('13 independent dynamic entries map by facade source and Layout dependencies stay public', () => {
  const result = afterContract(fixture());
  assert.equal(result.lazyEntries.length, 13);
  assert(result.publicRequired.includes('src/provider.ts'));
  assert(result.adminDeferredSrc.includes(PRIVATE));
  assert(!result.adminDeferredSrc.includes('src/provider.ts'));
  assert.deepEqual(result.tableImplementationModules, [TABLE]);
});
test('injecting an administrator-only source dependency into actual eager output is rejected', () => {
  const build = fixture(); build.chunks[0].modules.push(PRIVATE);
  assert.throws(() => afterContract(build), /dependencies leaked/);
});
test('injecting actual Table implementation into eager output is rejected despite antd barrel graph', () => {
  const build = fixture();
  build.modules[0].imports.push('node_modules/antd/es/index.js');
  build.modules.push({ id: 'node_modules/antd/es/index.js', imports: [TABLE], dynamicImports: [] });
  build.chunks[0].modules.push(TABLE);
  assert.throws(() => afterContract(build), /table implementation leaked/);
});
test('injecting a lazy page itself into eager output fails', () => {
  const build = fixture(); build.chunks[0].modules.push(LAZY_MODULES[0]);
  assert.throws(() => afterContract(build), /Lazy page leaked/);
});
test('missing or combined dynamic entries fail the independent-entry contract', () => {
  const missing = fixture(); missing.chunks.pop();
  assert.throws(() => afterContract(missing), /Missing independent dynamic entry/);
  const combined = fixture(); combined.chunks[2].file = combined.chunks[1].file;
  assert.throws(() => afterContract(combined), /13 independent entries/);
});
test('eager imports traverse static edges only and count JS and associated CSS once', () => {
  const build = fixture();
  build.chunks[0].imports.push(build.chunks[1].file);
  build.assets.push({ file: build.chunks[1].file, type: 'js', rawBytes: 20, gzipBytes: 10 });
  build.chunks[0].dynamicImports.push(build.chunks[2].file);
  const graph = eagerGraph(build);
  assert(graph.js.includes(build.chunks[1].file));
  assert(!graph.js.includes(build.chunks[2].file));
  assert.equal(graph.jsRawBytes, 120); assert.equal(graph.cssRawBytes, 20);
});
test('missing byte inventory cannot silently count initial assets as zero', () => {
  const missing = fixture(); delete missing.assets;
  assert.throws(() => afterContract(missing), /inventory is required/);
  const partial = fixture(); partial.assets = [];
  assert.throws(() => afterContract(partial), /inventory is missing/);
});
test('comparison enforces raw and gzip reductions and matching fixed runtime lock and parameters', () => {
  const after = fixture(); const before = fixture(); before.assets[0].rawBytes = 200; before.assets[0].gzipBytes = 90;
  assert.equal(buildContract(before, after).savings.jsRawBytes, 100);
  for (const field of ['lockSha256', 'nodeVersion', 'viteVersion', 'buildParameters']) {
    const invalid = structuredClone(after); invalid[field] = 'different';
    assert.throws(() => buildContract(before, invalid));
  }
  assert.throws(() => buildContract(after, after), /raw bytes/);
  const worseGzip = fixture(); worseGzip.assets[0].gzipBytes = 91;
  assert.throws(() => buildContract(before, worseGzip), /gzip estimate/);
});
test('unknown repeated or missing CLI parameters are rejected', () => {
  assert.deepEqual(argumentsOf(['--variant', 'after'], ['variant']), { variant: 'after' });
  for (const args of [['--unknown', 'x'], ['--variant'], ['--variant', 'after', '--variant', 'before']]) {
    assert.throws(() => argumentsOf(args, ['variant']));
  }
});
test('gzip estimates and relative module identifiers do not expose absolute local dependency paths', () => {
  const sizes = byteSizes(Buffer.from('abcd'.repeat(1000)));
  assert.equal(sizes.rawBytes, 4000); assert(sizes.gzipBytes < sizes.rawBytes);
  assert.equal(relativeModule('E:/repo/frontend/node_modules/antd/es/table/index.js', 'E:/repo/frontend'), 'node_modules/antd/es/table/index.js');
  assert.equal(relativeModule('E:/repo/frontend/src/main.tsx', 'E:/repo/frontend'), 'src/main.tsx');
});
test('source fingerprint detects non-lockfile source edits and excludes installed dependencies', t => {
  const root = temp(t); mkdirSync(path.join(root, 'src')); writeFileSync(path.join(root, 'src/main.tsx'), 'original');
  writeFileSync(path.join(root, 'package-lock.json'), '{}');
  const before = sourceDigest(root);
  mkdirSync(path.join(root, 'node_modules')); writeFileSync(path.join(root, 'node_modules/ignored'), 'installed');
  assert.equal(sourceDigest(root), before);
  writeFileSync(path.join(root, 'src/main.tsx'), 'changed'); assert.notEqual(sourceDigest(root), before);
});
test('output confinement rejects project root traversal and symlink/junction ancestors', t => {
  const root = temp(t); mkdirSync(path.join(root, 'real'));
  symlinkSync(path.join(root, 'real'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(outputRoot(root), root);
  assert.throws(() => outputRoot(PROJECT_ROOT));
  assert.throws(() => outputRoot(path.join(root, 'link/escape')), /symlink or junction/);
});
test('production static server has HTML freshness, hashed cache, missing chunk 404 and hidden metadata', async t => {
  const root = temp(t); mkdirSync(path.join(root, 'assets')); mkdirSync(path.join(root, '.vite'));
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Test</title>');
  writeFileSync(path.join(root, 'assets/page-12345678.js'), 'export default 1');
  writeFileSync(path.join(root, '.vite/loading-graph.json'), '{"private":"metadata"}');
  const server = createProductionServer({ dist: root }); const base = await listen(server); t.after(() => new Promise(resolve => server.close(resolve)));
  for (const pathname of ['/', '/index.html', '/admin/activities']) {
    const response = await fetch(base + pathname); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-cache');
  }
  const asset = await fetch(base + '/assets/page-12345678.js');
  assert.equal(asset.status, 200); assert(asset.headers.get('cache-control').includes('immutable')); assert(asset.headers.get('content-type').includes('javascript'));
  assert.equal(asset.headers.get('content-encoding'), null);
  for (const pathname of ['/assets/missing-12345678.js', '/.vite/loading-graph.json']) {
    const response = await fetch(base + pathname); assert.equal(response.status, 404); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert(response.headers.get('content-type').includes('text/plain')); assert(!(await response.text()).includes('<!doctype'));
  }
});
test('production server refuses filesystem symlinks and preserves source authority for API proxy', async t => {
  const root = temp(t); mkdirSync(path.join(root, 'dist')); mkdirSync(path.join(root, 'private'));
  writeFileSync(path.join(root, 'dist/index.html'), '<!doctype html>'); writeFileSync(path.join(root, 'private/secret.js'), 'private');
  symlinkSync(path.join(root, 'private'), path.join(root, 'dist/link'), process.platform === 'win32' ? 'junction' : 'dir');
  const backend = http.createServer((request, response) => { response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ source: request.headers['x-gather-client-ip'], method: request.method })); });
  await listen(backend); t.after(() => new Promise(resolve => backend.close(resolve)));
  const server = createProductionServer({ dist: path.join(root, 'dist'), backendPort: backend.address().port });
  const base = await listen(server); t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal((await fetch(base + '/link/secret.js')).status, 404);
  const proxied = await fetch(base + '/api/health', { headers: { 'X-Gather-Client-IP': '203.0.113.2' } });
  assert.deepEqual(await proxied.json(), { source: '127.0.0.1', method: 'GET' });
});

function artifactPair(t) {
  const root = temp(t);
  const builds = {};
  for (const variant of ['baseline', 'after']) {
    const build = fixture();
    const dist = path.join(root, variant, 'dist'); mkdirSync(path.join(dist, 'assets'), { recursive: true }); mkdirSync(path.join(dist, '.vite'));
    for (const chunk of build.chunks) writeFileSync(path.join(dist, chunk.file), chunk.isEntry ? 'A'.repeat(variant === 'baseline' ? 5000 : 1000) : 'export{}');
    writeFileSync(path.join(dist, 'assets/index-12345678.css'), 'body{color:red}');
    writeFileSync(path.join(dist, '.vite/manifest.json'), JSON.stringify(build.manifest));
    build.assets = assetInventory(dist); builds[variant] = build;
  }
  return { root, ...builds };
}
test('measurement preflight rechecks the comparison and exact disk manifests, bytes and hashes', t => {
  const { root, baseline, after } = artifactPair(t);
  assert.equal(verifyMeasurementArtifacts(baseline, after, root).lazyEntries.length, 13);
  writeFileSync(path.join(root, 'after/dist/assets/index-12345678.js'), 'B'.repeat(1000));
  assert.throws(() => verifyMeasurementArtifacts(baseline, after, root), /bytes or hashes differ/);
});
test('measurement preflight refuses an overwritten manifest or incompatible build metadata', t => {
  const { root, baseline, after } = artifactPair(t);
  writeFileSync(path.join(root, 'after/dist/.vite/manifest.json'), '{}');
  assert.throws(() => verifyMeasurementArtifacts(baseline, after, root), /disk manifest differs/);
  const incompatible = structuredClone(after); incompatible.lockSha256 = 'different';
  assert.throws(() => verifyMeasurementArtifacts(baseline, incompatible, root), /locks must match/);
});
const sampleSettings = { network: { latencyMs: 150, downloadBitsPerSecond: 1600000, uploadBitsPerSecond: 750000 }, timeoutMs: 1000 };
const sampleInput = { viewport: 'desktop', size: { width: 1280, height: 800 }, variant: 'after', round: 1, sequence: 1,
  url: 'http://127.0.0.1:5185/activities', settings: sampleSettings };
test('a context initialization failure still returns the scheduled failed sample', async () => {
  const sample = await runLoadingSample({ ...sampleInput, browser: { async newContext() { throw new Error('setup failed'); } } });
  assert.equal(sample.sequence, 1); assert.equal(sample.success, false); assert.equal(sample.failure, 'browser setup failed');
  assert.deepEqual(sample.resources, []);
});
test('CDP initialization failures retain the failed sample and close its context', async () => {
  let closed = 0;
  const context = { async newPage() { return {}; }, async newCDPSession() { return { async send() { throw new Error('CDP failed'); } }; }, async close() { closed++; } };
  const sample = await runLoadingSample({ ...sampleInput, browser: { async newContext() { return context; } } });
  assert.equal(sample.success, false); assert.equal(sample.failure, 'browser setup failed'); assert.equal(closed, 1);
});
test('observer initialization failures are not discarded before navigation', async () => {
  let closed = 0;
  const page = { on() {}, async addInitScript() { throw new Error('observer failed'); } };
  const context = { async newPage() { return page; }, async newCDPSession() { return { async send() {}, on() {} }; }, async close() { closed++; } };
  const sample = await runLoadingSample({ ...sampleInput, browser: { async newContext() { return context; } } });
  assert.equal(sample.success, false); assert.equal(sample.failure, 'browser setup failed'); assert.equal(closed, 1);
});
