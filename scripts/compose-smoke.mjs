import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { verifyAvatarSchema } from './avatar-schema.mjs';
import { verifyLocationPointSchema } from './location-point-schema.mjs';
import { initializeRun, cleanupRun, deleteOwnedFixtures } from './e2e-cleanup.mjs';

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
let cleanupCounts;
let primaryError;
const runId = randomUUID();
const title = `Compose 验证 ${runId}`;
const description = `gather-compose-smoke:${runId}`;
const startedKey = randomUUID();
const startedFixture = { key: startedKey, id: null, title: `Compose 签到验证 ${startedKey}`,
  description: `gather-compose-checkin:${runId}:${startedKey}` };
const fixtureIntentPath = `.runtime/ci/compose-fixtures-${runId}.json`;
const reportPath = '.runtime/ci/compose-smoke.json';
const passwordKey = randomUUID();
const passwordAccount = { key: passwordKey, id: null, username: `smoke_${passwordKey.replaceAll('-', '').slice(0, 24)}`,
  displayName: `e2e-${passwordKey}`, allowedDisplayNames: [`e2e-${passwordKey}`], role: 'USER' };
let passwordAttempted = false;

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
  clone() { const client = new ApiClient(); client.cookies = new Map(this.cookies); return client; }

  async response(path, options = {}) {
    const headers = new Headers(options.headers);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
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
  const [users] = await db.query('SELECT *, SHA2(avatar_image,256) AS avatar_checksum FROM users ORDER BY id');
  const [activities] = await db.query('SELECT id, title, description, location, category, starts_at, ends_at, registration_deadline, capacity, registered_count, created_by, cancelled_at, cancellation_reason, cancelled_by, cover_hash, SHA2(cover_image,256) AS cover_checksum FROM activities ORDER BY id');
  const [registrations] = await db.query('SELECT id, activity_id, user_id, status, created_at, updated_at, checked_in_at, checked_in_by FROM registrations ORDER BY id');
  const [notifications] = await db.query('SELECT * FROM notifications ORDER BY id');
  const [auditLogs] = await db.query('SELECT * FROM activity_audit_logs ORDER BY id');
  const [favorites] = await db.query('SELECT * FROM activity_favorites ORDER BY id');
  return JSON.stringify({ users, activities, registrations, notifications, auditLogs, favorites });
}

async function removeFixture() {
  // Exact intent can recover a created row even if its HTTP response was interrupted.
  const proofs = [{ key: runId, id: fixture?.id ?? null, title, description }, startedFixture];
  cleanupCounts = await deleteOwnedFixtures(db, proofs, new Set(), async (activities, accounts) => {
    await writeFile(fixtureIntentPath, JSON.stringify({ runId, proofs, passwordAccount, cleanupIntent: {
      activityIds: activities.map(row => row.id), userIds: accounts.map(row => row.id) } }, null, 2));
  }, { accounts: passwordAttempted ? [passwordAccount] : [] });
  assert(await snapshot() === baseline, 'Existing database records changed during smoke checks.');
  check('only the exact smoke fixtures and their check-in history were removed; baseline data preserved');
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
  assert.deepEqual(migrations.map(row => row.version), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14']);
  assert(migrations.every(row => row.success === 1));
  await db.query('SELECT category, starts_at, ends_at, registration_deadline, cover_hash, cover_image FROM activities LIMIT 0');
  await verifyAvatarSchema(db);
  await verifyLocationPointSchema(db);
  check('fresh MySQL schema contains successful Flyway V1 through V14, avatar pairs, location point pairs/ranges and activity registration-deadline/end-time/category/cover columns');
  await waitForDemoSeed();
  await verifyApiDatabaseBeforeWrites();
  check('running Docker ownership, exact ports and a cleaned UUID probe bind API writes to the isolated database');
  baseline = await snapshot();

  const anonymous = new ApiClient();
  const activities = await anonymous.json('/api/activities');
  assert(activities.length > 0, 'Fresh Compose startup must create demo activities.');
  assert(activities.every(row => Number.isInteger(row.waitingCount)));
  assert(activities.every(row => ['UNCATEGORIZED', 'TECHNOLOGY', 'SPORTS', 'CULTURE', 'OTHER'].includes(row.category)),
    'Every legacy activity must expose its stored category.');
  const discovery = await anonymous.json('/api/activities/search?page=1&pageSize=1&keyword=&status=ALL');
  assert.equal(discovery.total, activities.length, 'Public pagination must retain the full matching total.');
  assert.equal(discovery.items.length, 1);
  assert.equal(discovery.items[0].id, activities[0].id, 'Public pagination must preserve the legacy chronological ordering.');
  assert.equal(discovery.items[0].registrationStatus, null, 'Anonymous public search must not inherit another user identity.');
  assert.equal(discovery.summary.upcomingActivities, activities.filter(activity => !activity.closed).length);
  assert.equal(discovery.summary.availableSeats, activities.filter(activity => !activity.closed)
    .reduce((sum, activity) => sum + activity.capacity - activity.registeredCount, 0));
  check('anonymous discovery pagination and matching-set statistics preserve the legacy list contract');
  for (const path of ['/', `/activities/${activities[0].id}`, '/admin/dashboard', '/admin/audit-logs', '/notifications']) {
    const page = await fetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(10000) });
    assert(page.ok && page.headers.get('Content-Type')?.includes('text/html'), `SPA deep link ${path} is unavailable.`);
    const html = await page.text();
    assert(html.includes('id="root"') && html.includes('/assets/'), 'Expected built React assets through Nginx.');
  }
  check('built frontend and refreshed deep links are served by Nginx');

  const admin = new ApiClient();
  const demo = new ApiClient();
  const adminIdentity = await admin.login('admin', process.env.DEMO_ADMIN_PASSWORD ?? 'Admin123!');
  await demo.login('demo', process.env.DEMO_USER_PASSWORD ?? 'Demo123!');
  fixture = await admin.write('/api/admin/activities', 'POST', {
    title, description, location: 'Compose isolated validation', capacity: 1,
    startsAt: new Date(Date.now() + 48 * 3600000).toISOString(),
  });
  assert(Number.isSafeInteger(fixture.id));
  assert.equal(fixture.category, 'UNCATEGORIZED', 'Old clients that omit category must retain the default.');
  assert.equal(fixture.endsAt, null, 'Old clients that omit the end time must retain an unknown end.');
  assert.equal(fixture.registrationDeadline, null, 'Old clients that omit the deadline must retain signup until the start.');
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
  const earlyCheckToken = await admin.json('/api/auth/csrf');
  const earlyCheck = await admin.response(`/api/admin/activities/${fixture.id}/registrations/${roster.items[0].id}/check-in`, {
    method: 'POST', headers: { [earlyCheckToken.headerName]: earlyCheckToken.token },
  });
  assert.equal(earlyCheck.status, 409);
  assert.equal((await earlyCheck.json()).code, 'CHECK_IN_NOT_OPEN');

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
    title, description, location: 'Updated isolated smoke location', category: 'TECHNOLOGY', capacity: 99,
    startsAt: new Date(Date.now() + 72 * 3600000).toISOString(),
  });
  assert.equal(edited.location, 'Updated isolated smoke location');
  assert.equal(edited.category, 'TECHNOLOGY');
  assert.equal(edited.capacity, fixture.capacity, 'Editing must preserve the fixed capacity.');
  assert.equal(edited.startsAt, fixture.startsAt, 'Editing must preserve the published start time.');
  const categorized = await anonymous.json(`/api/activities/search?${new URLSearchParams({
    keyword: title, status: 'FULL', category: 'TECHNOLOGY', pageSize: '1',
  })}`);
  assert.equal(categorized.total, 1);
  assert.equal(categorized.items[0].id, fixture.id);
  assert.equal(categorized.items[0].category, 'TECHNOLOGY');
  assert.deepEqual(categorized.summary, { upcomingActivities: 1, availableSeats: 0 });
  const otherCategory = await anonymous.json(`/api/activities/search?${new URLSearchParams({ keyword: title, category: 'SPORTS' })}`);
  assert.equal(otherCategory.total, 0);
  assert.deepEqual(otherCategory.summary, { upcomingActivities: 0, availableSeats: 0 });
  const cancelledActivity = await admin.write(`/api/admin/activities/${fixture.id}/cancel`, 'POST', { reason: 'Temporary smoke activity cancelled' });
  assert(cancelledActivity.cancelled && cancelledActivity.closed && cancelledActivity.registeredCount === 0
    && cancelledActivity.waitingCount === 0 && cancelledActivity.registrationStatus === 'CANCELLED',
  'Activity cancellation must retain the registration while releasing all active/candidate states.');
  const repeatedCancellation = await admin.write(`/api/admin/activities/${fixture.id}/cancel`, 'POST', { reason: 'Ignored repeated reason' });
  assert.equal(repeatedCancellation.cancelledAt, cancelledActivity.cancelledAt);
  assert.equal(repeatedCancellation.cancellationReason, cancelledActivity.cancellationReason);
  assert.equal((await anonymous.response('/api/admin/audit-logs')).status, 401);
  assert.equal((await demo.response('/api/admin/audit-logs')).status, 403);
  const activityAuditPage = await admin.json(`/api/admin/audit-logs?activityId=${fixture.id}`);
  assert.equal(activityAuditPage.total, 3);
  assert.deepEqual(activityAuditPage.items.map(row => row.action), ['CANCEL', 'EDIT', 'CREATE']);
  assert(activityAuditPage.items.every(row => row.activityId === fixture.id && row.activityTitle === title
    && row.actorUserId === adminIdentity.id && row.actorUsername === 'admin' && !Object.hasOwn(row, 'changes')));
  const editAudit = await admin.json(`/api/admin/audit-logs/${activityAuditPage.items[1].id}`);
  assert.deepEqual(editAudit.changes, [{ field: 'location', before: 'Compose isolated validation', after: edited.location },
    { field: 'category', before: 'UNCATEGORIZED', after: 'TECHNOLOGY' }]);
  const createAudit = await admin.json(`/api/admin/audit-logs/${activityAuditPage.items[2].id}`);
  assert.deepEqual(createAudit.changes.find(change => change.field === 'category'), { field: 'category', before: null, after: 'UNCATEGORIZED' });
  const filteredAudit = await admin.json(`/api/admin/audit-logs?activityId=${fixture.id}&action=CANCEL&pageSize=1`);
  assert.equal(filteredAudit.total, 1);
  assert.deepEqual(filteredAudit.items, [activityAuditPage.items[0]]);
  check('administrator-only CREATE, EDIT and first CANCEL audit snapshots and complete detail changes are persisted');
  const cancelledSearch = await anonymous.json(`/api/activities/search?${new URLSearchParams({
    keyword: title, status: 'CANCELLED', category: 'TECHNOLOGY', page: '1', pageSize: '1',
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

  // This exact independent test fixture starts in the past; no published activity time is edited.
  await mkdir('.runtime/ci', { recursive: true });
  await writeFile(fixtureIntentPath, JSON.stringify({ runId, proofs: [{ key: runId, id: fixture.id, title, description }, startedFixture] }, null, 2));
  const [startedInsert] = await db.execute('INSERT INTO activities(title, description, location, starts_at, capacity, registered_count, created_by) VALUES (?, ?, ?, UTC_TIMESTAMP(6) - INTERVAL 1 DAY, 1, 1, ?)',
    [startedFixture.title, startedFixture.description, 'Isolated check-in fixture', adminIdentity.id]);
  startedFixture.id = Number(startedInsert.insertId);
  const [registrationInsert] = await db.execute("INSERT INTO registrations(activity_id,user_id,status,created_at,updated_at) VALUES (?,?,'ACTIVE',UTC_TIMESTAMP(6) - INTERVAL 2 DAY,UTC_TIMESTAMP(6) - INTERVAL 2 DAY)",
    [startedFixture.id, adminIdentity.id]);
  const checkInPath = `/api/admin/activities/${startedFixture.id}/registrations/${registrationInsert.insertId}/check-in`;
  const initialSignedRoster = await admin.json(`/api/admin/activities/${startedFixture.id}/registrations`);
  assert.equal((await anonymous.response('/api/admin/attendance')).status, 401);
  assert.equal((await demo.response('/api/admin/attendance')).status, 403);
  const initialAttendance = await admin.json('/api/admin/attendance');
  assert.equal(initialAttendance.total, 1);
  assert.equal(initialAttendance.items[0].id, startedFixture.id);
  assert.deepEqual(initialAttendance.summary, { totalActivities: 1, activeRegistrations: 1,
    checkedInRegistrations: 0, notCheckedInRegistrations: 1, checkInRate: 0 });
  assert.match(initialAttendance.asOf, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  const attendancePath = `/api/admin/attendance?${new URLSearchParams({ from: initialAttendance.from, to: initialAttendance.to })}`;
  const beforeCheckIn = await snapshot();
  assert.equal((await admin.response(checkInPath, { method: 'POST' })).status, 403);
  const demoCheckToken = await demo.json('/api/auth/csrf');
  assert.equal((await demo.response(checkInPath, { method: 'POST', headers: { [demoCheckToken.headerName]: demoCheckToken.token } })).status, 403);
  assert(await snapshot() === beforeCheckIn, 'Denied check-in requests must not change any data.');
  const signed = await admin.write(checkInPath);
  assert(signed.checkedInAt && signed.checkedInBy === adminIdentity.id);
  assert.equal(signed.status, 'ACTIVE');
  assert.equal(signed.updatedAt, initialSignedRoster.items[0].updatedAt);
  assert.equal(signed.createdAt, initialSignedRoster.items[0].createdAt);
  assert.deepEqual(await admin.write(checkInPath), signed);
  const signedRoster = await admin.json(`/api/admin/activities/${startedFixture.id}/registrations?status=ACTIVE&checkInStatus=CHECKED_IN`);
  assert.equal(signedRoster.total, 1);
  assert.deepEqual(signedRoster.items, [signed]);
  assert.deepEqual(signedRoster.summary, { activeRegistrations: 1, checkedInRegistrations: 1, notCheckedInRegistrations: 0 });
  assert.equal((await admin.json(`/api/admin/activities/${startedFixture.id}/registrations?checkInStatus=NOT_CHECKED_IN`)).total, 0);
  const csv = await admin.response(`/api/admin/activities/${startedFixture.id}/registrations/export?status=ACTIVE&checkInStatus=CHECKED_IN`, { headers: { Accept: 'text/csv, application/json' } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('Content-Type'), /^text\/csv/i);
  assert(csv.headers.get('Content-Disposition').includes(`activity-${startedFixture.id}-registrations.csv`));
  const csvBytes = new Uint8Array(await csv.arrayBuffer());
  assert.deepEqual([...csvBytes.slice(0, 3)], [239, 187, 191]);
  assert(new TextDecoder().decode(csvBytes).includes('"\tadmin"'));
  const beforeAttendanceOnly = JSON.parse(beforeCheckIn);
  const afterAttendanceOnly = JSON.parse(await snapshot());
  const oldAuditIds = new Set(beforeAttendanceOnly.auditLogs.map(row => row.id));
  const newAudits = afterAttendanceOnly.auditLogs.filter(row => !oldAuditIds.has(row.id));
  assert.equal(newAudits.length, 1, 'First check-in must append exactly one audit and repeats must append none.');
  assert.equal(newAudits[0].action, 'CHECK_IN');
  assert.equal(newAudits[0].activity_id, startedFixture.id);
  assert.equal(newAudits[0].registration_id, signed.id);
  assert.equal(newAudits[0].actor_user_id, adminIdentity.id);
  assert.equal(newAudits[0].target_username, 'admin');
  const checkInAuditPage = await admin.json(`/api/admin/audit-logs?activityId=${startedFixture.id}&action=CHECK_IN`);
  assert.equal(checkInAuditPage.total, 1);
  const checkInAudit = await admin.json(`/api/admin/audit-logs/${checkInAuditPage.items[0].id}`);
  assert.deepEqual(checkInAudit.changes, [{ field: 'checkedInAt', before: null, after: signed.checkedInAt }]);
  afterAttendanceOnly.auditLogs = afterAttendanceOnly.auditLogs.filter(row => oldAuditIds.has(row.id));
  for (const state of [beforeAttendanceOnly, afterAttendanceOnly]) {
    state.registrations = state.registrations.map(({ checked_in_at, checked_in_by, ...businessFields }) => businessFields);
  }
  assert(JSON.stringify(afterAttendanceOnly) === JSON.stringify(beforeAttendanceOnly), 'Check-in/export must preserve every previous business field, notification and audit snapshot apart from check-in fields and its one new audit.');
  const [[attendanceTruth]] = await db.execute("SELECT a.registered_count AS registeredCount, SUM(r.status='ACTIVE') AS active, SUM(r.status='WAITING') AS waiting, SUM(r.checked_in_at IS NOT NULL) AS checked FROM activities a JOIN registrations r ON r.activity_id=a.id WHERE a.id=? GROUP BY a.id", [startedFixture.id]);
  assert.equal(Number(attendanceTruth.registeredCount), Number(attendanceTruth.active));
  assert.equal(Number(attendanceTruth.checked), 1);
  assert.equal(Number(attendanceTruth.waiting), 0);
  const signedAttendance = await admin.json(attendancePath);
  assert.equal(signedAttendance.total, 1);
  assert.deepEqual(signedAttendance.summary, { totalActivities: 1, activeRegistrations: 1,
    checkedInRegistrations: 1, notCheckedInRegistrations: 0, checkInRate: 100 });
  assert(signedAttendance.items[0].id === startedFixture.id && signedAttendance.items[0].activeRegistrations === 1
    && signedAttendance.items[0].checkedInRegistrations === 1 && signedAttendance.items[0].checkInRate === 100);
  const outsideAttendance = await admin.json(`${attendancePath}&page=2&pageSize=1`);
  assert.equal(outsideAttendance.total, 1);
  assert.deepEqual(outsideAttendance.items, []);
  assert.deepEqual(outsideAttendance.summary, signedAttendance.summary);
  check('administrator attendance analysis reads the started fixture, refreshes after real check-in and retains global summary on an empty page');
  check('check-in preserves first trusted actor/time; filtered summary and protected UTF-8 CSV are real');

  assert.equal((await anonymous.response('/api/me/registrations/search')).status, 401);
  const minePath = '/api/me/registrations/search?page=1&pageSize=1&status=ACTIVE';
  const personal = await admin.json(minePath);
  assert.equal(personal.total, 1);
  assert.equal(personal.items.length, 1);
  assert.deepEqual(personal.summary, { activeRegistrations: 1, waitingRegistrations: 0, cancelledRegistrations: 1, checkedInRegistrations: 1 });
  const personalItem = personal.items[0];
  assert.equal(personalItem.id, signed.id);
  assert.equal(personalItem.activity.id, startedFixture.id);
  assert.equal(personalItem.status, 'ACTIVE');
  assert.equal(personalItem.activity.registrationStatus, personalItem.status);
  assert.equal(personalItem.checkedInAt, signed.checkedInAt);
  assert.deepEqual(Object.keys(personalItem).sort(), ['activity', 'checkedInAt', 'id', 'status']);
  const legacyPersonal = await admin.json('/api/me/registrations');
  assert.equal(legacyPersonal.length, 2);
  assert.deepEqual(legacyPersonal.map(row => row.activity.id), [fixture.id, startedFixture.id]);
  assert.deepEqual(legacyPersonal.map(row => row.activity.category), ['TECHNOLOGY', 'UNCATEGORIZED']);
  assert(legacyPersonal.every(row => JSON.stringify(Object.keys(row).sort()) === JSON.stringify(['activity', 'id', 'status'])));
  const matchingLegacy = legacyPersonal.find(row => row.id === personalItem.id);
  assert.deepEqual(matchingLegacy, { id: personalItem.id, status: personalItem.status, activity: personalItem.activity });
  const demoPersonal = await demo.json(`/api/me/registrations/search?page=1&pageSize=1&status=ALL&userId=${adminIdentity.id}`);
  assert.equal(demoPersonal.total, 1);
  assert.equal(demoPersonal.items[0].activity.id, fixture.id);
  assert.equal(demoPersonal.items[0].status, 'CANCELLED');
  assert.equal(demoPersonal.items[0].activity.registrationStatus, demoPersonal.items[0].status);
  assert.equal(demoPersonal.items[0].checkedInAt, null);
  assert.deepEqual(demoPersonal.summary, { activeRegistrations: 0, waitingRegistrations: 0, cancelledRegistrations: 1, checkedInRegistrations: 0 });
  const outsidePersonal = await admin.json('/api/me/registrations/search?page=2&pageSize=1&status=ACTIVE');
  assert.equal(outsidePersonal.total, 1);
  assert.deepEqual(outsidePersonal.items, []);
  assert.deepEqual(outsidePersonal.summary, personal.summary);
  check('personal registration pagination preserves legacy shape, global statistics and private attendance from the trusted Session');

  const passwordOwner = new ApiClient();
  passwordAttempted = true;
  const registeredPasswordOwner = await passwordOwner.write('/api/auth/register', 'POST', {
    username: passwordAccount.username, displayName: passwordAccount.displayName, password: 'LocalPassword123!',
  });
  assert(registeredPasswordOwner.role === 'USER' && registeredPasswordOwner.username === passwordAccount.username);
  passwordAccount.id = registeredPasswordOwner.id;
  await passwordOwner.login(passwordAccount.username, 'LocalPassword123!');
  const secondPasswordSession = new ApiClient();
  await secondPasswordSession.login(passwordAccount.username, 'LocalPassword123!');
  const oldPasswordCookie = secondPasswordSession.clone();
  const beforeWrongPassword = await snapshot();
  const passwordToken = await passwordOwner.json('/api/auth/csrf');
  const wrongPassword = await passwordOwner.response('/api/me/password', { method: 'POST',
    headers: { [passwordToken.headerName]: passwordToken.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'Incorrect123!', newPassword: 'UpdatedPassword123!' }) });
  assert.equal(wrongPassword.status, 400);
  assert.equal((await wrongPassword.json()).code, 'CURRENT_PASSWORD_INCORRECT');
  assert(await snapshot() === beforeWrongPassword, 'Rejected password change must preserve all application rows.');
  assert.deepEqual(await passwordOwner.write('/api/me/password', 'POST', {
    currentPassword: 'LocalPassword123!', newPassword: 'UpdatedPassword123!',
  }), { success: true });
  assert.equal((await passwordOwner.response('/api/auth/me')).status, 401);
  const revoked = await oldPasswordCookie.clone().response('/api/auth/me');
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json()).code, 'SESSION_REVOKED');
  const publicAfterPassword = await oldPasswordCookie.clone().json(`/api/activities/${fixture.id}`);
  assert.equal(publicAfterPassword.registrationStatus, null);
  const [[changedCredential]] = await db.execute('SELECT credential_version AS version FROM users WHERE id=?', [passwordAccount.id]);
  assert.equal(Number(changedCredential.version), 1);
  const wrongLoginToken = await passwordOwner.json('/api/auth/csrf');
  const oldPasswordLogin = await passwordOwner.response('/api/auth/login', { method: 'POST',
    headers: { [wrongLoginToken.headerName]: wrongLoginToken.token, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: passwordAccount.username, password: 'LocalPassword123!' }) });
  assert.equal(oldPasswordLogin.status, 401);
  assert.equal((await oldPasswordLogin.json()).code, 'INVALID_CREDENTIALS');
  await passwordOwner.login(passwordAccount.username, 'UpdatedPassword123!');
  await passwordOwner.write('/api/auth/logout');
  check('owned password change advances V7 version, revokes both sessions, rejects the old password and admits the new password without changing demo accounts');

  if (process.env.SMOKE_RESTART_BACKEND === '1') {
    assert.equal(process.env.COMPOSE_PROJECT_NAME, 'gather-ci', 'Restart is restricted to the isolated gather-ci project.');
    assert.equal(database, 'activity_platform_e2e', 'Restart requires the isolated CI database.');
    const beforeRestart = await snapshot();
    execFileSync('docker', ['compose', '-p', 'gather-ci', '-f', 'compose.yaml', '-f', '.github/compose.ci.yaml', 'restart', 'backend'], { stdio: 'inherit' });
    await waitHealthy();
    assert.equal((await admin.response('/api/auth/me')).status, 401, 'Restarted in-memory Session must require login.');
    assert(await snapshot() === beforeRestart, 'Restart changed existing activity or signup data.');
    await admin.login('admin', process.env.DEMO_ADMIN_PASSWORD ?? 'Admin123!');
    const persisted = await admin.json(`/api/activities/${fixture.id}`);
    assert.equal(persisted.registrationStatus, 'CANCELLED');
    assert.equal(persisted.registeredCount, 0);
    assert.equal(persisted.cancellationReason, cancelledActivity.cancellationReason);
    assert.equal(persisted.cancelledAt, cancelledActivity.cancelledAt);
    assert.deepEqual(await admin.json('/api/me/notifications'), persistedNotices, 'Notification history and first-read time must survive restart.');
    assert.deepEqual((await admin.json(`/api/admin/activities/${startedFixture.id}/registrations`)).items, [signed], 'First check-in metadata must survive restart.');
    assert.deepEqual(await admin.json(minePath), personal, 'Personal attendance and whole-account statistics must survive restart.');
    assert.deepEqual(await admin.json(`/api/admin/audit-logs?activityId=${fixture.id}`), activityAuditPage, 'Activity audit snapshots must survive restart.');
    assert.deepEqual(await admin.json(`/api/admin/audit-logs?activityId=${startedFixture.id}&action=CHECK_IN`), checkInAuditPage);
    const { asOf: previousAttendanceTime, ...previousAttendance } = signedAttendance;
    const { asOf: restartedAttendanceTime, ...restartedAttendance } = await admin.json(attendancePath);
    assert.deepEqual(restartedAttendance, previousAttendance, 'Attendance rows, date range and full summary must survive restart.');
    assert(Date.parse(restartedAttendanceTime) >= Date.parse(previousAttendanceTime));
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
  await writeFile(reportPath, JSON.stringify({ success: !primaryError, checks, fixtureId: fixture?.id ?? null, runId, cleanup: cleanupCounts }, null, 2));
}

if (primaryError) throw primaryError;
console.log(`Compose verification completed (${checks.length} checks); report: ${reportPath}`);
