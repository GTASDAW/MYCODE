import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

const baseUrl = new URL(process.env.E2E_BASE_URL ?? 'http://127.0.0.1:18088');
const loopback = new Set(['127.0.0.1', 'localhost']);
assert(loopback.has(baseUrl.hostname), 'Smoke checks require an explicitly local application URL.');
const database = process.env.E2E_DB_NAME;
assert(['activity_platform', 'activity_platform_test', 'activity_platform_e2e'].includes(database), 'Unexpected smoke database.');
assert(loopback.has(process.env.E2E_DB_HOST), 'Smoke database must be on the loopback address.');
assert(process.env.E2E_DB_USERNAME && process.env.E2E_DB_PASSWORD, 'Set explicit E2E_DB_* credentials before smoke checks.');
const databasePort = Number(process.env.E2E_DB_PORT);
assert(process.env.E2E_DB_PORT && Number.isInteger(databasePort) && databasePort >= 1 && databasePort <= 65535, 'Set a valid explicit E2E_DB_PORT.');

const checks = [];
let fixture;
let db;
let baseline;
let primaryError;
const runId = randomUUID();
const title = `Compose 验证 ${runId}`;
const description = `gather-compose-smoke:${runId}`;
const reportPath = '.runtime/ci/compose-smoke.json';

function check(name) { checks.push(name); console.log(`PASS: ${name}`); }

class ApiClient {
  cookies = new Map();

  async response(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set('Accept', 'application/json');
    if (this.cookies.size) headers.set('Cookie', [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    const result = await fetch(new URL(path, baseUrl), { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    for (const rawCookie of result.headers.getSetCookie()) {
      const part = rawCookie.split(';')[0];
      const separator = part.indexOf('=');
      const key = part.slice(0, separator);
      const value = part.slice(separator + 1);
      if (value) this.cookies.set(key, value);
      else this.cookies.delete(key);
    }
    return result;
  }

  async json(path, options = {}) {
    const result = await this.response(path, options);
    assert(result.ok, `${options.method ?? 'GET'} ${path} failed (${result.status}).`);
    return result.json();
  }

  async write(path, method = 'POST', data, form = false) {
    const csrf = await this.json('/api/auth/csrf');
    const headers = { [csrf.headerName]: csrf.token };
    if (data !== undefined) headers['Content-Type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
    return this.json(path, { method, headers, body: data === undefined ? undefined : form ? new URLSearchParams(data) : JSON.stringify(data) });
  }

  async login(username, password) {
    const user = await this.write('/api/auth/login', 'POST', { username, password }, true);
    assert.equal(user.username, username);
    return user;
  }
}

async function waitHealthy() {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const result = await fetch(new URL('/api/health', baseUrl), { signal: AbortSignal.timeout(3000) });
      if (result.ok && (await result.json()).status === 'UP') return;
    } catch { /* The known stack may still be starting; this bounded wait retries readiness only. */ }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error('The Compose application did not become healthy within 120 seconds.');
}

async function snapshot() {
  const [activities] = await db.query('SELECT id, title, description, location, starts_at, capacity, registered_count, created_by FROM activities ORDER BY id');
  const [registrations] = await db.query('SELECT id, activity_id, user_id, status, created_at, updated_at FROM registrations ORDER BY id');
  return JSON.stringify({ activities, registrations });
}

async function removeFixture() {
  // Exact intent can recover a created row even if its HTTP response was interrupted.
  await db.beginTransaction();
  try {
    const [rows] = await db.execute('SELECT id, title, description FROM activities WHERE CAST(title AS BINARY)=CAST(? AS BINARY) AND CAST(description AS BINARY)=CAST(? AS BINARY) FOR UPDATE', [title, description]);
    assert(rows.length <= 1, 'Multiple activities matched one smoke fixture intent.');
    if (fixture) {
      assert.equal(rows.length, 1, 'Created smoke activity is missing from the configured database; cleanup refused.');
      assert.equal(Number(rows[0].id), fixture.id, 'Smoke activity identity changed.');
    }
    for (const row of rows) {
      await db.execute('DELETE FROM registrations WHERE activity_id=?', [row.id]);
      const [result] = await db.execute('DELETE FROM activities WHERE id=? AND title=? AND description=?', [row.id, title, description]);
      assert.equal(result.affectedRows, 1, 'Smoke activity cleanup did not remove exactly one owned record.');
    }
    await db.commit();
    assert.equal(await snapshot(), baseline, 'Existing database records changed during smoke checks.');
    check('only the exact smoke fixture was removed; baseline data preserved');
  } catch (error) { await db.rollback(); throw error; }
}

try {
  await waitHealthy();
  check('Nginx /api/health reports the real database UP');
  db = await mysql.createConnection({
    host: process.env.E2E_DB_HOST,
    port: databasePort,
    database,
    user: process.env.E2E_DB_USERNAME,
    password: process.env.E2E_DB_PASSWORD,
    timezone: 'Z', dateStrings: true, connectTimeout: 10000,
  });
  const [[identity]] = await db.query('SELECT DATABASE() AS databaseName, @@server_uuid AS serverUuid, VERSION() AS version');
  assert.equal(identity.databaseName, database);
  assert.match(identity.version, /^8\.4\./, 'Compose must use real MySQL 8.4.');
  const [migrations] = await db.query('SELECT version, success FROM flyway_schema_history WHERE version IS NOT NULL ORDER BY installed_rank');
  assert.deepEqual(migrations.map(row => row.version), ['1', '2']);
  assert(migrations.every(row => row.success === 1));
  check('fresh MySQL schema contains successful Flyway V1 and V2');
  baseline = await snapshot();

  const anonymous = new ApiClient();
  const activities = await anonymous.json('/api/activities');
  assert(activities.length > 0, 'Fresh Compose startup must create demo activities.');
  assert(activities.every(row => Number.isInteger(row.waitingCount)));
  for (const path of ['/', `/activities/${activities[0].id}`, '/admin/dashboard']) {
    const page = await fetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(10000) });
    assert(page.ok && page.headers.get('Content-Type')?.includes('text/html'), `SPA deep link ${path} is unavailable.`);
    const html = await page.text();
    assert(html.includes('id="root"') && html.includes('/assets/'), 'Expected built React assets through Nginx.');
  }
  check('built frontend and refreshed deep links are served by Nginx');

  const admin = new ApiClient();
  const demo = new ApiClient();
  await admin.login('admin', process.env.DEMO_ADMIN_PASSWORD ?? 'Admin123!');
  await demo.login('demo', process.env.DEMO_USER_PASSWORD ?? 'Demo123!');
  fixture = await admin.write('/api/admin/activities', 'POST', {
    title, description, location: 'Compose isolated validation', capacity: 1,
    startsAt: new Date(Date.now() + 48 * 3600000).toISOString(),
  });
  assert(Number.isSafeInteger(fixture.id));
  const [ownedRows] = await db.execute('SELECT id, title, description FROM activities WHERE id=?', [fixture.id]);
  assert.equal(ownedRows.length, 1, 'The API-created fixture is absent from the configured smoke database.');
  assert.equal(ownedRows[0].title, title);
  assert.equal(ownedRows[0].description, description);
  assert.equal((await demo.write(`/api/activities/${fixture.id}/registration`)).registrationStatus, 'ACTIVE');
  const queued = await admin.write(`/api/activities/${fixture.id}/registration`);
  assert.equal(queued.registrationStatus, 'WAITING');
  assert.equal(queued.registeredCount, 1);
  assert.equal(queued.waitingCount, 1);
  const roster = await admin.json(`/api/admin/activities/${fixture.id}/registrations?status=WAITING`);
  assert.equal(roster.total, 1);
  assert.equal(roster.items[0].username, 'admin');
  const cancelled = await demo.write(`/api/activities/${fixture.id}/registration`, 'DELETE');
  assert.equal(cancelled.registrationStatus, 'CANCELLED');
  const promoted = await admin.json(`/api/activities/${fixture.id}`);
  assert.equal(promoted.registrationStatus, 'ACTIVE');
  assert.equal(promoted.registeredCount, 1);
  assert.equal(promoted.waitingCount, 0);
  check('login, CSRF, full signup and automatic promotion work through the real container stack');

  if (process.env.SMOKE_RESTART_BACKEND === '1') {
    assert.equal(process.env.COMPOSE_PROJECT_NAME, 'gather-ci', 'Restart is restricted to the isolated gather-ci project.');
    assert.equal(database, 'activity_platform_e2e', 'Restart requires the isolated CI database.');
    const beforeRestart = await snapshot();
    execFileSync('docker', ['compose', '-p', 'gather-ci', '-f', 'compose.yaml', '-f', '.github/compose.ci.yaml', 'restart', 'backend'], { stdio: 'inherit' });
    await waitHealthy();
    assert.equal((await admin.response('/api/auth/me')).status, 401, 'Restarted in-memory Session must require login.');
    assert.equal(await snapshot(), beforeRestart, 'Restart changed existing activity or signup data.');
    await admin.login('admin', process.env.DEMO_ADMIN_PASSWORD ?? 'Admin123!');
    const persisted = await admin.json(`/api/activities/${fixture.id}`);
    assert.equal(persisted.registrationStatus, 'ACTIVE');
    assert.equal(persisted.registeredCount, 1);
    check('backend restart preserves database data and expires the documented in-memory Session');
  }
} catch (error) {
  primaryError = error;
} finally {
  if (db) {
    if (baseline !== undefined) {
      try { await removeFixture(); }
      catch (cleanupError) { primaryError = primaryError ? new AggregateError([primaryError, cleanupError], 'Smoke check and exact cleanup failed.') : cleanupError; }
    }
    await db.end();
  }
  await mkdir('.runtime/ci', { recursive: true });
  await writeFile(reportPath, JSON.stringify({ success: !primaryError, checks, fixtureId: fixture?.id ?? null, runId }, null, 2));
}

if (primaryError) throw primaryError;
console.log(`Compose verification completed (${checks.length} checks); report: ${reportPath}`);
