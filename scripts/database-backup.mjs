import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { constants, createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import mysql from 'mysql2/promise';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backupRoot = join(repositoryRoot, '.runtime', 'backups');
const tables = ['users', 'activities', 'registrations', 'notifications', 'activity_audit_logs', 'activity_favorites', 'flyway_schema_history'];
const sourceNames = new Set(['activity_platform', 'activity_platform_test', 'activity_platform_e2e']);
const restoreName = /^gatherrestore[a-f0-9]{32}$/;
const restoreUser = /^grestore[a-f0-9]{16}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const packageUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha256 = /^[a-f0-9]{64}$/;
const quietWindow = 'Local rehearsal only: no writes or DDL during the complete backup window; the dump and verification snapshots use separate transactions.';
const executeFile = promisify(execFile);

class BackupError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.name = 'BackupError'; this.code = code; }
}
function refuse(code, message) { throw new BackupError(code, message); }
function sanitized(error, code, message) { return error instanceof BackupError ? error : new BackupError(code, message); }

function validateConfig(config, restoring = false) {
  if (!config || !['127.0.0.1', '::1'].includes(config.host)
      || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535
      || typeof config.user !== 'string' || !/^[a-zA-Z0-9_]{1,32}$/.test(config.user)
      || typeof config.password !== 'string' || !config.password || config.password.includes('\0')
      || typeof config.expectedServerUuid !== 'string' || !uuid.test(config.expectedServerUuid)
      || typeof config.binDir !== 'string' || !isAbsolute(config.binDir)) {
    refuse('CONFIG_INVALID', 'Explicit loopback database credentials, port, server UUID and an absolute MySQL binary directory are required.');
  }
  if (typeof config.database !== 'string' || (!sourceNames.has(config.database) && !restoreName.test(config.database))) {
    refuse('DATABASE_REFUSED', 'Only the named Gather local databases or an isolated restore schema may be backed up.');
  }
  if (restoring && (!restoreName.test(config.database) || !restoreUser.test(config.user))) {
    refuse('RESTORE_TARGET_REFUSED', 'Restore requires a new gatherrestore schema and its dedicated grestore account.');
  }
}

async function assertNoSymlinks(path) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) refuse('PATH_REFUSED', 'Symbolic links and junctions are not accepted.');
  }
  if (await realpath(absolute) !== absolute) refuse('PATH_REFUSED', 'The path must resolve directly to its configured location.');
  return lstat(absolute);
}

async function privateDirectory(path) {
  const parent = dirname(path);
  try { await assertNoSymlinks(parent); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await privateDirectory(parent);
  }
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await assertNoSymlinks(path);
  if (!info.isDirectory()) refuse('PATH_REFUSED', 'The backup location must be a directory.');
  await chmod(path, 0o700);
  const namespaces = ['backups', 'restore-drills'].map(name => join(repositoryRoot, '.runtime', name));
  if (process.platform === 'win32' && namespaces.some(base => path === base || path.startsWith(base + sep))) {
    // POSIX modes do not restrict inherited NTFS permissions. Keep this ACL
    // change inside the backup/drill namespaces, never the demo data directory.
    const encodedPath = Buffer.from(path, 'utf8').toString('base64');
    const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'));
      $self=[Security.Principal.WindowsIdentity]::GetCurrent().User;
      $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false);
      foreach($sid in @($self,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,
          [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow));
      }; [IO.Directory]::SetAccessControl($p,$acl);
      $actual=[IO.Directory]::GetAccessControl($p); if(-not $actual.AreAccessRulesProtected) { throw 'Directory ACL is not protected' };
      $allowed=@($self.Value,'S-1-5-18','S-1-5-32-544');
      foreach($entry in $actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if($entry.AccessControlType -eq 'Allow' -and $entry.IdentityReference.Value -notin $allowed) { throw 'Unexpected directory grant' }
      }`;
    try {
      await executeFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 15000, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BACKUP_|MYSQL_)/i.test(key))) });
    } catch { refuse('DIRECTORY_PERMISSIONS', 'The backup or drill directory could not be restricted to its owner, SYSTEM and administrators.'); }
  }
}

export async function secureRuntimeDirectory(path) {
  const absolute = resolve(path);
  if (!['backups', 'restore-drills'].some(name => {
    const base = join(repositoryRoot, '.runtime', name); return absolute === base || absolute.startsWith(base + sep);
  })) refuse('PATH_REFUSED', 'Only Gather backup and restore-drill directories may be secured.');
  await privateDirectory(absolute);
}

async function clientPath(config, name) {
  const directory = await assertNoSymlinks(config.binDir);
  if (!directory.isDirectory()) refuse('CLIENT_REFUSED', 'The configured MySQL binary directory is invalid.');
  const path = join(config.binDir, process.platform === 'win32' ? `${name}.exe` : name);
  if (!(await assertNoSymlinks(path)).isFile()) refuse('CLIENT_REFUSED', 'A regular MySQL client executable is required.');
  return path;
}

function connectionOptions(config) {
  return {
    host: config.host, port: config.port, database: config.database, user: config.user, password: config.password,
    connectTimeout: 10000, multipleStatements: false, charset: 'utf8mb4', timezone: 'Z',
    dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true,
  };
}

async function verifyIdentity(connection, config) {
  const [[identity]] = await connection.execute('SELECT DATABASE() AS databaseName, @@server_uuid AS serverUuid, @@version AS mysqlVersion');
  if (!identity || identity.databaseName !== config.database || identity.serverUuid !== config.expectedServerUuid) {
    refuse('IDENTITY_MISMATCH', 'The database or server UUID does not match the explicit configuration.');
  }
  if (typeof identity.mysqlVersion !== 'string' || !/^8\.4\./.test(identity.mysqlVersion)) {
    refuse('MYSQL_VERSION_REFUSED', 'This rehearsal requires MySQL 8.4.');
  }
  await connection.execute("SET SESSION time_zone = '+00:00'");
  return { host: config.host, port: config.port, database: config.database, serverUuid: identity.serverUuid, mysqlVersion: identity.mysqlVersion };
}

function canonicalCell(value) {
  if (value === null) return ['null'];
  if (Buffer.isBuffer(value)) return ['bytes', value.toString('base64')];
  if (typeof value === 'string') return ['string', value];
  if (typeof value === 'number' && Number.isFinite(value)) return ['number', String(value)];
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (typeof value === 'boolean') return ['boolean', value];
  refuse('SNAPSHOT_VALUE_REFUSED', 'A database value cannot be represented by the configured lossless reader.');
}

function contentDigest(rows, fields) {
  const columns = fields?.map(field => field.name) ?? Object.keys(rows[0] ?? {});
  const hash = createHash('sha256').update(`${JSON.stringify(columns)}\n`);
  for (const row of rows) hash.update(`${JSON.stringify(columns.map(column => canonicalCell(row[column])))}\n`);
  return hash.digest('hex');
}

// SHOW CREATE TABLE is compared separately from the complete, typed row digest.
// The caller must keep the entire rehearsal window free of DML and DDL: this
// read-only transaction cannot share a snapshot with the mysqldump process.
export async function snapshotDatabase(connection) {
  let started = false;
  try {
    await connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    // MySQL 8.4 rejects this START TRANSACTION form in prepared statements.
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    started = true;
    const [metadata] = await connection.execute('SELECT TABLE_NAME AS tableName, ENGINE AS engine, TABLE_TYPE AS tableType FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME');
    if (metadata.length !== tables.length || tables.some(name => !metadata.some(row => row.tableName === name && row.engine === 'InnoDB' && row.tableType === 'BASE TABLE'))) {
      refuse('SCHEMA_REFUSED', 'The Gather schema must contain exactly the seven expected InnoDB tables.');
    }
    const result = { tables: {}, migrations: [] };
    for (const name of tables) {
      const [[definition]] = await connection.execute(`SHOW CREATE TABLE \`${name}\``);
      const ddl = definition?.['Create Table'];
      if (typeof ddl !== 'string' || !ddl) refuse('SCHEMA_REFUSED', 'A table definition is unavailable.');
      const [rows, fields] = await connection.execute(`SELECT * FROM \`${name}\` ORDER BY \`${name === 'flyway_schema_history' ? 'installed_rank' : 'id'}\``);
      if (name === 'activities' && !fields?.some(field => field.name === 'ends_at')) {
        refuse('SCHEMA_REFUSED', 'The V11 activity end-time column is required.');
      }
      result.tables[name] = { rows: rows.length, contentSha256: contentDigest(rows, fields), schemaSha256: createHash('sha256').update(ddl).digest('hex') };
      if (name === 'users' && (!rows.some(row => row.username === 'admin' && row.role === 'ADMIN') || !rows.some(row => row.username === 'demo' && row.role === 'USER'))) {
        refuse('PRESET_ACCOUNTS_REFUSED', 'The expected admin and demo account roles are missing.');
      }
      if (name === 'flyway_schema_history') {
        if (rows.length !== 11 || rows.some((row, index) => String(row.version) !== String(index + 1) || Number(row.success) !== 1 || !Number.isInteger(row.checksum))) {
          refuse('MIGRATIONS_REFUSED', 'Exactly the successful Flyway V1 through V11 migrations and checksums are required.');
        }
        result.migrations = rows.map(row => ({ version: String(row.version), checksum: row.checksum }));
      }
    }
    await connection.commit();
    started = false;
    return result;
  } catch (error) {
    if (started) await connection.rollback().catch(() => {});
    throw sanitized(error, 'SNAPSHOT_FAILED', 'Database snapshot failed; no database details have been recorded.');
  }
}

function clientArguments(config) {
  return ['--no-defaults', '--no-login-paths', '--protocol=TCP', `--host=${config.host}`, `--port=${config.port}`, `--user=${config.user}`, '--default-character-set=utf8mb4'];
}
function clientEnvironment(config) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('MYSQL_'))), MYSQL_PWD: config.password };
}

async function runClient(executable, args, { env, input } = {}) {
  const child = spawn(executable, args, { env, shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  child.stderr.resume(); // Never return or log raw client diagnostics or SQL.
  const completion = new Promise((resolveRun, rejectRun) => {
    child.once('error', () => rejectRun(new BackupError('CLIENT_FAILED', 'The MySQL client could not run.')));
    child.once('close', code => code === 0 ? resolveRun() : rejectRun(new BackupError('CLIENT_FAILED', 'The MySQL client failed; the partial package or target is retained.')));
  });
  const transfer = input ? pipeline(input, child.stdin) : Promise.resolve(child.stdin.end());
  const results = await Promise.allSettled([completion, transfer]);
  if (results.some(result => result.status === 'rejected')) refuse('CLIENT_FAILED', 'The MySQL client failed; the partial package or target is retained.');
}

async function regularFile(path) {
  if (!(await assertNoSymlinks(path)).isFile()) refuse('PACKAGE_INVALID', 'Backup files must be regular files.');
  return open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
}

async function fileDigest(handle) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}

async function writePrivate(path, text) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}

export async function createBackup(config, dependencies = {}) {
  let connection;
  try {
    validateConfig(config);
    const executable = await clientPath(config, 'mysqldump');
    connection = await (dependencies.connect ?? mysql.createConnection)(connectionOptions(config));
    const source = await verifyIdentity(connection, config);
    const before = await snapshotDatabase(connection);
    await privateDirectory(backupRoot);
    const runId = randomUUID();
    const directory = join(backupRoot, runId);
    await mkdir(directory, { mode: 0o700 }); // Never reuse or overwrite a package.
    await assertNoSymlinks(directory);
    const partial = join(directory, 'dump.partial.sql');
    await writePrivate(partial, '');
    await (dependencies.runClient ?? runClient)(executable, [...clientArguments(config),
      '--single-transaction', '--quick', '--hex-blob', '--set-gtid-purged=OFF', '--no-tablespaces',
      '--skip-add-drop-table', '--skip-add-locks', '--skip-disable-keys', '--skip-triggers', '--skip-comments',
      `--result-file=${partial}`, config.database, ...tables,
    ], { env: clientEnvironment(config) });
    await chmod(partial, 0o600);
    const after = await snapshotDatabase(connection);
    if (JSON.stringify(before) !== JSON.stringify(after)) refuse('SOURCE_CHANGED', 'The source changed during the no-write/no-DDL rehearsal window; this package is not published.');
    const dump = await regularFile(partial);
    let digest;
    try { digest = await fileDigest(dump); } finally { await dump.close(); }
    if (!digest.bytes) refuse('DUMP_EMPTY', 'The MySQL client produced an empty dump; this package is not published.');
    const manifest = { version: 1, runId, createdAt: new Date().toISOString(), consistency: quietWindow, source, dump: digest, snapshot: before };
    const manifestPartial = join(directory, 'manifest.partial.json');
    await writePrivate(manifestPartial, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(partial, join(directory, 'dump.sql'));
    // A package is usable only after this atomic publication of its manifest.
    await rename(manifestPartial, join(directory, 'manifest.json'));
    return { directory, manifest };
  } catch (error) {
    throw sanitized(error, 'BACKUP_FAILED', 'Backup failed; no complete package was published.');
  } finally { if (connection) await connection.end().catch(() => {}); }
}

function validateManifest(manifest, runId) {
  if (!manifest || manifest.version !== 1 || manifest.runId !== runId || manifest.consistency !== quietWindow
      || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))
      || !manifest.source || !['127.0.0.1', '::1'].includes(manifest.source.host)
      || !Number.isInteger(manifest.source.port) || manifest.source.port < 1 || manifest.source.port > 65535
      || (!sourceNames.has(manifest.source.database) && !restoreName.test(manifest.source.database))
      || !uuid.test(manifest.source.serverUuid) || !/^8\.4\./.test(manifest.source.mysqlVersion)
      || !manifest.dump || !Number.isSafeInteger(manifest.dump.bytes) || manifest.dump.bytes < 1 || !sha256.test(manifest.dump.sha256)
      || !manifest.snapshot || !manifest.snapshot.tables || Object.keys(manifest.snapshot.tables).length !== tables.length
      || tables.some(name => {
        const table = manifest.snapshot.tables[name];
        return !table || !Number.isSafeInteger(table.rows) || table.rows < 0 || !sha256.test(table.contentSha256) || !sha256.test(table.schemaSha256);
      }) || !Array.isArray(manifest.snapshot.migrations) || manifest.snapshot.migrations.length !== 11
      || manifest.snapshot.migrations.some((migration, index) => migration.version !== String(index + 1) || !Number.isInteger(migration.checksum))) {
    refuse('PACKAGE_INVALID', 'The backup manifest is invalid or incomplete.');
  }
}

async function readPackage(directory) {
  if (typeof directory !== 'string') refuse('PATH_REFUSED', 'A backup package directory is required.');
  const absolute = resolve(directory);
  const runId = relative(backupRoot, absolute);
  if (!packageUuid.test(runId) || dirname(absolute) !== backupRoot) refuse('PATH_REFUSED', 'The package must be directly inside this repository .runtime/backups directory.');
  if (!(await assertNoSymlinks(absolute)).isDirectory()) refuse('PATH_REFUSED', 'The package path must be a directory.');
  const names = (await readdir(absolute)).sort();
  if (JSON.stringify(names) !== JSON.stringify(['dump.sql', 'manifest.json'])) refuse('PACKAGE_INVALID', 'Only a complete, published backup package can be restored.');
  const manifestFile = await regularFile(join(absolute, 'manifest.json'));
  let manifest;
  try {
    if ((await manifestFile.stat()).size > 1024 * 1024) refuse('PACKAGE_INVALID', 'The backup manifest is too large.');
    manifest = JSON.parse(await manifestFile.readFile('utf8'));
  } finally { await manifestFile.close(); }
  validateManifest(manifest, runId);
  const dump = await regularFile(join(absolute, 'dump.sql'));
  try {
    const digest = await fileDigest(dump);
    if (digest.bytes !== manifest.dump.bytes || digest.sha256 !== manifest.dump.sha256) refuse('PACKAGE_TAMPERED', 'The backup dump byte count or checksum does not match its manifest.');
    return { directory: absolute, manifest, dump };
  } catch (error) { await dump.close(); throw error; }
}

async function verifyRestorePrivileges(connection, config) {
  const [[identity]] = await connection.execute('SELECT CURRENT_USER() AS accountName');
  if (!identity || typeof identity.accountName !== 'string' || identity.accountName.split('@')[0] !== config.user) {
    refuse('RESTORE_ACCOUNT_REFUSED', 'The authenticated account must be the dedicated restore account.');
  }
  const [grants] = await connection.execute('SHOW GRANTS');
  const escapedUser = config.user;
  const recipient = `(?:\x60${escapedUser}\x60|'${escapedUser}')@(?:\x60[^\x60]+\x60|'[^']+')`;
  const usage = new RegExp(`^GRANT USAGE ON \\*\\.\\* TO ${recipient}$`);
  const schema = new RegExp(`^GRANT ALL PRIVILEGES ON \x60${config.database}\x60\\.\\* TO ${recipient}$`);
  let schemaGrant = false;
  if (!grants.length || grants.some(row => {
    const values = Object.values(row);
    if (values.length !== 1 || typeof values[0] !== 'string') return true;
    if (schema.test(values[0])) { schemaGrant = true; return false; }
    return !usage.test(values[0]);
  }) || !schemaGrant) {
    refuse('RESTORE_GRANTS_REFUSED', 'Restore permits only USAGE and ALL PRIVILEGES on the exact target schema, without roles or GRANT OPTION.');
  }
}

async function verifyEmptyTarget(connection) {
  for (const [table, column] of [['TABLES', 'TABLE_SCHEMA'], ['ROUTINES', 'ROUTINE_SCHEMA'], ['EVENTS', 'EVENT_SCHEMA'], ['TRIGGERS', 'TRIGGER_SCHEMA']]) {
    const [[row]] = await connection.execute(`SELECT COUNT(*) AS objectCount FROM information_schema.${table} WHERE ${column} = DATABASE()`);
    if (!row || Number(row.objectCount) !== 0) refuse('RESTORE_NOT_EMPTY', 'The target schema must be completely empty; existing or partially restored objects are never overwritten.');
  }
}

export async function restoreBackup(directory, config, dependencies = {}) {
  let connection;
  let backup;
  try {
    validateConfig(config, true);
    backup = await readPackage(directory);
    if (backup.manifest.source.serverUuid === config.expectedServerUuid && backup.manifest.source.database === config.database) {
      refuse('RESTORE_SOURCE_REFUSED', 'The backup source cannot be its own restore target.');
    }
    const executable = await clientPath(config, 'mysql');
    connection = await (dependencies.connect ?? mysql.createConnection)(connectionOptions(config));
    const target = await verifyIdentity(connection, config);
    await verifyRestorePrivileges(connection, config);
    await verifyEmptyTarget(connection);
    await (dependencies.runClient ?? runClient)(executable, [...clientArguments(config), '--binary-mode=1', '--local-infile=0', config.database], {
      env: clientEnvironment(config), input: backup.dump.createReadStream({ start: 0, autoClose: false }),
    });
    const restored = await snapshotDatabase(connection);
    if (JSON.stringify(restored) !== JSON.stringify(backup.manifest.snapshot)) {
      refuse('RESTORE_MISMATCH', 'The restored table definitions, rows or migrations do not match the backup; the target is retained for diagnosis.');
    }
    return { directory: backup.directory, target, verified: true, tables: restored.tables, migrations: restored.migrations, consistency: quietWindow };
  } catch (error) {
    throw sanitized(error, 'RESTORE_FAILED', 'Restore failed; the target is retained for diagnosis and is never automatically cleared or retried.');
  } finally {
    if (backup) await backup.dump.close().catch(() => {});
    if (connection) await connection.end().catch(() => {});
  }
}

function environmentConfig(environment) {
  for (const name of ['BACKUP_DB_HOST', 'BACKUP_DB_PORT', 'BACKUP_DB_NAME', 'BACKUP_DB_USER', 'BACKUP_DB_PASSWORD', 'BACKUP_DB_SERVER_UUID', 'BACKUP_MYSQL_BIN_DIR']) {
    if (!environment[name]) refuse('CONFIG_MISSING', `Set ${name} explicitly.`);
  }
  return { host: environment.BACKUP_DB_HOST, port: Number(environment.BACKUP_DB_PORT), database: environment.BACKUP_DB_NAME,
    user: environment.BACKUP_DB_USER, password: environment.BACKUP_DB_PASSWORD, expectedServerUuid: environment.BACKUP_DB_SERVER_UUID, binDir: environment.BACKUP_MYSQL_BIN_DIR };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [command, directory, ...extra] = process.argv.slice(2);
    if (extra.length || !['backup', 'restore'].includes(command) || (command === 'backup' && directory) || (command === 'restore' && !directory)) {
      refuse('USAGE', 'Use node scripts/database-backup.mjs backup | restore <directory>.');
    }
    const config = environmentConfig(process.env);
    const result = command === 'backup' ? await createBackup(config) : await restoreBackup(directory, config);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(sanitized(error, 'OPERATION_FAILED', 'The backup operation failed.').message);
    process.exitCode = 1;
  }
}
