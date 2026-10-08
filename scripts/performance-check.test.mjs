import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performanceSettings, latencyStatistics, summarizeRequests, verifyOwnershipManifest, cleanupOwned, waitForApiReady, monitoringView } from './performance-check.mjs';

const isolated = {
  COMPOSE_PROJECT_NAME: 'gather-perf-ci', PERF_BASE_URL: 'http://127.0.0.1:18098',
  PERF_DB_HOST: '127.0.0.1', PERF_DB_PORT: '33306', PERF_DB_NAME: 'activity_platform_perf',
  PERF_DB_USERNAME: 'activity', PERF_DB_PASSWORD: 'sample-isolated-only', PERF_APP_SHA: 'a'.repeat(40),
};
const runId = 'b11c3f72-c2ac-4c2c-af48-890173990714';
const key = 'e42cbf73-9196-47b5-a7cd-9898d31ea0c8';
const manifest = () => ({ version: 1, runId, database: 'activity_platform_perf', project: 'gather-perf-ci', serverUuid: 'isolated-server', adminId: 1,
  users: [{ id: 3, index: '000', username: `perf_${runId.replaceAll('-', '')}_000`, displayName: `gather-performance:${runId}`, role: 'USER' }],
  activities: [{ id: 4, key, title: `Perf ${key}`, description: `gather-performance:${runId}:${key}` }] });

test('fixed baseline guard permits only explicitly isolated local targets and exact application revision', () => {
  const settings = performanceSettings(isolated);
  assert.equal(settings.base.origin, 'http://127.0.0.1:18098');
  assert.equal(settings.database.database, 'activity_platform_perf');
  for (const override of [
    { COMPOSE_PROJECT_NAME: 'gather-ci' }, { PERF_DB_NAME: 'activity_platform' },
    { PERF_DB_HOST: 'localhost' }, { PERF_DB_HOST: 'database.example.com' },
    { PERF_DB_PORT: '3306' }, { PERF_DB_USERNAME: 'root' }, { PERF_DB_PASSWORD: undefined },
    { PERF_BASE_URL: 'http://example.com:18098' }, { PERF_BASE_URL: 'http://127.0.0.1:8088' },
    { PERF_BASE_URL: 'http://secret:secret@127.0.0.1:18098' }, { PERF_BASE_URL: 'http://127.0.0.1:18098/api' },
    { PERF_BASE_URL: 'https://127.0.0.1:18098' }, { PERF_APP_SHA: 'latest' },
    { PERF_CPU_LIMIT: '4' }, { PERF_MEMORY_LIMIT: '2048m' },
  ]) assert.throws(() => performanceSettings({ ...isolated, ...override }));
});

test('application readiness waits for HTTP 200 and UP through bounded startup failures', async () => {
  let clock = 0;
  let attempts = 0;
  const waits = [];
  await waitForApiReady('http://127.0.0.1:18098', {
    now: () => clock,
    wait: async ms => { waits.push(ms); clock += ms; },
    fetchRequest: async (url, options) => {
      assert.equal(url.href, 'http://127.0.0.1:18098/api/health');
      assert(options.signal instanceof AbortSignal);
      assert.equal(options.redirect, 'manual');
      attempts++;
      if (attempts === 1) throw new Error('Unprinted connection details.');
      if (attempts === 2) return { status: 503, json: async () => ({ status: 'UP' }) };
      if (attempts === 3) return { status: 200, json: async () => ({ status: 'DOWN' }) };
      return { status: 200, json: async () => ({ status: 'UP' }) };
    },
  });
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [1000, 1000, 1000]);
});

test('application readiness refuses unavailable service at its 120-second deadline without exposing response data', async () => {
  let clock = 0;
  let attempts = 0;
  await assert.rejects(waitForApiReady('http://127.0.0.1:18098', {
    now: () => clock,
    wait: async ms => { clock += ms; },
    fetchRequest: async () => { attempts++; throw new Error('secret connection data'); },
  }), error => /within 120 seconds; no database table queries/.test(error.message) && !error.message.includes('secret'));
  assert.equal(clock, 120000);
  assert.equal(attempts, 120);
});

test('nearest rank percentiles use exact sample boundaries without interpolation or mutation', () => {
  const samples = Array.from({ length: 100 }, (_, i) => 100 - i);
  const stats = latencyStatistics(samples);
  assert.deepEqual(stats, { count: 100, min: 1, avg: 50.5, p50: 50, p95: 95, p99: 99, max: 100 });
  assert.equal(samples[0], 100);
  assert.deepEqual(latencyStatistics([0]), { count: 1, min: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 });
  assert.equal(latencyStatistics([1, 2, 3]).p50, 2);
  for (const invalid of [[], [NaN], [-1], [Infinity]]) assert.throws(() => latencyStatistics(invalid));
});

test('business HTTP 4xx stays distinct from 5xx and transport failures', () => {
  const summary = summarizeRequests([
    { status: 200, registrationStatus: 'ACTIVE', durationMs: 1 },
    { status: 200, registrationStatus: 'WAITING', durationMs: 2 },
    { status: 409, durationMs: 3 }, { status: 403, durationMs: 4 },
    { status: 503, durationMs: 5 }, { networkFailure: true, durationMs: 6 },
    { status: 302, durationMs: 7 },
  ], 1000);
  assert.equal(summary.throughputPerSecond, 7);
  assert.deepEqual(summary.stateCounts, { ACTIVE: 1, WAITING: 1 });
  assert.deepEqual(summary.statuses, { 200: 2, 302: 1, 403: 1, 409: 1, 503: 1 });
  assert.equal(summary.business4xx, 2);
  assert.equal(summary.system5xx, 1);
  assert.equal(summary.networkFailures, 1);
  assert.equal(summary.otherHttpFailures, 1);
  assert.equal(summary.systemErrorRate, 2 / 7);
  assert.equal(summary.businessRejectionRate, 2 / 7);
});

test('monitoring adapter refuses unavailable, coerced and malformed numeric fields or another JVM', () => {
  const metric = () => ({ scope: 'CURRENT_JVM', instanceId: 'gather-perf', totalRequests: 100,
    clientErrors: 2, serverErrors: 0, serverErrorRate: 0, averageDurationMs: 2.4,
    routes: [
      { method: 'POST', route: '/api/activities/{id}/registration', status: 200, count: 8, averageDurationMs: 2 },
      { method: 'POST', route: '/api/activities/{id}/registration', status: 400, count: 2, averageDurationMs: 3 },
    ], registrationLock: { count: 10, averageDurationMs: 1.5 }, databasePool: { active: 1, idle: 19, pending: 0, max: 20 } });
  assert.deepEqual(monitoringView(metric()), { signupCount: 10, lockCount: 10, lockTotalMs: 15,
    active: 1, pending: 0, max: 20, javaVersion: null });
  const empty = metric();
  empty.routes = [];
  empty.registrationLock = { count: 0, averageDurationMs: 0 };
  assert.equal(monitoringView(empty).signupCount, 0);
  for (const field of ['active', 'idle', 'pending', 'max']) for (const invalid of [null, undefined, '0', NaN, Infinity, -1, 1.5]) {
    const value = metric();
    value.databasePool[field] = invalid;
    assert.throws(() => monitoringView(value));
  }
  for (const field of ['totalRequests', 'clientErrors', 'serverErrors']) for (const invalid of [null, '1', NaN, Infinity, -1, 0.5]) {
    const value = metric();
    value[field] = invalid;
    assert.throws(() => monitoringView(value));
  }
  for (const invalid of [null, '1', NaN, Infinity, -1]) for (const change of [
    value => { value.averageDurationMs = invalid; },
    value => { value.routes[0].averageDurationMs = invalid; },
    value => { value.registrationLock.averageDurationMs = invalid; },
  ]) {
    const value = metric();
    change(value);
    assert.throws(() => monitoringView(value));
  }
  for (const invalid of [null, '1', NaN, Infinity, -1, 0.5]) for (const change of [
    value => { value.routes[0].count = invalid; },
    value => { value.registrationLock.count = invalid; },
  ]) {
    const value = metric();
    change(value);
    assert.throws(() => monitoringView(value));
  }
  for (const change of [
    value => { value.scope = 'GLOBAL'; }, value => { value.instanceId = 'backend-a'; },
    value => { value.databasePool.max = 0; }, value => { value.serverErrorRate = 2; },
    value => { value.registrationLock.averageDurationMs = Number.MAX_VALUE; },
  ]) {
    const value = metric();
    change(value);
    assert.throws(() => monitoringView(value));
  }
});

test('manifest validation refuses changed UUID ownership, USER role and cleanup destination', () => {
  verifyOwnershipManifest(manifest());
  for (const change of [
    value => { value.database = 'activity_platform'; },
    value => { value.project = 'gather-redis-ci'; },
    value => { value.runId = '../database'; },
    value => { value.users[0].username = 'demo'; },
    value => { value.users[0].role = 'ADMIN'; },
    value => { value.users[0].displayName = 'unowned'; },
    value => { value.activities[0].description = 'unowned'; },
    value => { value.activities[0].id = 0; },
    value => { value.activities.push({ ...value.activities[0] }); },
    value => { value.users.push({ ...value.users[0] }); },
  ]) {
    const value = manifest();
    change(value);
    assert.throws(() => verifyOwnershipManifest(value));
  }
});

function fakeDatabase({ changedActivity = false, unownedReference = false, unownedActivityReference = false,
  changedUserRole = false, changedServer = false } = {}) {
  const calls = [];
  const proof = manifest();
  let activityDeleted = false;
  let userDeleted = false;
  let registrationDeleted = false;
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('SELECT DATABASE')) return [[{ name: 'activity_platform_perf', serverUuid: changedServer ? 'other-server' : 'isolated-server' }]];
      return [[]];
    },
    async beginTransaction() { calls.push('BEGIN'); },
    async commit() { calls.push('COMMIT'); },
    async rollback() { calls.push('ROLLBACK'); },
    async execute(sql) {
      calls.push(sql);
      if (sql.startsWith('SELECT id, title')) return [activityDeleted ? [] : [{ id: 4, title: changedActivity ? 'original-user-data' : proof.activities[0].title,
        description: proof.activities[0].description, created_by: 1 }]];
      if (sql.startsWith('SELECT id, username')) return [userDeleted ? [] : [{ id: 3, username: proof.users[0].username,
        display_name: proof.users[0].displayName, role: changedUserRole ? 'ADMIN' : 'USER' }]];
      if (sql.startsWith('SELECT user_id')) return [registrationDeleted ? [] : [{ user_id: unownedReference ? 2 : 3 }]];
      if (sql.startsWith('SELECT activity_id')) return [registrationDeleted ? [] : [{ activity_id: unownedActivityReference ? 99 : 4 }]];
      if (sql.startsWith('SELECT id FROM activities')) return [[]];
      if (sql.startsWith('DELETE FROM registrations')) registrationDeleted = true;
      if (sql.startsWith('DELETE FROM activities')) activityDeleted = true;
      if (sql.startsWith('DELETE FROM users')) userDeleted = true;
      if (sql.startsWith('DELETE ')) return [{ affectedRows: 1 }];
      throw new Error('Unexpected fake database operation.');
    },
  };
}

test('cleanup refuses changed database identity before starting transaction or deleting', async () => {
  const db = fakeDatabase({ changedServer: true });
  await assert.rejects(cleanupOwned(db, manifest()), /identity changed/);
  assert(!db.calls.some(sql => sql === 'BEGIN' || sql.startsWith('DELETE ')));
});

test('cleanup validates all exact activity ownership and references before any DELETE', async () => {
  for (const options of [{ changedActivity: true }, { unownedReference: true }, { unownedActivityReference: true }, { changedUserRole: true }]) {
    const db = fakeDatabase(options);
    await assert.rejects(cleanupOwned(db, manifest()), /Cleanup refused/);
    assert(db.calls.includes('ROLLBACK'));
    assert(!db.calls.some(sql => sql.startsWith('DELETE ')));
  }
});

test('verified cleanup removes children before exact activities and users in one transaction', async () => {
  const db = fakeDatabase();
  assert.deepEqual(await cleanupOwned(db, manifest()), { activitiesRemoved: 1, usersRemoved: 1, registrationsRemoved: 1 });
  const deletions = db.calls.filter(sql => sql.startsWith('DELETE '));
  assert.match(deletions[0], /^DELETE FROM registrations WHERE activity_id = \?/);
  assert.match(deletions[1], /^DELETE FROM activities WHERE id = \?.*created_by = \?/);
  assert.match(deletions[2], /^DELETE FROM users WHERE id = \?.*role = 'USER'/);
  assert.equal(db.calls.at(-1), 'COMMIT');
});

test('round cleanup preserves synthetic users, persists exact IDs before DELETE and final cleanup is idempotent', async () => {
  const db = fakeDatabase();
  const proof = manifest();
  let persisted;
  const round = await cleanupOwned(db, proof, { activityIds: [4], deleteUsers: false, persistManifest: value => {
    assert(!db.calls.some(sql => sql.startsWith('DELETE ')));
    persisted = structuredClone(value.cleanupIntent);
  } });
  assert.deepEqual(round, { activitiesRemoved: 1, usersRemoved: 0, registrationsRemoved: 1 });
  assert.deepEqual(persisted, { activityIds: [4], userIds: [] });
  assert(!db.calls.some(sql => sql.startsWith('DELETE FROM users')));
  assert.deepEqual(await cleanupOwned(db, proof), { activitiesRemoved: 0, usersRemoved: 1, registrationsRemoved: 0 });
  const deletionCount = db.calls.filter(sql => sql.startsWith('DELETE ')).length;
  assert.deepEqual(await cleanupOwned(db, proof), { activitiesRemoved: 0, usersRemoved: 0, registrationsRemoved: 0 });
  assert.equal(db.calls.filter(sql => sql.startsWith('DELETE ')).length, deletionCount);
});

test('missing activity without persisted ownership intent and unowned round target are refused before deletion', async () => {
  const db = fakeDatabase();
  const proof = manifest();
  await assert.rejects(cleanupOwned(db, proof, { activityIds: [99], deleteUsers: false }), /unowned activity/);
  assert(!db.calls.some(sql => sql.startsWith('DELETE ')));
  await cleanupOwned(db, proof, { activityIds: [4], deleteUsers: false });
  delete proof.cleanupIntent;
  const before = db.calls.filter(sql => sql.startsWith('DELETE ')).length;
  await assert.rejects(cleanupOwned(db, proof), /without a verified cleanup intent/);
  assert.equal(db.calls.filter(sql => sql.startsWith('DELETE ')).length, before);
});
