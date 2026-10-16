import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { argumentsOf, assetInventory, BASELINE_REVISION, digest, outputRoot, PROJECT_ROOT, rejectSymlinkAncestors, relativeModule, sourceDigest } from './frontend-loading-core.mjs';

const options = argumentsOf(process.argv.slice(2), ['variant', 'output-root']);
const variant = options.variant ?? 'both';
assert(['baseline', 'after', 'both'].includes(variant), 'Variant must be baseline, after or both');
const output = outputRoot(options['output-root']);
mkdirSync(output, { recursive: true });
const frontend = path.join(PROJECT_ROOT, 'frontend');
const nodeModules = path.join(frontend, 'node_modules');
assert(existsSync(path.join(nodeModules, 'vite/dist/node/index.js')), 'Install the existing lockfile dependencies before building');
const { build, version: viteVersion } = await import(pathToFileURL(path.join(nodeModules, 'vite/dist/node/index.js')).href);

function baselineSource() {
  const root = path.join(output, 'baseline-source');
  rejectSymlinkAncestors(path.join(root, 'frontend'));
  const marker = path.join(root, 'baseline-revision.txt');
  const proof = path.join(root, 'source-proof.json');
  if (!existsSync(marker)) {
    assert(!existsSync(path.join(root, 'frontend')), 'Unmarked baseline source already exists; choose a fresh ignored output root');
    mkdirSync(root, { recursive: true });
    const archive = path.join(output, 'baseline-source.tar');
    execFileSync('git', ['archive', '--format=tar', '--output', archive, BASELINE_REVISION, 'frontend'], { cwd: PROJECT_ROOT });
    execFileSync('tar', ['-xf', archive, '-C', root], { cwd: PROJECT_ROOT });
    writeFileSync(marker, BASELINE_REVISION + '\n');
    writeFileSync(proof, JSON.stringify({ revision: BASELINE_REVISION, archiveSha256: digest(readFileSync(archive)),
      sourceSha256: sourceDigest(path.join(root, 'frontend')) }) + '\n');
  }
  assert.equal(readFileSync(marker, 'utf8').trim(), BASELINE_REVISION, 'Baseline revision marker is incorrect');
  assert(existsSync(proof), 'Baseline source proof is missing; choose a new ignored output root');
  const expected = JSON.parse(readFileSync(proof, 'utf8'));
  const freshArchive = execFileSync('git', ['archive', '--format=tar', BASELINE_REVISION, 'frontend'], { cwd: PROJECT_ROOT, maxBuffer: 20 * 1024 * 1024 });
  assert.equal(digest(freshArchive), expected.archiveSha256, 'Fresh git archive differs from baseline proof');
  const source = path.join(root, 'frontend');
  assert.equal(sourceDigest(source), expected.sourceSha256, 'Archived baseline source changed');
  if (!existsSync(path.join(source, 'node_modules'))) symlinkSync(nodeModules, path.join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const expectedLock = execFileSync('git', ['show', `${BASELINE_REVISION}:frontend/package-lock.json`], { cwd: PROJECT_ROOT });
  assert.equal(digest(readFileSync(path.join(source, 'package-lock.json'), 'utf8').replaceAll('\r\n', '\n')),
    digest(expectedLock.toString('utf8').replaceAll('\r\n', '\n')), 'Archived baseline lockfile changed');
  return source;
}

for (const selected of variant === 'both' ? ['baseline', 'after'] : [variant]) {
  const root = selected === 'baseline' ? baselineSource() : frontend;
  const destination = path.join(output, selected);
  rejectSymlinkAncestors(path.join(destination, 'dist'));
  const chunks = [];
  const modules = [];
  const buildParameters = { mode: 'production', minify: true, sourcemap: false, manifest: true, defaultChunkWarningLimit: true };
  execFileSync(process.execPath, [path.join(nodeModules, 'typescript/bin/tsc'), '--project', path.join(root, 'tsconfig.app.json'), '--noEmit', '--incremental', 'false'], { cwd: root, stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(nodeModules, 'typescript/bin/tsc'), '--project', path.join(root, 'tsconfig.node.json'), '--noEmit', '--incremental', 'false'], { cwd: root, stdio: 'inherit' });
  const sourceSha256 = sourceDigest(root);
  await build({ root, configFile: path.join(root, 'vite.config.ts'), mode: 'production',
    build: { outDir: path.join(destination, 'dist'), emptyOutDir: true, minify: true, sourcemap: false, manifest: true,
      rollupOptions: { plugins: [{ name: 'gather-loading-evidence', generateBundle(_options, bundle) {
        for (const item of Object.values(bundle)) if (item.type === 'chunk') chunks.push({ file: item.fileName,
          imports: [...item.imports], dynamicImports: [...item.dynamicImports], isEntry: item.isEntry,
          isDynamicEntry: item.isDynamicEntry, facadeModule: item.facadeModuleId ? relativeModule(item.facadeModuleId, root) : null,
          modules: Object.keys(item.modules).map(id => relativeModule(id, root)).sort() });
        for (const id of this.getModuleIds()) {
          const info = this.getModuleInfo(id);
          modules.push({ id: relativeModule(id, root), imports: (info?.importedIds ?? []).map(value => relativeModule(value, root)).sort(),
            dynamicImports: (info?.dynamicallyImportedIds ?? []).map(value => relativeModule(value, root)).sort() });
        }
      } }] } } });
  assert.equal(sourceDigest(root), sourceSha256, 'Source changed while the production build was running');
  const result = { schemaVersion: 1, variant: selected, baselineRevision: BASELINE_REVISION,
    nodeVersion: process.version, viteVersion, sourceRevision: selected === 'baseline' ? BASELINE_REVISION
      : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim(),
    harnessRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim(),
    sourceDirty: selected === 'baseline' ? false : execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'frontend'],
      { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim().length > 0,
    sourceSha256, lockSha256: digest(readFileSync(path.join(root, 'package-lock.json'), 'utf8').replaceAll('\r\n', '\n')), buildParameters,
    manifest: JSON.parse(readFileSync(path.join(destination, 'dist/.vite/manifest.json'), 'utf8')),
    chunks: chunks.sort((a, b) => a.file.localeCompare(b.file)), modules: modules.sort((a, b) => a.id.localeCompare(b.id)),
    assets: assetInventory(path.join(destination, 'dist')) };
  writeFileSync(path.join(destination, 'build.json'), JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(`${selected} production build and module graph saved to ${path.relative(PROJECT_ROOT, destination)}\n`);
}
