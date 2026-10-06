import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseConfig, deleteOwnedFixtures, verifyDatabase, renameManifestWithRetry } from './e2e-cleanup.mjs';

function fakeDatabase(activities, registrations = [], failDeleteId) {
  const state = { activities: structuredClone(activities), registrations: structuredClone(registrations), queries: [], rollbacks: 0, commits: 0 };
  let snapshot;
  return {
    state,
    async beginTransaction() { snapshot = structuredClone({ activities: state.activities, registrations: state.registrations }); },
    async commit() { state.commits++; },
    async rollback() { Object.assign(state, snapshot); state.rollbacks++; },
    async execute(sql, parameters = []) {
      state.queries.push({ sql, parameters });
      if (sql.startsWith('SET TRANSACTION')) return [];
      if (sql.startsWith('SELECT id FROM activities')) {
        return [state.activities.filter(row => row.title === parameters[0] && row.description === parameters[1]).slice(0, 2).map(row => ({ id: row.id }))];
      }
      if (sql.startsWith('SELECT id, title')) return [state.activities.filter(row => row.id === parameters[0])];
      if (sql.startsWith('DELETE FROM registrations')) {
        const previous = state.registrations.length;
        state.registrations = state.registrations.filter(row => row.activity_id !== parameters[0]);
        return [{ affectedRows: previous - state.registrations.length }];
      }
      if (sql.startsWith('DELETE FROM activities')) {
        if (parameters[0] === failDeleteId) throw new Error('Simulated database failure during cleanup');
        const previous = state.activities.length;
        state.activities = state.activities.filter(row => !(row.id === parameters[0] && row.title === parameters[1] && row.description === parameters[2]));
        return [{ affectedRows: previous - state.activities.length }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

const fixture = (id, title = `test ${id}`) => ({ id, title, description: `unique ownership marker ${id}` });

test('cleanup rejects remote/unknown database targets and requires explicit credentials', () => {
  const environment = {
    E2E_DB_HOST: '127.0.0.1', E2E_DB_PORT: '3307', E2E_DB_NAME: 'activity_platform',
    E2E_DB_USERNAME: 'activity', E2E_DB_PASSWORD: 'sample',
  };
  assert.equal(databaseConfig(environment).database, 'activity_platform');
  assert.throws(() => databaseConfig({ ...environment, E2E_DB_HOST: 'production.example.com' }), /loopback/);
  assert.throws(() => databaseConfig({ ...environment, E2E_DB_NAME: 'production' }), /not a Gather/);
  assert.throws(() => databaseConfig({ ...environment, E2E_DB_PASSWORD: undefined }), /Set E2E_DB_PASSWORD/);
});

test('a different MySQL instance fails identity verification before any cleanup SQL', async () => {
  const queries = [];
  const connection = { async execute(sql) { queries.push(sql); return [[{ databaseName: 'activity_platform_e2e', serverUuid: 'different-server' }]]; } };
  await assert.rejects(verifyDatabase(connection,
    { host: '127.0.0.1', port: 33306, database: 'activity_platform_e2e' },
    { host: '127.0.0.1', port: 33306, database: 'activity_platform_e2e', serverUuid: 'original-server' }), /target differs/);
  assert.equal(queries.length, 1);
  assert.equal(queries.filter(query => query.startsWith('DELETE')).length, 0);
});

test('cleanup verifies every exact ownership proof before deleting, including later fixtures', async () => {
  const first = fixture(101);
  const second = fixture(102);
  const connection = fakeDatabase([first, { ...second, description: 'now belongs to somebody else' }]);
  await assert.rejects(deleteOwnedFixtures(connection, [first, second]), /ownership changed/);
  assert.equal(connection.state.activities.length, 2);
  assert.equal(connection.state.queries.filter(query => query.sql.startsWith('DELETE')).length, 0);
  assert.equal(connection.state.rollbacks, 1);
});

test('known created IDs missing from the configured database fail rather than report success', async () => {
  const connection = fakeDatabase([]);
  await assert.rejects(deleteOwnedFixtures(connection, [fixture(101)]), /target could be wrong/);
  assert.equal(connection.state.commits, 0);
  assert.equal(connection.state.rollbacks, 1);
});

test('lost creation responses resolve only their unique intent and preserve similar demo rows', async () => {
  const owned = fixture(101);
  const protectedRow = { ...fixture(102), title: owned.title };
  const connection = fakeDatabase([owned, protectedRow], [
    { activity_id: 101, status: 'ACTIVE' }, { activity_id: 101, status: 'WAITING' },
    { activity_id: 101, status: 'CANCELLED' }, { activity_id: 102, status: 'ACTIVE' },
  ]);
  const result = await deleteOwnedFixtures(connection, [{ ...owned, id: null }]);
  assert.equal(result.deletedActivities, 1);
  assert.equal(result.deletedRegistrations, 3);
  assert.deepEqual(result.resolvedIds, [101]);
  assert.deepEqual(connection.state.activities, [protectedRow]);
  assert.deepEqual(connection.state.registrations, [{ activity_id: 102, status: 'ACTIVE' }]);
  assert.equal(connection.state.commits, 1);
});

test('a cleanup database error propagates and rolls back all fixture and registration deletes', async () => {
  const rows = [fixture(101), fixture(102)];
  const registrations = [{ activity_id: 101, status: 'ACTIVE' }, { activity_id: 102, status: 'WAITING' }];
  const connection = fakeDatabase(rows, registrations, 102);
  await assert.rejects(deleteOwnedFixtures(connection, rows), /Simulated database failure/);
  assert.deepEqual(connection.state.activities, rows);
  assert.deepEqual(connection.state.registrations, registrations);
  assert.equal(connection.state.commits, 0);
  assert.equal(connection.state.rollbacks, 1);
});

test('a successfully completed run can be retried without deleting any new rows', async () => {
  const protectedRow = fixture(103);
  const connection = fakeDatabase([protectedRow]);
  const result = await deleteOwnedFixtures(connection, [fixture(101)], new Set([101]));
  assert.equal(result.deletedActivities, 0);
  assert.deepEqual(connection.state.activities, [protectedRow]);
  assert.equal(connection.state.queries.filter(query => query.sql.startsWith('DELETE')).length, 0);
});

test('failure to persist the verified cleanup intent prevents every delete', async () => {
  const owned = fixture(101);
  const connection = fakeDatabase([owned], [{ activity_id: 101, status: 'ACTIVE' }]);
  await assert.rejects(deleteOwnedFixtures(connection, [owned], new Set(), async () => {
    throw new Error('Disk write failed before cleanup');
  }), /Disk write failed/);
  assert.deepEqual(connection.state.activities, [owned]);
  assert.equal(connection.state.queries.filter(query => query.sql.startsWith('DELETE')).length, 0);
  assert.equal(connection.state.rollbacks, 1);
});

test('persisted verified IDs recover a committed cleanup when its final file write was interrupted', async () => {
  const owned = fixture(101);
  const connection = fakeDatabase([owned]);
  let persistedIds;
  await deleteOwnedFixtures(connection, [owned], new Set(), async resolved => {
    persistedIds = resolved.map(row => row.id);
  });
  // No completedAt is needed: these are the pre-delete verified intent IDs.
  const result = await deleteOwnedFixtures(connection, [owned], new Set(persistedIds));
  assert.equal(result.deletedActivities, 0);
  assert.deepEqual(result.resolvedIds, [101]);
  assert.equal(connection.state.commits, 2);
});

test('Windows temporary permission failures retry atomic replacement and can succeed', () => {
  const delays = [];
  const replacements = [];
  let attempts = 0;
  renameManifestWithRetry('manifest.tmp', 'manifest.json', {
    platform: 'win32', pause: delay => delays.push(delay),
    rename: (source, destination) => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error('File temporarily locked'), { code: attempts === 1 ? 'EPERM' : 'EACCES' });
      replacements.push({ source, destination });
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [20, 40]);
  assert.deepEqual(replacements, [{ source: 'manifest.tmp', destination: 'manifest.json' }]);
});

test('permanent Windows rename denial remains bounded and prevents cleanup deletes', async () => {
  const owned = fixture(101);
  const connection = fakeDatabase([owned]);
  const delays = [];
  let attempts = 0;
  await assert.rejects(deleteOwnedFixtures(connection, [owned], new Set(), async () => {
    renameManifestWithRetry('manifest.tmp', 'manifest.json', {
      platform: 'win32', pause: delay => delays.push(delay),
      rename: () => { attempts++; throw Object.assign(new Error('Permission permanently denied'), { code: 'EPERM' }); },
    });
  }), /Permission permanently denied/);
  assert.equal(attempts, 7);
  assert.ok(delays.reduce((sum, delay) => sum + delay, 0) <= 1000);
  assert.equal(connection.state.queries.filter(query => query.sql.startsWith('DELETE')).length, 0);
  assert.deepEqual(connection.state.activities, [owned]);
  assert.equal(connection.state.rollbacks, 1);
});

test('non-Windows or unrelated rename failures are never retried', () => {
  for (const [platform, code] of [['linux', 'EPERM'], ['win32', 'ENOENT']]) {
    let attempts = 0;
    let pauses = 0;
    assert.throws(() => renameManifestWithRetry('manifest.tmp', 'manifest.json', {
      platform, pause: () => pauses++,
      rename: () => { attempts++; throw Object.assign(new Error('Unretryable rename failure'), { code }); },
    }), /Unretryable/);
    assert.equal(attempts, 1);
    assert.equal(pauses, 0);
  }
});
