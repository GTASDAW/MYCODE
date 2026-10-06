import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const runtimeDirectory = resolve('.runtime/e2e');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const allowedDatabases = new Set(['activity_platform', 'activity_platform_test', 'activity_platform_e2e']);
const renameDelays = [20, 40, 80, 160, 250, 250];
const pauseBuffer = new Int32Array(new SharedArrayBuffer(4));

export function databaseConfig(environment = process.env) {
  for (const key of ['E2E_DB_HOST', 'E2E_DB_PORT', 'E2E_DB_NAME', 'E2E_DB_USERNAME', 'E2E_DB_PASSWORD']) {
    if (!environment[key]) throw new Error(`Set ${key} explicitly before E2E tests or cleanup. No test data has been deleted.`);
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(environment.E2E_DB_HOST)) {
    throw new Error('E2E cleanup is restricted to an explicitly configured loopback database.');
  }
  if (!allowedDatabases.has(environment.E2E_DB_NAME)) throw new Error('E2E cleanup database name is not a Gather development/test database.');
  const port = Number(environment.E2E_DB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('E2E_DB_PORT must be a valid TCP port.');
  return {
    host: environment.E2E_DB_HOST, port, database: environment.E2E_DB_NAME,
    user: environment.E2E_DB_USERNAME, password: environment.E2E_DB_PASSWORD,
    connectTimeout: 10000, multipleStatements: false,
  };
}

export async function verifyDatabase(connection, config, expected) {
  const [[identity]] = await connection.execute('SELECT DATABASE() AS databaseName, @@server_uuid AS serverUuid');
  if (identity.databaseName !== config.database || !identity.serverUuid) throw new Error('Connected database identity did not match the configured Gather database.');
  if (expected && (expected.host !== config.host || expected.port !== config.port
      || expected.database !== config.database || expected.serverUuid !== identity.serverUuid)) {
    throw new Error('Database target differs from the fixture manifest. Cleanup refused.');
  }
  const [migrations] = await connection.execute("SELECT version FROM flyway_schema_history WHERE success = 1 AND version IN ('1', '2') ORDER BY installed_rank");
  if (!['1', '2'].every(version => migrations.some(row => row.version === version))) {
    throw new Error('Gather Flyway V1/V2 migrations are missing. Cleanup refused.');
  }
  // These reads also validate the expected tables/columns before any fixture writes/deletes.
  await connection.execute('SELECT id, title, description, registered_count FROM activities LIMIT 0');
  await connection.execute('SELECT id, activity_id, user_id, status FROM registrations LIMIT 0');
  const [accounts] = await connection.execute("SELECT username, role FROM users WHERE username IN ('admin', 'demo')");
  if (!accounts.some(row => row.username === 'admin' && row.role === 'ADMIN')
      || !accounts.some(row => row.username === 'demo' && row.role === 'USER')) {
    throw new Error('Gather demo account identity is missing. Cleanup refused.');
  }
  return { host: config.host, port: config.port, database: config.database, serverUuid: identity.serverUuid };
}

export function renameManifestWithRetry(source, destination, {
  rename = renameSync, platform = process.platform,
  pause = milliseconds => Atomics.wait(pauseBuffer, 0, 0, milliseconds),
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { rename(source, destination); return; }
    catch (error) {
      // Windows file watchers/antivirus can briefly hold an existing manifest.
      // Keep atomic replacement: never remove the destination to work around it.
      if (platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code) || attempt >= renameDelays.length) throw error;
      pause(renameDelays[attempt]);
    }
  }
}

function saveManifest(path, manifest) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  // A permanent refusal still throws and retains the temporary file for diagnosis.
  renameManifestWithRetry(temporary, path);
}

function readManifest(path) {
  const absolutePath = resolve(path);
  if (dirname(absolutePath) !== runtimeDirectory) throw new Error('Fixture manifest must be directly inside .runtime/e2e.');
  const manifest = JSON.parse(readFileSync(absolutePath, 'utf8'));
  if (manifest.version !== 1 || !uuidPattern.test(manifest.runId) || !Array.isArray(manifest.fixtures)
      || !manifest.target || !allowedDatabases.has(manifest.target.database)) throw new Error('Invalid fixture manifest. Cleanup refused.');
  const keys = new Set();
  for (const fixture of manifest.fixtures) {
    if (!uuidPattern.test(fixture.key) || keys.has(fixture.key) || typeof fixture.title !== 'string'
        || typeof fixture.description !== 'string' || !fixture.description.endsWith(fixtureMarker(manifest.runId, fixture.key))
        || (fixture.id !== null && (!Number.isSafeInteger(fixture.id) || fixture.id < 1))) {
      throw new Error('Invalid fixture ownership proof. Cleanup refused.');
    }
    keys.add(fixture.key);
  }
  if (manifest.cleanupIntent && (!Array.isArray(manifest.cleanupIntent.verifiedIds)
      || manifest.cleanupIntent.verifiedIds.some(id => !Number.isSafeInteger(id) || id < 1))) {
    throw new Error('Invalid persisted cleanup intent. Cleanup refused.');
  }
  return { manifest, path: absolutePath };
}

function fixtureMarker(runId, key) { return `[Gather E2E ${runId}/${key}]`; }

export async function initializeRun(baseUrl) {
  const url = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('E2E tests only target a local Gather application.');
  }
  const config = databaseConfig();
  const connection = await mysql.createConnection(config);
  let manifestPath;
  try {
    const target = await verifyDatabase(connection, config);
    const runId = randomUUID();
    manifestPath = resolve(runtimeDirectory, `${runId}.json`);
    mkdirSync(runtimeDirectory, { recursive: true });
    saveManifest(manifestPath, { version: 1, runId, baseUrl: url.origin, target, startedAt: new Date().toISOString(), fixtures: [] });
    process.env.E2E_RUN_MANIFEST = manifestPath;
    console.log(`E2E fixture manifest: ${manifestPath}`);
    const probe = trackFixture(`浏览器数据库连接核对 ${runId.slice(0, 8)}`, '确认浏览器 API 与精确清理使用同一数据库。');
    const [created] = await connection.execute(
      "INSERT INTO activities (title, description, location, starts_at, capacity, registered_count, created_by) VALUES (?, ?, ?, UTC_TIMESTAMP(6) + INTERVAL 48 HOUR, 1, 0, (SELECT id FROM users WHERE username = 'admin'))",
      [probe.title, probe.description, 'E2E 数据库连接核对']);
    recordFixtureId(probe.key, created.insertId);
    const response = await fetch(new URL(`/api/activities/${created.insertId}`, url), { signal: AbortSignal.timeout(10000) });
    const activity = response.ok ? await response.json() : null;
    if (!activity || activity.id !== created.insertId || activity.title !== probe.title || activity.description !== probe.description) {
      throw new Error('The local API and E2E_DB_* database are different. Tests stopped before API fixture writes.');
    }
    return manifestPath;
  } catch (error) {
    if (manifestPath) {
      try { await cleanupRun(manifestPath); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'E2E setup and exact fixture cleanup both failed. See the run manifest.'); }
    }
    throw error;
  } finally { await connection.end(); }
}

export function trackFixture(title, description) {
  if (!process.env.E2E_RUN_MANIFEST) throw new Error('E2E fixture tracking was not initialized.');
  const { manifest, path } = readManifest(process.env.E2E_RUN_MANIFEST);
  const key = randomUUID();
  const fixture = { key, id: null, title, description: `${description}\n${fixtureMarker(manifest.runId, key)}` };
  manifest.fixtures.push(fixture);
  saveManifest(path, manifest);
  return fixture;
}

export function recordFixtureId(key, id) {
  const { manifest, path } = readManifest(process.env.E2E_RUN_MANIFEST);
  const fixture = manifest.fixtures.find(item => item.key === key);
  if (!fixture || !Number.isSafeInteger(id) || id < 1 || (fixture.id !== null && fixture.id !== id)) {
    throw new Error('Created activity ID could not be recorded safely.');
  }
  fixture.id = id;
  saveManifest(path, manifest);
}

export async function deleteOwnedFixtures(connection, fixtures, alreadyDeleted = new Set(), beforeDelete = async () => {}) {
  await connection.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  await connection.beginTransaction();
  try {
    const resolved = [];
    for (const fixture of fixtures) {
      let id = fixture.id;
      if (id === null) {
        // An HTTP/UI assertion can fail after INSERT but before its ID is recorded.
        // Resolve that one pre-recorded intent, never a title prefix/date/range.
        const [matches] = await connection.execute(
          'SELECT id FROM activities WHERE CAST(title AS BINARY) = CAST(? AS BINARY) AND CAST(description AS BINARY) = CAST(? AS BINARY) LIMIT 2',
          [fixture.title, fixture.description]);
        if (matches.length > 1) throw new Error('One fixture intent matched multiple activities. Cleanup refused.');
        if (matches.length === 1) id = matches[0].id;
      }
      if (id !== null) resolved.push({ ...fixture, id });
    }
    resolved.sort((first, second) => first.id - second.id);
    if (new Set(resolved.map(fixture => fixture.id)).size !== resolved.length) throw new Error('Duplicate activity IDs in fixture manifest. Cleanup refused.');

    const locked = [];
    // Validate ALL ownership proofs first, before the first DELETE.
    for (const fixture of resolved) {
      const [rows] = await connection.execute('SELECT id, title, description FROM activities WHERE id = ? FOR UPDATE', [fixture.id]);
      if (rows.length === 0) {
        if (alreadyDeleted.has(fixture.id)) continue;
        throw new Error(`Created activity ${fixture.id} is missing from this database. Cleanup target could be wrong.`);
      }
      if (rows[0].title !== fixture.title || rows[0].description !== fixture.description) {
        throw new Error(`Activity ${fixture.id} ownership changed. Entire cleanup rolled back.`);
      }
      locked.push(fixture);
    }
    // Persist verified IDs before deleting. A lost COMMIT reply/process interruption
    // can then be retried safely even if the final manifest write never happened.
    await beforeDelete(resolved);
    let deletedRegistrations = 0;
    for (const fixture of locked) {
      const [registrations] = await connection.execute('DELETE FROM registrations WHERE activity_id = ?', [fixture.id]);
      const [activity] = await connection.execute(
        'DELETE FROM activities WHERE id = ? AND CAST(title AS BINARY) = CAST(? AS BINARY) AND CAST(description AS BINARY) = CAST(? AS BINARY)',
        [fixture.id, fixture.title, fixture.description]);
      if (activity.affectedRows !== 1) throw new Error(`Activity ${fixture.id} was not deleted exactly once.`);
      deletedRegistrations += registrations.affectedRows;
    }
    await connection.commit();
    return { deletedActivities: locked.length, deletedRegistrations, resolvedIds: resolved.map(fixture => fixture.id) };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

export async function cleanupRun(manifestPath) {
  const { manifest, path } = readManifest(manifestPath);
  const config = databaseConfig();
  const connection = await mysql.createConnection(config);
  try {
    await verifyDatabase(connection, config, manifest.target);
    const previousIds = manifest.cleanup?.completedAt ? manifest.cleanup.resolvedIds : [];
    const allowedMissing = new Set([...previousIds, ...(manifest.cleanupIntent?.verifiedIds ?? [])]);
    const result = await deleteOwnedFixtures(connection, manifest.fixtures, allowedMissing, async resolved => {
      for (const fixture of resolved) manifest.fixtures.find(item => item.key === fixture.key).id = fixture.id;
      manifest.cleanupIntent = { verifiedIds: resolved.map(fixture => fixture.id), verifiedAt: new Date().toISOString() };
      saveManifest(path, manifest);
    });
    const completedAt = new Date().toISOString();
    if (manifest.cleanup?.completedAt) {
      // Keep the first successful deletion counts when CI's always-step retries.
      manifest.lastCleanupAttempt = { ...result, completedAt };
    } else {
      manifest.cleanup = { ...result, completedAt };
    }
    saveManifest(path, manifest);
    console.log(`E2E cleanup complete: ${result.deletedActivities} activities, ${result.deletedRegistrations} registrations; demo/other rows retained.`);
    return result;
  } catch (error) {
    const failure = { failedAt: new Date().toISOString(), error: error.message };
    if (manifest.cleanup?.completedAt) manifest.lastCleanupAttempt = failure;
    else manifest.cleanup = failure;
    saveManifest(path, manifest);
    throw error;
  } finally { await connection.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    console.error('Usage: npm run cleanup:e2e -- .runtime/e2e/<run-id>.json (requires the same E2E_DB_* environment).');
    process.exitCode = 1;
  } else {
    try { await cleanupRun(process.argv[2]); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
