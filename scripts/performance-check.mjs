import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { cpus, hostname, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const RUN_PROJECT = 'gather-perf-ci';
const RUN_DATABASE = 'activity_platform_perf';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUESTS = 100;
const REPEATS = 3;
const CONCURRENCIES = [1, 10, 50];
const OUTPUT = resolve('.runtime/ci');
const PHASES = ['A1', 'B1', 'B2', 'A2'];
export const MEASUREMENT_CONTRACT = 'gather-signup-v2-write-warmup';
const WARMUP_CONCURRENCIES = [1, 50];
export const LOCK_QUERY_SQL = {
  baseline: "SELECT id, title, description, location, starts_at, capacity, registered_count, (SELECT COUNT(*) FROM registrations rw WHERE rw.activity_id=activities.id AND rw.status='WAITING') AS waiting_count, NULL AS registration_status FROM activities WHERE id=? FOR UPDATE",
  candidate: 'SELECT starts_at, capacity, registered_count FROM activities WHERE id=? FOR UPDATE',
};
const pause = ms => new Promise(done => setTimeout(done, ms));

export function performanceOutput(phase) {
  assert(phase === undefined || PHASES.includes(phase), 'Comparison output phase must be one of A1/B1/B2/A2.');
  return phase === undefined ? OUTPUT : resolve(OUTPUT, 'comparison', phase);
}

export function performanceSettings(env = process.env) {
  assert.equal(env.COMPOSE_PROJECT_NAME, RUN_PROJECT, 'Performance writes require the isolated gather-perf-ci project.');
  assert.equal(env.PERF_DB_HOST, '127.0.0.1', 'Performance database must use explicit IPv4 loopback.');
  assert.equal(env.PERF_DB_PORT, '33306', 'Performance database must use the isolated published port.');
  assert.equal(env.PERF_DB_NAME, RUN_DATABASE, 'Performance database must be activity_platform_perf.');
  assert.equal(env.PERF_DB_USERNAME, 'activity', 'Performance database must use the isolated application account.');
  assert(env.PERF_DB_PASSWORD, 'Set PERF_DB_PASSWORD explicitly.');
  const base = new URL(env.PERF_BASE_URL ?? 'http://127.0.0.1:18098');
  assert.equal(base.href, 'http://127.0.0.1:18098/', 'Performance API must target the isolated HTTP loopback origin without credentials or path.');
  assert.equal(env.PERF_CPU_LIMIT ?? '2', '2', 'The fixed baseline requires a 2 CPU backend limit.');
  assert.equal(env.PERF_MEMORY_LIMIT ?? '1024m', '1024m', 'The fixed baseline requires a 1024 MiB backend limit.');
  const appSha = env.PERF_APP_SHA ?? env.GITHUB_SHA;
  assert(/^[0-9a-f]{40}$/.test(appSha ?? ''), 'Set PERF_APP_SHA to the exact 40-character measured application commit.');
  const phase = env.PERF_COMPARISON_PHASE;
  const output = performanceOutput(phase);
  if (phase !== undefined) assert(/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? ''), 'Comparison requires the exact harness GITHUB_SHA.');
  return {
    base, appSha, phase, output,
    database: { host: env.PERF_DB_HOST, port: 33306, database: RUN_DATABASE, user: env.PERF_DB_USERNAME,
      password: env.PERF_DB_PASSWORD, connectTimeout: 10000, timezone: 'Z', dateStrings: true, multipleStatements: false },
  };
}

// Nearest rank: sort n samples ascending; percentile p is sample ceil(p*n)-1.
// Each sample covers fetch start through reading and parsing the complete JSON body.
export function latencyStatistics(samples) {
  assert(samples.length > 0 && samples.every(value => Number.isFinite(value) && value >= 0), 'Latency samples must be finite nonnegative values.');
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = p => sorted[Math.ceil(p * sorted.length) - 1];
  return { count: sorted.length, min: sorted[0], avg: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: rank(0.5), p95: rank(0.95), p99: rank(0.99), max: sorted.at(-1) };
}

export function summarizeRequests(results, wallMs) {
  assert(Number.isFinite(wallMs) && wallMs > 0, 'Batch wall time must be positive.');
  const statuses = {};
  const stateCounts = {};
  let business4xx = 0;
  let system5xx = 0;
  let networkFailures = 0;
  let otherHttpFailures = 0;
  for (const result of results) {
    if (result.networkFailure) networkFailures++;
    else {
      statuses[result.status] = (statuses[result.status] ?? 0) + 1;
      if (result.status >= 400 && result.status < 500) business4xx++;
      else if (result.status >= 500) system5xx++;
      else if (result.status !== 200) otherHttpFailures++;
      if (result.registrationStatus) stateCounts[result.registrationStatus] = (stateCounts[result.registrationStatus] ?? 0) + 1;
    }
  }
  return { requests: results.length, wallMs, throughputPerSecond: results.length / (wallMs / 1000),
    latencyMs: latencyStatistics(results.map(result => result.durationMs)), statuses, stateCounts,
    business4xx, system5xx, networkFailures, otherHttpFailures,
    systemErrorRate: (system5xx + networkFailures) / results.length,
    businessRejectionRate: business4xx / results.length };
}

function dockerRead(args) {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe', timeout: 10000 }); }
  catch { throw new Error('Read-only isolated Docker identity inspection failed.'); }
}

function inspectService(service) {
  const ids = dockerRead(['ps', '--filter', `label=com.docker.compose.project=${RUN_PROJECT}`,
    '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}']).trim().split(/\s+/).filter(Boolean);
  assert.equal(ids.length, 1, `Exactly one running isolated ${service} container is required.`);
  const containers = JSON.parse(dockerRead(['inspect', ids[0]]));
  assert.equal(containers.length, 1, 'Container inspection must identify exactly one container.');
  const container = containers[0];
  assert.equal(container.Config.Labels['com.docker.compose.project'], RUN_PROJECT, 'Container project changed.');
  assert.equal(container.Config.Labels['com.docker.compose.service'], service, 'Container service changed.');
  assert.equal(container.State.Running, true, 'Isolated container must be running.');
  return container;
}

function containerEnvironment(container) {
  return Object.fromEntries(container.Config.Env.map(item => {
    const separator = item.indexOf('=');
    return [item.slice(0, separator), item.slice(separator + 1)];
  }));
}

function verifyContainerTargets(settings) {
  const backend = inspectService('backend');
  const database = inspectService('mysql');
  const web = inspectService('web');
  const backendEnv = containerEnvironment(backend);
  const dbEnv = containerEnvironment(database);
  assert(backendEnv.DB_URL?.startsWith(`jdbc:mysql://mysql:3306/${RUN_DATABASE}?`), 'Backend container does not target the isolated performance database.');
  assert(backendEnv.DB_USERNAME === settings.database.user && backendEnv.DB_PASSWORD === settings.database.password,
    'Backend and performance checker database credentials differ.');
  assert(dbEnv.MYSQL_DATABASE === RUN_DATABASE && dbEnv.MYSQL_USER === settings.database.user
    && dbEnv.MYSQL_PASSWORD === settings.database.password, 'MySQL container identity differs from the checker.');
  assert(!backendEnv.SPRING_PROFILES_ACTIVE, 'Baseline measurement requires default memory Session mode.');
  for (const [container, target, port] of [[database, '3306/tcp', '33306'], [web, '80/tcp', '18098']]) {
    const bindings = container.NetworkSettings.Ports[target];
    assert(bindings?.length === 1 && bindings[0].HostIp === '127.0.0.1' && bindings[0].HostPort === port,
      'Isolated port binding is not the expected exact loopback endpoint.');
  }
  for (const container of [backend, database]) {
    assert.equal(Number(container.HostConfig.NanoCpus), 2_000_000_000, 'Backend and MySQL must have actual 2 CPU cgroup limits.');
    assert.equal(Number(container.HostConfig.Memory), 1024 * 1024 * 1024, 'Backend and MySQL must have actual 1024 MiB memory cgroup limits.');
  }
  const applicationArtifact = verifyApplicationArtifact(backend, settings);
  const metadata = container => ({ image: container.Config.Image,
    imageId: container.Image,
    cpuLimit: Number(container.HostConfig.NanoCpus) / 1_000_000_000,
    memoryLimitBytes: Number(container.HostConfig.Memory) });
  return { backend: { ...metadata(backend), ...applicationArtifact }, mysql: metadata(database), web: metadata(web) };
}

export function verifyApplicationArtifact(backend, settings, { readDocker = dockerRead } = {}) {
  assert(/^sha256:[0-9a-f]{64}$/.test(backend.Image ?? ''), 'Backend must have a concrete Docker image digest.');
  const images = JSON.parse(readDocker(['image', 'inspect', backend.Image]));
  assert(images.length === 1 && images[0].Id === backend.Image, 'Running backend image identity differs from image inspection.');
  const revision = images[0].Config.Labels?.['org.opencontainers.image.revision'] ?? null;
  if (settings.phase !== undefined) {
    assert.equal(revision, settings.appSha, 'Running application image revision must equal the measured source commit.');
  } else if (revision !== null) {
    assert.equal(revision, settings.appSha, 'Labeled baseline image revision differs from the measured source commit.');
  }
  const jar = readDocker(['exec', backend.Id, 'sha256sum', '/app/app.jar']).trim();
  assert(/^[0-9a-f]{64}\s+\/app\/app\.jar$/.test(jar), 'Running production JAR SHA-256 could not be verified.');
  const java = readDocker(['exec', backend.Id, 'java', '--version']).split(/\r?\n/)[0];
  assert(/^openjdk 21(?:\.|\s)/.test(java), 'Measured runtime must be actual Java 21.');
  return { sourceRevision: revision, jarSha256: jar.split(/\s+/)[0], javaRuntime: java };
}

export async function waitForApiReady(base, { fetchRequest = fetch, now = Date.now, wait = pause } = {}) {
  const deadline = now() + 120000;
  while (now() < deadline) {
    try {
      const response = await fetchRequest(new URL('/api/health', base), {
        signal: AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - now()))), redirect: 'manual',
      });
      if (response.status === 200 && (await response.json()).status === 'UP') return;
    } catch { /* Known isolated startup only: never print health bodies or connection details. */ }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await wait(Math.min(1000, remaining));
  }
  assert.fail('The isolated performance API did not report UP within 120 seconds; no database table queries or fixture writes were attempted.');
}

class ApiClient {
  cookies = new Map();
  token;

  constructor(base) { this.base = base; }

  async request(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set('Accept', 'application/json');
    if (this.cookies.size) headers.set('Cookie', [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    const response = await fetch(new URL(path, this.base), { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(60000) });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0];
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const content = pair.slice(separator + 1);
      if (content) this.cookies.set(name, content);
      else this.cookies.delete(name);
    }
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; }
    catch { throw new Error('An isolated API response was not valid JSON.'); }
    return { status: response.status, data };
  }

  async json(path, options = {}) {
    const result = await this.request(path, options);
    assert(result.status === 200 || result.status === 201, `Isolated API ${options.method ?? 'GET'} request failed with HTTP ${result.status}.`);
    return result.data;
  }

  async csrf() {
    this.token = await this.json('/api/auth/csrf');
    assert(typeof this.token.token === 'string' && this.token.token.length > 0 && typeof this.token.headerName === 'string', 'CSRF response is incomplete.');
  }

  async login(username, password) {
    await this.csrf();
    const identity = await this.json('/api/auth/login', {
      method: 'POST', headers: { [this.token.headerName]: this.token.token, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }),
    });
    assert.equal(identity.username, username, 'Login identity differs from the prepared user.');
    await this.csrf();
    return identity;
  }

  async write(path, data) {
    return this.json(path, { method: 'POST', headers: { [this.token.headerName]: this.token.token, 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data) });
  }

  async signup(id) {
    const started = performance.now();
    try {
      const result = await this.request(`/api/activities/${id}/registration`, {
        method: 'POST', headers: { [this.token.headerName]: this.token.token },
      });
      return { status: result.status, registrationStatus: result.data?.registrationStatus,
        durationMs: performance.now() - started };
    } catch {
      return { networkFailure: true, durationMs: performance.now() - started };
    }
  }

  async logout() {
    if (!this.cookies.has('JSESSIONID')) return;
    const identity = await this.request('/api/auth/me');
    if (identity.status === 401) { this.cookies.clear(); return; }
    assert.equal(identity.status, 200, 'Owned session identity could not be verified for logout.');
    await this.csrf();
    await this.write('/api/auth/logout');
    this.cookies.clear();
    this.token = undefined;
  }
}

async function parallelMap(items, concurrency, work) {
  let next = 0;
  let failed = false;
  const results = new Array(items.length);
  const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && !failed) {
      const index = next++;
      try { results[index] = await work(items[index], index); }
      catch (error) { failed = true; throw error; }
    }
  }));
  const failures = workers.filter(worker => worker.status === 'rejected').map(worker => worker.reason);
  // All in-flight setup/logouts must settle before fixture cleanup can start.
  if (failures.length) throw new AggregateError(failures, 'A bounded performance operation failed.');
  return results;
}

async function snapshotDatabase(db) {
  const tables = {};
  for (const table of ['users', 'activities', 'registrations']) [tables[table]] = await db.query(`SELECT * FROM ${table} ORDER BY id`);
  // Kept only in memory: user password hashes must never enter an artifact.
  return JSON.stringify(tables);
}

async function verifyDatabase(db, settings) {
  const [[identity]] = await db.query('SELECT DATABASE() AS name, @@server_uuid AS serverUuid, VERSION() AS version');
  assert(identity.name === RUN_DATABASE && /^8\.4\./.test(identity.version) && identity.serverUuid, 'Expected isolated MySQL 8.4 database identity is missing.');
  const [migrations] = await db.query('SELECT version, success FROM flyway_schema_history ORDER BY installed_rank');
  const requiredMigrations = settings.phase === undefined ? ['1', '2', '3'] : ['1', '2'];
  assert(requiredMigrations.every(version => migrations.some(row => row.version === version && row.success === 1)), 'Required Gather Flyway migrations must be applied.');
  if (settings.phase === undefined) {
    await db.query('SELECT cancelled_at, cancellation_reason, cancelled_by FROM activities LIMIT 0');
  }
  assert(migrations.every(row => row.success === 1), 'Failed Flyway migrations are not allowed.');
  const seedDeadline = Date.now() + 30000;
  let seeded = false;
  // Health can answer before ApplicationRunner commits its seed transaction.
  while (Date.now() < seedDeadline) {
    const [[counts]] = await db.query('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM activities) AS activities, (SELECT COUNT(*) FROM registrations) AS registrations');
    assert(Number(counts.users) <= 2 && Number(counts.activities) <= 3 && Number(counts.registrations) === 0,
      'Measurement requires a fresh isolated database; existing non-seed data was found.');
    if (Number(counts.users) === 2 && Number(counts.activities) === 3) { seeded = true; break; }
    await pause(250);
  }
  assert(seeded, 'Exactly two seed users and three seed activities must commit within 30 seconds.');
  const [accounts] = await db.query('SELECT id, username, role, password_hash FROM users ORDER BY id');
  const admin = accounts.find(user => user.username === 'admin' && user.role === 'ADMIN');
  const demo = accounts.find(user => user.username === 'demo' && user.role === 'USER');
  assert(admin && demo && /^\$2[aby]\$\d\d\$/.test(demo.password_hash), 'Exact seed role and BCrypt identities are required.');
  const client = new ApiClient(settings.base);
  const api = await client.json('/api/activities');
  const [activities] = await db.query('SELECT id, title, description, location, capacity, registered_count, starts_at FROM activities ORDER BY id');
  assert(Array.isArray(api) && api.length === activities.length, 'Public API seed data does not match the isolated database.');
  for (const row of activities) {
    const view = api.find(item => item.id === row.id);
    assert(view && view.title === row.title && view.description === row.description && view.location === row.location
      && view.capacity === row.capacity && view.registeredCount === row.registered_count
      && new Date(view.startsAt).getTime() === new Date(`${row.starts_at.replace(' ', 'T')}Z`).getTime(),
    'Public API is not backed by the verified isolated seed database.');
  }
  await client.logout();
  return { identity, admin, demo };
}

function saveManifest(manifest) {
  const output = performanceOutput(manifest.phase);
  mkdirSync(output, { recursive: true });
  const path = resolve(output, `performance-${manifest.runId}.manifest.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

async function verifyUniqueApiDatabase(db, settings, manifest) {
  const key = randomUUID();
  const intent = { key, id: null, title: `Perf ${key}`, description: `gather-performance:${manifest.runId}:${key}` };
  manifest.activities.push(intent);
  saveManifest(manifest);
  const [inserted] = await db.execute('INSERT INTO activities (title, description, location, starts_at, capacity, registered_count, created_by) VALUES (?, ?, ?, UTC_TIMESTAMP(6) + INTERVAL 48 HOUR, 1, 0, ?)',
    [intent.title, intent.description, 'Isolated API database identity proof', manifest.adminId]);
  intent.id = inserted.insertId;
  saveManifest(manifest);
  const probe = await new ApiClient(settings.base).json(`/api/activities/${intent.id}`);
  assert(probe.id === intent.id && probe.title === intent.title && probe.description === intent.description,
    'Unique UUID API probe differs from the isolated SQL fixture; application writes refused.');
}

export function verifyOwnershipManifest(manifest) {
  performanceOutput(manifest.phase);
  assert(manifest.version === 1 && UUID.test(manifest.runId), 'Invalid performance ownership manifest.');
  assert(manifest.database === RUN_DATABASE && manifest.project === RUN_PROJECT, 'Performance ownership target changed.');
  assert(Number.isSafeInteger(manifest.adminId) && manifest.adminId > 0, 'Performance creator proof is missing.');
  assert(Array.isArray(manifest.users) && Array.isArray(manifest.activities), 'Performance ownership lists are missing.');
  const compact = manifest.runId.replaceAll('-', '');
  const userNames = new Set();
  const activityKeys = new Set();
  for (const user of manifest.users) {
    assert(/^\d{3}$/.test(user.index) && user.username === `perf_${compact}_${user.index}`
      && user.displayName === `gather-performance:${manifest.runId}` && user.role === 'USER'
      && (user.id === null || (Number.isSafeInteger(user.id) && user.id > 0)), 'Invalid synthetic user ownership proof.');
    assert(!userNames.has(user.username), 'Duplicate synthetic user proof.');
    userNames.add(user.username);
  }
  for (const activity of manifest.activities) {
    assert(UUID.test(activity.key) && !activityKeys.has(activity.key)
      && activity.title === `Perf ${activity.key}`
      && activity.description === `gather-performance:${manifest.runId}:${activity.key}`
      && (activity.id === null || (Number.isSafeInteger(activity.id) && activity.id > 0)), 'Invalid activity ownership proof.');
    activityKeys.add(activity.key);
  }
  if (manifest.cleanupIntent) {
    for (const [key, proofs] of [['activityIds', manifest.activities], ['userIds', manifest.users]]) {
      const ids = manifest.cleanupIntent[key];
      assert(Array.isArray(ids) && new Set(ids).size === ids.length && ids.every(id => Number.isSafeInteger(id)
        && id > 0 && proofs.some(proof => proof.id === id)), 'Invalid persisted exact cleanup intent.');
    }
  }
}

export async function cleanupOwned(db, manifest, { activityIds, deleteUsers = true, persistManifest = () => {} } = {}) {
  verifyOwnershipManifest(manifest);
  assert.equal(typeof deleteUsers, 'boolean', 'Cleanup user deletion mode must be explicit boolean.');
  if (activityIds !== undefined) {
    assert(Array.isArray(activityIds) && new Set(activityIds).size === activityIds.length
      && activityIds.every(id => manifest.activities.some(proof => proof.id === id)), 'Round cleanup includes an unowned activity ID.');
  }
  const allowedMissingActivities = new Set(manifest.cleanupIntent?.activityIds ?? []);
  const allowedMissingUsers = new Set(manifest.cleanupIntent?.userIds ?? []);
  const [[identity]] = await db.query('SELECT DATABASE() AS name, @@server_uuid AS serverUuid');
  assert(identity.name === RUN_DATABASE && identity.serverUuid === manifest.serverUuid, 'Cleanup database identity changed.');
  await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  await db.beginTransaction();
  try {
    const activities = [];
    const users = [];
    for (const proof of manifest.activities) {
      const [rows] = await db.execute(proof.id === null
        ? 'SELECT id, title, description, created_by FROM activities WHERE CAST(title AS BINARY) = CAST(? AS BINARY) AND CAST(description AS BINARY) = CAST(? AS BINARY) FOR UPDATE'
        : 'SELECT id, title, description, created_by FROM activities WHERE id = ? FOR UPDATE',
      proof.id === null ? [proof.title, proof.description] : [proof.id]);
      assert(rows.length <= 1, 'One activity intent resolved multiple rows. Cleanup refused.');
      if (rows.length === 0) {
        assert(proof.id === null || allowedMissingActivities.has(proof.id), 'An owned activity ID disappeared without a verified cleanup intent. Cleanup refused.');
        continue;
      }
      const row = rows[0];
      assert(row.title === proof.title && row.description === proof.description && row.created_by === manifest.adminId,
        'Activity ownership changed. Cleanup refused.');
      proof.id = row.id;
      activities.push({ ...proof, id: row.id });
    }
    for (const proof of manifest.users) {
      const [rows] = await db.execute('SELECT id, username, display_name, role FROM users WHERE CAST(username AS BINARY) = CAST(? AS BINARY) FOR UPDATE', [proof.username]);
      assert(rows.length <= 1, 'One user intent resolved multiple rows. Cleanup refused.');
      if (rows.length === 0) {
        assert(proof.id === null || allowedMissingUsers.has(proof.id), 'An owned user ID disappeared without a verified cleanup intent. Cleanup refused.');
        continue;
      }
      const row = rows[0];
      assert((proof.id === null || row.id === proof.id) && row.username === proof.username
        && row.display_name === proof.displayName && row.role === 'USER', 'Synthetic user ownership changed. Cleanup refused.');
      proof.id = row.id;
      users.push({ ...proof, id: row.id });
    }
    assert.equal(new Set(activities.map(row => row.id)).size, activities.length, 'Duplicate cleanup activity IDs.');
    assert.equal(new Set(users.map(row => row.id)).size, users.length, 'Duplicate cleanup user IDs.');
    const userIds = new Set(users.map(row => row.id));
    const ownedActivityIds = new Set(activities.map(row => row.id));
    // Validate every reference and ownership proof BEFORE the first DELETE.
    for (const row of activities) {
      const [children] = await db.execute('SELECT user_id FROM registrations WHERE activity_id = ? FOR UPDATE', [row.id]);
      assert(children.every(child => userIds.has(child.user_id)), 'An unowned user references a performance activity. Cleanup refused.');
    }
    for (const row of users) {
      const [references] = await db.execute('SELECT activity_id FROM registrations WHERE user_id = ? FOR UPDATE', [row.id]);
      assert(references.every(reference => ownedActivityIds.has(reference.activity_id)), 'A synthetic user references an unowned activity. Cleanup refused.');
      const [created] = await db.execute('SELECT id FROM activities WHERE created_by = ? FOR UPDATE', [row.id]);
      assert.equal(created.length, 0, 'A synthetic user unexpectedly owns activities. Cleanup refused.');
    }
    const selectedActivities = activities.filter(row => activityIds === undefined || activityIds.includes(row.id));
    // Persist ALL verified targets before deleting. Lost commit replies can safely
    // retry missing rows only with this exact prior ownership proof.
    manifest.cleanupIntent = {
      activityIds: [...new Set([...allowedMissingActivities, ...selectedActivities.map(row => row.id)])],
      userIds: [...new Set([...allowedMissingUsers, ...(deleteUsers ? users.map(row => row.id) : [])])],
    };
    await persistManifest(manifest);
    let registrationsRemoved = 0;
    for (const row of selectedActivities) {
      const [children] = await db.execute('DELETE FROM registrations WHERE activity_id = ?', [row.id]);
      registrationsRemoved += children.affectedRows;
      const [deleted] = await db.execute('DELETE FROM activities WHERE id = ? AND CAST(title AS BINARY) = CAST(? AS BINARY) AND CAST(description AS BINARY) = CAST(? AS BINARY) AND created_by = ?',
        [row.id, row.title, row.description, manifest.adminId]);
      assert.equal(deleted.affectedRows, 1, 'Owned activity was not deleted exactly once.');
    }
    for (const row of deleteUsers ? users : []) {
      const [deleted] = await db.execute("DELETE FROM users WHERE id = ? AND CAST(username AS BINARY) = CAST(? AS BINARY) AND CAST(display_name AS BINARY) = CAST(? AS BINARY) AND role = 'USER'",
        [row.id, row.username, row.displayName]);
      assert.equal(deleted.affectedRows, 1, 'Owned synthetic user was not deleted exactly once.');
    }
    await db.commit();
    return { activitiesRemoved: selectedActivities.length, usersRemoved: deleteUsers ? users.length : 0, registrationsRemoved };
  } catch (error) { await db.rollback(); throw error; }
}

async function prepareUsers(db, settings, seed, manifest, clients) {
  const compact = manifest.runId.replaceAll('-', '');
  manifest.users = Array.from({ length: REQUESTS }, (_, index) => ({ id: null, index: String(index).padStart(3, '0'),
    username: `perf_${compact}_${String(index).padStart(3, '0')}`, displayName: `gather-performance:${manifest.runId}`, role: 'USER' }));
  saveManifest(manifest);
  const values = manifest.users.flatMap(user => [user.username, seed.demo.password_hash, user.displayName, user.role]);
  await db.execute(`INSERT INTO users (username, password_hash, display_name, role) VALUES ${manifest.users.map(() => '(?, ?, ?, ?)').join(', ')}`, values);
  // Release the copied BCrypt secret as soon as fixture INSERT finishes.
  seed.demo.password_hash = undefined;
  values.fill(undefined);
  const [rows] = await db.execute('SELECT id, username FROM users WHERE CAST(display_name AS BINARY) = CAST(? AS BINARY)', [`gather-performance:${manifest.runId}`]);
  assert.equal(rows.length, REQUESTS, 'Synthetic user insertion count differs from the exact intended set.');
  for (const user of manifest.users) {
    user.id = rows.find(row => row.username === user.username)?.id;
    assert(Number.isSafeInteger(user.id) && user.id > 0, 'Synthetic user identity could not be resolved.');
  }
  saveManifest(manifest);
  // Login BCrypt CPU is deliberately outside timing, with no more than 5 preparations in flight.
  return parallelMap(manifest.users, 5, async user => {
    const client = new ApiClient(settings.base);
    clients.push(client);
    const identity = await client.login(user.username, 'Demo123!');
    assert(identity.id === user.id && identity.role === 'USER', 'Unique synthetic API identity does not match the verified MySQL fixture.');
    return client;
  });
}

async function createActivities(admin, manifest, count, startsAt, capacity) {
  const intents = Array.from({ length: count }, () => {
    const key = randomUUID();
    return { key, id: null, title: `Perf ${key}`, description: `gather-performance:${manifest.runId}:${key}` };
  });
  manifest.activities.push(...intents);
  // Persist ALL exact creation intents before HTTP. A lost response can be recovered by exact UUID equality.
  saveManifest(manifest);
  return parallelMap(intents, 5, async intent => {
    const activity = await admin.write('/api/admin/activities', { title: intent.title, description: intent.description,
      location: 'Isolated performance check', startsAt, capacity });
    assert(Number.isSafeInteger(activity.id) && activity.id > 0 && activity.title === intent.title
      && activity.description === intent.description, 'Created activity does not match its pre-recorded ownership intent.');
    intent.id = activity.id;
    saveManifest(manifest);
    return intent;
  });
}

// The monitoring wire adapter is kept small and explicit; contract checked before any measured write.
export function monitoringView(data) {
  const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const duration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  assert(data && Array.isArray(data.routes) && data.registrationLock && data.databasePool, 'Monitoring API contract is incomplete.');
  assert(data.scope === 'CURRENT_JVM' && data.instanceId === 'gather-perf', 'Performance monitoring requires the fixed gather-perf JVM instance.');
  assert([data.totalRequests, data.clientErrors, data.serverErrors].every(count)
    && duration(data.averageDurationMs) && duration(data.serverErrorRate) && data.serverErrorRate <= 1,
  'Monitoring totals, average and error rate must be nonnegative finite numeric values.');
  assert(data.routes.every(row => row && typeof row.method === 'string' && typeof row.route === 'string'
    && count(row.status) && row.status >= 100 && row.status <= 599 && count(row.count) && duration(row.averageDurationMs)),
  'Monitoring route status/count/average values are malformed.');
  assert(count(data.registrationLock.count) && duration(data.registrationLock.averageDurationMs),
    'Monitoring lock count/average must be nonnegative finite numeric values.');
  assert([data.databasePool.active, data.databasePool.idle, data.databasePool.pending, data.databasePool.max].every(count)
    && data.databasePool.max > 0, 'Monitoring pool fields must be concrete nonnegative integers with a positive maximum.');
  const routes = data.routes.filter(row => row.method === 'POST' && row.route === '/api/activities/{id}/registration');
  const signupCount = routes.reduce((sum, route) => sum + route.count, 0);
  const lockTotalMs = data.registrationLock.averageDurationMs * data.registrationLock.count;
  assert(count(signupCount) && duration(lockTotalMs), 'Monitoring aggregate count or duration overflowed.');
  return { signupCount,
    lockCount: data.registrationLock.count, lockTotalMs,
    active: data.databasePool.active, pending: data.databasePool.pending, max: data.databasePool.max,
    javaVersion: data.javaVersion ?? null };
}

async function measureRound(admin, db, clients, activities, scenario, concurrency, repeat, recordRound) {
  const before = monitoringView(await admin.json('/api/admin/monitoring'));
  assert([before.signupCount, before.lockCount, before.lockTotalMs, before.active, before.pending, before.max].every(Number.isFinite), 'Monitoring values must be finite.');
  let peakActive = before.active;
  let peakPending = before.pending;
  let poolSamples = 1;
  let samplingFailure;
  let inFlight;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = admin.json('/api/admin/monitoring').then(data => {
      const sample = monitoringView(data);
      peakActive = Math.max(peakActive, sample.active);
      peakPending = Math.max(peakPending, sample.pending);
      poolSamples++;
    }).catch(() => { samplingFailure = new Error('Monitoring pool sampling failed.'); }).finally(() => { inFlight = undefined; });
  }, 200);
  let results;
  let wallMs;
  try {
    const started = performance.now();
    results = await parallelMap(clients, concurrency, (client, index) => client.signup(activities[scenario === 'same-activity' ? 0 : index].id));
    wallMs = performance.now() - started;
  } finally {
    clearInterval(timer);
    await inFlight;
  }
  if (samplingFailure) throw samplingFailure;
  const after = monitoringView(await admin.json('/api/admin/monitoring'));
  const summary = summarizeRequests(results, wallMs);
  const locks = after.lockCount - before.lockCount;
  const routeRequests = after.signupCount - before.signupCount;
  const stats = { scenario, concurrency, repeat, ...summary, latencySamplesMs: results.map(row => row.durationMs), server: { signupRequests: routeRequests,
    lockQueryCount: locks, lockQueryAverageMs: locks ? (after.lockTotalMs - before.lockTotalMs) / locks : 0,
    poolMax: after.max, sampledPoolPeakActive: Math.max(peakActive, after.active),
    sampledPoolPeakPending: Math.max(peakPending, after.pending), poolSamples, poolSampleIntervalMs: 200 } };
  stats.server.poolSamples++;
  recordRound(stats);
  assert(summary.requests === REQUESTS && summary.statuses[200] === REQUESTS && summary.business4xx === 0
    && summary.system5xx === 0 && summary.networkFailures === 0 && summary.otherHttpFailures === 0,
  'Measured signup batch must complete all 100 requests with HTTP 200; business and system failures remain separate.');
  const expectedActive = scenario === 'same-activity' ? 10 : 100;
  const expectedWaiting = REQUESTS - expectedActive;
  assert((summary.stateCounts.ACTIVE ?? 0) === expectedActive && (summary.stateCounts.WAITING ?? 0) === expectedWaiting,
    'Returned signup states do not satisfy the measured scenario.');
  assert.equal(routeRequests, REQUESTS, 'Server signup route counter delta must equal the 100 measured requests.');
  assert.equal(locks, REQUESTS, 'Server registration lock query counter delta must equal the 100 measured requests.');
  let active = 0;
  let waiting = 0;
  for (const activity of activities) {
    const [[truth]] = await db.execute("SELECT a.capacity, a.registered_count AS registeredCount, COUNT(r.id) AS total, COALESCE(SUM(r.status = 'ACTIVE'), 0) AS active, COALESCE(SUM(r.status = 'WAITING'), 0) AS waiting FROM activities a LEFT JOIN registrations r ON r.activity_id = a.id WHERE a.id = ? GROUP BY a.id", [activity.id]);
    assert(truth && Number(truth.registeredCount) === Number(truth.active) && Number(truth.active) === Number(truth.capacity)
      && Number(truth.total) === (scenario === 'same-activity' ? REQUESTS : 1), 'MySQL activity counts or unique registration count are inconsistent.');
    active += Number(truth.active);
    waiting += Number(truth.waiting);
  }
  assert(active === expectedActive && waiting === expectedWaiting, 'Real MySQL ACTIVE/WAITING counts differ from the returned states.');
  stats.database = { active, waiting, registrations: active + waiting, invariantsPassed: true };
  return stats;
}

export async function collectQueryEvidence(db, activityId) {
  assert(Number.isSafeInteger(activityId) && activityId > 0, 'Query evidence requires a verified synthetic activity primary key.');
  const [[state]] = await db.execute("SELECT capacity, registered_count AS active, (SELECT COUNT(*) FROM registrations WHERE activity_id = ? AND status = 'WAITING') AS waiting FROM activities WHERE id = ?", [activityId, activityId]);
  assert(state && Number(state.capacity) === 10 && Number(state.active) === 10 && Number(state.waiting) === 90,
    'SQL evidence must use the already validated 10 ACTIVE / 90 WAITING warmup fixture.');
  const results = {};
  const status = async () => {
    const [rows] = await db.query("SHOW SESSION STATUS WHERE Variable_name IN ('Handler_read_key', 'Handler_read_next')");
    const values = Object.fromEntries(rows.map(row => [row.Variable_name, Number(row.Value)]));
    assert(['Handler_read_key', 'Handler_read_next'].every(key => Number.isSafeInteger(values[key]) && values[key] >= 0),
      'Actual session handler counters must be available.');
    return values;
  };
  for (const [version, sourceSql] of Object.entries(LOCK_QUERY_SQL)) {
    await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await db.beginTransaction();
    try {
      const [plans] = await db.query(`EXPLAIN FORMAT=JSON ${sourceSql}`, [activityId]);
      assert(plans.length === 1 && typeof plans[0].EXPLAIN === 'string', 'MySQL must return one actual JSON execution plan.');
      const plan = JSON.parse(plans[0].EXPLAIN);
      const before = await status();
      const [rows, fields] = await db.query(sourceSql, [activityId]);
      const after = await status();
      assert(rows.length === 1 && fields.length === (version === 'baseline' ? 9 : 3), 'The measured SQL projection differs from the production version.');
      if (version === 'baseline') assert.equal(Number(rows[0].waiting_count), 90, 'Baseline correlated count must read the 90 waiting rows.');
      const handlerDelta = Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]]));
      assert(Object.values(handlerDelta).every(value => Number.isSafeInteger(value) && value >= 0), 'Session handler counter delta must be nonnegative.');
      results[version] = { sourceSql, explainFormat: 'JSON', plan, resultRows: rows.length, resultColumns: fields.length,
        handlerDelta, countsExcludeExplain: true };
    } finally {
      // Same connection, no concurrent writes; explicitly release each probe row lock.
      await db.rollback();
    }
  }
  return { transactionIsolation: 'READ_COMMITTED', active: 10, waiting: 90,
    measuredThrough: 'direct-mysql-single-select', excludedFromHttpMeasurementAndMetrics: true, queries: results };
}

function markdownReport(report) {
  const lines = ['# Gather 可复现报名压测', '', `- 结果：${report.success ? '通过' : '失败'}`, `- 应用提交：${report.environment?.appSha ?? '未验证'}`,
    '- 性质：当前软件基线；没有宣称任何性能优化或生产容量。',
    '- 环境：隔离 GitHub CI（或等价隔离本机）中，负载生成器和服务共享宿主；结果受共享宿主、网络代理和采样开销影响。',
    '- 时长：客户端从发送请求到完整读取并解析 JSON；不包含账号登录、创建活动、预热和统计校验。',
    '- 应用就绪：写入前最多等待 /api/health 120 秒，每次请求最多 2 秒；就绪等待不计入报名测量。',
    '- 分位数：将全部请求耗时升序排列，p 分位数取 ceil(p × n) 对应样本，使用 nearest rank。',
    '- 系统错误率仅包含 HTTP 5xx 和网络/读取失败；业务 4xx 单列。此有效未来活动场景预期全部 HTTP 200。',
    '- 池指标以 200 ms 周期、至多一个请求在途采样；短批次和瞬时峰值可能无法捕捉，采样 GET 会增加少量负载。',
    '- 锁指标为活动行 SELECT FOR UPDATE 的查询耗时（包含等待），也包含 SQL/网络执行；不能解释为纯锁等待时间。',
    '- 不从服务器分组 P95 推导聚合 P95；报告分位数来自本批 100 个客户端原始样本。', '',
    '## 固定条件', '', `每批 ${REQUESTS} 个不同用户；并发 ${CONCURRENCIES.join('/')}；两场景分别重复 ${REPEATS} 轮；共 18 批、1800 次报名。`,
    '同活动：10 名额，结果应为 10 ACTIVE / 90 WAITING。不同活动：100 场各 1 名额，结果应为 100 ACTIVE。',
    '每轮使用新活动，固定开始时间为本次运行开始后 48 小时；100 用户只准备登录一次；BCrypt 准备并发最多 5。',
    '每轮测量后精确删除该轮活动和报名，保留合成用户；每轮前后基线固定为 102 用户、4 活动（含 1 身份探针）、0 报名。',
    '正式测量前顺序 GET 活动列表 20 次，再按并发 1/50 × 同活动/不同活动各预热 1 批，共 400 次真实报名；每批同样验证和精确清理。',
    '预热单独记录，不属于正式 18 批或其计数差；HTTP 报名不重试。池采样次数包含批次前、周期读取及批次后。', '',
    '## 实际环境', '', '```json', JSON.stringify(report.environment ?? {}, null, 2), '```', '',
    '## 写路径预热', '', '```json', JSON.stringify(report.warmup?.map(row => ({ scenario: row.scenario,
      concurrency: row.concurrency, requests: row.requests, database: row.database, cleanup: row.cleanup })) ?? [], null, 2), '```', '',
    '## 批次结果', '', '| 场景 | 并发 | 轮次 | req/s | avg ms | P50 ms | P95 ms | P99 ms | max ms | 锁查询均值 ms | 池 active/pending 采样峰值 | 4xx/5xx/网络 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|'];
  for (const row of report.rounds) lines.push(`| ${row.scenario} | ${row.concurrency} | ${row.repeat} | ${row.throughputPerSecond.toFixed(2)} | ${row.latencyMs.avg.toFixed(2)} | ${row.latencyMs.p50.toFixed(2)} | ${row.latencyMs.p95.toFixed(2)} | ${row.latencyMs.p99.toFixed(2)} | ${row.latencyMs.max.toFixed(2)} | ${row.server.lockQueryAverageMs.toFixed(2)} | ${row.server.sampledPoolPeakActive}/${row.server.sampledPoolPeakPending} | ${row.business4xx}/${row.system5xx}/${row.networkFailures} |`);
  lines.push('', '## 清理', '', '```json', JSON.stringify(report.cleanup, null, 2), '```', '',
    '判断瓶颈必须结合多个重复批次、客户端分位数、锁查询耗时和池指标。此报告不把单次测量推广为稳定容量。');
  return `${lines.join('\n')}\n`;
}

export async function runPerformanceChecks() {
  const report = { success: false, measurementContract: MEASUREMENT_CONTRACT, startedAt: new Date().toISOString(),
    warmup: [], rounds: [], cleanup: { completed: false } };
  const clients = [];
  let db;
  let baseline;
  let manifest;
  let primaryError;
  let settings;
  try {
    settings = performanceSettings();
    report.phase = settings.phase ?? null;
    const containers = verifyContainerTargets(settings);
    // Compose --wait only guarantees running state for services without healthchecks.
    // Application/Flyway readiness is outside all measured request durations.
    await waitForApiReady(settings.base);
    db = await mysql.createConnection(settings.database);
    const seed = await verifyDatabase(db, settings);
    baseline = await snapshotDatabase(db);
    manifest = { version: 1, runId: randomUUID(), project: RUN_PROJECT, database: RUN_DATABASE,
      serverUuid: seed.identity.serverUuid, adminId: seed.admin.id, phase: settings.phase, users: [], activities: [] };
    saveManifest(manifest);
    await verifyUniqueApiDatabase(db, settings, manifest);
    const admin = new ApiClient(settings.base);
    clients.push(admin);
    const adminIdentity = await admin.login('admin', 'Admin123!');
    assert(adminIdentity.id === seed.admin.id && adminIdentity.role === 'ADMIN', 'Admin API identity differs from the verified database.');
    monitoringView(await admin.json('/api/admin/monitoring'));
    report.environment = { appSha: settings.appSha, harnessSha: process.env.GITHUB_SHA ?? null,
      node: process.version, java: containers.backend.javaRuntime,
      mysql: seed.identity.version, os: `${platform()} ${release()}`, cpuModels: [...new Set(cpus().map(cpu => cpu.model))],
      hostname: hostname(), logicalCpus: cpus().length, hostMemoryBytes: totalmem(), containers,
      project: RUN_PROJECT, database: RUN_DATABASE, databaseServerUuid: seed.identity.serverUuid,
      databaseBaselineSha256: createHash('sha256').update(baseline).digest('hex'),
      sessionMode: 'memory', loadGeneratorSharesHost: true, warmupGetRequests: 20,
      warmupWriteRequests: 400, warmupConcurrencies: WARMUP_CONCURRENCIES, startsAfterHours: 48,
      requestsPerBatch: REQUESTS, repeats: REPEATS, concurrencies: CONCURRENCIES, samplingIntervalMs: 200,
      clientTiming: 'fetch-start-through-complete-json-parse', percentileMethod: 'nearest-rank',
      measurementExcludes: ['login', 'activity-creation', 'warmup', 'database-assertions', 'cleanup'],
      poolSamplesInclude: ['before', 'periodic', 'after'] };
    const prepared = await prepareUsers(db, settings, seed, manifest, clients);
    const roundBaseline = await snapshotDatabase(db);
    report.environment.roundBaselineRows = { users: 102, activities: 4, registrations: 0 };
    const warmup = new ApiClient(settings.base);
    for (let index = 0; index < 20; index++) await warmup.json('/api/activities');
    const startsAt = new Date(Date.parse(report.startedAt) + 48 * 3600000).toISOString();
    for (const concurrency of WARMUP_CONCURRENCIES) for (const scenario of ['same-activity', 'different-activities']) {
      const activities = await createActivities(admin, manifest, scenario === 'same-activity' ? 1 : REQUESTS, startsAt,
        scenario === 'same-activity' ? 10 : 1);
      const round = await measureRound(admin, db, prepared, activities, scenario, concurrency, 1, row => report.warmup.push(row));
      if (settings.phase !== undefined && scenario === 'same-activity' && concurrency === 50) {
        report.queryEvidence = await collectQueryEvidence(db, activities[0].id);
      }
      round.cleanup = await cleanupOwned(db, manifest, { activityIds: activities.map(activity => activity.id),
        deleteUsers: false, persistManifest: saveManifest });
      assert.equal(await snapshotDatabase(db), roundBaseline, 'Write warmup cleanup must restore the exact prepared baseline before measurement.');
      round.cleanup.baselineRowsPreserved = true;
      console.log(`WARMUP PASS: ${scenario}, concurrency ${concurrency}: 100 HTTP 200; exact cleanup verified; excluded from measurement.`);
    }
    for (const concurrency of CONCURRENCIES) for (const scenario of ['same-activity', 'different-activities']) for (let repeat = 1; repeat <= REPEATS; repeat++) {
      const activities = await createActivities(admin, manifest, scenario === 'same-activity' ? 1 : REQUESTS, startsAt,
        scenario === 'same-activity' ? 10 : 1);
      const round = await measureRound(admin, db, prepared, activities, scenario, concurrency, repeat, row => report.rounds.push(row));
      round.cleanup = await cleanupOwned(db, manifest, { activityIds: activities.map(activity => activity.id),
        deleteUsers: false, persistManifest: saveManifest });
      assert.equal(await snapshotDatabase(db), roundBaseline, 'Round cleanup must restore the exact prepared baseline before the next batch.');
      round.cleanup.baselineRowsPreserved = true;
      console.log(`PASS: ${scenario}, concurrency ${concurrency}, repeat ${repeat}: 100 HTTP 200; MySQL invariants and server counters verified.`);
    }
  } catch (error) { primaryError = error; }
  finally {
    try {
      await parallelMap(clients, 5, client => client.logout());
    } catch (error) { primaryError = primaryError ? new AggregateError([primaryError, error], 'Measurement and owned session logout failed.') : error; }
    if (db) {
      try {
        if (manifest) {
          const counts = await cleanupOwned(db, manifest, { persistManifest: saveManifest });
          assert.equal(await snapshotDatabase(db), baseline, 'Exact cleanup did not preserve every original seed database row.');
          const rounds = [...report.warmup, ...report.rounds].reduce((total, round) => ({ activities: total.activities + (round.cleanup?.activitiesRemoved ?? 0),
            registrations: total.registrations + (round.cleanup?.registrationsRemoved ?? 0) }), { activities: 0, registrations: 0 });
          report.cleanup = { ...counts, roundActivitiesRemoved: rounds.activities, roundRegistrationsRemoved: rounds.registrations,
            totalActivitiesRemoved: counts.activitiesRemoved + rounds.activities,
            totalRegistrationsRemoved: counts.registrationsRemoved + rounds.registrations, completed: true, seedRowsPreserved: true };
          manifest.cleanup = report.cleanup;
          saveManifest(manifest);
        }
      } catch (error) { primaryError = primaryError ? new AggregateError([primaryError, error], 'Measurement and exact fixture cleanup failed.') : error; }
      finally { await db.end(); }
    }
    report.success = !primaryError && report.rounds.length === 18 && report.warmup.length === 4 && report.cleanup.completed;
    report.completedAt = new Date().toISOString();
    if (primaryError) report.failure = safeError(primaryError);
    const output = settings?.output ?? OUTPUT;
    mkdirSync(output, { recursive: true });
    writeFileSync(resolve(output, 'performance.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    writeFileSync(resolve(output, 'performance.md'), markdownReport(report), 'utf8');
  }
  if (primaryError) throw primaryError;
  assert(report.success, 'Performance check did not complete all required rounds and cleanup.');
  console.log(`Performance verification completed: 400 warmup + 1800 measured signups; exact cleanup preserved seed rows. Reports: ${settings.output}/performance.{json,md}`);
}

function safeError(error) {
  if (error instanceof AggregateError) return { kind: 'multiple-failures', errors: error.errors.map(safeError) };
  // mysql2 errors include SQL and parameters; fetch errors can contain URLs. Never serialize arbitrary errors.
  if (error?.sql || error?.sqlMessage || /^ER_/.test(error?.code ?? '')) return { kind: 'database-failure', code: /^ER_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'unavailable' };
  if (error instanceof assert.AssertionError) return { kind: 'verification-failure', message: error.message.split('\n')[0] };
  return { kind: 'runtime-failure', message: 'An isolated performance operation failed. Inspect sanitized CI steps and the ownership manifest.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runPerformanceChecks(); }
  catch (error) { console.error(JSON.stringify(safeError(error))); process.exitCode = 1; }
}
