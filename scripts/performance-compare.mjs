import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { latencyStatistics, LOCK_QUERY_SQL, MEASUREMENT_CONTRACT, performanceOutput } from './performance-check.mjs';

export const BASELINE_SHA = 'ccfb35f04432d9b9d54996b84be3832ac55773f9';
const PHASES = ['A1', 'B1', 'B2', 'A2'];
const SCENARIOS = ['same-activity', 'different-activities'];
const CONCURRENCIES = [1, 10, 50];
const OUTPUT = resolve('.runtime/ci/comparison');
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const same = (actual, expected, label) => assert.deepEqual(actual, expected, label);

function close(actual, expected, label) {
  assert(nonnegative(actual) && Math.abs(actual - expected) <= 1e-8 * Math.max(1, expected), label);
}

function validateBatch(row) {
  assert(row && SCENARIOS.includes(row.scenario) && [1, 10, 50].includes(row.concurrency)
    && Number.isInteger(row.repeat) && row.repeat >= 1 && row.repeat <= 3, 'Batch identity is invalid.');
  assert.equal(row.requests, 100, 'Every batch must contain exactly 100 measured requests.');
  assert(positive(row.wallMs), 'Batch wall time must be concrete and positive.');
  assert(Array.isArray(row.latencySamplesMs) && row.latencySamplesMs.length === 100, 'All 100 raw client samples must be preserved.');
  const computed = latencyStatistics(row.latencySamplesMs);
  assert(row.latencyMs && row.latencyMs.count === 100, 'Client latency summary must contain 100 samples.');
  for (const field of ['min', 'avg', 'p50', 'p95', 'p99', 'max']) close(row.latencyMs[field], computed[field], 'Client statistics must match nearest-rank raw samples.');
  close(row.throughputPerSecond, 100000 / row.wallMs, 'Throughput must equal completed requests divided by batch wall seconds.');
  same(row.statuses, { 200: 100 }, 'Every measured response must be HTTP 200.');
  for (const field of ['business4xx', 'system5xx', 'networkFailures', 'otherHttpFailures', 'systemErrorRate', 'businessRejectionRate']) {
    assert.equal(row[field], 0, 'Missing or nonzero failure accounting refuses comparison.');
  }
  const sameActivity = row.scenario === 'same-activity';
  const active = sameActivity ? 10 : 100;
  const waiting = sameActivity ? 90 : 0;
  assert(row.stateCounts && row.stateCounts.ACTIVE === active && (row.stateCounts.WAITING ?? 0) === waiting
    && Object.keys(row.stateCounts).every(key => ['ACTIVE', 'WAITING'].includes(key)), 'Returned ACTIVE/WAITING counts differ from the scenario.');
  same(row.database, { active, waiting, registrations: 100, invariantsPassed: true }, 'Real MySQL invariant proof is missing.');
  assert(row.server && row.server.signupRequests === 100 && row.server.lockQueryCount === 100
    && nonnegative(row.server.lockQueryAverageMs), 'Server counter deltas and lock query duration must be concrete.');
  assert(integer(row.server.poolMax) && row.server.poolMax > 0
    && integer(row.server.sampledPoolPeakActive) && row.server.sampledPoolPeakActive <= row.server.poolMax
    && integer(row.server.sampledPoolPeakPending) && integer(row.server.poolSamples) && row.server.poolSamples >= 2
    && row.server.poolSampleIntervalMs === 200, 'Pool samples must include before/after and bounded periodic reads.');
  same(row.cleanup, { activitiesRemoved: sameActivity ? 1 : 100, usersRemoved: 0,
    registrationsRemoved: 100, baselineRowsPreserved: true }, 'Every batch must restore its exact prepared baseline.');
}

function validateReport(report, phase, currentSha) {
  assert(report && report.success === true && report.phase === phase && report.measurementContract === MEASUREMENT_CONTRACT,
    'Every phase must be successful and use the identical write-warmed timing contract.');
  assert(positive(Date.parse(report.startedAt)) && positive(Date.parse(report.completedAt))
    && Date.parse(report.completedAt) > Date.parse(report.startedAt), 'Each phase must record its actual start and completion times.');
  const env = report.environment;
  assert(env && env.appSha === (phase.startsWith('A') ? BASELINE_SHA : currentSha) && env.harnessSha === currentSha,
    'Comparison application and harness revisions must be exact expected commits.');
  assert(typeof env.hostname === 'string' && env.hostname.length > 0 && /^v24\./.test(env.node ?? '')
    && /^openjdk 21(?:\.|\s)/.test(env.java ?? '') && /^8\.4\./.test(env.mysql ?? '')
    && typeof env.os === 'string' && env.os.length > 0 && Array.isArray(env.cpuModels) && env.cpuModels.length > 0
    && env.cpuModels.every(model => typeof model === 'string' && model.length > 0)
    && integer(env.logicalCpus) && env.logicalCpus > 0 && positive(env.hostMemoryBytes), 'Actual runtime and host metadata must be present.');
  assert(typeof env.databaseServerUuid === 'string' && /^[0-9a-f-]{36}$/.test(env.databaseServerUuid)
    && digest(env.databaseBaselineSha256), 'Database server UUID and untouched seed snapshot fingerprint are required.');
  assert(env.project === 'gather-perf-ci' && env.database === 'activity_platform_perf' && env.sessionMode === 'memory'
    && env.loadGeneratorSharesHost === true && env.warmupGetRequests === 20 && env.warmupWriteRequests === 400
    && env.startsAfterHours === 48 && env.requestsPerBatch === 100 && env.repeats === 3 && env.samplingIntervalMs === 200,
  'Comparison conditions differ from the fixed isolated protocol.');
  same(env.concurrencies, CONCURRENCIES, 'Measured concurrency levels changed.');
  same(env.warmupConcurrencies, [1, 50], 'Write warmup concurrency levels changed.');
  same(env.roundBaselineRows, { users: 102, activities: 4, registrations: 0 }, 'Prepared data volume changed.');
  assert(env.clientTiming === 'fetch-start-through-complete-json-parse' && env.percentileMethod === 'nearest-rank', 'Latency timing or percentile definition changed.');
  same(env.measurementExcludes, ['login', 'activity-creation', 'warmup', 'database-assertions', 'cleanup'], 'Preparation must be excluded from measurement.');
  same(env.poolSamplesInclude, ['before', 'periodic', 'after'], 'Pool sampling definition changed.');
  for (const service of ['backend', 'mysql', 'web']) {
    const container = env.containers?.[service];
    assert(container && typeof container.image === 'string' && container.image.length > 0
      && /^sha256:[0-9a-f]{64}$/.test(container.imageId ?? ''), 'Actual Docker image identities are required.');
    if (service !== 'web') assert(container.cpuLimit === 2 && container.memoryLimitBytes === 1024 * 1024 * 1024,
      'Backend/MySQL resource limits must both be exactly 2 CPUs and 1024 MiB.');
    else assert(nonnegative(container.cpuLimit) && nonnegative(container.memoryLimitBytes), 'Actual web resource values are required.');
  }
  assert(env.containers.backend.sourceRevision === env.appSha && digest(env.containers.backend.jarSha256)
    && env.containers.backend.javaRuntime === env.java, 'Actual labeled running image and production JAR proof are required.');
  assert(Array.isArray(report.rounds) && report.rounds.length === 18 && Array.isArray(report.warmup)
    && report.warmup.length === 4, 'Each phase must contain all 18 measured batches and four independent warmup batches.');
  const keys = new Set();
  for (const row of report.rounds) {
    validateBatch(row);
    const key = `${row.scenario}/${row.concurrency}/${row.repeat}`;
    assert(!keys.has(key), 'Duplicate batch cannot substitute for a missing repeat.');
    keys.add(key);
  }
  for (const concurrency of CONCURRENCIES) for (const scenario of SCENARIOS) for (let repeat = 1; repeat <= 3; repeat++) {
    assert(keys.has(`${scenario}/${concurrency}/${repeat}`), 'The full scenario/concurrency/repeat grid is required.');
  }
  const warmupKeys = new Set();
  for (const row of report.warmup) {
    validateBatch(row);
    assert([1, 50].includes(row.concurrency) && row.repeat === 1, 'Unexpected warmup batch.');
    warmupKeys.add(`${row.scenario}/${row.concurrency}`);
  }
  assert.equal(warmupKeys.size, 4, 'Write warmup must cover both scenarios and both fixed concurrency levels.');
  const all = [...report.warmup, ...report.rounds];
  const activities = all.reduce((sum, row) => sum + row.cleanup.activitiesRemoved, 0);
  same(report.cleanup, { activitiesRemoved: 1, usersRemoved: 100, registrationsRemoved: 0,
    roundActivitiesRemoved: activities, roundRegistrationsRemoved: 2200, totalActivitiesRemoved: activities + 1,
    totalRegistrationsRemoved: 2200, completed: true, seedRowsPreserved: true }, 'Final exact cleanup and untouched seed rows must be proven.');
  const evidence = report.queryEvidence;
  assert(evidence && evidence.transactionIsolation === 'READ_COMMITTED' && evidence.active === 10 && evidence.waiting === 90
    && evidence.measuredThrough === 'direct-mysql-single-select' && evidence.excludedFromHttpMeasurementAndMetrics === true,
  'Actual SQL plan and single-statement handler evidence must use the validated warmup fixture outside HTTP timing.');
  for (const version of ['baseline', 'candidate']) {
    const query = evidence.queries?.[version];
    assert(query && query.sourceSql === LOCK_QUERY_SQL[version] && query.explainFormat === 'JSON'
      && query.plan?.query_block && query.resultRows === 1 && query.resultColumns === (version === 'baseline' ? 9 : 3)
      && query.countsExcludeExplain === true && integer(query.handlerDelta?.Handler_read_key)
      && integer(query.handlerDelta?.Handler_read_next), 'Both fixed production SQL plans/projections and actual handler deltas are required.');
  }
}

export function distribution(values) {
  assert(values.length > 0 && values.every(nonnegative), 'Distribution must contain actual finite values.');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { values, min: sorted[0], median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    max: sorted.at(-1) };
}

function groupStatistics(rows) {
  return { batches: rows.length, requests: rows.reduce((sum, row) => sum + row.requests, 0),
    throughputPerSecond: distribution(rows.map(row => row.throughputPerSecond)),
    batchP95Ms: distribution(rows.map(row => row.latencyMs.p95)),
    batchLockQueryAverageMs: distribution(rows.map(row => row.server.lockQueryAverageMs)),
    pooledClientLatencyMs: latencyStatistics(rows.flatMap(row => row.latencySamplesMs)),
    lockQueryWeightedAverageMs: rows.reduce((sum, row) => sum + row.server.lockQueryAverageMs * row.server.lockQueryCount, 0)
      / rows.reduce((sum, row) => sum + row.server.lockQueryCount, 0),
    poolSamples: rows.map(row => ({ active: row.server.sampledPoolPeakActive, pending: row.server.sampledPoolPeakPending,
      samples: row.server.poolSamples })) };
}

function percentChange(before, after) {
  // A missing/zero baseline cannot be turned into a fabricated zero-percent improvement.
  return before > 0 ? (after / before - 1) * 100 : null;
}

export function comparePerformanceReports(reports, currentSha) {
  assert(sha(currentSha) && currentSha !== BASELINE_SHA, 'Candidate must be an exact distinct 40-character application commit.');
  assert(Array.isArray(reports) && reports.length === 4, 'All four A1/B1/B2/A2 phases are required.');
  for (let i = 0; i < PHASES.length; i++) validateReport(reports[i], PHASES[i], currentSha);
  const reference = reports[0].environment;
  for (let i = 1; i < reports.length; i++) {
    const env = reports[i].environment;
    assert(Date.parse(reports[i - 1].completedAt) <= Date.parse(reports[i].startedAt), 'Stages must execute sequentially in A-B-B-A order.');
    for (const field of ['hostname', 'node', 'java', 'mysql', 'os', 'cpuModels', 'logicalCpus', 'hostMemoryBytes',
      'databaseServerUuid', 'databaseBaselineSha256']) same(env[field], reference[field], 'All phases must retain the same verified host, runtimes and database.');
    for (const service of ['mysql', 'web']) same(env.containers[service], reference.containers[service], 'MySQL/web images and resources must be identical across phases.');
  }
  for (const pair of [[0, 3], [1, 2]]) same(reports[pair[0]].environment.containers.backend,
    reports[pair[1]].environment.containers.backend, 'Each source version must run the exact same image and JAR in both stages.');
  assert(reports[0].environment.containers.backend.jarSha256 !== reports[1].environment.containers.backend.jarSha256,
    'Baseline and candidate production JARs must be distinct measured artifacts.');
  const groups = [];
  for (const concurrency of CONCURRENCIES) for (const scenario of SCENARIOS) {
    const stages = reports.map(report => ({ phase: report.phase,
      ...groupStatistics(report.rounds.filter(row => row.scenario === scenario && row.concurrency === concurrency)) }));
    const baseline = groupStatistics([reports[0], reports[3]].flatMap(report => report.rounds.filter(row => row.scenario === scenario && row.concurrency === concurrency)));
    const candidate = groupStatistics([reports[1], reports[2]].flatMap(report => report.rounds.filter(row => row.scenario === scenario && row.concurrency === concurrency)));
    const pairedChanges = [[stages[0], stages[1]], [stages[3], stages[2]]].map(([before, after]) => ({
      baselinePhase: before.phase, candidatePhase: after.phase,
      throughputPercent: percentChange(before.throughputPerSecond.median, after.throughputPerSecond.median),
      batchP95Percent: percentChange(before.batchP95Ms.median, after.batchP95Ms.median),
      lockQueryAveragePercent: percentChange(before.batchLockQueryAverageMs.median, after.batchLockQueryAverageMs.median),
    }));
    groups.push({ scenario, concurrency, stages, baseline, candidate, pairedChanges,
      changePercent: { throughputMedian: percentChange(baseline.throughputPerSecond.median, candidate.throughputPerSecond.median),
        batchP95Median: percentChange(baseline.batchP95Ms.median, candidate.batchP95Ms.median),
        lockQueryAverage: percentChange(baseline.lockQueryWeightedAverageMs, candidate.lockQueryWeightedAverageMs) },
      observations: { bothPairsHigherThroughput: pairedChanges.every(pair => pair.throughputPercent > 0),
        bothPairsLowerP95: pairedChanges.every(pair => pair.batchP95Percent < 0),
        batchP95RangesOverlap: Math.max(baseline.batchP95Ms.min, candidate.batchP95Ms.min)
          <= Math.min(baseline.batchP95Ms.max, candidate.batchP95Ms.max) } });
  }
  return { success: true, measurementContract: MEASUREMENT_CONTRACT, order: PHASES,
    baselineSha: BASELINE_SHA, currentSha, measuredRequests: 7200, warmupRequests: 1600,
    groups, reports, limitations: [
      'Same shared CI host, not dedicated hardware; generator, MySQL, backend and sampling compete for resources.',
      'A-B-B-A reduces simple order bias but does not eliminate JIT, operating-system or database buffer variation.',
      'Batch P95 median/range summarize batch-level percentiles; pooled client percentiles use all 600 raw samples per version/group.',
      'Lock query duration includes SQL execution and lock waiting; pool values are sampled maxima, not absolute peaks.',
      'No confidence level, stable production capacity or causal bottleneck claim follows from these samples alone.',
    ] };
}

export function comparisonMarkdown(result) {
  const number = value => value.toFixed(2);
  const change = value => value === null ? '不可计算' : `${value >= 0 ? '+' : ''}${number(value)}%`;
  const range = value => `${number(value.median)} [${number(value.min)}, ${number(value.max)}]`;
  const lines = ['# 报名查询 A-B-B-A 实测对照', '', `基线：${result.baselineSha}；候选：${result.currentSha}。`,
    '', '同一 runner、同一 MySQL 数据库和 Web 镜像；后端每段重新启动，相同实际 CPU/内存限制。',
    '顺序 A1 → B1 → B2 → A2；每段 400 次独立写预热 + 18 批正式测量，共 1600 次预热和 7200 次正式报名。',
    '全部原始客户端样本、阶段环境、错误分类、SQL 人数不变量与精确清理结果保存在 comparison.json 及四份原报告。',
    '', '## 六批/版本的分布', '',
    '每格是六批中位数 [最小值, 最大值]；Δ 为候选相对基线，吞吐增加为正、耗时增加为正。未挑选最快批。', '',
    '| 场景 | 并发 | A req/s | B req/s | Δ 吞吐 | A 批 P95 ms | B 批 P95 ms | Δ 批 P95 | A/B 锁查询加权均值 ms |',
    '|---|---:|---|---|---:|---|---|---:|---|'];
  for (const group of result.groups) lines.push(`| ${group.scenario} | ${group.concurrency} | ${range(group.baseline.throughputPerSecond)} | ${range(group.candidate.throughputPerSecond)} | ${change(group.changePercent.throughputMedian)} | ${range(group.baseline.batchP95Ms)} | ${range(group.candidate.batchP95Ms)} | ${change(group.changePercent.batchP95Median)} | ${number(group.baseline.lockQueryWeightedAverageMs)}/${number(group.candidate.lockQueryWeightedAverageMs)} |`);
  lines.push('', '## 各阶段三批分布', '', '| 场景 | 并发 | 阶段 | req/s 中位数 [范围] | 批 P95 ms 中位数 [范围] | 锁查询均值 ms 中位数 [范围] |', '|---|---:|---|---|---|---|');
  for (const group of result.groups) for (const stage of group.stages) lines.push(`| ${group.scenario} | ${group.concurrency} | ${stage.phase} | ${range(stage.throughputPerSecond)} | ${range(stage.batchP95Ms)} | ${range(stage.batchLockQueryAverageMs)} |`);
  lines.push('', '## 两次相邻版本对照', '', '| 场景 | 并发 | 对照 | Δ 吞吐 | Δ 批 P95 | Δ 锁查询批均值 |', '|---|---:|---|---:|---:|---:|');
  for (const group of result.groups) for (const pair of group.pairedChanges) lines.push(`| ${group.scenario} | ${group.concurrency} | ${pair.baselinePhase}/${pair.candidatePhase} | ${change(pair.throughputPercent)} | ${change(pair.batchP95Percent)} | ${change(pair.lockQueryAveragePercent)} |`);
  lines.push('', '## 独立 SQL 证据', '', '每段使用已验证 10 ACTIVE / 90 WAITING 的同活动预热数据，READ COMMITTED 下按固定旧/新 SQL 各读一次，单连接无并发写，随后 ROLLBACK。Handler 差分排除 EXPLAIN；这不是 HTTP 延迟或纯锁等待测量。', '',
    '| 阶段 | 旧列/新列 | 旧 Handler_read_key/next | 新 Handler_read_key/next |', '|---|---|---|---|');
  for (const report of result.reports) {
    const old = report.queryEvidence.queries.baseline;
    const current = report.queryEvidence.queries.candidate;
    lines.push(`| ${report.phase} | ${old.resultColumns}/${current.resultColumns} | ${old.handlerDelta.Handler_read_key}/${old.handlerDelta.Handler_read_next} | ${current.handlerDelta.Handler_read_key}/${current.handlerDelta.Handler_read_next} |`);
  }
  lines.push('', '完整 EXPLAIN JSON 保存在四份原报告；应区分覆盖索引扫描与全表扫描，不把减少扫描行数直接等同于端到端提升。', '',
    '## 结果边界', '', '以下只是本次有限样本的方向检查，不代表统计显著性：');
  for (const group of result.groups) lines.push(`- ${group.scenario} / 并发 ${group.concurrency}：两对吞吐均更高=${group.observations.bothPairsHigherThroughput}；两对 P95 均更低=${group.observations.bothPairsLowerP95}；批 P95 范围重叠=${group.observations.batchP95RangesOverlap}。`);
  lines.push('', ...result.limitations.map(text => `- ${text}`), '',
    '方向不一致或范围重叠时，应报告“本轮未证明稳定收益”。即便方向一致，也只能陈述该受限环境中的观测结果，不能外推生产容量。');
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const reports = PHASES.map(phase => JSON.parse(readFileSync(resolve(performanceOutput(phase), 'performance.json'), 'utf8')));
    const result = comparePerformanceReports(reports, process.env.PERF_CURRENT_SHA ?? process.env.GITHUB_SHA);
    mkdirSync(OUTPUT, { recursive: true });
    writeFileSync(resolve(OUTPUT, 'comparison.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    writeFileSync(resolve(OUTPUT, 'comparison.md'), comparisonMarkdown(result), 'utf8');
    console.log('PASS: A-B-B-A comparison verified 7200 measured requests, 1600 warmup requests, all raw samples and exact cleanup.');
  } catch (error) {
    console.error(error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Comparison artifacts were missing or invalid.');
    process.exitCode = 1;
  }
}
