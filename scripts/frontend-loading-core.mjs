import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, '.runtime/frontend-loading');
export const BASELINE_REVISION = 'c98df13603074bb48eff89ec3785e47d186ffebf';
export const LAZY_MODULES = [
  'ActivityDetailPage', 'CreateActivityPage', 'EditActivityPage', 'LoginPage', 'RegisterPage', 'ProfilePage',
  'NotificationsPage', 'MyRegistrationsPage', 'MyFavoritesPage', 'AdminDashboardPage', 'AdminActivitiesPage',
  'AdminRegistrationsPage', 'AdminMonitoringPage', 'AdminAuditLogsPage',
].map(name => `src/pages/${name}.tsx`);

export function argumentsOf(argv, allowed) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    assert(option?.startsWith('--') && allowed.includes(option.slice(2)), `Unknown option: ${option}`);
    assert(argv[index + 1] !== undefined && !argv[index + 1].startsWith('--'), `Missing value for ${option}`);
    assert(!(option.slice(2) in result), `Repeated option: ${option}`);
    result[option.slice(2)] = argv[index + 1];
  }
  return result;
}

export function outputRoot(value = DEFAULT_OUTPUT) {
  const resolved = path.resolve(value);
  // All generated source snapshots, build results, measurements and browser artifacts stay ignored.
  const runtime = path.join(PROJECT_ROOT, '.runtime');
  const relative = path.relative(runtime, resolved);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Output must be inside this project .runtime directory');
  rejectSymlinkAncestors(resolved);
  return resolved;
}

export function rejectSymlinkAncestors(value) {
  let current = path.resolve(value);
  while (current !== path.dirname(current)) {
    if (existsSync(current)) assert(!lstatSync(current).isSymbolicLink(), 'Generated output must not traverse a symlink or junction');
    current = path.dirname(current);
  }
}

export function digest(value) { return createHash('sha256').update(value).digest('hex'); }
export function slash(value) { return value.replaceAll('\\', '/'); }
export function jsonFile(file) { return JSON.parse(readFileSync(file, 'utf8')); }
export function byteSizes(buffer) { return { rawBytes: buffer.length, gzipBytes: gzipSync(buffer, { level: 9 }).length }; }

export function relativeModule(id, sourceRoot) {
  const normalized = slash(id);
  const dependency = normalized.lastIndexOf('/node_modules/');
  if (dependency >= 0) return normalized.slice(dependency + 1);
  const source = slash(sourceRoot) + '/';
  if (normalized.startsWith(source)) return normalized.slice(source.length);
  return normalized.replaceAll(slash(PROJECT_ROOT), '<workspace>');
}

export function sourceDigest(root) {
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(`${slash(path.relative(root, full))}\0${digest(readFileSync(full))}`);
    }
  }
  walk(root);
  return digest(files.join('\n'));
}

export function assetInventory(dist) {
  const assets = [];
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const info = lstatSync(full);
      assert(!info.isSymbolicLink(), 'Build asset inventory must not traverse a symlink or junction');
      if (info.isDirectory()) walk(full);
      else if (/\.(?:js|css)$/.test(name)) assets.push({ file: slash(path.relative(dist, full)),
        type: name.endsWith('.js') ? 'js' : 'css', ...byteSizes(readFileSync(full)), sha256: digest(readFileSync(full)) });
    }
  }
  assert(existsSync(dist), 'Build dist is missing'); walk(dist); return assets;
}

export function eagerGraph(build) {
  assert(Array.isArray(build.assets), 'JS/CSS asset inventory is required');
  const byFile = new Map(build.chunks.map(chunk => [chunk.file, chunk]));
  const entries = Object.values(build.manifest).filter(entry => entry.isEntry).map(entry => entry.file);
  assert(entries.length > 0, 'Manifest must contain an eager HTML entry');
  const files = new Set();
  function visit(file) {
    if (files.has(file)) return;
    files.add(file);
    const chunk = byFile.get(file);
    assert(chunk, `Manifest references missing JS chunk: ${file}`);
    chunk.imports.filter(value => byFile.has(value)).forEach(visit);
  }
  entries.forEach(visit);
  const css = new Set();
  Object.values(build.manifest).filter(entry => files.has(entry.file)).forEach(entry => entry.css?.forEach(file => css.add(file)));
  const modules = new Set([...files].flatMap(file => byFile.get(file).modules));
  const totals = { jsRawBytes: 0, jsGzipBytes: 0, cssRawBytes: 0, cssGzipBytes: 0 };
  for (const file of [...files, ...css]) {
    const asset = build.assets.find(candidate => candidate.file === file);
    assert(asset && Number.isSafeInteger(asset.rawBytes) && asset.rawBytes > 0
      && Number.isSafeInteger(asset.gzipBytes) && asset.gzipBytes > 0, `Initial asset inventory is missing or invalid: ${file}`);
  }
  for (const asset of build.assets) {
    if (asset.type === 'js' && files.has(asset.file)) { totals.jsRawBytes += asset.rawBytes; totals.jsGzipBytes += asset.gzipBytes; }
    if (asset.type === 'css' && css.has(asset.file)) { totals.cssRawBytes += asset.rawBytes; totals.cssGzipBytes += asset.gzipBytes; }
  }
  return { js: [...files].sort(), css: [...css].sort(), modules: [...modules].sort(), ...totals };
}

export function afterContract(after) {
  const current = eagerGraph(after);
  for (const module of LAZY_MODULES) assert(!current.modules.includes(module), `Lazy page leaked into eager graph: ${module}`);
  const dynamicEntries = after.chunks.filter(chunk => chunk.isDynamicEntry);
  const lazyEntries = LAZY_MODULES.map(module => {
    const entry = dynamicEntries.find(chunk => chunk.facadeModule === module);
    assert(entry, `Missing independent dynamic entry: ${module}`);
    const reachable = new Set();
    const chunks = new Map(after.chunks.map(chunk => [chunk.file, chunk]));
    function visit(file) {
      if (reachable.has(file)) return;
      reachable.add(file);
      chunks.get(file)?.imports.filter(imported => chunks.has(imported)).forEach(visit);
    }
    visit(entry.file);
    return { module, file: entry.file, imports: [...reachable].filter(file => file !== entry.file).sort(),
      modules: [...new Set([...reachable].flatMap(file => chunks.get(file)?.modules ?? []))].sort() };
  });
  assert.equal(new Set(lazyEntries.map(entry => entry.file)).size, LAZY_MODULES.length, 'Lazy pages must map to 14 independent entries');
  const moduleEdges = new Map(after.modules.map(module => [module.id, module.imports]));
  function descendants(entry) {
    const found = new Set();
    function visit(id) { if (found.has(id)) return; found.add(id); (moduleEdges.get(id) ?? []).forEach(visit); }
    visit(entry); return found;
  }
  // Derive source ownership independently of emitted eager chunks, so an accidental eager import fails.
  // antd's re-export barrel appears in the pre-tree-shake module graph: it does not prove every export is used.
  const publicGraph = descendants('src/main.tsx');
  const administratorModules = LAZY_MODULES.filter(module => /\/Admin|\/CreateActivity|\/EditActivity/.test(module));
  const exclusive = new Set(administratorModules.flatMap(module => [...descendants(module)])
    .filter(module => module.startsWith('src/') && !publicGraph.has(module)));
  const leaks = current.modules.filter(module => exclusive.has(module));
  assert.deepEqual(leaks, [], 'Administrator-only dependencies leaked into homepage eager closure');
  assert(exclusive.size > administratorModules.length, 'Expected real administrator-only source dependencies in module graph');
  const tableImplementations = after.chunks.flatMap(chunk => chunk.modules).filter(module =>
    /node_modules\/(?:antd\/es\/table\/(?:InternalTable|Table)\.js|@rc-component\/table\/es\/Table\.js)$/.test(module));
  assert(tableImplementations.length > 0, 'Administrator table implementation evidence is missing');
  for (const module of tableImplementations) assert(!current.modules.includes(module), `Administrator table implementation leaked eagerly: ${module}`);
  return { eager: current, lazyEntries, publicRequired: [...publicGraph].sort(), adminDeferredSrc: [...exclusive].sort(),
    tableImplementationModules: [...new Set(tableImplementations)].sort() };
}

export function buildContract(before, after) {
  assert(before.baselineRevision === BASELINE_REVISION, 'Baseline must use the fixed source revision');
  assert.equal(before.lockSha256, after.lockSha256, 'Before/after package locks must match');
  assert.equal(before.nodeVersion, after.nodeVersion, 'Before/after must use the same Node runtime');
  assert.equal(before.viteVersion, after.viteVersion, 'Before/after must use the same Vite runtime');
  assert.deepEqual(before.buildParameters, after.buildParameters, 'Before/after build parameters must match');
  const baseline = eagerGraph(before);
  const evidence = afterContract(after);
  const current = evidence.eager;
  assert(current.jsRawBytes < baseline.jsRawBytes, 'Initial JS raw bytes must fall below baseline');
  assert(current.jsGzipBytes < baseline.jsGzipBytes, 'Initial JS gzip estimate must fall below baseline');
  return { schemaVersion: 1, baselineRevision: BASELINE_REVISION, generatedAt: new Date().toISOString(),
    baseline: { eager: baseline, sourceSha256: before.sourceSha256 }, after: { eager: current, sourceSha256: after.sourceSha256 },
    lazyEntries: evidence.lazyEntries, publicRequired: evidence.publicRequired,
    administratorDeferredDependencies: evidence.adminDeferredSrc, administratorTableImplementations: evidence.tableImplementationModules,
    estimates: { gzip: 'Independent level-9 gzip per JS/CSS file; excludes HTTP headers and is not a browser measurement' },
    savings: { jsRawBytes: baseline.jsRawBytes - current.jsRawBytes, jsGzipBytes: baseline.jsGzipBytes - current.jsGzipBytes } };
}

export function verifyMeasurementArtifacts(before, after, output) {
  const root = outputRoot(output);
  const contract = buildContract(before, after);
  for (const [variant, build] of [['baseline', before], ['after', after]]) {
    const dist = path.join(root, variant, 'dist');
    rejectSymlinkAncestors(dist);
    assert.deepEqual(jsonFile(path.join(dist, '.vite/manifest.json')), build.manifest, `${variant} disk manifest differs from build metadata`);
    const sorted = assets => [...assets].sort((a, b) => a.file.localeCompare(b.file));
    assert.deepEqual(sorted(assetInventory(dist)), sorted(build.assets), `${variant} disk JS/CSS bytes or hashes differ from build metadata`);
  }
  return contract;
}
