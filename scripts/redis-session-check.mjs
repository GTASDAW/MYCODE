import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { databaseConfig, verifyDatabase, deleteOwnedFixtures } from './e2e-cleanup.mjs';

const composeFiles = ['compose.yaml', 'compose.redis.yaml', '.github/compose.ci.yaml', '.github/compose.redis-ci.yaml'];
const reportPath = '.runtime/ci/redis-session-check.json';
const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));

export function isolatedSettings(environment = process.env) {
  assert(environment.COMPOSE_PROJECT_NAME === 'gather-redis-ci', 'Redis lifecycle checks require the isolated gather-redis-ci project.');
  const database = databaseConfig(environment);
  assert(database.database === 'activity_platform_e2e', 'Redis lifecycle checks require the isolated activity_platform_e2e database.');
  assert((environment.SESSION_TIMEOUT ?? '30m') === '30m', 'The normal session timeout must be 30m.');
  assert((environment.SESSION_NAMESPACE ?? 'gather:session') === 'gather:session', 'Unexpected Redis session namespace.');
  assert((environment.SESSION_COOKIE_SECURE ?? 'false') === 'false', 'The isolated HTTP CI stack requires SESSION_COOKIE_SECURE=false.');
  assert(environment.REDIS_PASSWORD, 'Set an explicit Redis password for the isolated stack.');
  const urls = ['REDIS_TEST_BASE_URL', 'REDIS_TEST_A_URL', 'REDIS_TEST_B_URL'].map((key, index) => {
    const defaults = ['http://127.0.0.1:19088', 'http://127.0.0.1:19081', 'http://127.0.0.1:19082'];
    let url;
    try { url = new URL(environment[key] ?? defaults[index]); }
    catch { throw new Error(`${key} must be a valid HTTP loopback URL.`); }
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.protocol === 'http:' && !url.username && !url.password,
      `${key} must be an HTTP loopback URL without embedded credentials.`);
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
}

class ApiClient {
  cookies = new Map();
  sessionCookiePolicy;

  clone() { const client = new ApiClient(); client.cookies = new Map(this.cookies); return client; }

  async response(base, path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set('Accept', 'application/json');
    if (this.cookies.size) headers.set('Cookie', [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    const response = await fetch(new URL(path, base), { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
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
  for (const table of ['users', 'activities', 'registrations']) [rows[table]] = await db.query(`SELECT * FROM ${table} ORDER BY id`);
  return JSON.stringify(rows);
}

async function expectedError(response, status, code) {
  assert(response.status === status, `Expected HTTP ${status}, received ${response.status}.`);
  assert((await response.json()).code === code, `Expected ${code} response.`);
}

export async function runRedisSessionChecks() {
  let settings;
  const checks = [];
  const clients = [];
  const runId = randomUUID();
  const ownedFixture = { key: runId, id: null, title: `Redis 会话验证 ${runId}`, description: `gather-redis-session-check:${runId}` };
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
  let removed = { activities: 0, registrations: 0, users: 0 };
  const passed = name => { checks.push(name); console.log(`PASS: ${name}`); };
  const client = () => { const created = new ApiClient(); clients.push(created); return created; };

  try {
    settings = isolatedSettings();
    verifyComposeSettings(settings);
    await waitForStack(settings);
    db = await mysql.createConnection({ ...settings.database, timezone: 'Z', dateStrings: true });
    await waitForDemoSeed(db);
    await verifyDatabase(db, settings.database);
    const [[seedCounts]] = await db.query('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM activities) AS activities');
    assert(Number(seedCounts.users) === 2 && Number(seedCounts.activities) === 3,
      'The fresh isolated CI stack must contain exactly two demo users and three demo activities.');
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

    // Persist the exact account creation/nickname intent before registration; never record its password or Session.
    await mkdir('.runtime/ci', { recursive: true });
    const saveAccountManifest = async () => writeFile(accountManifestPath, `${JSON.stringify({
      runId, database: settings.database.database, account: ownedAccount, fixture: ownedFixture,
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
          const result = await deleteOwnedFixtures(db, [ownedFixture], new Set(), async (activities, accounts) => {
            if (accountAttempted) await writeFile(accountManifestPath, `${JSON.stringify({ runId, database: settings.database.database,
              account: ownedAccount, fixture: ownedFixture, cleanupIntent: {
                activityIds: activities.map(activity => activity.id), userIds: accounts.map(account => account.id),
              } }, null, 2)}\n`);
          }, { accounts: accountAttempted ? [ownedAccount] : [] });
          removed = { activities: result.deletedActivities, registrations: result.deletedRegistrations, users: result.deletedUsers };
          assert(await databaseSnapshot(db) === baseline, 'Exact Redis fixture cleanup did not preserve the database baseline.');
          passed('only the exact UUID fixture and its registrations removed; existing database records preserved');
        }
      } catch (error) { primaryError = primaryError ? new AggregateError([primaryError, error], 'Redis verification and exact fixture cleanup failed.') : error; }
      finally { await db.end(); }
    }
    await mkdir('.runtime/ci', { recursive: true });
    await writeFile(reportPath, `${JSON.stringify({ success: !primaryError, checks, counts: { checksPassed: checks.length,
      activitiesRemoved: removed.activities, registrationsRemoved: removed.registrations, usersRemoved: removed.users } }, null, 2)}\n`);
  }
  if (primaryError) throw primaryError;
  console.log(`Redis session verification completed (${checks.length} checks); report: ${reportPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runRedisSessionChecks();
