import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latencyStatistics, LOCK_QUERY_SQL, MEASUREMENT_CONTRACT } from './performance-check.mjs';
import { BASELINE_SHA, comparePerformanceReports, comparisonMarkdown, distribution } from './performance-compare.mjs';

const candidateSha = 'b'.repeat(40);
const phases = ['A1', 'B1', 'B2', 'A2'];

function batch(scenario, concurrency, repeat, factor = 1) {
  const samples = Array.from({ length: 100 }, (_, index) => factor * (index + 1));
  const same = scenario === 'same-activity';
  return { scenario, concurrency, repeat, requests: 100, wallMs: 1000 * factor, throughputPerSecond: 100 / factor,
    latencySamplesMs: samples, latencyMs: latencyStatistics(samples), statuses: { 200: 100 },
    stateCounts: same ? { ACTIVE: 10, WAITING: 90 } : { ACTIVE: 100 }, business4xx: 0, system5xx: 0,
    networkFailures: 0, otherHttpFailures: 0, systemErrorRate: 0, businessRejectionRate: 0,
    database: { active: same ? 10 : 100, waiting: same ? 90 : 0, registrations: 100, invariantsPassed: true },
    server: { signupRequests: 100, lockQueryCount: 100, lockQueryAverageMs: 2 * factor, poolMax: 20,
      sampledPoolPeakActive: concurrency > 1 ? 20 : 1, sampledPoolPeakPending: concurrency > 20 ? 30 : 0,
      poolSamples: 7, poolSampleIntervalMs: 200 },
    cleanup: { activitiesRemoved: same ? 1 : 100, usersRemoved: 0, registrationsRemoved: 100, baselineRowsPreserved: true } };
}

function reports() {
  return phases.map((phase, index) => {
    const isBaseline = phase.startsWith('A');
    const rows = [];
    for (const concurrency of [1, 10, 50]) for (const scenario of ['same-activity', 'different-activities']) for (let repeat = 1; repeat <= 3; repeat++) {
      rows.push(batch(scenario, concurrency, repeat, isBaseline ? repeat : repeat * 0.8));
    }
    const warmup = [];
    for (const concurrency of [1, 50]) for (const scenario of ['same-activity', 'different-activities']) warmup.push(batch(scenario, concurrency, 1));
    return { success: true, phase, measurementContract: MEASUREMENT_CONTRACT,
      startedAt: new Date(Date.UTC(2026, 9, 9, 1, index * 10)).toISOString(),
      completedAt: new Date(Date.UTC(2026, 9, 9, 1, index * 10 + 5)).toISOString(),
      environment: { appSha: isBaseline ? BASELINE_SHA : candidateSha, harnessSha: candidateSha,
        hostname: 'same-isolated-runner', node: 'v24.21.0', java: 'openjdk 21.0.10 2026-01-20 LTS', mysql: '8.4.11',
        os: 'linux test-kernel', cpuModels: ['test-cpu'], logicalCpus: 4, hostMemoryBytes: 8 * 1024 ** 3,
        databaseServerUuid: 'b11c3f72-c2ac-4c2c-af48-890173990714', databaseBaselineSha256: 'e'.repeat(64),
        project: 'gather-perf-ci', database: 'activity_platform_perf', sessionMode: 'memory', loadGeneratorSharesHost: true,
        warmupGetRequests: 20, warmupWriteRequests: 400, warmupConcurrencies: [1, 50], startsAfterHours: 48,
        requestsPerBatch: 100, repeats: 3, samplingIntervalMs: 200, concurrencies: [1, 10, 50],
        roundBaselineRows: { users: 102, activities: 4, registrations: 0 },
        clientTiming: 'fetch-start-through-complete-json-parse', percentileMethod: 'nearest-rank',
        measurementExcludes: ['login', 'activity-creation', 'warmup', 'database-assertions', 'cleanup'],
        poolSamplesInclude: ['before', 'periodic', 'after'],
        containers: {
          backend: { image: isBaseline ? 'gather-baseline' : 'gather-candidate', imageId: `sha256:${(isBaseline ? 'a' : 'b').repeat(64)}`,
            cpuLimit: 2, memoryLimitBytes: 1024 ** 3, sourceRevision: isBaseline ? BASELINE_SHA : candidateSha,
            jarSha256: (isBaseline ? 'a' : 'b').repeat(64), javaRuntime: 'openjdk 21.0.10 2026-01-20 LTS' },
          mysql: { image: 'mysql:8.4.11', imageId: `sha256:${'c'.repeat(64)}`, cpuLimit: 2, memoryLimitBytes: 1024 ** 3 },
          web: { image: 'gather-web', imageId: `sha256:${'d'.repeat(64)}`, cpuLimit: 0, memoryLimitBytes: 0 },
        } },
      rounds: rows, warmup,
      queryEvidence: { transactionIsolation: 'READ_COMMITTED', active: 10, waiting: 90,
        measuredThrough: 'direct-mysql-single-select', excludedFromHttpMeasurementAndMetrics: true,
        queries: Object.fromEntries(Object.entries(LOCK_QUERY_SQL).map(([version, sourceSql]) => [version, {
          sourceSql, explainFormat: 'JSON', plan: { query_block: { table: { table_name: 'activities' } } },
          resultRows: 1, resultColumns: version === 'baseline' ? 9 : 3, countsExcludeExplain: true,
          handlerDelta: { Handler_read_key: version === 'baseline' ? 2 : 1, Handler_read_next: version === 'baseline' ? 90 : 0 },
        }])) },
      cleanup: { activitiesRemoved: 1, usersRemoved: 100, registrationsRemoved: 0, roundActivitiesRemoved: 1111,
        roundRegistrationsRemoved: 2200, totalActivitiesRemoved: 1112, totalRegistrationsRemoved: 2200,
        completed: true, seedRowsPreserved: true } };
  });
}

test('complete comparison retains all six batches per version/group and calculates pooled percentiles from all raw samples', () => {
  const result = comparePerformanceReports(reports(), candidateSha);
  assert.equal(result.measuredRequests, 7200);
  assert.equal(result.warmupRequests, 1600);
  assert.equal(result.groups.length, 6);
  const group = result.groups[0];
  assert.equal(group.baseline.batches, 6);
  assert.equal(group.baseline.requests, 600);
  assert.deepEqual(group.baseline.throughputPerSecond.values, [100, 50, 100 / 3, 100, 50, 100 / 3]);
  assert.equal(group.baseline.throughputPerSecond.median, 50);
  assert.equal(group.baseline.batchP95Ms.median, 190);
  assert.equal(group.baseline.pooledClientLatencyMs.count, 600);
  assert.equal(group.baseline.pooledClientLatencyMs.p95, 255);
  assert.equal(group.baseline.lockQueryWeightedAverageMs, 4);
  assert.equal(group.changePercent.throughputMedian, 25);
  assert(Math.abs(group.changePercent.batchP95Median + 20) < 1e-9);
  assert(group.observations.bothPairsHigherThroughput && group.observations.bothPairsLowerP95);
  const markdown = comparisonMarkdown(result);
  assert(markdown.includes('A1/A') === false);
  assert(markdown.includes('A1/B1') && markdown.includes('A2/B2'));
  assert(markdown.includes('未挑选最快批') && markdown.includes('不能外推生产容量'));
});

test('missing or coerced values, raw samples, failures and cleanup evidence refuse comparison', () => {
  for (const change of [
    r => { delete r[0].environment.hostname; },
    r => { r[0].environment.containers.backend.jarSha256 = null; },
    r => { r[0].rounds[0].server.lockQueryAverageMs = null; },
    r => { r[0].rounds[0].server.lockQueryAverageMs = '0'; },
    r => { delete r[0].rounds[0].business4xx; },
    r => { r[0].rounds[0].system5xx = 1; },
    r => { r[0].rounds[0].server.poolSamples = 1; },
    r => { r[0].rounds[0].latencySamplesMs.pop(); },
    r => { r[0].rounds[0].latencyMs.p95 = 0; },
    r => { r[0].rounds[0].cleanup.baselineRowsPreserved = false; },
    r => { r[0].cleanup.seedRowsPreserved = false; },
    r => { r[0].warmup.pop(); },
    r => { delete r[0].queryEvidence; },
    r => { r[0].queryEvidence.queries.baseline.handlerDelta.Handler_read_next = null; },
    r => { r[0].rounds[1] = structuredClone(r[0].rounds[0]); },
    r => { r[0].success = false; },
  ]) {
    const input = reports();
    change(input);
    assert.throws(() => comparePerformanceReports(input, candidateSha));
  }
});

test('wrong source, JAR, environment, database or stage order cannot produce a before/after claim', () => {
  for (const change of [
    r => { r[1].environment.appSha = 'c'.repeat(40); },
    r => { r[1].environment.harnessSha = BASELINE_SHA; },
    r => { r[1].environment.containers.backend.sourceRevision = BASELINE_SHA; },
    r => { r[2].environment.containers.backend.jarSha256 = 'f'.repeat(64); },
    r => { r[1].environment.hostname = 'another-runner'; },
    r => { r[1].environment.databaseServerUuid = 'a11c3f72-c2ac-4c2c-af48-890173990714'; },
    r => { r[1].environment.databaseBaselineSha256 = 'f'.repeat(64); },
    r => { r[1].environment.containers.mysql.imageId = `sha256:${'f'.repeat(64)}`; },
    r => { r[1].environment.containers.backend.cpuLimit = 4; },
    r => { r[1].environment.containers.mysql.memoryLimitBytes = 2 * 1024 ** 3; },
    r => { r[1].environment.warmupWriteRequests = 200; },
    r => { r[1].startedAt = r[0].startedAt; },
    r => { [r[1], r[2]] = [r[2], r[1]]; },
  ]) {
    const input = reports();
    change(input);
    assert.throws(() => comparePerformanceReports(input, candidateSha));
  }
  assert.throws(() => comparePerformanceReports(reports().slice(0, 3), candidateSha));
  assert.throws(() => comparePerformanceReports(reports(), 'latest'));
});

test('conflicting adjacent-pair directions stay explicit rather than becoming a stable improvement conclusion', () => {
  const input = reports();
  input[2].rounds = input[2].rounds.map(row => batch(row.scenario, row.concurrency, row.repeat, row.repeat * 1.2));
  const result = comparePerformanceReports(input, candidateSha);
  assert(result.groups.every(group => !group.observations.bothPairsHigherThroughput && !group.observations.bothPairsLowerP95));
  assert(result.groups.every(group => group.pairedChanges[0].batchP95Percent < 0 && group.pairedChanges[1].batchP95Percent > 0));
  assert.equal(result.reports[2].rounds[0].latencySamplesMs.at(-1), 120);
});

test('ordinary distribution median uses the middle pair and refuses missing measurements', () => {
  assert.deepEqual(distribution([3, 1, 2, 4]), { values: [3, 1, 2, 4], min: 1, median: 2.5, max: 4 });
  for (const values of [[], [null], [undefined], ['0'], [NaN], [-1]]) assert.throws(() => distribution(values));
});
