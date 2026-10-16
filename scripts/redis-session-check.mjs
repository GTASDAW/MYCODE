import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { databaseConfig, verifyDatabase, deleteOwnedFixtures, initializeRun, cleanupRun } from './e2e-cleanup.mjs';

const composeFiles = ['compose.yaml', 'compose.redis.yaml', '.github/compose.ci.yaml', '.github/compose.redis-ci.yaml'];
const reportPath = '.runtime/ci/redis-session-check.json';
const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));

export function isolatedSettings(environment = process.env) {
  assert(environment.COMPOSE_PROJECT_NAME === 'gather-redis-ci', 'Redis lifecycle checks require the isolated gather-redis-ci project.');
  const database = databaseConfig(environment);
  assert(database.database === 'activity_platform_e2e', 'Redis lifecycle checks require the isolated activity_platform_e2e database.');
  assert(database.host === '127.0.0.1' && database.port === 33306 && database.user === 'activity',
    'Redis lifecycle checks require the exact isolated IPv4 MySQL endpoint and application account.');
  assert((environment.SESSION_TIMEOUT ?? '30m') === '30m', 'The normal session timeout must be 30m.');
  assert((environment.SESSION_NAMESPACE ?? 'gather:session') === 'gather:session', 'Unexpected Redis session namespace.');
  assert((environment.SESSION_COOKIE_SECURE ?? 'false') === 'false', 'The isolated HTTP CI stack requires SESSION_COOKIE_SECURE=false.');
  assert(environment.REDIS_PASSWORD, 'Set an explicit Redis password for the isolated stack.');
  const urls = ['REDIS_TEST_BASE_URL', 'REDIS_TEST_A_URL', 'REDIS_TEST_B_URL'].map((key, index) => {
    const defaults = ['http://127.0.0.1:19088', 'http://127.0.0.1:19081', 'http://127.0.0.1:19082'];
    let url;
    try { url = new URL(environment[key] ?? defaults[index]); }
    catch { throw new Error(`${key} must be a valid HTTP loopback URL.`); }
    assert(url.href === `${defaults[index]}/`, `${key} must use its exact isolated HTTP loopback origin without credentials or path.`);
    return url;
  });
  assert(new Set(urls.map(url => url.origin)).size === 3, 'Nginx and both direct backend URLs must be distinct.');
  return { database, web: urls[0], a: urls[1], b: urls[2] };
}

function compose(argumentsList, timeout = '30m') {
  try {
    return execFileSync('docker', ['compose', '-p', 'gather-redis-ci', ...composeFiles.flatMap(file => ['-f', file]), ...argumentsList], {
      encoding: 'utf8', stdio: 'pipe', timeout: 180000,
      env: { ...process.env, SESSION_TIMEOUT: timeout },
    });
  } catch (error) {
    // The resolved config contains credentials; never expose subprocess buffers.
    throw new Error(`The isolated Docker Compose ${argumentsList[0]} command failed (exit ${error.status ?? 'unavailable'}).`);
  }
}

function verifyComposeSettings(settings) {
  let resolved;
  try { resolved = JSON.parse(compose(['config', '--format', 'json'])); }
  catch { throw new Error('Could not validate the isolated Redis Compose configuration.'); }
  assert(resolved.name === 'gather-redis-ci', 'Resolved Compose project differs from the isolated Redis project.');
  for (const service of ['backend', 'backend2']) {
    const environment = resolved.services?.[service]?.environment;
    assert(environment?.SPRING_PROFILES_ACTIVE === 'redis', `${service} must use the Redis profile.`);
    assert(environment.DB_URL?.startsWith('jdbc:mysql://mysql:3306/activity_platform_e2e?'), `${service} must use the isolated database.`);
    assert(environment.DB_USERNAME === settings.database.user && environment.DB_PASSWORD === settings.database.password,
      `${service} database credentials differ from the explicitly configured check database.`);
    assert(environment.SESSION_TIMEOUT === '30m', `${service} normal session timeout must be 30m.`);
    assert(environment.SESSION_NAMESPACE === 'gather:session', `${service} has an unexpected session namespace.`);
    assert(environment.REDIS_HOST === 'redis' && String(environment.REDIS_PORT) === '6379'
      && environment.REDIS_PASSWORD === process.env.REDIS_PASSWORD, `${service} does not target the configured isolated Redis service.`);
  }
  assert(resolved.services?.redis?.environment?.REDIS_PASSWORD === process.env.REDIS_PASSWORD,
    'The isolated Redis server must use the explicitly configured password.');
  for (const [service, target, host, port] of [
    ['web', 80, settings.web.hostname, Number(settings.web.port)],
    ['backend', 8080, settings.a.hostname, Number(settings.a.port)],
    ['backend2', 8080, settings.b.hostname, Number(settings.b.port)],
    ['mysql', 3306, settings.database.host, settings.database.port],
  ]) {
    assert(resolved.services[service]?.ports?.some(binding => binding.host_ip === host
      && Number(binding.target) === target && Number(binding.published) === port),
    `${service} loopback port does not match the resolved isolated Compose binding.`);
  }
  return resolved;
}

function dockerRead(argumentsList) {
  try { return execFileSync('docker', argumentsList, { encoding: 'utf8', stdio: 'pipe', timeout: 10000 }); }
  catch { throw new Error('Read-only isolated Redis Docker identity inspection failed.'); }
}

function verifyRunningComposeSettings(settings, declared) {
  const ports = { web: ['80/tcp', String(settings.web.port)], mysql: ['3306/tcp', String(settings.database.port)],
    backend: ['8080/tcp', String(settings.a.port)], backend2: ['8080/tcp', String(settings.b.port)], redis: null };
  for (const service of ['mysql', 'redis', 'backend', 'backend2', 'web']) {
    const ids = dockerRead(['ps', '--filter', 'label=com.docker.compose.project=gather-redis-ci',
      '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}']).trim().split(/\s+/).filter(Boolean);
    assert(ids.length === 1, `Exactly one running isolated Redis-stack ${service} container is required.`);
    const containers = JSON.parse(dockerRead(['inspect', ids[0]]));
    assert(containers.length === 1, 'Docker inspection must resolve exactly one Redis-stack container.');
    const actual = containers[0];
    assert(actual.State?.Running && actual.Config?.Labels?.['com.docker.compose.project'] === 'gather-redis-ci'
      && actual.Config.Labels['com.docker.compose.service'] === service, 'Running Redis-stack container ownership changed.');
    const actualEnvironment = Object.fromEntries(actual.Config.Env.map(item => {
      const separator = item.indexOf('=');
      return [item.slice(0, separator), item.slice(separator + 1)];
    }));
    for (const [key, value] of Object.entries(declared.services[service].environment ?? {})) {
      // Never expose inspected values: DB/Redis passwords remain in process memory only.
      assert(actualEnvironment[key] === String(value), `Running ${service} environment differs from the isolated declaration (${key}).`);
    }
    const published = Object.entries(actual.NetworkSettings.Ports ?? {}).filter(([, bindings]) => bindings?.length);
    if (ports[service] === null) assert(published.length === 0, 'Isolated Redis must not expose a shared host port.');
    else {
      const [target, port] = ports[service];
      const bindings = actual.NetworkSettings.Ports[target];
      assert(published.length === 1 && bindings?.length === 1 && bindings[0].HostIp === '127.0.0.1'
        && bindings[0].HostPort === port, `Running ${service} must use its exact isolated loopback binding.`);
    }
  }
}

async function verifyAllApiDatabasesBeforeWrites(settings) {
  const priorManifest = process.env.E2E_RUN_MANIFEST;
  let manifestPath;
  let primaryError;
  try {
    manifestPath = await initializeRun(settings.web);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert(manifest.fixtures.length === 1, 'Database identity proof must contain one exact UUID fixture.');
    const probe = manifest.fixtures[0];
    assert(Number.isSafeInteger(probe.id) && probe.id > 0, 'Database identity probe must have a recorded positive ID.');
    // Read sequentially so no outstanding request can race the exact probe cleanup.
    for (const base of [settings.a, settings.b, settings.web]) {
      const response = await fetch(new URL(`/api/activities/${probe.id}`, base), {
        redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' },
      });
      let activity = null;
      if (response.ok) activity = await response.json();
      else await response.arrayBuffer();
      assert(activity?.id === probe.id && activity.title === probe.title && activity.description === probe.description,
        'One isolated Redis API endpoint differs from the UUID SQL database proof; API writes refused.');
    }
  } catch (error) { primaryError = error; }
  finally {
    try { if (manifestPath) await cleanupRun(manifestPath); }
    catch (error) { primaryError = primaryError ? new AggregateError([primaryError, error], 'Redis identity proof and exact probe cleanup failed.') : error; }
    finally {
      if (priorManifest === undefined) delete process.env.E2E_RUN_MANIFEST;
      else process.env.E2E_RUN_MANIFEST = priorManifest;
    }
  }
  if (primaryError) throw primaryError;
}

export class ApiClient {
  cookies = new Map();
  sessionCookiePolicy;
  lastResponseDeletedSession = false;

  clone() { const client = new ApiClient(); client.cookies = new Map(this.cookies); return client; }

  async response(base, path, options = {}) {
    const headers = new Headers(options.headers);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    if (this.cookies.size) headers.set('Cookie', [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    const response = await fetch(new URL(path, base), { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    this.lastResponseDeletedSession = response.headers.getSetCookie().some(cookie =>
      /^JSESSIONID=;/i.test(cookie) || /^JSESSIONID=/i.test(cookie) && /(?:max-age=0|expires=Thu, 01 Jan 1970)/i.test(cookie));
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
      if (name === 'JSESSIONID' && value) {
        const attributes = cookie.split(';').slice(1).map(attribute => attribute.trim().toLowerCase());
        this.sessionCookiePolicy = {
          path: attributes.find(attribute => attribute.startsWith('path='))?.slice(5),
          httpOnly: attributes.includes('httponly'),
          sameSite: attributes.find(attribute => attribute.startsWith('samesite='))?.slice(9),
          secure: attributes.includes('secure'),
        };
      }
    }
    return response;
  }

  async json(base, path, options = {}) {
    const response = await this.response(base, path, options);
    assert(response.ok, `${options.method ?? 'GET'} ${path} returned ${response.status}.`);
    return response.json();
  }

  async csrf(base) {
    const token = await this.json(base, '/api/auth/csrf');
    assert(typeof token.headerName === 'string' && typeof token.token === 'string' && token.token.length > 0, 'CSRF response is incomplete.');
    return token;
  }

  async write(base, path, token, method = 'POST', data, form = false) {
    const headers = { [token.headerName]: token.token };
    if (data !== undefined) headers['Content-Type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
    return this.json(base, path, {
      method, headers, body: data === undefined ? undefined : form ? new URLSearchParams(data) : JSON.stringify(data),
    });
  }

  async login(base, username, password) {
    const token = await this.csrf(base);
    this.verifySessionCookiePolicy();
    const priorCookie = this.cookies.get('JSESSIONID');
    assert(priorCookie, 'Anonymous CSRF access must create a JSESSIONID.');
    const user = await this.write(base, '/api/auth/login', token, 'POST', { username, password }, true);
    assert(user.username === username, 'Login returned the wrong user.');
    assert(this.cookies.get('JSESSIONID') && this.cookies.get('JSESSIONID') !== priorCookie,
      'Login must rotate the session identifier to prevent session fixation.');
    this.verifySessionCookiePolicy();
    return { user, priorToken: token };
  }

  verifySessionCookiePolicy() {
    const policy = this.sessionCookiePolicy;
    assert(policy?.path === '/' && policy.httpOnly && policy.sameSite === 'lax' && !policy.secure,
      'JSESSIONID must have Path=/, HttpOnly, SameSite=Lax and no Secure flag on the isolated HTTP CI stack.');
  }
}

async function healthy(url) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(3000) });
      if (response.ok && (await response.json()).status === 'UP') return;
    } catch { /* Only retry bounded readiness while the known isolated stack starts. */ }
    await delay(1000);
  }
  throw new Error('An isolated Redis stack endpoint did not become healthy within 120 seconds.');
}

async function waitForStack(settings) { await Promise.all([settings.a, settings.b, settings.web].map(healthy)); }

async function waitForDemoSeed(db) {
  // Tomcat can answer health before ApplicationRunner commits initialization.
  // Wait only for that known startup transition; duplicates remain an immediate failure.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const [[counts]] = await db.query('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM activities) AS activities');
    assert(Number(counts.users) <= 2 && Number(counts.activities) <= 3,
      'Concurrent startup created duplicate demo data in the fresh isolated CI stack.');
    if (Number(counts.users) === 2 && Number(counts.activities) === 3) return;
    await delay(250);
  }
  throw new Error('Demo initialization did not commit exactly two users and three activities within 30 seconds.');
}

function recreateBackends(timeout) {
  compose(['up', '-d', '--no-deps', '--force-recreate', 'backend', 'backend2'], timeout);
  // Nginx resolves these service addresses on startup; recreated containers may have new IPs.
  compose(['restart', 'web'], timeout);
}

async function databaseSnapshot(db) {
  const rows = {};
  for (const table of ['users', 'activities', 'registrations', 'notifications', 'activity_audit_logs']) [rows[table]] = await db.query(`SELECT * FROM ${table} ORDER BY id`);
  return JSON.stringify(rows);
}

async function expectedError(response, status, code) {
  assert(response.status === status, `Expected HTTP ${status}, received ${response.status}.`);
  assert((await response.json()).code === code, `Expected ${code} response.`);
}

export async function withActivityTableLock(connection, action, settle = async () => {}, beforeLock = async () => {}) {
  let locked = false;
  let result;
  const errors = [];
  try {
    await beforeLock();
    await connection.execute('SET SESSION lock_wait_timeout=5');
    await connection.execute('LOCK TABLES activities WRITE');
    locked = true;
    result = await action();
  } catch (error) { errors.push(error); }
  finally {
    if (locked) try { await connection.execute('UNLOCK TABLES'); } catch (error) { errors.push(error); }
    // Closing the owning connection also releases locks if UNLOCK itself failed.
    try { await connection.end(); } catch (error) { errors.push(error); }
    try { await settle(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'The isolated held-session verification and lock cleanup failed; first error is preserved.');
  return result;
}

export async function runRedisSessionChecks() {
  let settings;
  const checks = [];
  const clients = [];
  const runId = randomUUID();
  const ownedFixture = { key: runId, id: null, title: `Redis 会话验证 ${runId}`, description: `gather-redis-session-check:${runId}` };
  const checkInKey = randomUUID();
  const ownedCheckInFixture = { key: checkInKey, id: null, title: `Redis 签到验证 ${checkInKey}`,
    description: `gather-redis-checkin:${runId}:${checkInKey}` };
  const accountKey = randomUUID();
  const ownedAccount = { key: accountKey, id: null, username: `redis_${accountKey.replaceAll('-', '').slice(0, 24)}`,
    displayName: `e2e-${accountKey}`, allowedDisplayNames: [`e2e-${accountKey}`, `改名-${accountKey}`], role: 'USER' };
  const accountManifestPath = resolve('.runtime/ci', `redis-account-${runId}.manifest.json`);
  let accountAttempted = false;
  let accountClient;
  let otherAccountSession;
  let db;
  let baseline;
  let fixture;
  let timeoutChanged = false;
  let primaryError;
  let removed = { activities: 0, registrations: 0, users: 0, notifications: 0, auditLogs: 0 };
  const passed = name => { checks.push(name); console.log(`PASS: ${name}`); };
  const client = () => { const created = new ApiClient(); clients.push(created); return created; };

  try {
    settings = isolatedSettings();
    const declared = verifyComposeSettings(settings);
    verifyRunningComposeSettings(settings, declared);
    await waitForStack(settings);
    db = await mysql.createConnection({ ...settings.database, timezone: 'Z', dateStrings: true });
    await waitForDemoSeed(db);
    await verifyDatabase(db, settings.database);
    const [[seedCounts]] = await db.query('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM activities) AS activities');
    assert(Number(seedCounts.users) === 2 && Number(seedCounts.activities) === 3,
      'The fresh isolated CI stack must contain exactly two demo users and three demo activities.');
    await verifyAllApiDatabasesBeforeWrites(settings);
    passed('running container ownership and exact ports verified; one cleaned UUID SQL probe binds A, B and Nginx before API writes');
    baseline = await databaseSnapshot(db);
    passed('isolated dual-instance Redis stack and MySQL identity verified');

    const admin = client();
    const { user, priorToken } = await admin.login(settings.a, 'admin', process.env.DEMO_ADMIN_PASSWORD ?? 'Admin123!');
    await expectedError(await admin.response(settings.b, '/api/auth/logout', {
      method: 'POST', headers: { [priorToken.headerName]: priorToken.token },
    }), 403, 'CSRF_INVALID');
    const token = await admin.csrf(settings.a);
    assert(token.token !== priorToken.token, 'Successful login must rotate the CSRF token.');
    for (const base of [settings.a, settings.b]) {
      const identity = await admin.json(base, '/api/auth/me');
      assert(JSON.stringify(identity) === JSON.stringify(user), 'The same cookie must resolve the same authenticated user on both instances.');
    }
    await expectedError(await admin.response(settings.b, '/api/auth/logout', { method: 'POST' }), 403, 'CSRF_INVALID');
    passed('JSESSIONID flags are compatible; login rotates session/CSRF; identical cookie authenticates A and B; missing/old CSRF is rejected on B');

    const demo = client();
    await demo.login(settings.a, 'demo', process.env.DEMO_USER_PASSWORD ?? 'Demo123!');
    const demoToken = await demo.csrf(settings.a);
    await expectedError(await demo.response(settings.b, '/api/admin/overview'), 403, 'FORBIDDEN');
    passed('ordinary-user admin permission denial is shared across instances');

    fixture = await admin.write(settings.b, '/api/admin/activities', token, 'POST', {
      title: ownedFixture.title, description: ownedFixture.description, location: 'Redis isolated lifecycle verification',
      capacity: 1, startsAt: new Date(Date.now() + 48 * 3600000).toISOString(),
    });
    assert(Number.isSafeInteger(fixture.id) && fixture.id > 0, 'Activity creation returned an invalid ID.');
    ownedFixture.id = fixture.id;
    const [created] = await db.execute('SELECT title, description FROM activities WHERE id = ?', [fixture.id]);
    assert(created.length === 1 && created[0].title === ownedFixture.title && created[0].description === ownedFixture.description,
      'API fixture does not match the explicitly configured isolated database.');
    assert((await demo.write(settings.a, `/api/activities/${fixture.id}/registration`, demoToken)).registrationStatus === 'ACTIVE', 'Demo must occupy the seat on A.');
    const waiting = await admin.write(settings.b, `/api/activities/${fixture.id}/registration`, token);
    assert(waiting.registrationStatus === 'WAITING' && waiting.registeredCount === 1 && waiting.waitingCount === 1, 'Admin must join the waiting list on B.');
    assert((await demo.write(settings.b, `/api/activities/${fixture.id}/registration`, demoToken, 'DELETE')).registrationStatus === 'CANCELLED', 'Demo must cancel through B.');
    const promoted = await admin.json(settings.a, `/api/activities/${fixture.id}`);
    assert(promoted.registrationStatus === 'ACTIVE' && promoted.registeredCount === 1 && promoted.waitingCount === 0, 'Cancellation on B must promote admin on A.');
    const [[counts]] = await db.execute("SELECT a.registered_count AS registeredCount, a.capacity, SUM(r.status = 'ACTIVE') AS activeCount, SUM(r.status = 'WAITING') AS waitingCount, SUM(r.status = 'CANCELLED') AS cancelledCount FROM activities a JOIN registrations r ON r.activity_id = a.id WHERE a.id = ? GROUP BY a.id", [fixture.id]);
    assert(Number(counts.registeredCount) === 1 && Number(counts.capacity) === 1 && Number(counts.activeCount) === 1
      && Number(counts.waitingCount) === 0 && Number(counts.cancelledCount) === 1, 'Real MySQL counters and registration states must agree.');
    passed('A-issued CSRF works on B; cross-instance signup, waiting and promotion preserve real MySQL invariants');

    const noticePage = await admin.json(settings.a, '/api/me/notifications');
    assert(noticePage.total === 1 && noticePage.unreadCount === 1 && noticePage.items.length === 1,
      'One real promotion must create exactly one private unread notification.');
    const promotionNotice = noticePage.items[0];
    assert(promotionNotice.type === 'PROMOTED' && promotionNotice.activityId === fixture.id
      && promotionNotice.activityTitle === ownedFixture.title && promotionNotice.readAt === null);
    for (const base of [settings.a, settings.b, settings.web]) {
      assert.deepEqual(await admin.json(base, '/api/me/notifications'), noticePage);
      assert.equal((await demo.json(base, '/api/me/notifications')).total, 0);
    }
    await expectedError(await admin.response(settings.b, `/api/me/notifications/${promotionNotice.id}/read`, { method: 'POST' }), 403, 'CSRF_INVALID');
    await expectedError(await demo.response(settings.b, `/api/me/notifications/${promotionNotice.id}/read`, {
      method: 'POST', headers: { [demoToken.headerName]: demoToken.token },
    }), 404, 'NOTIFICATION_NOT_FOUND');
    const readNotice = await admin.write(settings.b, `/api/me/notifications/${promotionNotice.id}/read`, token);
    assert(readNotice.readAt);
    assert.deepEqual(await admin.write(settings.a, `/api/me/notifications/${promotionNotice.id}/read`, token), readNotice);
    for (const base of [settings.a, settings.b, settings.web]) {
      assert.equal((await admin.json(base, '/api/me/notifications/unread-count')).unreadCount, 0);
      assert.deepEqual((await admin.json(base, '/api/me/notifications?status=READ')).items, [readNotice]);
    }
    passed('promotion notifications are private on A/B/Nginx; cross-instance read is CSRF protected and idempotent');

    // Persist the exact account creation/nickname intent before registration; never record its password or Session.
    await mkdir('.runtime/ci', { recursive: true });
    const saveAccountManifest = async () => writeFile(accountManifestPath, `${JSON.stringify({
      runId, database: settings.database.database, account: ownedAccount, fixture: ownedFixture, checkInFixture: ownedCheckInFixture,
    }, null, 2)}\n`);
    await saveAccountManifest();
    accountAttempted = true;
    accountClient = client();
    const registrationToken = await accountClient.csrf(settings.a);
    const registrationResponse = await accountClient.response(settings.b, '/api/auth/register', {
      method: 'POST', headers: { [registrationToken.headerName]: registrationToken.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ownedAccount.username, displayName: ownedAccount.displayName, password: 'LocalAccount123!' }),
    });
    assert(registrationResponse.status === 201, 'Registration through B must create an ordinary account.');
    const accountIdentity = await registrationResponse.json();
    assert(Number.isSafeInteger(accountIdentity.id) && accountIdentity.id > 0 && accountIdentity.role === 'USER'
      && accountIdentity.username === ownedAccount.username && accountIdentity.displayName === ownedAccount.displayName,
    'Registration identity differs from the exact owned account.');
    ownedAccount.id = accountIdentity.id;
    await saveAccountManifest();
    await expectedError(await accountClient.response(settings.a, '/api/auth/me'), 401, 'UNAUTHENTICATED');
    await accountClient.login(settings.a, ownedAccount.username, 'LocalAccount123!');
    otherAccountSession = client();
    await otherAccountSession.login(settings.b, ownedAccount.username, 'LocalAccount123!');
    const profileToken = await accountClient.csrf(settings.a);
    const renamed = await accountClient.write(settings.b, '/api/me/profile', profileToken, 'PATCH', {
      displayName: ownedAccount.allowedDisplayNames[1], id: user.id, role: 'ADMIN', username: 'admin',
    });
    assert(renamed.id === ownedAccount.id && renamed.role === 'USER' && renamed.username === ownedAccount.username
      && renamed.displayName === ownedAccount.allowedDisplayNames[1], 'Profile writes must target the trusted current user only.');
    for (const current of [accountClient, otherAccountSession]) for (const base of [settings.a, settings.b]) {
      const identity = await current.json(base, '/api/auth/me');
      assert(identity.id === ownedAccount.id && identity.displayName === renamed.displayName && identity.role === 'USER',
        'Independent sessions must read the latest database nickname on both replicas.');
    }
    assert((await admin.json(settings.a, '/api/auth/me')).displayName === user.displayName, 'Forged profile identity modified another account.');
    await expectedError(await accountClient.response(settings.b, '/api/admin/overview'), 403, 'FORBIDDEN');
    const candidate = await accountClient.write(settings.a, `/api/activities/${fixture.id}/registration`, profileToken);
    assert(candidate.registrationStatus === 'WAITING' && candidate.registeredCount === 1 && candidate.waitingCount === 1,
      'A newly registered ordinary user must participate through the shared Session.');
    await accountClient.write(settings.b, `/api/activities/${fixture.id}/registration`, profileToken, 'DELETE');
    passed('registration creates USER without logging in; two independent sessions read the latest nickname on A/B; profile identity cannot be forged and signup works');

    const backends = new Set();
    // Startup health checks can temporarily mark one upstream failed. Allow its
    // normal Nginx fail_timeout to elapse instead of treating a retry list as a replica.
    for (let attempt = 0; attempt < 40 && backends.size < 2; attempt++) {
      const response = await admin.response(settings.web, '/api/auth/me');
      assert(response.ok, 'The shared session must survive Nginx routing.');
      const backend = response.headers.get('X-Gather-Backend');
      assert(backend, 'Nginx must expose X-Gather-Backend for the isolated check.');
      backends.add(backend.split(',').at(-1).trim());
      if (backends.size < 2) await delay(500);
    }
    assert(backends.size === 2, 'Nginx must route authenticated requests to two distinct backend instances.');
    passed('Nginx serves the same authenticated cookie through two distinct backend instances');

    // Initialize only this exact independent started fixture after Docker/SQL/API ownership binding.
    await saveAccountManifest();
    const [checkInActivity] = await db.execute('INSERT INTO activities(title,description,location,starts_at,capacity,registered_count,created_by) VALUES (?,?,?,UTC_TIMESTAMP(6) - INTERVAL 1 DAY,2,2,?)',
      [ownedCheckInFixture.title, ownedCheckInFixture.description, 'Isolated cross-instance check-in', user.id]);
    ownedCheckInFixture.id = Number(checkInActivity.insertId);
    await saveAccountManifest();
    const demoIdentity = await demo.json(settings.a, '/api/auth/me');
    await db.execute("INSERT INTO registrations(activity_id,user_id,status,created_at,updated_at) VALUES (?,?,'ACTIVE',UTC_TIMESTAMP(6) - INTERVAL 2 DAY,UTC_TIMESTAMP(6) - INTERVAL 2 DAY),(?,?,'ACTIVE',UTC_TIMESTAMP(6) - INTERVAL 2 DAY,UTC_TIMESTAMP(6) - INTERVAL 2 DAY),(?,?,'WAITING',UTC_TIMESTAMP(6) - INTERVAL 2 DAY,UTC_TIMESTAMP(6) - INTERVAL 2 DAY)",
      [ownedCheckInFixture.id, user.id, ownedCheckInFixture.id, ownedAccount.id, ownedCheckInFixture.id, demoIdentity.id]);
    const initialCheckInRoster = await admin.json(settings.a, `/api/admin/activities/${ownedCheckInFixture.id}/registrations`);
    const initialAttendance = await admin.json(settings.a, '/api/admin/attendance');
    assert.equal(initialAttendance.total, 1);
    assert.equal(initialAttendance.items[0].id, ownedCheckInFixture.id);
    assert.deepEqual(initialAttendance.summary, { totalActivities: 1, activeRegistrations: 2,
      checkedInRegistrations: 0, notCheckedInRegistrations: 2, checkInRate: 0 });
    const attendancePath = `/api/admin/attendance?${new URLSearchParams({ from: initialAttendance.from, to: initialAttendance.to })}`;
    const beforeAttendanceOnly = JSON.parse(await databaseSnapshot(db));
    assert.deepEqual(initialCheckInRoster.summary, { activeRegistrations: 2, checkedInRegistrations: 0, notCheckedInRegistrations: 2 });
    const checkInRegistration = initialCheckInRoster.items.find(row => row.userId === ownedAccount.id);
    assert(checkInRegistration && checkInRegistration.checkedInAt === null);
    const checkInPath = `/api/admin/activities/${ownedCheckInFixture.id}/registrations/${checkInRegistration.id}/check-in`;
    await expectedError(await admin.response(settings.b, checkInPath, { method: 'POST' }), 403, 'CSRF_INVALID');
    const accountCheckInToken = await accountClient.csrf(settings.a);
    await expectedError(await accountClient.response(settings.b, checkInPath, {
      method: 'POST', headers: { [accountCheckInToken.headerName]: accountCheckInToken.token },
    }), 403, 'FORBIDDEN');
    const checkedIn = await admin.write(settings.a, checkInPath, token);
    assert(checkedIn.checkedInAt && checkedIn.checkedInBy === user.id && checkedIn.updatedAt === checkInRegistration.updatedAt);
    for (const base of [settings.a, settings.b, settings.web]) {
      assert.deepEqual(await admin.write(base, checkInPath, token), checkedIn);
      const page = await admin.json(base, `/api/admin/activities/${ownedCheckInFixture.id}/registrations?checkInStatus=CHECKED_IN`);
      assert.deepEqual(page.summary, { activeRegistrations: 2, checkedInRegistrations: 1, notCheckedInRegistrations: 1 });
      assert.deepEqual(page.items, [checkedIn]);
    }
    const exportPath = `/api/admin/activities/${ownedCheckInFixture.id}/registrations/export?status=ACTIVE&checkInStatus=CHECKED_IN`;
    let checkInCsv;
    for (const base of [settings.a, settings.b, settings.web]) {
      const response = await admin.response(base, exportPath, { headers: { Accept: 'text/csv, application/json' } });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('Content-Type'), /^text\/csv/i);
      assert(response.headers.get('Content-Disposition').includes(`activity-${ownedCheckInFixture.id}-registrations.csv`));
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.deepEqual([...bytes.slice(0, 3)], [239, 187, 191]);
      const csv = new TextDecoder().decode(bytes);
      assert(csv.includes(`"\t${ownedAccount.username}"`));
      if (checkInCsv === undefined) checkInCsv = csv;
      else assert.equal(csv, checkInCsv);
    }
    await expectedError(await accountClient.response(settings.web, exportPath, { headers: { Accept: 'text/csv, application/json' } }), 403, 'FORBIDDEN');
    const afterAttendanceOnly = JSON.parse(await databaseSnapshot(db));
    const oldAuditIds = new Set(beforeAttendanceOnly.activity_audit_logs.map(row => row.id));
    const newAudits = afterAttendanceOnly.activity_audit_logs.filter(row => !oldAuditIds.has(row.id));
    assert.equal(newAudits.length, 1, 'Cross-instance first check-in appends exactly one audit and all repeated writes append none.');
    assert(newAudits[0].action === 'CHECK_IN' && newAudits[0].activity_id === ownedCheckInFixture.id
      && newAudits[0].registration_id === checkedIn.id && newAudits[0].actor_user_id === user.id
      && newAudits[0].target_username === ownedAccount.username && newAudits[0].target_display_name === ownedAccount.allowedDisplayNames[1]);
    afterAttendanceOnly.activity_audit_logs = afterAttendanceOnly.activity_audit_logs.filter(row => oldAuditIds.has(row.id));
    for (const state of [beforeAttendanceOnly, afterAttendanceOnly]) {
      state.registrations = state.registrations.map(({ checked_in_at, checked_in_by, ...businessFields }) => businessFields);
    }
    assert(JSON.stringify(afterAttendanceOnly) === JSON.stringify(beforeAttendanceOnly), 'Cross-instance check-in/export must preserve old business rows and audit snapshots apart from check-in fields and one new audit.');
    const [[attendanceTruth]] = await db.execute("SELECT a.registered_count AS registeredCount, SUM(r.status='ACTIVE') AS active, SUM(r.status='WAITING') AS waiting, SUM(r.checked_in_at IS NOT NULL) AS checked FROM activities a JOIN registrations r ON r.activity_id=a.id WHERE a.id=? GROUP BY a.id", [ownedCheckInFixture.id]);
    assert.equal(Number(attendanceTruth.registeredCount), Number(attendanceTruth.active));
    assert.equal(Number(attendanceTruth.active), 2);
    assert.equal(Number(attendanceTruth.waiting), 1);
    assert.equal(Number(attendanceTruth.checked), 1);
    const signedAttendance = await admin.json(settings.a, attendancePath);
    assert.deepEqual(signedAttendance.summary, { totalActivities: 1, activeRegistrations: 2,
      checkedInRegistrations: 1, notCheckedInRegistrations: 1, checkInRate: 50 });
    assert(signedAttendance.items.length === 1 && signedAttendance.items[0].id === ownedCheckInFixture.id
      && signedAttendance.items[0].activeRegistrations === 2 && signedAttendance.items[0].checkedInRegistrations === 1
      && signedAttendance.items[0].checkInRate === 50);
    const { asOf: signedAttendanceTime, ...stableAttendance } = signedAttendance;
    for (const base of [settings.a, settings.b, settings.web]) {
      const { asOf, ...view } = await admin.json(base, attendancePath);
      assert.deepEqual(view, stableAttendance);
      assert(Date.parse(asOf) >= Date.parse(signedAttendanceTime));
      const outside = await admin.json(base, `${attendancePath}&page=2&pageSize=1`);
      assert.equal(outside.total, 1);
      assert.deepEqual(outside.items, []);
      assert.deepEqual(outside.summary, signedAttendance.summary);
    }
    await expectedError(await accountClient.response(settings.b, attendancePath), 403, 'FORBIDDEN');
    await expectedError(await new ApiClient().response(settings.web, attendancePath), 401, 'UNAUTHENTICATED');
    passed('attendance analysis and weighted full summary refresh after check-in and agree on A/B/Nginx; user/anonymous access is denied');
    passed('trusted check-in and complete filtered UTF-8 CSV agree on A/B/Nginx; repeat keeps first metadata and role/CSRF denial holds');

    const beforeRestart = await databaseSnapshot(db);
    compose(['restart', 'backend']);
    await waitForStack(settings);
    for (const base of [settings.a, settings.b]) {
      const identity = await admin.json(base, '/api/auth/me');
      assert(JSON.stringify(identity) === JSON.stringify(user), 'Shared authentication must remain valid after restarting A.');
    }
    const repeated = await admin.write(settings.b, `/api/activities/${fixture.id}/registration`, token);
    assert(repeated.registrationStatus === 'ACTIVE' && repeated.registeredCount === 1, 'Pre-restart CSRF must remain usable on B without duplicating registration.');
    assert(await databaseSnapshot(db) === beforeRestart, 'Backend A restart or duplicate signup changed database records.');
    for (const base of [settings.a, settings.b]) {
      assert.deepEqual((await admin.json(base, `/api/admin/activities/${ownedCheckInFixture.id}/registrations?checkInStatus=CHECKED_IN`)).items, [checkedIn]);
      const response = await admin.response(base, exportPath, { headers: { Accept: 'text/csv, application/json' } });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), checkInCsv);
      const { asOf, ...attendanceAfterRestart } = await admin.json(base, attendancePath);
      assert.deepEqual(attendanceAfterRestart, stableAttendance, 'Attendance summary and rows must survive replica restart.');
      assert(Date.parse(asOf) >= Date.parse(signedAttendanceTime));
    }
    passed('restarting only A preserves shared login, existing CSRF and exact database data');

    for (const base of [settings.a, settings.b]) {
      const identity = await accountClient.json(base, '/api/auth/me');
      assert(identity.id === ownedAccount.id && identity.displayName === ownedAccount.allowedDisplayNames[1],
        'Updated profile must remain readable across a Java replica restart.');
    }
    const oldAccountCookie = accountClient.clone();
    await accountClient.write(settings.b, '/api/auth/logout', await accountClient.csrf(settings.a));
    for (const base of [settings.a, settings.b]) await expectedError(await oldAccountCookie.clone().response(base, '/api/auth/me'), 401, 'UNAUTHENTICATED');
    for (const base of [settings.a, settings.b]) {
      assert((await otherAccountSession.json(base, '/api/auth/me')).displayName === ownedAccount.allowedDisplayNames[1],
        'Logging out one Session must preserve another independent Session.');
    }
    await accountClient.login(settings.b, ownedAccount.username, 'LocalAccount123!');
    assert((await accountClient.json(settings.a, '/api/auth/me')).displayName === ownedAccount.allowedDisplayNames[1],
      'Re-login must load the persisted nickname across replicas.');
    passed('updated nickname survives replica restart and re-login; logout invalidates only its shared Session without rewriting identity or CSRF');

    const edited = await admin.write(settings.b, `/api/admin/activities/${fixture.id}`, token, 'PATCH', {
      title: ownedFixture.title, description: ownedFixture.description, location: 'Updated lifecycle verification location',
      capacity: 99, startsAt: new Date(Date.now() + 72 * 3600000).toISOString(),
    });
    assert(edited.capacity === fixture.capacity && edited.startsAt === fixture.startsAt
      && edited.location === 'Updated lifecycle verification location', 'Editing must preserve the published time and capacity.');
    const signupToken = await accountClient.csrf(settings.a);
    const lifecycleResults = await Promise.allSettled([
      admin.write(settings.b, `/api/admin/activities/${fixture.id}/cancel`, token, 'POST', { reason: 'Isolated cross-instance lifecycle check' }),
      accountClient.response(settings.a, `/api/activities/${fixture.id}/registration`, {
        method: 'POST', headers: { [signupToken.headerName]: signupToken.token },
      }),
    ]);
    assert(lifecycleResults.every(result => result.status === 'fulfilled'), 'Both cross-instance lifecycle requests must settle successfully before cleanup.');
    const cancelledActivity = lifecycleResults[0].value;
    const competingSignup = lifecycleResults[1].value;
    if (competingSignup.status === 200) {
      assert((await competingSignup.json()).registrationStatus === 'WAITING', 'Signup before cancellation can only join this full fixture queue.');
    } else await expectedError(competingSignup, 409, 'ACTIVITY_CANCELLED');
    assert(cancelledActivity.cancelled && cancelledActivity.closed && cancelledActivity.registeredCount === 0
      && cancelledActivity.waitingCount === 0, 'Concurrent signup and cancellation must converge on a closed empty activity.');
    for (const base of [settings.a, settings.b]) {
      const activity = await accountClient.json(base, `/api/activities/${fixture.id}`);
      assert(activity.cancelled && activity.registeredCount === 0 && activity.waitingCount === 0
        && activity.registrationStatus === 'CANCELLED' && activity.cancellationReason === cancelledActivity.cancellationReason,
      'Both replicas must expose cancelled history and the original reason.');
    }
    const repeatedActivity = await admin.write(settings.a, `/api/admin/activities/${fixture.id}/cancel`, token, 'POST', { reason: 'Ignored repeated reason' });
    assert(repeatedActivity.cancelledAt === cancelledActivity.cancelledAt && repeatedActivity.cancellationReason === cancelledActivity.cancellationReason,
      'Repeating cancellation must preserve the first cancellation metadata.');
    const auditPage = await admin.json(settings.a, `/api/admin/audit-logs?activityId=${fixture.id}`);
    assert.equal(auditPage.total, 3);
    assert.deepEqual(auditPage.items.map(row => row.action), ['CANCEL', 'EDIT', 'CREATE']);
    assert(auditPage.items.every(row => row.actorUserId === user.id && row.actorUsername === 'admin'
      && row.activityId === fixture.id && row.activityTitle === ownedFixture.title && !Object.hasOwn(row, 'changes')));
    for (const base of [settings.a, settings.b, settings.web]) {
      assert.deepEqual(await admin.json(base, `/api/admin/audit-logs?activityId=${fixture.id}`), auditPage);
      const editAudit = await admin.json(base, `/api/admin/audit-logs/${auditPage.items[1].id}`);
      assert.deepEqual(editAudit.changes, [{ field: 'location', before: 'Redis isolated lifecycle verification', after: edited.location }]);
      const attendanceAudit = await admin.json(base, `/api/admin/audit-logs?activityId=${ownedCheckInFixture.id}&action=CHECK_IN`);
      assert.equal(attendanceAudit.total, 1);
      const detail = await admin.json(base, `/api/admin/audit-logs/${attendanceAudit.items[0].id}`);
      assert.deepEqual(detail.changes, [{ field: 'checkedInAt', before: null, after: checkedIn.checkedInAt }]);
      assert(detail.targetUsername === ownedAccount.username && detail.targetDisplayName === ownedAccount.allowedDisplayNames[1]);
    }
    await expectedError(await accountClient.response(settings.b, '/api/admin/audit-logs'), 403, 'FORBIDDEN');
    await expectedError(await new ApiClient().response(settings.web, `/api/admin/audit-logs/${auditPage.items[0].id}`), 401, 'UNAUTHENTICATED');
    passed('CREATE, EDIT, first CANCEL and CHECK_IN audit snapshots and full changes agree on both replicas and Nginx; non-administrators are denied');
    await expectedError(await accountClient.response(settings.b, `/api/activities/${fixture.id}/registration`, {
      method: 'POST', headers: { [signupToken.headerName]: signupToken.token },
    }), 409, 'ACTIVITY_CANCELLED');
    const [[finalCounts]] = await db.execute("SELECT a.registered_count AS registeredCount, SUM(r.status='ACTIVE') AS active, SUM(r.status='WAITING') AS waiting, COUNT(r.id) AS records FROM activities a JOIN registrations r ON r.activity_id=a.id WHERE a.id=? GROUP BY a.id", [fixture.id]);
    assert(Number(finalCounts.registeredCount) === 0 && Number(finalCounts.active) === 0 && Number(finalCounts.waiting) === 0
      && Number(finalCounts.records) === 3, 'Cancellation must retain all three histories and no active or waiting rows.');
    passed('cross-instance editing preserves immutable fields; racing signup and activity cancellation retains history with zero active or waiting rows');

    const searchPath = `/api/activities/search?${new URLSearchParams({
      keyword: ownedFixture.title, status: 'CANCELLED', page: '1', pageSize: '1',
    })}`;
    for (const current of [admin, accountClient]) for (const base of [settings.a, settings.b, settings.web]) {
      const page = await current.json(base, searchPath);
      assert(page.total === 1 && page.items.length === 1 && page.items[0].id === fixture.id
        && page.items[0].registrationStatus === 'CANCELLED' && page.summary.upcomingActivities === 0
        && page.summary.availableSeats === 0, 'Both replicas must return the correct scoped search, history and filtered statistics.');
    }
    const anonymousSearch = await new ApiClient().json(settings.web, `${searchPath}&userId=${user.id}`);
    assert(anonymousSearch.total === 1 && anonymousSearch.items.length === 1 && anonymousSearch.items[0].id === fixture.id
      && anonymousSearch.items[0].registrationStatus === null && anonymousSearch.summary.upcomingActivities === 0
      && anonymousSearch.summary.availableSeats === 0, 'An anonymous query must preserve public results without specifying another user identity.');
    passed('public search through A/B and Nginx preserves filtered statistics and trusted current-user registration state');

    for (const base of [settings.a, settings.b, settings.web]) {
      const adminNotices = await admin.json(base, '/api/me/notifications');
      const accountNotices = await accountClient.json(base, '/api/me/notifications');
      assert.equal(adminNotices.total, 2);
      assert.equal(adminNotices.unreadCount, 1);
      assert.deepEqual(adminNotices.items.find(row => row.type === 'PROMOTED'), readNotice);
      const accountCancellationCount = competingSignup.status === 200 ? 1 : 0;
      assert.equal(accountNotices.total, accountCancellationCount);
      assert.equal(accountNotices.unreadCount, accountCancellationCount);
      assert.equal(accountNotices.items.length, accountCancellationCount);
      for (const cancellation of [adminNotices.items[0], ...accountNotices.items]) {
        assert(cancellation.type === 'ACTIVITY_CANCELLED' && cancellation.activityId === fixture.id
          && cancellation.activityTitle === ownedFixture.title && cancellation.cancellationReason === cancelledActivity.cancellationReason);
      }
      assert.equal((await demo.json(base, '/api/me/notifications')).total, 0);
    }
    await expectedError(await new ApiClient().response(settings.web, '/api/me/notifications'), 401, 'UNAUTHENTICATED');
    passed('cancellation notifies only current participants once; promotion read history survives restart and is shared across A/B/Nginx');

    for (const current of [admin, accountClient]) {
      const legacy = await current.json(settings.a, '/api/me/registrations');
      assert.equal(legacy.length, 2);
      const full = await current.json(settings.a, '/api/me/registrations/search?page=1&pageSize=100&status=ALL');
      assert.equal(full.total, 2);
      assert.deepEqual(full.items.map(row => row.activity.id), [fixture.id, ownedCheckInFixture.id]);
      assert.deepEqual(full.summary, { activeRegistrations: 1, waitingRegistrations: 0, cancelledRegistrations: 1,
        checkedInRegistrations: current === admin ? 0 : 1 });
      assert.deepEqual(full.items.map(({ checkedInAt, ...oldFields }) => oldFields), legacy);
      assert(full.items.every(row => JSON.stringify(Object.keys(row).sort()) === JSON.stringify(['activity', 'checkedInAt', 'id', 'status'])
        && row.activity.registrationStatus === row.status), 'Personal queries must not expose attendance administrator fields.');
      const ownAttendance = full.items.find(row => row.activity.id === ownedCheckInFixture.id);
      assert.equal(ownAttendance.checkedInAt, current === admin ? null : checkedIn.checkedInAt);
      for (const base of [settings.a, settings.b, settings.web]) {
        const page = await current.json(base, `/api/me/registrations/search?page=1&pageSize=1&status=ACTIVE&userId=${demoIdentity.id}`);
        assert.equal(page.total, 1);
        assert.deepEqual(page.items, [ownAttendance]);
        assert.deepEqual(page.summary, full.summary);
        const second = await current.json(base, '/api/me/registrations/search?page=2&pageSize=1&status=ALL');
        assert.equal(second.total, 2);
        assert.deepEqual(second.items, [full.items[1]]);
        assert.deepEqual(second.summary, full.summary);
      }
    }
    const demoPersonal = await demo.json(settings.web, '/api/me/registrations/search?page=1&pageSize=10&status=WAITING');
    assert.equal(demoPersonal.total, 1);
    assert.equal(demoPersonal.items[0].activity.id, ownedCheckInFixture.id);
    assert.equal(demoPersonal.items[0].status, 'WAITING');
    assert.equal(demoPersonal.items[0].activity.registrationStatus, demoPersonal.items[0].status);
    assert.deepEqual(Object.keys(demoPersonal.items[0]).sort(), ['activity', 'checkedInAt', 'id', 'status']);
    assert.equal(demoPersonal.items[0].checkedInAt, null);
    assert.deepEqual(demoPersonal.summary, { activeRegistrations: 0, waitingRegistrations: 1, cancelledRegistrations: 1, checkedInRegistrations: 0 });
    await expectedError(await new ApiClient().response(settings.web, '/api/me/registrations/search'), 401, 'UNAUTHENTICATED');
    passed('personal pagination and global summary are scoped to each Session on A/B/Nginx; only own attendance is exposed and legacy arrays agree');

    const savedOldSession = otherAccountSession.clone();
    const savedOldCsrf = await otherAccountSession.csrf(settings.b);
    const publicPasswordSession = client();
    await publicPasswordSession.login(settings.b, ownedAccount.username, 'LocalAccount123!');
    const publicOldCookie = publicPasswordSession.clone();
    const currentPasswordToken = await accountClient.csrf(settings.a);
    const beforePassword = JSON.parse(await databaseSnapshot(db));
    // The fixed isolated project/ports/database/UUID probe above authorize this
    // short table lock only in this CI database. It holds an existing read after
    // its credential check so the real Java Session can save after password change.
    const lateCookie = accountClient.clone();
    const lockConnection = await mysql.createConnection({ ...settings.database, timezone: 'Z', dateStrings: true });
    let changedPassword;
    let lateRead;
    let completedLateRead;
    await withActivityTableLock(lockConnection, async () => {
      lateRead = lateCookie.response(settings.b, '/api/me/registrations/search?page=1&pageSize=10&status=ALL');
      const deadline = Date.now() + 4000;
      let waiting = false;
      while (Date.now() < deadline) {
        // Never return or print PROCESSLIST.INFO, connection IDs or credentials.
        const [[state]] = await db.execute("SELECT COUNT(*) AS total FROM information_schema.PROCESSLIST WHERE DB=? AND USER=? AND COMMAND='Query' AND STATE='Waiting for table metadata lock' AND INFO LIKE '%registrations%' AND INFO LIKE '%activities%'",
          [settings.database.database, settings.database.user]);
        if (Number(state.total) === 1) { waiting = true; break; }
        await delay(50);
      }
      assert(waiting, 'The owned old-session Java read did not demonstrably pass credential validation and wait on its activity SELECT.');
      changedPassword = await accountClient.write(settings.a, '/api/me/password', currentPasswordToken, 'POST', {
        currentPassword: 'LocalAccount123!', newPassword: 'UpdatedAccount123!',
      });
    }, async () => { if (lateRead) completedLateRead = await lateRead; }, async () => {
      const [[identity]] = await db.execute('SELECT @@server_uuid AS serverUuid');
      await verifyDatabase(lockConnection, settings.database, { ...settings.database, serverUuid: identity.serverUuid });
    });
    assert.equal(completedLateRead.status, 200, 'The admitted in-flight read may finish after password change.');
    const latePage = await completedLateRead.json();
    assert.equal(latePage.total, 2, 'The held Java read must still belong to the exact existing owned user.');
    for (const base of [settings.a, settings.b, settings.web]) {
      const afterLateSave = await lateCookie.clone().response(base, '/api/auth/me');
      assert.equal(afterLateSave.status, 401, 'Late saving the old real Java Session must never restore authenticated access.');
      await afterLateSave.arrayBuffer();
    }
    passed('a real B request held after credential validation finishes after A changes the password; its late shared-session save cannot restore identity on A/B/Nginx');
    assert.deepEqual(changedPassword, { success: true });
    assert.equal(accountClient.lastResponseDeletedSession, false, 'Password change must not send a late Cookie deletion that could erase a new login.');
    await expectedError(await accountClient.response(settings.b, '/api/auth/me'), 401, 'UNAUTHENTICATED');
    const revokedPasswordClient = savedOldSession.clone();
    await expectedError(await revokedPasswordClient.response(settings.b, '/api/me/profile'), 401, 'SESSION_REVOKED');
    assert.equal(revokedPasswordClient.lastResponseDeletedSession, false, 'Credential-version rejection must not expire a newly logged-in Cookie.');
    for (const base of [settings.a, settings.b, settings.web]) {
      const stale = await savedOldSession.clone().response(base, '/api/auth/me');
      assert.equal(stale.status, 401);
      const failure = await stale.json();
      assert(['SESSION_REVOKED', 'UNAUTHENTICATED'].includes(failure.code));
      const publicActivity = await publicOldCookie.clone().json(base, `/api/activities/${fixture.id}`);
      assert.equal(publicActivity.registrationStatus, null);
      const deniedWrite = await savedOldSession.clone().response(base, '/api/me/password', { method: 'POST',
        headers: { [savedOldCsrf.headerName]: savedOldCsrf.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: 'UpdatedAccount123!', newPassword: 'ShouldNeverSave123!' }) });
      assert([401, 403].includes(deniedWrite.status), 'Stale Session or CSRF must never change credentials again.');
      await deniedWrite.arrayBuffer();
    }
    const afterPassword = JSON.parse(await databaseSnapshot(db));
    for (const state of [beforePassword, afterPassword]) state.users = state.users.map(row => row.id === ownedAccount.id
      ? { ...row, password_hash: '<owned-password>', credential_version: '<owned-version>' } : row);
    assert(JSON.stringify(afterPassword) === JSON.stringify(beforePassword), 'Password change may alter only the exact owned hash/version, preserving all other data.');
    const [[versionAfterPassword]] = await db.execute('SELECT credential_version AS version FROM users WHERE id=?', [ownedAccount.id]);
    assert.equal(Number(versionAfterPassword.version), 1);
    const rejectedOldLogin = client();
    const oldLoginToken = await rejectedOldLogin.csrf(settings.b);
    await expectedError(await rejectedOldLogin.response(settings.b, '/api/auth/login', { method: 'POST',
      headers: { [oldLoginToken.headerName]: oldLoginToken.token, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: ownedAccount.username, password: 'LocalAccount123!' }) }), 401, 'INVALID_CREDENTIALS');
    await accountClient.login(settings.b, ownedAccount.username, 'UpdatedAccount123!');
    for (const base of [settings.a, settings.b, settings.web]) assert((await accountClient.json(base, '/api/auth/me')).id === ownedAccount.id);
    passed('changing only the owned password on A advances V7 once; all old cookies/CSRF lose identity on A/B/Nginx, public reads are anonymous and the new password logs in across replicas');

    const loggedOutCookie = admin.clone();
    await admin.write(settings.b, '/api/auth/logout', token);
    for (const base of [settings.a, settings.b]) await expectedError(await loggedOutCookie.clone().response(base, '/api/auth/me'), 401, 'UNAUTHENTICATED');
    passed('logout on B invalidates the prior cookie on both A and B');

    timeoutChanged = true;
    recreateBackends('3s');
    await waitForStack(settings);
    const expiring = client();
    await expiring.login(settings.a, 'demo', process.env.DEMO_USER_PASSWORD ?? 'Demo123!');
    const idleCookie = expiring.clone();
    await delay(5000); // No request touches this session while measuring genuine idle expiration.
    for (const base of [settings.a, settings.b]) await expectedError(await idleCookie.clone().response(base, '/api/auth/me'), 401, 'UNAUTHENTICATED');
    passed('a genuinely idle 3-second session expires on both instances without deleting Redis keys');
  } catch (error) { primaryError = error; }
  finally {
    if (timeoutChanged) {
      try {
        recreateBackends('30m');
        await waitForStack(settings);
        passed('both backend timeouts restored to 30m and Nginx restarted before browser regressions');
      } catch (error) { primaryError = primaryError ? new AggregateError([primaryError, error], 'Redis verification and timeout restoration failed.') : error; }
    }
    for (const owned of clients) {
      if (!owned.cookies.get('JSESSIONID')) continue;
      try {
        const response = await owned.response(settings.b, '/api/auth/me');
        if (response.status === 401) continue;
        assert(response.ok, 'Could not verify an owned session before logout.');
        const token = await owned.csrf(settings.b);
        await owned.write(settings.b, '/api/auth/logout', token);
      } catch (error) { primaryError = primaryError ? new AggregateError([primaryError, error], 'Redis verification and owned-session logout failed.') : error; }
    }
    if (db) {
      try {
        if (baseline !== undefined) {
          const result = await deleteOwnedFixtures(db, [ownedFixture, ownedCheckInFixture], new Set(), async (activities, accounts) => {
            if (accountAttempted) await writeFile(accountManifestPath, `${JSON.stringify({ runId, database: settings.database.database,
              account: ownedAccount, fixture: ownedFixture, checkInFixture: ownedCheckInFixture, cleanupIntent: {
                activityIds: activities.map(activity => activity.id), userIds: accounts.map(account => account.id),
              } }, null, 2)}\n`);
          }, { accounts: accountAttempted ? [ownedAccount] : [] });
          removed = { activities: result.deletedActivities, registrations: result.deletedRegistrations, users: result.deletedUsers, notifications: result.deletedNotifications, auditLogs: result.deletedAuditLogs };
          assert(await databaseSnapshot(db) === baseline, 'Exact Redis fixture cleanup did not preserve the database baseline.');
          passed('only the exact UUID fixture and its registrations removed; existing database records preserved');
        }
      } catch (error) { primaryError = primaryError ? new AggregateError([primaryError, error], 'Redis verification and exact fixture cleanup failed.') : error; }
      finally { await db.end(); }
    }
    await mkdir('.runtime/ci', { recursive: true });
    await writeFile(reportPath, `${JSON.stringify({ success: !primaryError, checks, counts: { checksPassed: checks.length,
      activitiesRemoved: removed.activities, registrationsRemoved: removed.registrations, usersRemoved: removed.users,
      notificationsRemoved: removed.notifications, auditLogsRemoved: removed.auditLogs } }, null, 2)}\n`);
  }
  if (primaryError) throw primaryError;
  console.log(`Redis session verification completed (${checks.length} checks); report: ${reportPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runRedisSessionChecks();
