import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseConfig, deleteOwnedFixtures, verifyDatabase, renameManifestWithRetry } from './e2e-cleanup.mjs';

function fakeDatabase(activities, registrations = [], failDeleteId, users = [], failUserDeleteId, notifications = [], auditLogs = [], favorites = []) {
  const state = { activities: structuredClone(activities), registrations: structuredClone(registrations), users: structuredClone(users),
    notifications: structuredClone(notifications), auditLogs: structuredClone(auditLogs), favorites: structuredClone(favorites), queries: [], rollbacks: 0, commits: 0 };
  let snapshot;
  return {
    state,
    async beginTransaction() { snapshot = structuredClone({ activities: state.activities, registrations: state.registrations, users: state.users, notifications: state.notifications, auditLogs: state.auditLogs, favorites: state.favorites }); },
    async commit() { state.commits++; },
    async rollback() { Object.assign(state, snapshot); state.rollbacks++; },
    async execute(sql, parameters = []) {
      state.queries.push({ sql, parameters });
      if (sql.startsWith('SET TRANSACTION')) return [];
      if (sql.startsWith('SELECT user_id AS userId')) {
        const activityCount=(sql.match(/activity_id IN \(([^)]+)\)/)?.[1].match(/\?/g)??[]).length;
        const activityIds=parameters.slice(0,activityCount), userIds=parameters.slice(activityCount);
        return [state.favorites.filter(row=>activityIds.includes(row.activity_id)||userIds.includes(row.user_id)).map(row=>({userId:row.user_id,activityId:row.activity_id}))];
      }
      if (sql.startsWith('DELETE FROM activity_favorites')) {
        const previous=state.favorites.length; state.favorites=state.favorites.filter(row=>row.user_id!==parameters[0]||row.activity_id!==parameters[1]);
        return [{affectedRows:previous-state.favorites.length}];
      }
      if (sql.startsWith('SELECT a.activity_id')) return [state.auditLogs.map(row => ({ activityId: row.activity_id,
        registrationId: row.registration_id ?? null,
        registrationActivityId: state.registrations.find(registration => registration.id === row.registration_id)?.activity_id ?? null }))
        .filter(row => row.activityId === parameters[0] || row.registrationActivityId === parameters[1])];
      if (sql.startsWith('SELECT id FROM users')) return [state.users.filter(row => row.username === parameters[0]).slice(0, 2).map(row => ({ id: row.id }))];
      if (sql.startsWith('SELECT id, username')) return [state.users.filter(row => row.id === parameters[0])];
      if (sql.startsWith('SELECT activity_id')) {
        const rows = sql.includes('FROM notifications') ? state.notifications : sql.includes('FROM activity_audit_logs') ? state.auditLogs : state.registrations;
        const userField = sql.includes('WHERE checked_in_by') ? 'checked_in_by' : sql.includes('WHERE actor_user_id') ? 'actor_user_id' : 'user_id';
        return [rows.filter(row => row[userField] === parameters[0]).map(row => ({ activityId: row.activity_id }))];
      }
      if (sql.startsWith('SELECT id FROM activities WHERE created_by')) return [state.activities.filter(row => row.created_by === parameters[0] || row.cancelled_by === parameters[1]).map(row => ({ id: row.id }))];
      if (sql.startsWith('SELECT id FROM activities')) {
        return [state.activities.filter(row => row.title === parameters[0] && row.description === parameters[1]).slice(0, 2).map(row => ({ id: row.id }))];
      }
      if (sql.startsWith('SELECT id, title')) return [state.activities.filter(row => row.id === parameters[0])];
      if (sql.startsWith('DELETE FROM activity_audit_logs')) {
        const previous = state.auditLogs.length;
        state.auditLogs = state.auditLogs.filter(row => row.activity_id !== parameters[0]);
        return [{ affectedRows: previous - state.auditLogs.length }];
      }
      if (sql.startsWith('DELETE FROM notifications')) {
        const previous = state.notifications.length;
        state.notifications = state.notifications.filter(row => row.activity_id !== parameters[0]);
        return [{ affectedRows: previous - state.notifications.length }];
      }
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
      if (sql.startsWith('DELETE FROM users')) {
        if (parameters[0] === failUserDeleteId) throw new Error('Simulated database failure during user cleanup');
        const previous = state.users.length;
        state.users = state.users.filter(row => !(row.id === parameters[0] && row.username === parameters[1] && row.role === parameters[2]));
        return [{ affectedRows: previous - state.users.length }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

const fixture = (id, title = `test ${id}`) => ({ id, title, description: `unique ownership marker ${id}` });
const account = id => ({ id, username: `e2e_unique_account_${id}`, role: 'USER', displayName: `unique initial ${id}`, allowedDisplayNames: [`unique initial ${id}`, `unique renamed ${id}`] });

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

test('exact account cleanup resolves a lost registration response, accepts predeclared renames and preserves demo users', async () => {
  const owned = fixture(101);
  const ownedAccount = account(201);
  const demo = { id: 2, username: 'demo', displayName: '体验用户', role: 'USER' };
  const connection = fakeDatabase([owned], [{ activity_id: 101, user_id: 201, status: 'ACTIVE' }], undefined,
    [{ ...ownedAccount, displayName: ownedAccount.allowedDisplayNames[1] }, demo]);
  let verifiedAccounts;
  const result = await deleteOwnedFixtures(connection, [owned], new Set(), async (_fixtures, accounts) => { verifiedAccounts = accounts; },
    { accounts: [{ ...ownedAccount, id: null }] });
  assert.equal(result.deletedUsers, 1);
  assert.equal(result.deletedActivities, 1);
  assert.deepEqual(result.resolvedUserIds, [201]);
  assert.equal(verifiedAccounts[0].id, 201);
  assert.deepEqual(connection.state.users, [demo]);
  assert.deepEqual(connection.state.registrations, []);
  const deletes = connection.state.queries.filter(query => query.sql.startsWith('DELETE')).map(query => query.sql);
  assert.ok(deletes[0].startsWith('DELETE FROM activity_audit_logs'));
  assert.ok(deletes[1].startsWith('DELETE FROM notifications'));
  assert.ok(deletes[2].startsWith('DELETE FROM registrations'));
  assert.ok(deletes[3].startsWith('DELETE FROM activities'));
  assert.ok(deletes[4].startsWith('DELETE FROM users'));
});

test('a later account with changed nickname or role rejects the whole cleanup before all deletes', async () => {
  const owned = fixture(101);
  const first = account(201);
  const second = account(202);
  for (const tampered of [{ ...second, displayName: 'unowned name' }, { ...second, role: 'ADMIN' }, { ...second, username: 'other_account' }]) {
    const connection = fakeDatabase([owned], [{ activity_id: 101, user_id: 201, status: 'WAITING' }], undefined, [first, tampered]);
    await assert.rejects(deleteOwnedFixtures(connection, [owned], new Set(), async () => {}, { accounts: [first, second] }), /ownership changed/);
    assert.equal(connection.state.queries.filter(query => query.sql.startsWith('DELETE')).length, 0);
    assert.deepEqual(connection.state.users, [first, tampered]);
    assert.equal(connection.state.rollbacks, 1);
  }
});

test('user references to any activity outside this run refuse cleanup atomically', async () => {
  const owned = fixture(101);
  const protectedRow = fixture(102);
  const user = account(201);
  for (const registrations of [[{ activity_id: 102, user_id: 201, status: 'CANCELLED' }], []]) {
    const rows = registrations.length ? [owned, protectedRow] : [owned, { ...protectedRow, created_by: 201 }];
    const connection = fakeDatabase(rows, registrations, undefined, [user]);
    await assert.rejects(deleteOwnedFixtures(connection, [owned], new Set(), async () => {}, { accounts: [user] }), /outside this run/);
    assert.equal(connection.state.queries.filter(query => query.sql.startsWith('DELETE')).length, 0);
    assert.deepEqual(connection.state.activities, rows);
    assert.equal(connection.state.rollbacks, 1);
  }
});

test('missing known user IDs and duplicate account IDs never silently succeed', async () => {
  const user = account(201);
  const missing = fakeDatabase([], [], undefined, []);
  await assert.rejects(deleteOwnedFixtures(missing, [], new Set(), async () => {}, { accounts: [user] }), /target could be wrong/);
  const duplicate = fakeDatabase([], [], undefined, [user]);
  await assert.rejects(deleteOwnedFixtures(duplicate, [], new Set(), async () => {}, { accounts: [user, user] }), /Duplicate user IDs/);
  assert.equal(missing.state.commits + duplicate.state.commits, 0);
});

test('failed user DELETE restores all already deleted activities, registrations and users', async () => {
  const owned = fixture(101);
  const user = account(201);
  const registrations = [{ activity_id: 101, user_id: 201, status: 'ACTIVE' }];
  const connection = fakeDatabase([owned], registrations, undefined, [user], 201);
  await assert.rejects(deleteOwnedFixtures(connection, [owned], new Set(), async () => {}, { accounts: [user] }), /user cleanup/);
  assert.deepEqual(connection.state.activities, [owned]);
  assert.deepEqual(connection.state.registrations, registrations);
  assert.deepEqual(connection.state.users, [user]);
  assert.equal(connection.state.commits, 0);
  assert.equal(connection.state.rollbacks, 1);
});

test('both verified user and activity IDs persist before deletes and recover a lost commit reply', async () => {
  const owned = fixture(101);
  const user = account(201);
  const connection = fakeDatabase([owned], [], undefined, [user]);
  let persisted;
  await deleteOwnedFixtures(connection, [owned], new Set(), async (activities, accounts) => {
    persisted = { activities: activities.map(row => row.id), accounts: accounts.map(row => row.id) };
  }, { accounts: [user] });
  const recovered = await deleteOwnedFixtures(connection, [owned], new Set(persisted.activities), async () => {},
    { accounts: [user], alreadyDeletedAccounts: new Set(persisted.accounts) });
  assert.equal(recovered.deletedUsers, 0);
  assert.equal(recovered.deletedActivities, 0);
  assert.deepEqual(recovered.resolvedUserIds, [201]);
  assert.equal(connection.state.commits, 2);
});

test('a declared activity edit is exactly recoverable after its HTTP response is lost', async () => {
  const original = fixture(301);
  const edited = { title: 'edited activity 301', description: `edited copy\n${original.description}` };
  const protectedRow = { ...fixture(302), title: edited.title };
  const intent = { ...original, id: null, allowedVersions: [original, edited] };
  const connection = fakeDatabase([{ ...original, ...edited }, protectedRow], [
    { activity_id: 301, status: 'CANCELLED' }, { activity_id: 302, status: 'ACTIVE' },
  ]);
  const result = await deleteOwnedFixtures(connection, [intent]);
  assert.deepEqual(result.resolvedIds, [301]);
  assert.equal(result.deletedActivities, 1);
  assert.deepEqual(connection.state.activities, [protectedRow]);
  assert.deepEqual(connection.state.registrations, [{ activity_id: 302, status: 'ACTIVE' }]);
  const retry = await deleteOwnedFixtures(connection, [{ ...intent, id: 301 }], new Set([301]));
  assert.equal(retry.deletedActivities, 0);
  assert.deepEqual(connection.state.activities, [protectedRow]);
});

test('an undeclared later activity title or description refuses all cleanup deletes', async () => {
  const first = fixture(301);
  const original = fixture(302);
  const edited = { title: 'declared edit', description: `declared edit\n${original.description}` };
  const intent = { ...original, allowedVersions: [original, edited] };
  for (const changed of [{ ...original, title: 'undeclared edit' }, { ...original, ...edited, description: 'undeclared description' }]) {
    const connection = fakeDatabase([first, changed], [{ activity_id: first.id, status: 'ACTIVE' }]);
    await assert.rejects(deleteOwnedFixtures(connection, [first, intent]), /ownership changed/);
    assert.equal(connection.state.queries.filter(query => query.sql.startsWith('DELETE')).length, 0);
    assert.deepEqual(connection.state.activities, [first, changed]);
    assert.equal(connection.state.rollbacks, 1);
  }
});

test('declaring a failed edit preserves the original exact proof for cleanup', async () => {
  const original = fixture(301);
  const intent = { ...original, allowedVersions: [original, { title: 'never saved', description: `never saved\n${original.description}` }] };
  const connection = fakeDatabase([original]);
  const result = await deleteOwnedFixtures(connection, [intent]);
  assert.equal(result.deletedActivities, 1);
  assert.deepEqual(connection.state.activities, []);
});

test('two rows matching different declared versions are ambiguous and never deleted', async () => {
  const original = fixture(301);
  const edited = { title: 'declared edit', description: `declared edit\n${original.description}` };
  const connection = fakeDatabase([original, { ...edited, id: 302 }]);
  await assert.rejects(deleteOwnedFixtures(connection, [{ ...original, id: null, allowedVersions: [original, edited] }]), /multiple activities/);
  assert.equal(connection.state.queries.filter(query => query.sql.startsWith('DELETE')).length, 0);
  assert.equal(connection.state.rollbacks, 1);
});

test('invalid fixture versions that omit the original proof fail before lookup or delete', async () => {
  const original = fixture(301);
  for (const allowedVersions of [[], [{ title: 'other', description: 'unowned' }], [{ title: original.title, description: null }]]) {
    const connection = fakeDatabase([original]);
    await assert.rejects(deleteOwnedFixtures(connection, [{ ...original, allowedVersions }]), /version ownership proof/);
    assert.equal(connection.state.queries.filter(query => query.sql.startsWith('SELECT') || query.sql.startsWith('DELETE')).length, 0);
    assert.equal(connection.state.rollbacks, 1);
  }
});

test('a fixture account referenced as canceller outside this run refuses all cleanup deletes', async () => {
  const owned = fixture(301);
  const protectedRow = { ...fixture(302), cancelled_by: 201 };
  const user = account(201);
  const connection = fakeDatabase([owned, protectedRow], [], undefined, [user]);
  await assert.rejects(deleteOwnedFixtures(connection, [owned], new Set(), async () => {}, { accounts: [user] }), /outside this run/);
  assert.equal(connection.state.queries.filter(query => query.sql.startsWith('DELETE')).length, 0);
  assert.deepEqual(connection.state.activities, [owned, protectedRow]);
  assert.deepEqual(connection.state.users, [user]);
});

test('V13 and complete avatar, registration-deadline, end-time, cover, favorite, category, credential, notification, check-in and audit schemas are required before fixture writes or cleanup', async () => {
  for (const absent of ['migration', 'registration-deadline-column', 'end-time-column', 'cover-columns', 'category-column', 'credential-column', 'avatar-columns', 'avatar-constraint', 'avatar-checksum', 'notification-table', 'check-in-columns', 'audit-table', 'favorite-table']) {
    const queries = [];
    const connection = { async execute(sql) {
      queries.push(sql);
      if (sql.startsWith('SELECT DATABASE')) return [[{ databaseName: 'activity_platform_test', serverUuid: 'verified-server' }]];
      if (sql.includes('flyway_schema_history')) return [[...['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', ...(absent === 'migration' ? [] : ['13'])].map(version => ({ version }))]];
      if (sql.includes('registration_deadline') && absent === 'registration-deadline-column') throw new Error('Registration deadline schema absent');
      if (sql.includes('ends_at') && absent === 'end-time-column') throw new Error('Activity end-time schema absent');
      if (sql.includes('cover_hash, cover_image') && absent === 'cover-columns') throw new Error('Cover schema absent');
      if (sql.includes('description, category,') && absent === 'category-column') throw new Error('Activity category schema absent');
      if (sql.includes('credential_version') && absent === 'credential-column') throw new Error('Credential version schema absent');
      if (sql.includes('information_schema.COLUMNS')) return [absent === 'avatar-columns' ? [] : [{name:'avatar_hash',type:'char',nullable:'YES',charset:'ascii',length:64},{name:'avatar_image',type:'mediumblob',nullable:'YES'}]];
      if (sql.includes('information_schema.TABLE_CONSTRAINTS')) return [absent === 'avatar-constraint' ? [] : [{enforced:'YES',clause:"((avatar_image IS NULL AND avatar_hash IS NULL) OR (avatar_image IS NOT NULL AND avatar_hash IS NOT NULL AND OCTET_LENGTH(avatar_image) BETWEEN 1 AND 2097152 AND REGEXP_LIKE(avatar_hash, '^[0-9a-f]{64}$', 'c'))) IS TRUE"}]];
      if (sql.startsWith('SELECT COUNT(*) AS invalid')) return [[{invalid:absent === 'avatar-checksum' ? 1 : 0}]];
      if (sql.includes('FROM registrations') && absent === 'check-in-columns') throw new Error('Check-in schema absent');
      if (sql.includes('FROM notifications') && absent === 'notification-table') throw new Error('Notification schema absent');
      if (sql.includes('FROM activity_audit_logs') && absent === 'audit-table') throw new Error('Audit schema absent');
      if (sql.includes('FROM activity_favorites') && absent === 'favorite-table') throw new Error('Favorite schema absent');
      return [[]];
    } };
    await assert.rejects(verifyDatabase(connection, { host: '127.0.0.1', port: 3307, database: 'activity_platform_test' }),
      absent === 'migration' ? /V1\/V2\/V3\/V4\/V5\/V6\/V7\/V8\/V9\/V10\/V11\/V12\/V13/ : absent === 'registration-deadline-column' ? /Registration deadline schema absent/ : absent === 'end-time-column' ? /Activity end-time schema absent/ : absent === 'cover-columns' ? /Cover schema absent/ : absent === 'category-column' ? /Activity category schema absent/ : absent === 'credential-column' ? /Credential version schema absent/ : absent.startsWith('avatar-') ? /V13|checksums are invalid/ : absent === 'check-in-columns' ? /Check-in schema absent/ : absent === 'audit-table' ? /Audit schema absent/ : absent === 'favorite-table' ? /Favorite schema absent/ : /Notification schema absent/);
    assert.equal(queries.filter(sql => /^(INSERT|UPDATE|DELETE)/.test(sql)).length, 0);
    if (absent === 'migration') assert.equal(queries.some(sql => sql.includes('FROM notifications')), false);
    else if (absent === 'registration-deadline-column') assert.ok(queries.some(sql => sql.includes('registration_deadline FROM activities LIMIT 0')));
    else if (absent === 'end-time-column') assert.ok(queries.some(sql => sql.includes('starts_at, ends_at, registration_deadline FROM activities LIMIT 0')));
    else if (absent === 'cover-columns') assert.ok(queries.some(sql => sql.includes('cover_hash, cover_image FROM activities LIMIT 0')));
    else if (absent === 'category-column') assert.ok(queries.some(sql => sql.includes('description, category, registered_count')));
    else if (absent === 'notification-table') assert.ok(queries.some(sql => sql.includes('activity_title, cancellation_reason, created_at, read_at FROM notifications')));
    else if (absent === 'credential-column') assert.ok(queries.some(sql => sql.includes('role, credential_version, avatar_hash, avatar_image FROM users LIMIT 0')));
    else if (absent === 'avatar-columns') assert.ok(queries.some(sql => sql.includes('information_schema.COLUMNS')));
    else if (absent === 'avatar-constraint') assert.ok(queries.some(sql => sql.includes('information_schema.TABLE_CONSTRAINTS')));
    else if (absent === 'avatar-checksum') assert.ok(queries.some(sql => sql.includes('BINARY SHA2(avatar_image,256)')));
    else if (absent === 'check-in-columns') assert.ok(queries.some(sql => sql.includes('status, checked_in_at, checked_in_by FROM registrations LIMIT 0')));
    else if (absent === 'favorite-table') assert.ok(queries.some(sql => sql.includes('created_at FROM activity_favorites LIMIT 0')));
    else assert.ok(queries.some(sql => sql.includes('occurred_at, changes_json FROM activity_audit_logs LIMIT 0')));
  }
});

test('notification cleanup deletes only exact owned activities and preserves baseline notifications', async () => {
  const owned = fixture(401);
  const protectedRow = fixture(402);
  const user = account(501);
  const demo = { id: 2, username: 'demo', displayName: '体验用户', role: 'USER' };
  const protectedNotification = { id: 603, activity_id: 402, user_id: 2, type: 'PROMOTED', read_at: 'unchanged' };
  const notifications = [
    { id: 601, activity_id: 401, user_id: 501, type: 'PROMOTED', read_at: null },
    { id: 602, activity_id: 401, user_id: 2, type: 'ACTIVITY_CANCELLED', read_at: null },
    protectedNotification,
  ];
  const connection = fakeDatabase([owned, protectedRow], [], undefined, [user, demo], undefined, notifications);
  const result = await deleteOwnedFixtures(connection, [owned], new Set(), async () => {}, { accounts: [user] });
  assert.equal(result.deletedNotifications, 2);
  assert.deepEqual(connection.state.notifications, [protectedNotification]);
  assert.deepEqual(connection.state.activities, [protectedRow]);
  assert.deepEqual(connection.state.users, [demo]);
  const deletes = connection.state.queries.filter(query => query.sql.startsWith('DELETE')).map(query => query.sql);
  assert.deepEqual(deletes.map(sql => sql.split(' ')[2]), ['activity_audit_logs', 'notifications', 'registrations', 'activities', 'users']);
});

test('an owned account notification for a non-owned activity rejects cleanup before any delete', async () => {
  const owned = fixture(401);
  const protectedRow = fixture(402);
  const user = account(501);
  const notification = { id: 601, activity_id: 402, user_id: 501, type: 'ACTIVITY_CANCELLED' };
  const connection = fakeDatabase([owned, protectedRow], [], undefined, [user], undefined, [notification]);
  await assert.rejects(deleteOwnedFixtures(connection, [owned], new Set(), async () => {}, { accounts: [user] }), /outside this run/);
  assert.equal(connection.state.queries.filter(query => query.sql.startsWith('DELETE')).length, 0);
  assert.deepEqual(connection.state.notifications, [notification]);
  assert.deepEqual(connection.state.users, [user]);
  assert.equal(connection.state.rollbacks, 1);
});

test('failed activity or user cleanup rolls notification deletion back in the same transaction', async () => {
  const owned = fixture(401);
  const user = account(501);
  const notifications = [{ id: 601, activity_id: 401, user_id: 501, type: 'PROMOTED' }];
  for (const failure of ['activity', 'user']) {
    const connection = fakeDatabase([owned], [], failure === 'activity' ? 401 : undefined,
      [user], failure === 'user' ? 501 : undefined, notifications);
    await assert.rejects(deleteOwnedFixtures(connection, [owned], new Set(), async () => {}, { accounts: [user] }), /Simulated database failure/);
    assert.deepEqual(connection.state.notifications, notifications);
    assert.deepEqual(connection.state.activities, [owned]);
    assert.deepEqual(connection.state.users, [user]);
    assert.equal(connection.state.commits, 0);
    assert.equal(connection.state.rollbacks, 1);
  }
});

test('completed notification cleanup is idempotent and retains unrelated notifications on retry', async () => {
  const owned = fixture(401);
  const protectedRow = fixture(402);
  const notifications = [{ id: 601, activity_id: 401, user_id: 2 }, { id: 602, activity_id: 402, user_id: 2 }];
  const connection = fakeDatabase([owned, protectedRow], [], undefined, [], undefined, notifications);
  const result = await deleteOwnedFixtures(connection, [owned]);
  assert.equal(result.deletedNotifications, 1);
  const previousQueryCount = connection.state.queries.length;
  const retried = await deleteOwnedFixtures(connection, [owned], new Set(result.resolvedIds));
  assert.equal(retried.deletedNotifications, 0);
  assert.equal(connection.state.queries.slice(previousQueryCount).some(query => query.sql.startsWith('DELETE')), false);
  assert.deepEqual(connection.state.notifications, [notifications[1]]);
});

test('a fixture user referenced as check-in operator outside this run refuses every delete', async () => {
  const owned = fixture(701);
  const protectedRow = fixture(702);
  const user = account(801);
  const registrations = [
    { id: 901, activity_id: 701, user_id: 801, status: 'ACTIVE', checked_in_at: null, checked_in_by: null },
    { id: 902, activity_id: 702, user_id: 2, status: 'ACTIVE', checked_in_at: 'first check-in', checked_in_by: 801 },
  ];
  const connection = fakeDatabase([owned, protectedRow], registrations, undefined, [user]);
  await assert.rejects(deleteOwnedFixtures(connection, [owned], new Set(), async () => {}, { accounts: [user] }), /outside this run/);
  assert.equal(connection.state.queries.filter(query => query.sql.startsWith('DELETE')).length, 0);
  assert.deepEqual(connection.state.registrations, registrations);
  assert.deepEqual(connection.state.users, [user]);
  assert.equal(connection.state.rollbacks, 1);
});

test('owned check-in rows delete before users, preserve external metadata, and are idempotent', async () => {
  const owned = fixture(701);
  const protectedRow = fixture(702);
  const user = account(801);
  const external = { id: 902, activity_id: 702, user_id: 2, status: 'ACTIVE',
    created_at: 'original creation', updated_at: 'original update', checked_in_at: 'first check-in', checked_in_by: 1 };
  const connection = fakeDatabase([owned, protectedRow], [
    { id: 901, activity_id: 701, user_id: 2, status: 'ACTIVE', checked_in_at: 'owned check-in', checked_in_by: 801 }, external,
  ], undefined, [user]);
  const first = await deleteOwnedFixtures(connection, [owned], new Set(), async () => {}, { accounts: [user] });
  assert.equal(first.deletedRegistrations, 1);
  assert.equal(first.deletedUsers, 1);
  assert.deepEqual(connection.state.registrations, [external]);
  const deletes = connection.state.queries.filter(query => query.sql.startsWith('DELETE')).map(query => query.sql.split(' ')[2]);
  assert.deepEqual(deletes, ['activity_audit_logs', 'notifications', 'registrations', 'activities', 'users']);
  const queryCount = connection.state.queries.length;
  await deleteOwnedFixtures(connection, [owned], new Set(first.resolvedIds), async () => {},
    { accounts: [user], alreadyDeletedAccounts: new Set(first.resolvedUserIds) });
  assert.equal(connection.state.queries.slice(queryCount).some(query => query.sql.startsWith('DELETE')), false);
  assert.deepEqual(connection.state.registrations, [external]);
});

test('a failed user delete restores owned check-in timestamps and operators atomically', async () => {
  const owned = fixture(701);
  const user = account(801);
  const checked = { id: 901, activity_id: 701, user_id: 2, status: 'ACTIVE',
    updated_at: 'unchanged registration time', checked_in_at: 'first check-in', checked_in_by: 801 };
  const connection = fakeDatabase([owned], [checked], undefined, [user], user.id);
  await assert.rejects(deleteOwnedFixtures(connection, [owned], new Set(), async () => {}, { accounts: [user] }), /user cleanup/);
  assert.deepEqual(connection.state.registrations, [checked]);
  assert.deepEqual(connection.state.activities, [owned]);
  assert.deepEqual(connection.state.users, [user]);
  assert.equal(connection.state.commits, 0);
  assert.equal(connection.state.rollbacks, 1);
});

test('audit cleanup removes only approved activity logs, permits the original administrator actor and preserves external snapshots', async () => {
  const owned = fixture(901);
  const external = fixture(902);
  const user = account(1001);
  const registrations = [{ id: 1101, activity_id: owned.id, user_id: user.id }, { id: 1102, activity_id: external.id, user_id: 2 }];
  const retained = { id: 1203, activity_id: external.id, registration_id: 1102, actor_user_id: 1,
    activity_title: 'original title snapshot', actor_display_name: 'original administrator' };
  const audits = [
    { id: 1201, activity_id: owned.id, registration_id: 1101, actor_user_id: 1 },
    { id: 1202, activity_id: owned.id, registration_id: null, actor_user_id: user.id }, retained,
  ];
  const db = fakeDatabase([owned, external], registrations, undefined, [user], undefined, [], audits);
  const result = await deleteOwnedFixtures(db, [owned], new Set(), async () => {}, { accounts: [user] });
  assert.equal(result.deletedAuditLogs, 2);
  assert.deepEqual(db.state.auditLogs, [retained]);
  assert.deepEqual(db.state.registrations, [registrations[1]]);
  const deletes = db.state.queries.filter(query => query.sql.startsWith('DELETE')).map(query => query.sql.split(' ')[2]);
  assert.deepEqual(deletes, ['activity_audit_logs', 'notifications', 'registrations', 'activities', 'users']);
  const retry = await deleteOwnedFixtures(db, [owned], new Set(result.resolvedIds), async () => {},
    { accounts: [user], alreadyDeletedAccounts: new Set(result.resolvedUserIds) });
  assert.equal(retry.deletedAuditLogs, 0);
  assert.deepEqual(db.state.auditLogs, [retained]);
});

test('a temporary audit actor referenced by another activity rejects all cleanup before deletion', async () => {
  const owned = fixture(901);
  const external = fixture(902);
  const user = account(1001);
  const audit = { id: 1201, activity_id: external.id, registration_id: null, actor_user_id: user.id };
  const db = fakeDatabase([owned, external], [], undefined, [user], undefined, [], [audit]);
  await assert.rejects(deleteOwnedFixtures(db, [owned], new Set(), async () => {}, { accounts: [user] }), /outside this run/);
  assert.equal(db.state.queries.some(query => query.sql.startsWith('DELETE')), false);
  assert.deepEqual(db.state.auditLogs, [audit]);
  assert.equal(db.state.rollbacks, 1);
});

test('cross-activity audit registration references are rejected in either direction, even when both activities are approved', async () => {
  const owned = fixture(901);
  const other = fixture(902);
  const registrations = [{ id: 1101, activity_id: owned.id }, { id: 1102, activity_id: other.id }];
  for (const [audit, fixtures] of [
    [{ id: 1201, activity_id: owned.id, registration_id: 1102 }, [owned]],
    [{ id: 1201, activity_id: other.id, registration_id: 1101 }, [owned]],
    [{ id: 1201, activity_id: owned.id, registration_id: 1102 }, [owned, other]],
    [{ id: 1201, activity_id: owned.id, registration_id: 9999 }, [owned]],
  ]) {
    const db = fakeDatabase([owned, other], registrations, undefined, [], undefined, [], [audit]);
    await assert.rejects(deleteOwnedFixtures(db, fixtures), /audit registration references a different activity/);
    assert.equal(db.state.queries.some(query => query.sql.startsWith('DELETE')), false);
    assert.deepEqual(db.state.auditLogs, [audit]);
    assert.deepEqual(db.state.registrations, registrations);
    assert.equal(db.state.rollbacks, 1);
  }
});

test('a later failed user delete restores audit snapshots together with every other owned row', async () => {
  const owned = fixture(901);
  const user = account(1001);
  const registration = { id: 1101, activity_id: owned.id, user_id: user.id };
  const audit = { id: 1201, activity_id: owned.id, registration_id: registration.id, actor_user_id: 1, changes_json: '[{"field":"title"}]' };
  const db = fakeDatabase([owned], [registration], undefined, [user], user.id, [], [audit]);
  await assert.rejects(deleteOwnedFixtures(db, [owned], new Set(), async () => {}, { accounts: [user] }), /user cleanup/);
  assert.deepEqual(db.state.auditLogs, [audit]);
  assert.deepEqual(db.state.activities, [owned]);
  assert.deepEqual(db.state.registrations, [registration]);
  assert.deepEqual(db.state.users, [user]);
  assert.equal(db.state.rollbacks, 1);
});


test('declared favorite pairs are deleted exactly and unrelated favorites remain', async () => {
  const owned=fixture(901), other=fixture(902);
  const original={user_id:2,activity_id:902};
  const db=fakeDatabase([owned,other],[],undefined,[],undefined,[],[],[{user_id:2,activity_id:901},original]);
  const result=await deleteOwnedFixtures(db,[owned],new Set(),async()=>{},{favorites:[{userId:2,activityId:901}]});
  assert.equal(result.deletedFavorites,1); assert.deepEqual(db.state.favorites,[original]);
  assert(db.state.queries.findIndex(q=>q.sql.startsWith('DELETE FROM activity_favorites')) < db.state.queries.findIndex(q=>q.sql.startsWith('DELETE FROM activities')));
});
test('undeclared favorites and temporary users favoriting outside activities reject all deletion', async () => {
  for(const outside of [false,true]) {
    const owned=fixture(911), other=fixture(912), user=account(921);
    const favorite={user_id:921,activity_id:outside?912:911};
    const db=fakeDatabase([owned,other],[],undefined,[user],undefined,[],[],[favorite]);
    await assert.rejects(deleteOwnedFixtures(db,[owned],new Set(),async()=>{},{accounts:[user]}),/favorite reference/);
    assert.equal(db.state.queries.filter(q=>q.sql.startsWith('DELETE')).length,0);
    assert.deepEqual(db.state.favorites,[favorite]); assert.equal(db.state.rollbacks,1);
  }
});
test('favorite deletion rolls back with a later activity deletion failure', async () => {
  const owned=fixture(931), favorite={user_id:2,activity_id:931};
  const db=fakeDatabase([owned],[],931,[],undefined,[],[],[favorite]);
  await assert.rejects(deleteOwnedFixtures(db,[owned],new Set(),async()=>{},{favorites:[{userId:2,activityId:931}]}),/Simulated database failure/);
  assert.deepEqual(db.state.favorites,[favorite]); assert.deepEqual(db.state.activities,[owned]);
});
