import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolatedSettings, withActivityTableLock } from './redis-session-check.mjs';

const isolatedEnvironment = {
  COMPOSE_PROJECT_NAME: 'gather-redis-ci',
  E2E_DB_HOST: '127.0.0.1', E2E_DB_PORT: '33306', E2E_DB_NAME: 'activity_platform_e2e',
  E2E_DB_USERNAME: 'activity', E2E_DB_PASSWORD: 'sample-ci-only', REDIS_PASSWORD: 'sample-ci-only',
};

test('Redis lifecycle defaults target three distinct isolated loopback endpoints', () => {
  const settings = isolatedSettings(isolatedEnvironment);
  assert.equal(settings.web.origin, 'http://127.0.0.1:19088');
  assert.equal(settings.a.origin, 'http://127.0.0.1:19081');
  assert.equal(settings.b.origin, 'http://127.0.0.1:19082');
  assert.equal(settings.database.database, 'activity_platform_e2e');
});

test('Redis lifecycle rejects other projects/databases and remote or credential-bearing endpoints', () => {
  for (const override of [
    { COMPOSE_PROJECT_NAME: 'gather-ci' },
    { E2E_DB_NAME: 'activity_platform' },
    { E2E_DB_HOST: 'database.example.com' },
    { REDIS_TEST_A_URL: 'http://example.com:19081' },
    { REDIS_TEST_A_URL: 'http://user:secret@127.0.0.1:19081' },
    { REDIS_TEST_A_URL: 'https://127.0.0.1:19081' },
    { REDIS_TEST_A_URL: 'http://127.0.0.1:19088' },
  ]) assert.throws(() => isolatedSettings({ ...isolatedEnvironment, ...override }));
});

test('Redis lifecycle requires normal timeout/namespace and explicit isolated passwords', () => {
  for (const override of [
    { SESSION_TIMEOUT: '3s' }, { SESSION_NAMESPACE: 'other:session' },
    { SESSION_COOKIE_SECURE: 'true' },
    { E2E_DB_PASSWORD: undefined }, { REDIS_PASSWORD: undefined },
  ]) assert.throws(() => isolatedSettings({ ...isolatedEnvironment, ...override }));
});

test('isolated held-session verification always releases the activity lock, closes its connection and settles the admitted read', async () => {
  const events = [];
  const connection = { async query(sql) { events.push(sql); },
    async execute() { assert.fail('Fixed table-lock control statements cannot use prepared-statement execute.'); },
    async end() { events.push('CLOSE'); } };
  const result = await withActivityTableLock(connection, async () => { events.push('CHANGE'); return 'changed'; }, async () => { events.push('SETTLED'); });
  assert.equal(result, 'changed');
  assert.deepEqual(events, ['SET SESSION lock_wait_timeout=5', 'LOCK TABLES activities WRITE', 'CHANGE', 'UNLOCK TABLES', 'CLOSE', 'SETTLED']);
});

test('failure before or after locking preserves the original error and still closes and settles safely', async () => {
  for (const failLock of [false, true]) {
    const events = [];
    const original = new Error(failLock ? 'lock refused' : 'password verification failed');
    const connection = { async query(sql) { events.push(sql); if (failLock && sql.startsWith('LOCK')) throw original; },
      async end() { events.push('CLOSE'); } };
    await assert.rejects(withActivityTableLock(connection, async () => { throw original; }, async () => { events.push('SETTLED'); }), error => error === original);
    assert.equal(events.includes('UNLOCK TABLES'), !failLock);
    assert.deepEqual(events.slice(-2), ['CLOSE', 'SETTLED']);
  }
});

test('unlock and late-response failures are reported with the primary error instead of masking it or swallowing cleanup failure', async () => {
  const original = new Error('primary verification failed');
  const unlock = new Error('unlock failed');
  const late = new Error('late read failed');
  let closed = false;
  const connection = { async query(sql) { if (sql === 'UNLOCK TABLES') throw unlock; }, async end() { closed = true; } };
  await assert.rejects(withActivityTableLock(connection, async () => { throw original; }, async () => { throw late; }), error => {
    assert(error instanceof AggregateError); assert.deepEqual(error.errors, [original, unlock, late]); return true;
  });
  assert(closed);
});

test('changed lock-connection identity is refused before acquiring a table lock and the connection is closed', async () => {
  const events = [];
  const original = new Error('database identity changed');
  const connection = { async query(sql) { events.push(sql); }, async end() { events.push('CLOSE'); } };
  await assert.rejects(withActivityTableLock(connection, async () => { events.push('ACTION'); }, async () => { events.push('SETTLED'); },
    async () => { throw original; }), error => error === original);
  assert.deepEqual(events, ['CLOSE', 'SETTLED']);
});
