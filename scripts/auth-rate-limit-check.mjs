import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { ApiClient } from './redis-session-check.mjs';
import { databaseConfig, verifyDatabase, initializeRun, cleanupRun, trackAccount, recordAccountId } from './e2e-cleanup.mjs';

const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
const windowSeconds = 8;
const rateKeys = ['LOGIN_SOURCE_LIMIT', 'LOGIN_SOURCE_WINDOW_SECONDS', 'LOGIN_PAIR_LIMIT', 'LOGIN_PAIR_WINDOW_SECONDS',
  'REGISTER_SOURCE_LIMIT', 'REGISTER_SOURCE_WINDOW_SECONDS', 'MAX_BUCKETS', 'NAMESPACE', 'TRUSTED_PROXY_IPS']
  .map(key => `AUTH_RATE_LIMIT_${key}`);

export function verifyOwnedRateOperation(namespace, command, key) {
  assert(/^gather:auth-rate-limit-ci-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(namespace),
    'Redis damage testing requires the exact dedicated UUID namespace.');
  const prefix = `${namespace}:{auth-rate-limit}:`;
  assert((command === 'EXISTS' && [`${prefix}counts`, `${prefix}expires`].includes(key))
    || (command === 'DEL' && key === `${prefix}expires`), 'Redis damage testing permits only two existence probes and the exact owned expiry-index deletion.');
}

export function isolatedSettings(environment = process.env) {
  const mode = environment.AUTH_RATE_LIMIT_TEST_MODE ?? 'redis';
  assert(['memory', 'redis'].includes(mode), 'Rate-limit checks require an explicit known memory or Redis mode.');
  const redis = mode === 'redis';
  const project = redis ? 'gather-redis-ci' : 'gather-ci';
  assert(environment.COMPOSE_PROJECT_NAME === project, 'Rate-limit checks require their exact isolated Compose project.');
  const database = databaseConfig(environment);
  assert(database.host === '127.0.0.1' && database.port === 33306 && database.database === 'activity_platform_e2e'
    && database.user === 'activity', 'Rate-limit checks require the exact isolated IPv4 MySQL endpoint and application account.');
  assert((environment.SESSION_COOKIE_SECURE ?? 'false') === 'false', 'The isolated HTTP stack requires non-Secure cookies.');
  assert((environment.SESSION_TIMEOUT ?? '30m') === '30m', 'Rate-limit checks must preserve the normal Session timeout.');
  if (redis) {
    assert(environment.REDIS_PASSWORD, 'Set an explicit password for the isolated Redis service.');
    assert((environment.SESSION_NAMESPACE ?? 'gather:session') === 'gather:session', 'Unexpected isolated Session namespace.');
  }
  const defaults = redis ? ['http://127.0.0.1:19088', 'http://127.0.0.1:19081', 'http://127.0.0.1:19082']
    : ['http://127.0.0.1:18088'];
  const keys = redis ? ['E2E_BASE_URL', 'REDIS_TEST_A_URL', 'REDIS_TEST_B_URL'] : ['E2E_BASE_URL'];
  const urls = defaults.map((expected, index) => {
    let url;
    try { url = new URL(environment[keys[index]] ?? expected); }
    catch { throw new Error('Rate-limit checks require valid exact isolated HTTP loopback URLs.'); }
    assert(url.href === `${expected}/`, 'Rate-limit endpoint differs from its exact isolated origin.');
    return url;
  });
  return { mode, redis, project, database, web: urls[0], endpoints: redis ? urls.slice(1) : urls,
    composeFiles: redis ? ['compose.yaml', 'compose.redis.yaml', '.github/compose.ci.yaml', '.github/compose.redis-ci.yaml']
      : ['compose.yaml', '.github/compose.ci.yaml'] };
}

function docker(argumentsList, timeout = 15000) {
  try { return execFileSync('docker', argumentsList, { encoding: 'utf8', stdio: 'pipe', timeout }); }
  catch { throw new Error('An isolated rate-limit Docker operation failed; subprocess buffers are withheld.'); }
}

function compose(settings, argumentsList) {
  return docker(['compose', '-p', settings.project, ...settings.composeFiles.flatMap(file => ['-f', file]), ...argumentsList], 180000);
}

export function verifyDeclaredSettings(settings, declared, environment = process.env) {
  assert(declared.name === settings.project, 'Resolved Compose project differs from the isolated rate-limit project.');
  const services = settings.redis ? ['backend', 'backend2'] : ['backend'];
  for (const service of services) {
    const actual = declared.services?.[service]?.environment;
    assert(actual?.DB_URL?.startsWith('jdbc:mysql://mysql:3306/activity_platform_e2e?')
      && actual.DB_USERNAME === settings.database.user && actual.DB_PASSWORD === settings.database.password,
    'Rate-limit backend database settings differ from the explicitly configured isolated database.');
    assert(settings.redis ? actual.SPRING_PROFILES_ACTIVE === 'redis' : !actual.SPRING_PROFILES_ACTIVE,
      'Rate-limit backend profile differs from the selected mode.');
    assert((actual.AUTH_RATE_LIMIT_TRUSTED_PROXY_IPS ?? '') === '', 'Strict source checks require forwarded headers to remain untrusted.');
    const values = {
      AUTH_RATE_LIMIT_LOGIN_SOURCE_LIMIT: environment.AUTH_RATE_LIMIT_LOGIN_SOURCE_LIMIT ?? '10000',
      AUTH_RATE_LIMIT_LOGIN_PAIR_LIMIT: environment.AUTH_RATE_LIMIT_LOGIN_PAIR_LIMIT ?? '1000',
      AUTH_RATE_LIMIT_REGISTER_SOURCE_LIMIT: environment.AUTH_RATE_LIMIT_REGISTER_SOURCE_LIMIT ?? '10000',
      AUTH_RATE_LIMIT_LOGIN_SOURCE_WINDOW_SECONDS: environment.AUTH_RATE_LIMIT_LOGIN_SOURCE_WINDOW_SECONDS ?? '60',
      AUTH_RATE_LIMIT_LOGIN_PAIR_WINDOW_SECONDS: environment.AUTH_RATE_LIMIT_LOGIN_PAIR_WINDOW_SECONDS ?? '60',
      AUTH_RATE_LIMIT_REGISTER_SOURCE_WINDOW_SECONDS: environment.AUTH_RATE_LIMIT_REGISTER_SOURCE_WINDOW_SECONDS ?? '600',
      AUTH_RATE_LIMIT_MAX_BUCKETS: environment.AUTH_RATE_LIMIT_MAX_BUCKETS ?? '10000',
      AUTH_RATE_LIMIT_NAMESPACE: environment.AUTH_RATE_LIMIT_NAMESPACE ?? 'gather:auth-rate-limit-ci',
    };
    for (const [key, value] of Object.entries(values)) assert(String(actual[key]) === String(value), `Declared ${service} rate settings differ (${key}).`);
    if (settings.redis) assert(actual.REDIS_HOST === 'redis' && String(actual.REDIS_PORT) === '6379'
      && actual.REDIS_PASSWORD === environment.REDIS_PASSWORD && actual.SESSION_TIMEOUT === '30m'
      && actual.SESSION_NAMESPACE === 'gather:session', 'Redis rate checks must preserve isolated Redis and Session settings.');
  }
  const databaseEnvironment = declared.services?.mysql?.environment;
  assert(databaseEnvironment?.MYSQL_DATABASE === settings.database.database && databaseEnvironment.MYSQL_USER === settings.database.user
    && databaseEnvironment.MYSQL_PASSWORD === settings.database.password, 'Rate-limit MySQL service differs from the verified test database.');
  if (settings.redis) assert(declared.services?.redis?.environment?.REDIS_PASSWORD === environment.REDIS_PASSWORD,
    'Rate-limit Redis service differs from the explicitly configured isolated server.');
}

function verifyRunningStack(settings) {
  let declared;
  try { declared = JSON.parse(compose(settings, ['config', '--format', 'json'])); }
  catch { throw new Error('Could not parse isolated rate-limit Compose settings.'); }
  verifyDeclaredSettings(settings, declared);
  const bindings = { mysql: ['3306/tcp', '33306'], web: ['80/tcp', settings.web.port],
    backend: settings.redis ? ['8080/tcp', settings.endpoints[0].port] : null,
    ...(settings.redis ? { backend2: ['8080/tcp', settings.endpoints[1].port], redis: null } : {}) };
  for (const [service, binding] of Object.entries(bindings)) {
    const ids = docker(['ps', '--filter', `label=com.docker.compose.project=${settings.project}`,
      '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}']).trim().split(/\s+/).filter(Boolean);
    assert(ids.length === 1, 'Exactly one owned running rate-limit container per service is required.');
    const inspected = JSON.parse(docker(['inspect', ids[0]]));
    assert(inspected.length === 1, 'Container inspection must resolve exactly one owned service.');
    const actual = inspected[0];
    assert(actual.State?.Running && actual.Config?.Labels?.['com.docker.compose.project'] === settings.project
      && actual.Config.Labels['com.docker.compose.service'] === service, 'Running rate-limit container ownership changed.');
    const actualEnvironment = Object.fromEntries(actual.Config.Env.map(value => {
      const separator = value.indexOf('=');
      return [value.slice(0, separator), value.slice(separator + 1)];
    }));
    for (const [key, value] of Object.entries(declared.services[service].environment ?? {})) {
      assert(actualEnvironment[key] === String(value), `Running rate-limit service differs from its declaration (${service}, ${key}).`);
    }
    const published = Object.entries(actual.NetworkSettings.Ports ?? {}).filter(([, values]) => values?.length);
    if (!binding) assert(published.length === 0, 'A private rate-limit service unexpectedly exposes a host port.');
    else {
      const [target, port] = binding;
      const values = actual.NetworkSettings.Ports[target];
      assert(published.length === 1 && values?.length === 1 && values[0].HostIp === '127.0.0.1' && values[0].HostPort === port,
        'A running rate-limit port differs from its exact isolated loopback binding.');
      assert(declared.services[service].ports?.some(value => value.host_ip === '127.0.0.1'
        && Number(value.target) === Number(target.split('/')[0]) && String(value.published) === port),
      'A declared rate-limit port differs from its exact isolated loopback binding.');
    }
  }
}

async function healthy(settings) {
  const deadline = Date.now() + 120000;
  for (const endpoint of [settings.web, ...settings.endpoints]) {
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(new URL('/api/health', endpoint), { signal: AbortSignal.timeout(3000) });
        if (response.ok && (await response.json()).status === 'UP') { ready = true; break; }
      } catch { /* Bounded readiness of only the already verified isolated stack. */ }
      await delay(1000);
    }
    assert(ready, 'An isolated rate-limit endpoint did not become healthy within 120 seconds.');
  }
}

async function snapshot(db) {
  const tables = {};
  for (const table of ['users', 'activities', 'registrations', 'notifications']) [tables[table]] = await db.query(`SELECT * FROM ${table} ORDER BY id`);
  return JSON.stringify(tables); // In-memory comparison only; never log database contents.
}

async function error(response, status, code) {
  assert(response.status === status, `Expected HTTP ${status}, received ${response.status}.`);
  const body = await response.json();
  assert(body.code === code, `Expected error code ${code}.`);
  assert(response.headers.get('x-request-id'), 'Every rejected authentication request must retain a server request identifier.');
  if (status === 429) {
    assert(Number.isInteger(body.retryAfterSeconds) && body.retryAfterSeconds >= 1 && body.retryAfterSeconds <= windowSeconds,
      'Retry delay must be a bounded positive integer.');
    assert(response.headers.get('retry-after') === String(body.retryAfterSeconds), 'JSON and Retry-After must agree.');
  }
  return body;
}

export async function verifyConcurrentAdmissions(responses, admitted) {
  assert(responses.filter(response => response.status === 401).length === admitted
    && responses.filter(response => response.status === 429).length === responses.length - admitted,
    'Concurrent pair attempts must admit exactly the configured requests across all actual instances.');
  for (const response of responses) await error(response, response.status,
    response.status === 401 ? 'INVALID_CREDENTIALS' : 'AUTH_RATE_LIMITED');
}

async function attempt(client, endpoint, csrf, username, password = 'Incorrect123!', headers = {}, path = '/api/auth/login') {
  return client.response(endpoint, path, { method: 'POST',
    headers: { [csrf.headerName]: csrf.token, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ username, password }) });
}

async function registration(client, endpoint, csrf, account, path = '/api/auth/register') {
  return client.response(endpoint, path, { method: 'POST',
    headers: { [csrf.headerName]: csrf.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: account.username, displayName: account.displayName, password: 'Demo123!' }) });
}

function browserChecks(settings) {
  return new Promise((resolveBrowser, reject) => {
    const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', 'e2e/auth-rate-limit.spec.ts',
      `--output=.runtime/ci/auth-rate-limit-${settings.mode}-browser-results`], {
      stdio: 'inherit', env: { ...process.env, E2E_BASE_URL: settings.web.origin, AUTH_RATE_LIMIT_E2E: '1',
        AUTH_RATE_LIMIT_TEST_WINDOW_SECONDS: String(windowSeconds),
        PLAYWRIGHT_HTML_OUTPUT_DIR: `.runtime/ci/auth-rate-limit-${settings.mode}-browser-report` },
    });
    child.on('error', () => reject(new Error('Could not start the isolated strict-limit browser checks.')));
    child.on('exit', code => code === 0 ? resolveBrowser() : reject(new Error('The isolated strict-limit browser checks failed.')));
  });
}

export async function runRateLimitChecks() {
  const settings = isolatedSettings();
  const checks = [];
  const passed = name => { checks.push(name); console.log(`PASS: ${name}`); };
  const previousEnvironment = new Map(rateKeys.map(key => [key, process.env[key]]));
  const previousManifest = process.env.E2E_RUN_MANIFEST;
  let db, baseline, manifestPath, primaryError;
  let strictChanged = false;
  const strictNamespace = `gather:auth-rate-limit-ci-${randomUUID()}`;
  const newClient = () => new ApiClient();
  const resetWindow = () => delay((windowSeconds + 1) * 1000);
  const recreate = async () => {
    compose(settings, ['up', '-d', '--no-deps', '--force-recreate', ...(settings.redis ? ['backend', 'backend2'] : ['backend'])]);
    compose(settings, ['restart', 'web']); // Recreated service addresses must be resolved again.
    await healthy(settings);
    verifyRunningStack(settings);
  };
  const restoreEnvironment = () => {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  try {
    verifyRunningStack(settings);
    await healthy(settings);
    db = await mysql.createConnection({ ...settings.database, timezone: 'Z', dateStrings: true });
    await verifyDatabase(db, settings.database);
    baseline = await snapshot(db);
    manifestPath = await initializeRun(settings.web);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert(manifest.fixtures.length === 1, 'Rate-limit identity proof must contain one exact UUID probe.');
    const probe = manifest.fixtures[0];
    for (const endpoint of settings.endpoints) {
      const response = await fetch(new URL(`/api/activities/${probe.id}`, endpoint), { signal: AbortSignal.timeout(10000) });
      const activity = response.ok ? await response.json() : null;
      assert(activity?.id === probe.id && activity.title === probe.title && activity.description === probe.description,
        'A rate-limit API endpoint differs from the UUID SQL proof; authentication writes refused.');
    }
    passed('owned Docker containers, exact ports, profile, MySQL V5 and UUID API/database identity verified before authentication writes');
    Object.assign(process.env, {
      AUTH_RATE_LIMIT_LOGIN_SOURCE_LIMIT: '6', AUTH_RATE_LIMIT_LOGIN_PAIR_LIMIT: '3', AUTH_RATE_LIMIT_REGISTER_SOURCE_LIMIT: '2',
      AUTH_RATE_LIMIT_LOGIN_SOURCE_WINDOW_SECONDS: String(windowSeconds), AUTH_RATE_LIMIT_LOGIN_PAIR_WINDOW_SECONDS: String(windowSeconds),
      AUTH_RATE_LIMIT_REGISTER_SOURCE_WINDOW_SECONDS: String(windowSeconds), AUTH_RATE_LIMIT_MAX_BUCKETS: '10000',
      AUTH_RATE_LIMIT_NAMESPACE: strictNamespace, AUTH_RATE_LIMIT_TRUSTED_PROXY_IPS: '',
    });
    strictChanged = true;
    await recreate();
    passed(`strict ${settings.mode} limits are running; Session settings stay unchanged`);

    const first = settings.endpoints[0];
    const second = settings.endpoints.at(-1);
    const csrfClient = newClient();
    const csrf = await csrfClient.csrf(first);
    for (let index = 0; index < 8; index++) {
      await error(await csrfClient.response(index % 2 ? second : first, '/api/auth/login', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'demo', password: 'Incorrect123!' }) }), 403, 'CSRF_INVALID');
    }
    await error(await attempt(csrfClient, first, csrf, 'demo'), 401, 'INVALID_CREDENTIALS');
    await error(await attempt(csrfClient, second, csrf, ' DEMO '), 401, 'INVALID_CREDENTIALS');
    assert(new URL('/api/auth/%6cogin', first).pathname === '/api/auth/%6cogin', 'Encoded-path proof must remain encoded on the wire.');
    await error(await attempt(csrfClient, first, csrf, 'DeMo', 'Incorrect123!', {}, '/api/auth/%6cogin'), 401, 'INVALID_CREDENTIALS');
    const rejectedLogin = await attempt(csrfClient, second, csrf, 'demo', process.env.DEMO_USER_PASSWORD ?? 'Demo123!', {
      'X-Forwarded-For': '198.51.100.10', Forwarded: 'for=198.51.100.11', 'X-Gather-Client-IP': '198.51.100.12',
    });
    await error(rejectedLogin, 429, 'AUTH_RATE_LIMITED');
    await error(await attempt(csrfClient, first, csrf, 'demo', process.env.DEMO_USER_PASSWORD ?? 'Demo123!', {}, '/api/auth/%6cogin'), 429, 'AUTH_RATE_LIMITED');
    await error(await csrfClient.response(second, '/api/auth/me'), 401, 'UNAUTHENTICATED');
    for (let index = 0; index < 3; index++) await error(await attempt(csrfClient, index % 2 ? second : first, csrf,
      `notconsumed_${randomUUID().replaceAll('-', '').slice(0, 16)}`), 401, 'INVALID_CREDENTIALS');
    await error(await attempt(csrfClient, second, csrf, `blocked_${randomUUID().replaceAll('-', '').slice(0, 16)}`), 429, 'AUTH_RATE_LIMITED');
    passed('invalid CSRF does not consume limits; normalized usernames and encoded login paths share a bucket and forged source headers cannot authenticate a blocked request');
    passed('two pair-quota rejections do not consume source quota: three remaining distinct usernames are admitted and the next is source-limited');

    await resetWindow();
    const parallelClients = Array.from({ length: 8 }, newClient);
    const tokens = await Promise.all(parallelClients.map((client, index) => client.csrf(index % 2 ? second : first)));
    const parallel = await Promise.all(parallelClients.map((client, index) => attempt(client, index % 2 ? second : first,
      tokens[index], 'demo')));
    await verifyConcurrentAdmissions(parallel, 3);
    passed('concurrent login pair admission is atomic and admits exactly three attempts across the selected actual instances');

    await resetWindow();
    const sourceClient = newClient();
    const sourceToken = await sourceClient.csrf(first);
    for (let index = 0; index < 6; index++) await error(await attempt(sourceClient, index % 2 ? second : first,
      sourceToken, `source_${randomUUID().replaceAll('-', '').slice(0, 20)}`), 401, 'INVALID_CREDENTIALS');
    await error(await attempt(sourceClient, second, sourceToken, `other_${randomUUID().slice(0, 16)}`, 'Incorrect123!', {
      'X-Forwarded-For': '198.51.100.20', Forwarded: 'for=198.51.100.21', 'X-Gather-Client-IP': '198.51.100.22',
    }), 429, 'AUTH_RATE_LIMITED');
    passed('changing usernames and forged forwarded headers cannot bypass the six-attempt source limit');

    await resetWindow();
    const recovered = newClient();
    await recovered.login(first, 'demo', process.env.DEMO_USER_PASSWORD ?? 'Demo123!');
    assert((await recovered.json(second, '/api/auth/me')).username === 'demo', 'An admitted login must preserve the selected Session mode.');
    const recoveredToken = await recovered.csrf(second);
    await recovered.write(second, '/api/auth/logout', recoveredToken);
    passed('expired buckets naturally recover and an ordinary valid login remains usable without clearing keys');
    const accent = newClient();
    const accentToken = await accent.csrf(first);
    await error(await attempt(accent, second, accentToken, 'démo', process.env.DEMO_USER_PASSWORD ?? 'Demo123!'), 401, 'INVALID_CREDENTIALS');
    await error(await accent.response(first, '/api/auth/me'), 401, 'UNAUTHENTICATED');
    passed('accent-folding database collation cannot authenticate a different submitted username with the demo password');

    const registerClient = newClient();
    const registerToken = await registerClient.csrf(first);
    for (let index = 0; index < 5; index++) await error(await registerClient.response(index % 2 ? second : first, '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '1invalid', displayName: '无效 CSRF', password: 'Demo123!' }),
    }), 403, 'CSRF_INVALID');
    const accounts = Array.from({ length: 5 }, () => trackAccount());
    const beforeRejected = await snapshot(db);
    assert(new URL('/api/auth/%72egister', first).pathname === '/api/auth/%72egister', 'Encoded registration proof must remain encoded on the wire.');
    const results = await Promise.all(accounts.map((account, index) => registration(registerClient,
      index % 2 ? second : first, registerToken, account, index % 2 ? '/api/auth/%72egister' : '/api/auth/register')));
    assert(results.filter(response => response.status === 201).length === 2 && results.filter(response => response.status === 429).length === 3,
      'Concurrent registration must admit exactly two writes across the selected actual instances.');
    for (let index = 0; index < results.length; index++) {
      const response = results[index];
      if (response.status === 201) {
        const user = await response.json();
        assert(user.username === accounts[index].username && user.role === 'USER', 'Admitted registration must create only its exact ordinary-user fixture.');
        recordAccountId(accounts[index].key, user.id);
        accounts[index].id = user.id;
      } else {
        await error(response, 429, 'AUTH_RATE_LIMITED');
        const [[count]] = await db.execute('SELECT COUNT(*) AS total FROM users WHERE username=?', [accounts[index].username]);
        assert(Number(count.total) === 0, 'A rejected registration unexpectedly created a user.');
      }
    }
    const [[createdCount]] = await db.execute(`SELECT COUNT(*) AS total FROM users WHERE username IN (${accounts.map(() => '?').join(',')})`,
      accounts.map(account => account.username));
    assert(Number(createdCount.total) === 2 && await snapshot(db) !== beforeRejected, 'Exactly the two admitted fixture accounts must exist.');
    await error(await registerClient.response(second, '/api/auth/me'), 401, 'UNAUTHENTICATED');
    passed('invalid CSRF does not consume registration quota; encoded and normal registration paths share atomic quota, create exactly two ordinary users and none for 429, and leave the Session anonymous');

    await resetWindow();
    const retriedAccount = accounts.find(account => account.id === null);
    assert(retriedAccount, 'An exact rejected fixture is required for retry.');
    const retried = await registration(registerClient, second, registerToken, retriedAccount);
    assert(retried.status === 201, 'Registration must recover after the natural window expires.');
    const retriedUser = await retried.json();
    recordAccountId(retriedAccount.key, retriedUser.id);
    passed('registration can be manually retried after TTL with the same owned account intent');

    await browserChecks(settings);
    passed('real strict-limit desktop and mobile countdown, manual retry, input preservation and late-response browser checks passed');
    if (settings.redis) {
      await resetWindow();
      const corrupt = newClient();
      const corruptToken = await corrupt.csrf(first);
      await error(await attempt(corrupt, first, corruptToken, 'demo'), 401, 'INVALID_CREDENTIALS');
      verifyRunningStack(settings);
      const ownNamespace = strictNamespace;
      assert(process.env.AUTH_RATE_LIMIT_NAMESPACE === ownNamespace,
        'The running damage-test namespace must remain the UUID generated by this script.');
      const redisNumber = (command, key) => {
        verifyOwnedRateOperation(ownNamespace, command, key);
        const result = compose(settings, ['exec', '-T', 'redis', 'sh', '-c',
          'export REDISCLI_AUTH="$REDIS_PASSWORD"; exec redis-cli --raw "$@"', 'sh', command, key]).trim();
        assert(/^[01]$/.test(result), 'An owned Redis key operation did not return its expected numeric result.');
        return Number(result);
      };
      const prefix = `${ownNamespace}:{auth-rate-limit}:`;
      assert(redisNumber('EXISTS', `${prefix}counts`) === 1 && redisNumber('EXISTS', `${prefix}expires`) === 1,
        'Both exact owned active rate keys must exist before the controlled damage experiment.');
      const beforeUnavailable = await snapshot(db);
      assert(redisNumber('DEL', `${prefix}expires`) === 1, 'The exact owned expiry-index key was not removed once.');
      // This window contains only login buckets. A new registration bucket has
      // no matching field in either key, so a local per-digest check alone would
      // incorrectly admit it. The global cardinality guard must reject first.
      await error(await corrupt.response(second, '/api/auth/register', { method: 'POST',
        headers: { [corruptToken.headerName]: corruptToken.token, 'Content-Type': 'application/json' }, body: '{}' }),
      503, 'AUTH_RATE_LIMIT_UNAVAILABLE');
      await error(await attempt(corrupt, second, corruptToken, `fresh_${randomUUID().slice(0, 16)}`), 503, 'AUTH_RATE_LIMIT_UNAVAILABLE');
      await error(await corrupt.response(first, '/api/auth/me'), 401, 'UNAUTHENTICATED');
      assert(await snapshot(db) === beforeUnavailable, 'Unavailable rate storage must not modify application data.');
      passed('removing only this UUID expiry index rejects an entirely new registration bucket and a new login with 503, preserving authentication and MySQL');
      await resetWindow();
      await error(await attempt(corrupt, second, corruptToken, 'demo'), 401, 'INVALID_CREDENTIALS');
      passed('the surviving owned count key expires naturally and valid attempts recover without deleting Session or other Redis keys');
    }
  } catch (caught) { primaryError = caught; }
  finally {
    restoreEnvironment();
    if (strictChanged) {
      try { await recreate(); passed('normal authentication limits restored and verified on the owned stack; Session timeout remains unchanged'); }
      catch (caught) { primaryError = primaryError ? new AggregateError([primaryError, caught], 'Rate-limit checks and ordinary-limit restoration failed.') : caught; }
    }
    try { if (manifestPath) await cleanupRun(manifestPath); }
    catch (caught) { primaryError = primaryError ? new AggregateError([primaryError, caught], 'Rate-limit checks and exact owned fixture cleanup failed.') : caught; }
    if (db) {
      try { if (baseline !== undefined) { assert(await snapshot(db) === baseline, 'Rate-limit cleanup did not preserve the exact database baseline.'); passed('exact owned accounts and UUID probe removed; all pre-existing database records preserved'); } }
      catch (caught) { primaryError = primaryError ? new AggregateError([primaryError, caught], 'Rate-limit checks and baseline verification failed.') : caught; }
      finally { await db.end(); }
    }
    if (previousManifest === undefined) delete process.env.E2E_RUN_MANIFEST;
    else process.env.E2E_RUN_MANIFEST = previousManifest;
    await mkdir('.runtime/ci', { recursive: true });
    await writeFile(`.runtime/ci/auth-rate-limit-${settings.mode}.json`, `${JSON.stringify({ success: !primaryError, mode: settings.mode,
      windowSeconds, loginPairLimit: 3, loginSourceLimit: 6, registerSourceLimit: 2, checks }, null, 2)}\n`);
  }
  if (primaryError) throw primaryError;
  console.log(`Authentication rate-limit verification completed (${checks.length} checks, ${settings.mode}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runRateLimitChecks();
