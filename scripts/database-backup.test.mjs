import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackup, restoreBackup, snapshotDatabase } from './database-backup.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backupRoot = join(root, '.runtime', 'backups');
const unitRoot = join(root, '.runtime', 'backup-unit', randomUUID());
const binDir = join(unitRoot, 'bin');
const sourceUuid = '12345678-1234-1234-1234-123456789abc';
const otherUuid = '87654321-4321-4321-4321-cba987654321';
const restoreDatabase = `gatherrestore${'a'.repeat(32)}`;
const restoreUsername = `grestore${'b'.repeat(16)}`;
const tableNames = ['users', 'activities', 'registrations', 'notifications', 'activity_audit_logs', 'activity_favorites', 'flyway_schema_history'];
const ownedPackages = new Set();
const baseConfig = { host: '127.0.0.1', port: 33306, database: 'activity_platform_test', user: 'backupreader', password: 'unit-secret-never-log', expectedServerUuid: sourceUuid, binDir };
const targetConfig = { ...baseConfig, database: restoreDatabase, user: restoreUsername, expectedServerUuid: otherUuid };
const dumpSql = Buffer.from('CREATE TABLE `unit_probe` (`id` bigint);\n-- 中文 / binary is represented by hex in a real dump\n');

function copy(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
  return value;
}

function fixture() {
  return {
    users: [{ id: '1', username: 'admin', role: 'ADMIN', password_hash: '$2a$10$unit-secret-hash', credential_version: '7' },
      { id: '2', username: 'demo', role: 'USER', password_hash: '$2a$10$another-secret-hash', credential_version: '1' }],
    activities: [{ id: '3', title: '含中文与换行\n活动', description: 'literal \\n', cover_image: Buffer.from([0, 255, 128, 10]), cover_hash: 'f'.repeat(64), starts_at: '2026-10-01 01:02:03.123456' }],
    registrations: [{ id: '4', activity_id: '3', user_id: '2', status: 'ACTIVE', checked_in_at: null }],
    notifications: [{ id: '5', user_id: '2', activity_id: '3', read_at: null }],
    activity_audit_logs: [{ id: '6', activity_id: '3', changes_json: '{"category":{"before":"OTHER","after":"CULTURE"}}' }],
    activity_favorites: [{ id: '7', user_id: '2', activity_id: '3' }],
    flyway_schema_history: Array.from({ length: 10 }, (_, index) => ({ installed_rank: index + 1, version: String(index + 1), checksum: index * 100 - 100, success: 1 })),
  };
}

function database({ config = baseConfig, data = fixture(), nonempty = {}, grants, account, version = '8.4.7', engine = 'InnoDB', fail } = {}) {
  const state = { data: copy(data), queries: [], commits: 0, rollbacks: 0, ended: false, imported: false };
  return {
    state,
    async end() { state.ended = true; },
    async commit() { state.commits++; },
    async rollback() { state.rollbacks++; },
    async query(sql) {
      state.queries.push(sql);
      assert.equal(sql,'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      return [[]];
    },
    async execute(sql) {
      state.queries.push(sql);
      if (fail?.(sql)) throw new Error('PRIVATE SQL / password / raw database diagnostic');
      if (sql.startsWith('START TRANSACTION')) throw new Error('MySQL does not support this prepared transaction statement');
      if (sql.startsWith('SET ')) return [[]];
      if (sql.startsWith('SELECT DATABASE()')) return [[{ databaseName: config.database, serverUuid: config.expectedServerUuid, mysqlVersion: version }]];
      if (sql.startsWith('SELECT CURRENT_USER()')) return [[{ accountName: account ?? `${config.user}@localhost` }]];
      if (sql === 'SHOW GRANTS') return [(grants ?? [
        `GRANT USAGE ON *.* TO \`${config.user}\`@\`localhost\``,
        `GRANT ALL PRIVILEGES ON \`${config.database}\`.* TO \`${config.user}\`@\`localhost\``,
      ]).map(grant => ({ 'Grants for restore': grant }))];
      if (sql.startsWith('SELECT COUNT(*) AS objectCount')) {
        const kind = sql.match(/information_schema\.(\w+)/)[1];
        return [[{ objectCount: state.imported ? 7 : nonempty[kind] ?? 0 }]];
      }
      if (sql.startsWith('SELECT TABLE_NAME')) return [tableNames.map(tableName => ({ tableName, engine, tableType: 'BASE TABLE' }))];
      if (sql.startsWith('SHOW CREATE TABLE')) {
        const name = sql.match(/`([^`]+)`/)[1];
        return [[{ Table: name, 'Create Table': `CREATE TABLE \`${name}\` (\`id\` bigint NOT NULL) ENGINE=InnoDB` }]];
      }
      if (sql.startsWith('SELECT * FROM')) {
        const name = sql.match(/`([^`]+)`/)[1];
        const rows = state.data[name];
        return [copy(rows), Object.keys(rows[0] ?? fixture()[name][0]).map(name => ({ name }))];
      }
      throw new Error('Unexpected private query');
    },
  };
}

async function makeBackup({ config = baseConfig, connection = database({ config }), run } = {}) {
  const calls = [];
  const result = await createBackup(config, {
    connect: async options => { calls.push({ options }); return connection; },
    runClient: async (executable, args, options) => {
      const path = args.find(arg => arg.startsWith('--result-file=')).slice('--result-file='.length);
      ownedPackages.add(dirname(path));
      calls.push({ executable, args, options, path });
      if (run) await run({ connection, path, args, options });
      else await writeFile(path, dumpSql);
    },
  });
  return { ...result, connection, calls };
}

async function importBackup(directory, { config = targetConfig, connection = database({ config }), run } = {}) {
  let importedBytes;
  const calls = [];
  const summary = await restoreBackup(directory, config, {
    connect: async options => { calls.push({ options }); return connection; },
    runClient: async (executable, args, options) => {
      calls.push({ executable, args, options });
      const chunks = [];
      for await (const chunk of options.input) chunks.push(chunk);
      importedBytes = Buffer.concat(chunks);
      connection.state.imported = true;
      if (run) await run(connection);
    },
  });
  return { summary, connection, importedBytes, calls };
}

async function editManifest(directory, edit) {
  const path = join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  edit(manifest);
  await writeFile(path, JSON.stringify(manifest));
}

before(async () => {
  await mkdir(binDir, { recursive: true });
  for (const name of ['mysql', 'mysqldump']) await writeFile(join(binDir, process.platform === 'win32' ? `${name}.exe` : name), 'not executable: injected clients only');
});
after(async () => {
  // Remove only this test run's recorded UUID packages and dedicated unit folder.
  for (const directory of ownedPackages) {
    assert.equal(dirname(directory), backupRoot);
    assert.match(directory.slice(backupRoot.length + 1), /^[a-f0-9-]{36}$/);
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(dirname(unitRoot), join(root, '.runtime', 'backup-unit'));
  await rm(unitRoot, { recursive: true, force: true });
});

test('snapshots use one read-only RR transaction, all columns and primary-key order without retaining secrets', async () => {
  const connection = database();
  const result = await snapshotDatabase(connection);
  assert.equal(connection.state.queries[0], 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  assert.equal(connection.state.queries[1], 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  assert.equal(connection.state.commits, 1);
  assert.equal(connection.state.rollbacks, 0);
  assert.equal(Object.keys(result.tables).length, 7);
  assert.equal(result.tables.users.rows, 2);
  assert.equal(result.migrations.length, 10);
  for (const name of tableNames) assert.ok(connection.state.queries.includes(`SELECT * FROM \`${name}\` ORDER BY \`${name === 'flyway_schema_history' ? 'installed_rank' : 'id'}\``));
  assert.doesNotMatch(JSON.stringify(result), /secret-hash|含中文/);
  connection.state.data.activities[0].cover_image[1] = 254;
  const changed = await snapshotDatabase(connection);
  assert.notEqual(changed.tables.activities.contentSha256, result.tables.activities.contentSha256);
  assert.equal(changed.tables.users.contentSha256, result.tables.users.contentSha256);
});

test('snapshot refuses invalid migrations, preset roles and non-InnoDB tables and rolls back', async () => {
  for (const [mutate, code] of [
    [connection => { connection.state.data.flyway_schema_history[9].success = 0; }, 'MIGRATIONS_REFUSED'],
    [connection => { connection.state.data.flyway_schema_history.pop(); }, 'MIGRATIONS_REFUSED'],
    [connection => { connection.state.data.users[1].role = 'ADMIN'; }, 'PRESET_ACCOUNTS_REFUSED'],
  ]) {
    const connection = database(); mutate(connection);
    await assert.rejects(snapshotDatabase(connection), { code });
    assert.equal(connection.state.rollbacks, 1);
    assert.equal(connection.state.commits, 0);
  }
  await assert.rejects(snapshotDatabase(database({ engine: 'MyISAM' })), { code: 'SCHEMA_REFUSED' });
});

test('raw database snapshot failures are sanitized and never reported as a valid snapshot', async () => {
  const connection = database({ fail: sql => sql.startsWith('SELECT * FROM `activities`') });
  await assert.rejects(snapshotDatabase(connection), error => error.code === 'SNAPSHOT_FAILED' && !/PRIVATE|password|SQL/.test(error.message));
  assert.equal(connection.state.rollbacks, 1);
});

test('configuration rejects remote/unknown targets, implicit identity and invalid paths before connecting', async () => {
  for (const change of [{ host: 'localhost' }, { host: 'production.example' }, { database: 'production' }, { port: 0 }, { expectedServerUuid: '' }, { password: '' }, { binDir: 'relative' }, { user: '--defaults-file=secret' }]) {
    let connected = false;
    await assert.rejects(createBackup({ ...baseConfig, ...change }, { connect: async () => { connected = true; } }));
    assert.equal(connected, false);
  }
});

test('backup uses isolated client credentials, fixed safe flags and publishes only complete private files', async () => {
  const oldPassword = process.env.MYSQL_PWD;
  const oldHome = process.env.MYSQL_HOME;
  process.env.MYSQL_PWD = 'ambient-secret'; process.env.MYSQL_HOME = 'ambient-config';
  try {
    const { directory, manifest, calls, connection } = await makeBackup();
    const call = calls[1];
    assert.deepEqual(call.args.slice(0, 2), ['--no-defaults', '--no-login-paths']);
    for (const flag of ['--single-transaction', '--quick', '--hex-blob', '--set-gtid-purged=OFF', '--no-tablespaces', '--skip-add-drop-table', '--skip-add-locks', '--skip-disable-keys', '--skip-triggers', '--skip-comments', '--default-character-set=utf8mb4']) assert.ok(call.args.includes(flag));
    assert.deepEqual(call.args.slice(-8), [baseConfig.database, ...tableNames]);
    assert.doesNotMatch(call.args.join(' '), /unit-secret|ambient-secret|--password|--databases|--force/);
    assert.equal(call.options.env.MYSQL_PWD, baseConfig.password);
    assert.equal(call.options.env.MYSQL_HOME, undefined);
    assert.equal(process.env.MYSQL_PWD, 'ambient-secret');
    assert.equal(calls[0].options.multipleStatements, false);
    assert.equal(calls[0].options.dateStrings, true);
    assert.equal(calls[0].options.bigNumberStrings, true);
    assert.equal(calls[0].options.jsonStrings, true);
    assert.deepEqual((await readdir(directory)).sort(), ['dump.sql', 'manifest.json']);
    assert.equal(manifest.dump.bytes, dumpSql.length);
    assert.match(manifest.dump.sha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.consistency, /no writes or DDL/);
    assert.equal(connection.state.commits, 2);
    assert.equal(connection.state.ended, true);
    assert.doesNotMatch(await readFile(join(directory, 'manifest.json'), 'utf8'), /unit-secret|secret-hash|password/);
    if (process.platform !== 'win32') {
      assert.equal((await lstat(directory)).mode & 0o777, 0o700);
      for (const file of ['dump.sql', 'manifest.json']) assert.equal((await lstat(join(directory, file))).mode & 0o777, 0o600);
    }
  } finally {
    if (oldPassword === undefined) delete process.env.MYSQL_PWD; else process.env.MYSQL_PWD = oldPassword;
    if (oldHome === undefined) delete process.env.MYSQL_HOME; else process.env.MYSQL_HOME = oldHome;
  }
});

test('backup rejects the wrong server UUID and non-8.4 servers before invoking mysqldump', async () => {
  for (const connection of [database({ config: { ...baseConfig, expectedServerUuid: otherUuid } }), database({ version: '8.0.44' })]) {
    let ran = false;
    await assert.rejects(createBackup(baseConfig, { connect: async () => connection, runClient: async () => { ran = true; } }));
    assert.equal(ran, false);
    assert.equal(connection.state.ended, true);
  }
});

test('source changes, dump failure and empty output never publish a manifest or retry', async () => {
  for (const [action, code] of [
    [async ({ connection, path }) => { await writeFile(path, dumpSql); connection.state.data.users[1].credential_version = '2'; }, 'SOURCE_CHANGED'],
    [async () => { throw new Error('raw client SQL/password output'); }, 'BACKUP_FAILED'],
    [async () => {}, 'DUMP_EMPTY'],
  ]) {
    let directory;
    let attempts = 0;
    await assert.rejects(makeBackup({ run: async options => { directory = dirname(options.path); attempts++; await action(options); } }), error => error.code === code && !/password|raw client/.test(error.message));
    assert.equal(attempts, 1);
    assert.deepEqual(await readdir(directory), ['dump.partial.sql']);
  }
});

test('restoration verifies the full seven-table snapshot and streams the verified dump with client commands disabled', async () => {
  const backup = await makeBackup();
  const restored = await importBackup(backup.directory);
  assert.equal(restored.summary.verified, true);
  assert.deepEqual(restored.summary.tables, backup.manifest.snapshot.tables);
  assert.deepEqual(restored.summary.migrations, backup.manifest.snapshot.migrations);
  assert.equal(restored.importedBytes.compare(dumpSql), 0);
  assert.deepEqual(restored.calls[1].args.slice(0, 2), ['--no-defaults', '--no-login-paths']);
  assert.ok(restored.calls[1].args.includes('--binary-mode=1'));
  assert.ok(restored.calls[1].args.includes('--local-infile=0'));
  assert.equal(restored.calls[1].options.env.MYSQL_PWD, targetConfig.password);
  assert.doesNotMatch(restored.calls[1].args.join(' '), /--password|unit-secret|--force/);
  assert.equal(restored.connection.state.ended, true);
});

test('restore refuses all original databases and source-equals-target but permits another new schema on the same server', async () => {
  const backup = await makeBackup();
  for (const database of ['activity_platform', 'activity_platform_test', 'activity_platform_e2e']) {
    await assert.rejects(restoreBackup(backup.directory, { ...targetConfig, database }), { code: 'RESTORE_TARGET_REFUSED' });
  }
  const sourceConfig = { ...baseConfig, database: `gatherrestore${'c'.repeat(32)}` };
  const isolated = await makeBackup({ config: sourceConfig, connection: database({ config: sourceConfig }) });
  await assert.rejects(restoreBackup(isolated.directory, { ...sourceConfig, user: restoreUsername }), { code: 'RESTORE_SOURCE_REFUSED' });
  const config = { ...targetConfig, expectedServerUuid: sourceUuid };
  assert.equal((await importBackup(isolated.directory, { config, connection: database({ config }) })).summary.verified, true);
});

test('restore refuses wrong server identity, nonempty schemas and accounts with grants beyond the target', async () => {
  const { directory } = await makeBackup();
  const prefix = `TO \`${restoreUsername}\`@\`localhost\``;
  const connections = [
    database({ config: { ...targetConfig, expectedServerUuid: sourceUuid } }),
    ...['TABLES', 'ROUTINES', 'EVENTS', 'TRIGGERS'].map(kind => database({ config: targetConfig, nonempty: { [kind]: 1 } })),
    database({ config: targetConfig, account: 'root@localhost' }),
    ...[
      [`GRANT ALL PRIVILEGES ON *.* ${prefix}`],
      [`GRANT ALL PRIVILEGES ON \`${restoreDatabase}\`.* ${prefix} WITH GRANT OPTION`],
      [`GRANT ALL PRIVILEGES ON \`other_schema\`.* ${prefix}`],
      [`GRANT \`role_name\`@\`%\` ${prefix}`],
      [`GRANT USAGE ON *.* ${prefix}`],
    ].map(grants => database({ config: targetConfig, grants })),
  ];
  for (const connection of connections) {
    let imported = false;
    await assert.rejects(restoreBackup(directory, targetConfig, { connect: async () => connection, runClient: async () => { imported = true; } }));
    assert.equal(imported, false);
    assert.equal(connection.state.ended, true);
    assert.equal(connection.state.queries.some(sql => /DROP|DELETE|TRUNCATE/.test(sql)), false);
  }
  await assert.rejects(restoreBackup(directory, { ...targetConfig, user: 'root' }), { code: 'RESTORE_TARGET_REFUSED' });
});

test('restore refuses tampered bytes, incomplete manifests, unpublished packages and paths outside the fixed root', async () => {
  for (const action of [
    async directory => writeFile(join(directory, 'dump.sql'), Buffer.concat([dumpSql, Buffer.from('tampered')])),
    async directory => editManifest(directory, manifest => { delete manifest.snapshot.tables.users; }),
    async directory => editManifest(directory, manifest => { manifest.snapshot.migrations[9].checksum = null; }),
    async directory => writeFile(join(directory, 'manifest.json'), 'not JSON / PRIVATE RAW SECRET'),
    async directory => unlink(join(directory, 'manifest.json')),
    async directory => writeFile(join(directory, 'dump.partial.sql'), 'partial'),
  ]) {
    const { directory } = await makeBackup(); await action(directory);
    let connected = false;
    await assert.rejects(restoreBackup(directory, targetConfig, { connect: async () => { connected = true; } }), error => !/PRIVATE|SECRET/.test(error.message));
    assert.equal(connected, false);
  }
  await assert.rejects(restoreBackup(unitRoot, targetConfig), { code: 'PATH_REFUSED' });
  await assert.rejects(restoreBackup(join(backupRoot, '..', 'outside'), targetConfig), { code: 'PATH_REFUSED' });
});

test('backup and restore reject directory junctions and symbolic files', async t => {
  const { directory } = await makeBackup();
  const alias = join(backupRoot, randomUUID());
  const binAlias = join(unitRoot, 'linked-bin');
  try {
    await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    ownedPackages.add(alias);
    await symlink(binDir, binAlias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('This host does not permit test symlinks.');
    throw error;
  }
  await assert.rejects(restoreBackup(alias, targetConfig), { code: 'PATH_REFUSED' });
  await assert.rejects(createBackup({ ...baseConfig, binDir: binAlias }), { code: 'PATH_REFUSED' });
  const originalDump = join(unitRoot, 'original-dump.sql');
  await writeFile(originalDump, dumpSql);
  await unlink(join(directory, 'dump.sql'));
  try { await symlink(originalDump, join(directory, 'dump.sql'), 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('This host does not permit file symlinks.');
    throw error;
  }
  await assert.rejects(restoreBackup(directory, targetConfig), { code: 'PATH_REFUSED' });
});

test('import failure and post-import mismatch retain the target, never clear data or claim success', async () => {
  const { directory } = await makeBackup();
  for (const run of [
    async () => { throw new Error('raw import diagnostic with password and SQL'); },
    async connection => { connection.state.data.activities[0].cover_image[0] = 3; },
  ]) {
    const connection = database({ config: targetConfig });
    await assert.rejects(importBackup(directory, { connection, run }), error => !/raw import|password|SQL/.test(error.message));
    assert.equal(connection.state.imported, true);
    assert.equal(connection.state.queries.some(sql => /DROP|DELETE|TRUNCATE/.test(sql)), false);
    assert.equal(connection.state.ended, true);
  }
});

test('CLI requires explicit environment and hides supplied command-line secrets in usage errors', () => {
  const modulePath = join(root, 'scripts', 'database-backup.mjs');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BACKUP_')));
  const missing = spawnSync(process.execPath, [modulePath, 'backup'], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /CONFIG_MISSING: Set BACKUP_DB_HOST explicitly/);
  const invalid = spawnSync(process.execPath, [modulePath, 'backup', '--password=PRIVATE_SECRET'], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /USAGE/);
  assert.doesNotMatch(invalid.stderr + invalid.stdout, /PRIVATE_SECRET/);
});
