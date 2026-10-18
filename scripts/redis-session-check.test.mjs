import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolatedSettings, withActivityRowLock, settleImmediately, decodeOwnedSessionCookie, ownedSessionHashProbe } from './redis-session-check.mjs';

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

const ownedSessionId = '12345678-1234-4567-89ab-123456789abc';
const inspectedRedis = () => ({ containerId: 'a'.repeat(64), namespace: 'gather:session' });

test('owned Redis session cookies permit only a single canonical UUID or its exact standard Base64 encoding', () => {
  assert.equal(decodeOwnedSessionCookie(ownedSessionId), ownedSessionId);
  assert.equal(decodeOwnedSessionCookie(Buffer.from(ownedSessionId).toString('base64')), ownedSessionId);
  for (const value of [undefined, '', '*', `${ownedSessionId}.route`, `${ownedSessionId};other=value`,
    ownedSessionId.toUpperCase(), Buffer.from(`${ownedSessionId}.route`).toString('base64'),
    ` ${Buffer.from(ownedSessionId).toString('base64')}`, Buffer.from(ownedSessionId.replace('-4567-', '-1567-')).toString('base64'),
    Buffer.from('gather:session:sessions:*').toString('base64')]) {
    assert.throws(() => decodeOwnedSessionCookie(value), error => !value || !error.message.includes(value));
  }
});

test('partial-hash probes fix the inspected container and exact owned key, allow only required fields and keep credentials out of arguments', () => {
  const calls = [], identity = inspectedRedis();
  const ownHash = ownedSessionHashProbe(identity, (program, args, options) => { calls.push({ program, args, options }); return '1\n'; });
  identity.containerId = 'b'.repeat(64); identity.namespace = 'other';
  const cookie = Buffer.from(ownedSessionId).toString('base64');
  const hash = ownHash(cookie);
  assert.equal(hash.exists(), 1);
  for (const field of ['creationTime', 'lastAccessedTime', 'maxInactiveInterval']) {
    assert.equal(hash.hasRequired(field), 1); assert.equal(hash.omitRequired(field), 1);
  }
  assert.throws(() => ownHash(cookie), /newly created dedicated session/);
  assert.equal(calls.length, 7);
  for (const call of calls) {
    assert.equal(call.program, 'docker');
    assert.deepEqual(call.args, ['exec', '-i', 'a'.repeat(64), 'sh', '-c', 'REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli --raw']);
    assert.match(call.options.input, new RegExp(`^(?:EXISTS gather:session:sessions:${ownedSessionId}|(?:HEXISTS|HDEL) gather:session:sessions:${ownedSessionId} (?:creationTime|lastAccessedTime|maxInactiveInterval))\\n$`));
    assert(!call.args.join(' ').includes(ownedSessionId));
    assert(!call.args.includes('-a'));
    assert.equal(call.options.timeout, 10000); assert.equal(call.options.maxBuffer, 1024);
    assert.equal(call.options.stdio, 'pipe'); assert.equal(call.options.windowsHide, true);
  }
  for (const field of ['*', 'sessionAttr:SPRING_SECURITY_CONTEXT', 'creationTime\nFLUSHDB', undefined]) {
    assert.throws(() => hash.hasRequired(field)); assert.throws(() => hash.omitRequired(field));
  }
  assert.equal(calls.length, 7, 'Refused fields must never dispatch a Docker command.');
});

test('partial-hash probes refuse unverified targets and malformed ownership before invoking Docker', () => {
  let calls = 0;
  const execute = () => { calls++; return '1\n'; };
  for (const identity of [undefined, {}, { ...inspectedRedis(), namespace: 'shared:session' },
    { ...inspectedRedis(), containerId: 'redis' }, { ...inspectedRedis(), containerId: '-all' }]) {
    assert.throws(() => ownedSessionHashProbe(identity, execute));
  }
  const ownHash = ownedSessionHashProbe(inspectedRedis(), execute);
  for (const cookie of ['*', `${ownedSessionId}\nDEL other`, 'not-a-session']) assert.throws(() => ownHash(cookie));
  assert.equal(calls, 0);
});

test('partial-hash Redis failures and non-integer output never expose a key, cookie or subprocess diagnostic', () => {
  const secret = 'PRIVATE redis password command details';
  for (const output of ['0\n', '1\r\n']) {
    const hash = ownedSessionHashProbe(inspectedRedis(), () => output)(ownedSessionId);
    assert.equal(hash.exists(), Number(output.trim()));
  }
  for (const execute of [() => { throw new Error(`${secret} ${ownedSessionId}`); },
    ...['', '2\n', `1\n${secret}`, `${ownedSessionId}\n`, '1\n0\n'].map(output => () => output)]) {
    const hash = ownedSessionHashProbe(inspectedRedis(), execute)(ownedSessionId);
    assert.throws(() => hash.exists(), error => !error.message.includes(secret) && !error.message.includes(ownedSessionId));
  }
});

function rowLockConnection(events, { rows = [{ id: 7 }], failLock, failRollback, failClose } = {}) {
  return {
    async execute(sql, values) {
      events.push({ sql, values });
      if (sql.endsWith('FOR UPDATE')) {
        if (failLock) throw failLock;
        return [rows];
      }
      return [];
    },
    async query() { assert.fail('The owned row-lock experiment must never use broad text-protocol table locks.'); },
    async beginTransaction() { events.push('BEGIN'); },
    async rollback() { events.push('ROLLBACK'); if (failRollback) throw failRollback; },
    async end() { events.push('CLOSE'); if (failClose) throw failClose; },
  };
}

test('isolated held-session verification locks only the bound activity primary key and rolls back before settling the admitted signup', async () => {
  const events = [];
  const result = await withActivityRowLock(rowLockConnection(events), 7,
    async () => { events.push('CHANGE'); return 'changed'; }, async () => { events.push('SETTLED'); });
  assert.equal(result, 'changed');
  assert.deepEqual(events, [
    { sql: 'SET SESSION innodb_lock_wait_timeout=5', values: undefined },
    { sql: 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', values: undefined }, 'BEGIN',
    { sql: 'SELECT id FROM activities WHERE id=? FOR UPDATE', values: [7] },
    'CHANGE', 'ROLLBACK', 'CLOSE', 'SETTLED',
  ]);
});

test('failure before or after locking preserves the original error and still closes and settles safely', async () => {
  for (const failLock of [false, true]) {
    const events = [];
    const original = new Error(failLock ? 'lock refused' : 'password verification failed');
    const connection = rowLockConnection(events, { failLock: failLock ? original : undefined });
    await assert.rejects(withActivityRowLock(connection, 7, async () => { throw original; },
      async () => { events.push('SETTLED'); }), error => error === original);
    assert(events.includes('ROLLBACK'));
    assert.deepEqual(events.slice(-2), ['CLOSE', 'SETTLED']);
  }
});

test('rollback, connection-close and late-response failures retain the primary error and attempt every cleanup', async () => {
  const original = new Error('primary verification failed');
  const rollback = new Error('rollback failed');
  const close = new Error('connection close failed');
  const late = new Error('late signup failed');
  const events = [];
  const connection = rowLockConnection(events, { failRollback: rollback, failClose: close });
  await assert.rejects(withActivityRowLock(connection, 7, async () => { throw original; },
    async () => { events.push('SETTLED'); throw late; }), error => {
    assert(error instanceof AggregateError); assert.deepEqual(error.errors, [original, rollback, close, late]); return true;
  });
  assert.deepEqual(events.slice(-3), ['ROLLBACK', 'CLOSE', 'SETTLED']);
});

test('changed lock-connection identity is refused before starting a transaction and the connection is closed', async () => {
  const events = [];
  const original = new Error('database identity changed');
  const connection = rowLockConnection(events);
  await assert.rejects(withActivityRowLock(connection, 7, async () => { events.push('ACTION'); }, async () => { events.push('SETTLED'); },
    async () => { throw original; }), error => error === original);
  assert.deepEqual(events, ['CLOSE', 'SETTLED']);
});

test('invalid or missing activity IDs never admit the held request, and existing transactions always roll back', async () => {
  for (const id of [0, -1, '7', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const events = [];
    await assert.rejects(withActivityRowLock(rowLockConnection(events), id,
      async () => { assert.fail('Invalid activity ID admitted a request.'); }, async () => { events.push('SETTLED'); }));
    assert.deepEqual(events, ['CLOSE', 'SETTLED']);
  }
  for (const rows of [[], [{ id: 8 }], [{ id: 7 }, { id: 8 }]]) {
    const events = [];
    await assert.rejects(withActivityRowLock(rowLockConnection(events, { rows }), 7,
      async () => { assert.fail('Missing exact activity row admitted a request.'); }, async () => { events.push('SETTLED'); }));
    assert.deepEqual(events.slice(-3), ['ROLLBACK', 'CLOSE', 'SETTLED']);
  }
});

test('an early rejected held request is observed immediately and remains available for final cleanup error reporting', async () => {
  const original = new Error('held request timed out before password response');
  const pending = settleImmediately(Promise.reject(original));
  await new Promise(resolve => setImmediate(resolve));
  const outcome = await pending;
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.reason, original);
});
