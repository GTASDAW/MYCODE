import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { initializeRun, cleanupRun } from './e2e-cleanup.mjs';

const baseUrl = new URL(process.env.E2E_BASE_URL ?? 'http://127.0.0.1:18088');
assert.equal(process.env.COMPOSE_PROJECT_NAME, 'gather-ci', 'Smoke checks require the isolated gather-ci project.');
assert.equal(baseUrl.href, 'http://127.0.0.1:18088/', 'Smoke API must use its exact isolated loopback origin.');
const database = process.env.E2E_DB_NAME;
assert.equal(database, 'activity_platform_e2e', 'Smoke checks require the isolated activity_platform_e2e database.');
assert.equal(process.env.E2E_DB_HOST, '127.0.0.1', 'Smoke database must use explicit IPv4 loopback.');
assert.equal(process.env.E2E_DB_USERNAME, 'activity', 'Smoke checks require the isolated application account.');
assert(process.env.E2E_DB_PASSWORD, 'Set explicit E2E_DB_* credentials before smoke checks.');
const databasePort = Number(process.env.E2E_DB_PORT);
assert.equal(databasePort, 33306, 'Smoke database must use the isolated published port.');

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

function dockerRead(argumentsList) {
  try { return execFileSync('docker', argumentsList, { encoding: 'utf8', stdio: 'pipe', timeout: 10000 }); }
  catch { throw new Error('Read-only isolated smoke Docker identity inspection failed.'); }
}

function verifyRunningStack() {
  let declared;
  try {
    declared = JSON.parse(dockerRead(['compose', '-p', 'gather-ci', '-f', 'compose.yaml', '-f', '.github/compose.ci.yaml', 'config', '--format', 'json']));
  } catch { throw new Error('Could not validate the isolated smoke Compose configuration.'); }
  assert.equal(declared.name, 'gather-ci', 'Resolved smoke Compose project changed.');
  const backend = declared.services?.backend?.environment;
  const mysqlEnvironment = declared.services?.mysql?.environment;
  assert(backend?.DB_URL?.startsWith('jdbc:mysql://mysql:3306/activity_platform_e2e?')
    && backend.DB_USERNAME === process.env.E2E_DB_USERNAME && backend.DB_PASSWORD === process.env.E2E_DB_PASSWORD
    && !backend.SPRING_PROFILES_ACTIVE, 'The smoke backend must target its isolated memory-session database.');
  assert(mysqlEnvironment?.MYSQL_DATABASE === database && mysqlEnvironment.MYSQL_USER === process.env.E2E_DB_USERNAME
    && mysqlEnvironment.MYSQL_PASSWORD === process.env.E2E_DB_PASSWORD, 'The smoke MySQL service differs from the configured check database.');
  for (const [service, target, port] of [['web', '80/tcp', '18088'], ['mysql', '3306/tcp', '33306'], ['backend', null, null]]) {
    const ids = dockerRead(['ps', '--filter', 'label=com.docker.compose.project=gather-ci',
      '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}']).trim().split(/\s+/).filter(Boolean);
    assert.equal(ids.length, 1, `Exactly one running isolated ${service} container is required.`);
    const containers = JSON.parse(dockerRead(['inspect', ids[0]]));
    assert.equal(containers.length, 1, 'Docker inspection must resolve exactly one smoke container.');
    const actual = containers[0];
    assert(actual.State?.Running && actual.Config?.Labels?.['com.docker.compose.project'] === 'gather-ci'
      && actual.Config.Labels['com.docker.compose.service'] === service, 'Running smoke container ownership changed.');
    const actualEnvironment = Object.fromEntries(actual.Config.Env.map(item => {
      const separator = item.indexOf('=');
      return [item.slice(0, separator), item.slice(separator + 1)];
    }));
    if (service === 'backend') assert(!actualEnvironment.SPRING_PROFILES_ACTIVE, 'The running smoke backend must use default memory Session mode.');
    for (const [key, value] of Object.entries(declared.services[service].environment ?? {})) {
      // Boolean assertion messages deliberately never include actual/expected secrets.
      assert(actualEnvironment[key] === String(value), `Running ${service} environment differs from the isolated declaration (${key}).`);
    }
    const published = Object.entries(actual.NetworkSettings.Ports ?? {}).filter(([, bindings]) => bindings?.length);
    if (target === null) assert.equal(published.length, 0, 'The memory-session backend must not expose a direct host port.');
    else {
      const bindings = actual.NetworkSettings.Ports[target];
      assert(published.length === 1 && bindings?.length === 1 && bindings[0].HostIp === '127.0.0.1'
        && bindings[0].HostPort === port, `Running ${service} must use its exact isolated loopback binding.`);
      assert(declared.services[service].ports?.some(binding => binding.host_ip === '127.0.0.1'
        && Number(binding.target) === Number(target.split('/')[0]) && String(binding.published) === port),
      `${service} declared loopback binding does not match the smoke target.`);
    }
  }
}

async function waitForDemoSeed() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const [accounts] = await db.query("SELECT username, role FROM users WHERE username IN ('admin','demo')");
    const [[counts]] = await db.query('SELECT COUNT(*) AS activities FROM activities');
    if (accounts.some(row => row.username === 'admin' && row.role === 'ADMIN')
      && accounts.some(row => row.username === 'demo' && row.role === 'USER') && Number(counts.activities) > 0) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Smoke demo initialization did not commit within 30 seconds.');
}

async function verifyApiDatabaseBeforeWrites() {
  const priorManifest = process.env.E2E_RUN_MANIFEST;
  let manifestPath;
  try { manifestPath = await initializeRun(baseUrl); }
  finally {
    try { if (manifestPath) await cleanupRun(manifestPath); }
    finally {
      if (priorManifest === undefined) delete process.env.E2E_RUN_MANIFEST;
      else process.env.E2E_RUN_MANIFEST = priorManifest;
    }
  }
}

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
  const [activities] = await db.query('SELECT id, title, description, location, starts_at, capacity, registered_count, created_by, cancelled_at, cancellation_reason, cancelled_by FROM activities ORDER BY id');
  const [registrations] = await db.query('SELECT id, activity_id, user_id, status, created_at, updated_at FROM registrations ORDER BY id');
  const [notifications] = await db.query('SELECT * FROM notifications ORDER BY id');
  return JSON.stringify({ activities, registrations, notifications });
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
      await db.execute('DELETE FROM notifications WHERE activity_id=?', [row.id]);
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
  verifyRunningStack();
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
  assert.deepEqual(migrations.map(row => row.version), ['1', '2', '3', '4']);
  assert(migrations.every(row => row.success === 1));
  check('fresh MySQL schema contains successful Flyway V1, V2, V3 and V4');
  await waitForDemoSeed();
  await verifyApiDatabaseBeforeWrites();
  check('running Docker ownership, exact ports and a cleaned UUID probe bind API writes to the isolated database');
  baseline = await snapshot();

  const anonymous = new ApiClient();
  const activities = await anonymous.json('/api/activities');
  assert(activities.length > 0, 'Fresh Compose startup must create demo activities.');
  assert(activities.every(row => Number.isInteger(row.waitingCount)));
  const discovery = await anonymous.json('/api/activities/search?page=1&pageSize=1&keyword=&status=ALL');
  assert.equal(discovery.total, activities.length, 'Public pagination must retain the full matching total.');
  assert.equal(discovery.items.length, 1);
  assert.equal(discovery.items[0].id, activities[0].id, 'Public pagination must preserve the legacy chronological ordering.');
  assert.equal(discovery.items[0].registrationStatus, null, 'Anonymous public search must not inherit another user identity.');
  assert.equal(discovery.summary.upcomingActivities, activities.filter(activity => !activity.closed).length);
  assert.equal(discovery.summary.availableSeats, activities.filter(activity => !activity.closed)
    .reduce((sum, activity) => sum + activity.capacity - activity.registeredCount, 0));
  check('anonymous discovery pagination and matching-set statistics preserve the legacy list contract');
  for (const path of ['/', `/activities/${activities[0].id}`, '/admin/dashboard', '/notifications']) {
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

  assert.equal((await anonymous.response('/api/me/notifications')).status, 401);
  const promotionNotices = await admin.json('/api/me/notifications?page=1&pageSize=1&status=ALL');
  assert.equal(promotionNotices.total, 1);
  assert.equal(promotionNotices.unreadCount, 1);
  const promotionNotice = promotionNotices.items[0];
  assert.equal(promotionNotice.type, 'PROMOTED');
  assert.equal(promotionNotice.activityId, fixture.id);
  assert.equal(promotionNotice.activityTitle, title);
  assert.equal(promotionNotice.readAt, null);
  assert.equal((await demo.json('/api/me/notifications')).total, 0);
  assert.equal((await admin.response(`/api/me/notifications/${promotionNotice.id}/read`, { method: 'POST' })).status, 403);
  const demoReadToken = await demo.json('/api/auth/csrf');
  assert.equal((await demo.response(`/api/me/notifications/${promotionNotice.id}/read`, {
    method: 'POST', headers: { [demoReadToken.headerName]: demoReadToken.token },
  })).status, 404);
  const firstRead = await admin.write(`/api/me/notifications/${promotionNotice.id}/read`);
  assert(firstRead.readAt);
  assert.deepEqual(await admin.write(`/api/me/notifications/${promotionNotice.id}/read`), firstRead);
  assert.equal((await admin.json('/api/me/notifications/unread-count')).unreadCount, 0);
  check('promotion creates one private notification; read authorization, CSRF and first-read idempotence hold');

  const edited = await admin.write(`/api/admin/activities/${fixture.id}`, 'PATCH', {
    title, description, location: 'Updated isolated smoke location', capacity: 99,
    startsAt: new Date(Date.now() + 72 * 3600000).toISOString(),
  });
  assert.equal(edited.location, 'Updated isolated smoke location');
  assert.equal(edited.capacity, fixture.capacity, 'Editing must preserve the fixed capacity.');
  assert.equal(edited.startsAt, fixture.startsAt, 'Editing must preserve the published start time.');
  const cancelledActivity = await admin.write(`/api/admin/activities/${fixture.id}/cancel`, 'POST', { reason: 'Temporary smoke activity cancelled' });
  assert(cancelledActivity.cancelled && cancelledActivity.closed && cancelledActivity.registeredCount === 0
    && cancelledActivity.waitingCount === 0 && cancelledActivity.registrationStatus === 'CANCELLED',
  'Activity cancellation must retain the registration while releasing all active/candidate states.');
  const repeatedCancellation = await admin.write(`/api/admin/activities/${fixture.id}/cancel`, 'POST', { reason: 'Ignored repeated reason' });
  assert.equal(repeatedCancellation.cancelledAt, cancelledActivity.cancelledAt);
  assert.equal(repeatedCancellation.cancellationReason, cancelledActivity.cancellationReason);
  const cancelledSearch = await anonymous.json(`/api/activities/search?${new URLSearchParams({
    keyword: title, status: 'CANCELLED', page: '1', pageSize: '1',
  })}`);
  assert.equal(cancelledSearch.total, 1);
  assert.equal(cancelledSearch.items[0].id, fixture.id);
  assert.equal(cancelledSearch.summary.upcomingActivities, 0);
  assert.equal(cancelledSearch.summary.availableSeats, 0);
  check('editing preserves published time/capacity; activity cancellation is atomic and idempotent');

  const cancellationNotices = await admin.json('/api/me/notifications?status=UNREAD&page=1&pageSize=1');
  assert.equal(cancellationNotices.total, 1);
  assert.equal(cancellationNotices.unreadCount, 1);
  assert.equal(cancellationNotices.items[0].type, 'ACTIVITY_CANCELLED');
  assert.equal(cancellationNotices.items[0].activityId, fixture.id);
  assert.equal(cancellationNotices.items[0].cancellationReason, cancelledActivity.cancellationReason);
  assert.equal((await admin.json('/api/me/notifications')).total, 2);
  assert.equal((await demo.json('/api/me/notifications')).total, 0);
  const persistedNotices = await admin.json('/api/me/notifications');
  check('activity cancellation notifies current participants once and excludes previously cancelled users');

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
    assert.equal(persisted.registrationStatus, 'CANCELLED');
    assert.equal(persisted.registeredCount, 0);
    assert.equal(persisted.cancellationReason, cancelledActivity.cancellationReason);
    assert.equal(persisted.cancelledAt, cancelledActivity.cancelledAt);
    assert.deepEqual(await admin.json('/api/me/notifications'), persistedNotices, 'Notification history and first-read time must survive restart.');
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
