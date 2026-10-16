import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { argumentsOf, BASELINE_REVISION, jsonFile, outputRoot, verifyMeasurementArtifacts } from './frontend-loading-core.mjs';
import { createProductionServer } from './frontend-loading-server.mjs';
import { runLoadingSample } from './frontend-loading-sample.mjs';

const options = argumentsOf(process.argv.slice(2), ['output-root', 'channel']);
const output = outputRoot(options['output-root']);
const builds = { baseline: jsonFile(path.join(output, 'baseline/build.json')), after: jsonFile(path.join(output, 'after/build.json')) };
assert.equal(builds.baseline.sourceRevision, BASELINE_REVISION, 'Measured baseline must match the fixed commit');
assert.equal(builds.after.sourceDirty, false, 'Commit frontend source before final measurement; build metadata reports dirty source');
verifyMeasurementArtifacts(builds.baseline, builds.after, output);
const servers = [];
const samples = [];
const ports = { baseline: 5184, after: 5185 };
const settings = { samplesPerVariantPerViewport: 10, viewports: { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } },
  network: { downloadBitsPerSecond: 1_600_000, uploadBitsPerSecond: 750_000, latencyMs: 150 },
  cpuThrottle: 'none', cache: 'new browser context for every sample; CDP cache disabled; service workers blocked',
  instrumentation: 'Playwright init-script observers only; no product globals, Cookie/HAR/trace or storage state are saved',
  ordering: 'AB pairs, reversed BA on alternate rounds, within each viewport', timeoutMs: 60000,
  transfer: 'CDP Network.loadingFinished.encodedDataLength for completed JS/CSS HTTP responses; headers included by Chromium; content-encoding identity' };
let browser;
function save() {
  mkdirSync(output, { recursive: true });
  const report = { schemaVersion: 1, createdAt: new Date().toISOString(), browser: browser?.version(), settings,
    revisions: Object.fromEntries(Object.entries(builds).map(([variant, build]) => [variant, {
      sourceRevision: build.sourceRevision, sourceSha256: build.sourceSha256, sourceDirty: build.sourceDirty,
      nodeVersion: build.nodeVersion, viteVersion: build.viteVersion, lockSha256: build.lockSha256 }])), samples };
  writeFileSync(path.join(output, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
  const lines = ['# Production browser loading measurements', '',
    '40 scheduled cold-cache samples; all successes, failures and timeouts are retained. Fresh contexts, fixed network and no CPU throttling.',
    'JS/CSS bytes below come from real Chromium HTTP transfer accounting. Static gzip estimates are separate in comparison.md.', '',
    '| Viewport | Variant | Scheduled | Passed | Failed | Median JS/CSS encoded bytes | Median list visible ms | Median LCP ms | Median DCL ms |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|'];
  function median(values) {
    const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
    if (!sorted.length) return 'unavailable';
    const middle = Math.floor(sorted.length / 2);
    return (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2).toFixed(1);
  }
  for (const viewport of Object.keys(settings.viewports)) for (const variant of ['baseline', 'after']) {
    const values = samples.filter(sample => sample.viewport === viewport && sample.variant === variant);
    const successes = values.filter(sample => sample.success);
    lines.push(`| ${viewport} | ${variant} | ${values.length} | ${successes.length} | ${values.length - successes.length} | ${median(successes.map(value => value.encodedJsCssBytes))} | ${median(successes.map(value => value.listVisibleMs))} | ${median(successes.map(value => value.lcpMs))} | ${median(successes.map(value => value.dclMs))} |`);
  }
  lines.push('', 'Medians describe successful samples only; failures remain in the scheduled/failed columns and every raw sample. This fixed local experiment does not establish production performance.', '');
  writeFileSync(path.join(output, 'measurements.md'), lines.join('\n'));
}
try {
  for (const variant of ['baseline', 'after']) {
    const server = createProductionServer({ dist: path.join(output, variant, 'dist') });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ports[variant], '127.0.0.1', resolve); });
    servers.push(server);
  }
  browser = await chromium.launch({ channel: options.channel ?? process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true });
  for (const [viewport, size] of Object.entries(settings.viewports)) for (let round = 0; round < 10; round++) {
    for (const variant of round % 2 ? ['after', 'baseline'] : ['baseline', 'after']) {
      const sample = await runLoadingSample({ browser, viewport, size, variant, round: round + 1,
        sequence: samples.length + 1, url: 'http://127.0.0.1:' + ports[variant] + '/activities', settings });
      samples.push(sample);
      save();
      process.stdout.write(`${sample.sequence}/40 ${viewport} ${variant}: ${sample.success ? 'passed' : sample.failure}\n`);
    }
  }
  assert.equal(samples.length, 40, 'Every scheduled sample must be retained');
  assert(samples.every(sample => sample.success), 'Browser measurements contain failures; see raw measurements.json');
} finally {
  save();
  await browser?.close();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
}
