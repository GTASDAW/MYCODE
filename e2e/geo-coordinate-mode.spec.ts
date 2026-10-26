import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { databaseConfig, verifyDatabase, trackAccount, recordAccountId, trackFixture, recordFixtureId } from '../scripts/e2e-cleanup.mjs';

// Never ask the device for GPS or retain Session/CSRF headers in traces. The
// explicitly labelled contract tests do not exercise provider conversion or
// persist self check-in; their final trusted roster read proves that boundary.
test.use({ trace: 'off' });

type Status = 'ACTIVE' | 'WAITING' | 'CANCELLED';
type Method = 'ADMIN' | 'SELF_LOCATION' | null;
interface Account { key: string; id: number; username: string; displayName: string }
interface Activity {
  id: number; title: string; description: string; startsAt: string; endsAt: string | null;
  locationPoint: { longitude: number; latitude: number } | null;
  registeredCount: number; waitingCount: number; cancelled: boolean;
}
interface Registration {
  id: number; userId: number; username: string; displayName: string; status: Status;
  createdAt: string; updatedAt: string; checkedInAt: string | null;
  checkInMethod: Method; checkInVersion: number;
  checkedInBy: number | null; checkedInByDisplayName: string | null;
}
interface Roster {
  activity: Activity; items: Registration[]; total: number;
  summary: { activeRegistrations: number; checkedInRegistrations: number; notCheckedInRegistrations: number };
}
interface Mine {
  id: number; status: Status; checkedInAt: string | null; checkInMethod: Method; checkInVersion: number; activity: Activity;
}
interface MinePage {
  items: Mine[]; total: number; locationCheckInEnabled: boolean; locationCheckInGcj02Supported?: boolean;
  summary: { activeRegistrations: number; checkedInRegistrations: number; waitingRegistrations: number; cancelledRegistrations: number };
}
interface Fixture { id: number; title: string; accounts: Account[]; before: Roster }
interface StandardNative {
  count: () => number;
  options: (index: number) => PositionOptions;
  succeed: (index: number, accuracy?: number) => void;
}
declare global { interface Window { __gatherStandardLocationContract: StandardNative } }
const password = 'Demo123!';
const fakeCoordinates = { longitude: 116.397, latitude: 39.908, accuracyMeters: 20 };
const selfPath = (id: number) => `/api/me/registrations/${id}/check-in`;
const myRow = (page: Page, id: number) => page.getByTestId(`myregistration-${id}`);
const myButton = (page: Page, id: number) => page.getByRole('button', { name: `到场签到 ${id}`, exact: true });
const ownedRow = (fixture: Fixture, account = fixture.accounts[0]) => fixture.before.items.find(row => row.userId === account.id)!;

async function write(request: APIRequestContext, path: string, method: 'POST' | 'PATCH' = 'POST', data?: unknown) {
  const csrf = await request.get('/api/auth/csrf');
  expect(csrf.status()).toBe(200);
  const token = await csrf.json();
  return request.fetch(path, { method, data, headers: { [token.headerName]: token.token } });
}
async function loginApi(request: APIRequestContext) {
  const token = await (await request.get('/api/auth/csrf')).json();
  const response = await request.post('/api/auth/login', { form: { username: 'admin', password: 'Admin123!' }, headers: { [token.headerName]: token.token } });
  expect(response.status()).toBe(200);
}
async function logoutApi(request: APIRequestContext) {
  const me = await request.get('/api/auth/me');
  if (me.status() === 401) return;
  expect(me.status()).toBe(200);
  expect((await write(request, '/api/auth/logout')).status()).toBe(200);
}
async function register(request: APIRequestContext): Promise<Account> {
  const account = trackAccount(['定位-']);
  const response = await write(request, '/api/auth/register', 'POST', { username: account.username, displayName: account.displayName, password });
  expect(response.status()).toBe(201);
  const user = await response.json();
  recordAccountId(account.key, user.id);
  return { ...account, id: user.id };
}
async function roster(request: APIRequestContext, fixture: Pick<Fixture, 'id'>): Promise<Roster> {
  const response = await request.get(`/api/admin/activities/${fixture.id}/registrations?page=1&pageSize=100&status=ALL&checkInStatus=ALL`);
  expect(response.status()).toBe(200);
  return response.json();
}
async function fixtures(request: APIRequestContext, info: TestInfo): Promise<Fixture> {
  const statuses: Status[] = ['ACTIVE'];
  const accounts: Account[] = [];
  const manifestPath = process.env.E2E_RUN_MANIFEST;
  if (!manifestPath || dirname(resolve(manifestPath)) !== resolve('.runtime/e2e')) throw new Error('Verified fixture manifest is required.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const config = databaseConfig(), connection = await mysql.createConnection(config);
  const intent = trackFixture(`普通定位 ${info.project.name} ${randomUUID().slice(0, 8)}`, '普通定位回归：原生点和标准签到成功为替身；诊断默认关闭按真实拒绝核对，不调用真实高德或写入自助签到。');
  try {
    await verifyDatabase(connection, config, manifest.target);
    for (const _ of statuses) accounts.push(await register(request));
    const recorded = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const account of accounts) {
      if (!recorded.accounts.some((owned: Account) => owned.key === account.key && owned.id === account.id && owned.username === account.username && owned.displayName === account.displayName))
        throw new Error('Exact owned standard-location account proof is required.');
    }
    const me = await request.get('/api/auth/me');
    expect(me.status()).toBe(200);
    const admin = await me.json();
    expect(admin.role).toBe('ADMIN');
    await connection.beginTransaction();
    const [admins] = await connection.execute<any[]>("SELECT id, username, role FROM users WHERE id = ? AND username = 'admin' AND role = 'ADMIN' FOR UPDATE", [admin.id]);
    expect(admins).toHaveLength(1);
    for (const account of [...accounts].sort((a, b) => a.id - b.id)) {
      const [users] = await connection.execute<any[]>('SELECT id, username, display_name AS displayName, role FROM users WHERE id = ? FOR UPDATE', [account.id]);
      expect(users).toEqual([{ id: account.id, username: account.username, displayName: account.displayName, role: 'USER' }]);
    }
    const utc = (value: number) => new Date(value).toISOString().replace('T', ' ').replace('Z', '');
    const now = Date.now(), active = statuses.filter(status => status === 'ACTIVE').length;
    const [created] = await connection.execute<mysql.ResultSetHeader>(
      'INSERT INTO activities (title, description, location, location_longitude, location_latitude, starts_at, ends_at, capacity, registered_count, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [intent.title, intent.description, '独立定位签到临时场地', '116.3971280', '39.9165270', utc(now - 2 * 3600000),
        utc(now + 3600000), Math.max(1, active), active, admin.id]);
    for (const [index, account] of accounts.entries()) {
      await connection.execute('INSERT INTO registrations (activity_id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [created.insertId, account.id, statuses[index], utc(now - 3 * 3600000 - index * 1000), utc(now - 3 * 3600000 - index * 1000)]);
    }
    await connection.commit();
    recordFixtureId(intent.key, created.insertId);
    const before = await roster(request, { id: created.insertId });
    expect(before.activity).toMatchObject({ id: created.insertId, title: intent.title, description: intent.description, registeredCount: active });
    expect(before.items).toHaveLength(statuses.length);
    expect(before.items.every(row => row.checkedInAt === null && row.checkInMethod === null && row.checkInVersion === 0)).toBe(true);
    return { id: created.insertId, title: intent.title, accounts, before };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { await connection.end(); }
}
async function loginForm(page: Page, account?: Account) {
  await page.getByLabel('账号', { exact: true }).fill(account?.username ?? 'admin');
  await page.getByLabel('密码', { exact: true }).fill(account ? password : 'Admin123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: account ? `账号菜单，${account.displayName}` : /账号菜单/, exact: !!account })).toBeVisible();
}
async function login(page: Page, account?: Account) {
  await page.goto('/login');
  await loginForm(page, account);
}
async function settle(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function nativeContract(page: Page) {
  await page.addInitScript(() => {
    const calls: { success: PositionCallback; failure: PositionErrorCallback; options: PositionOptions }[] = [];
    Object.defineProperty(window, 'isSecureContext', { configurable: true, get: () => true });
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition(success: PositionCallback, failure: PositionErrorCallback, options: PositionOptions) { calls.push({ success, failure, options }); },
      watchPosition() { throw new Error('Standard-location contract forbids background GPS.'); },
    } });
    window.__gatherStandardLocationContract = {
      count: () => calls.length, options: index => calls[index].options,
      succeed: (index, accuracy = 20) => calls[index].success({ coords: { longitude: 116.397, latitude: 39.908, accuracy }, timestamp: Date.now() } as GeolocationPosition),
    };
  });
}
async function nativeCount(page: Page) { return page.evaluate(() => window.__gatherStandardLocationContract.count()); }
async function beginNative(page: Page, row: Registration) {
  const index = await nativeCount(page); await myButton(page, row.id).click();
  await expect.poll(() => nativeCount(page)).toBe(index + 1); return index;
}
async function succeed(page: Page, index: number) { await page.evaluate(index => window.__gatherStandardLocationContract.succeed(index), index); }

async function ordinaryPage(page: Page, row: Registration) {
  await page.goto('/my-registrations'); await expect(myRow(page, row.id)).toBeVisible();
  await expect(page.getByText('定位兼容设置', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '定位坐标模式', exact: true })).toHaveCount(0);
  await expect(page.getByText('高德坐标兼容（已校准设备）', { exact: true })).toHaveCount(0);
}
interface ContractWrite { path: string; id: number; body: Record<string, unknown> }
async function standardInterfaceContract(page: Page, fixture: Fixture) {
  const owned = new Set(fixture.before.items.map(row => row.id)), originals = new Map<number, Mine>();
  const changes = new Map<number, { checkedInAt: string; checkInMethod: 'SELF_LOCATION'; checkInVersion: number }>();
  const writes: ContractWrite[] = [], jobs: Promise<{ error?: unknown }>[] = [];
  let capability: true | false | undefined;
  const searchMatcher = '**/api/me/registrations/search?**';
  const selfMatcher = (url: URL) => /^\/api\/me\/registrations\/\d+\/check-in(?:\/gcj02)?$/.test(url.pathname);
  await page.route(searchMatcher, async route => {
    const response = await route.fetch(); if (response.status() !== 200) { await route.fulfill({ response }); return; }
    const body = await response.json() as MinePage; let delta = 0;
    for (const row of body.items) {
      if (!owned.has(row.id)) continue; originals.set(row.id, structuredClone(row));
      const changed = changes.get(row.id); if (changed) { if (!row.checkedInAt) delta++; Object.assign(row, changed); }
    }
    // The standard positive UI case advertises readiness only on this owned
    // page. It never represents the real application's private WebKey state.
    if (body.items.some(row => owned.has(row.id))) {
      body.locationCheckInEnabled = true;
      if (capability === undefined) delete body.locationCheckInGcj02Supported;
      else body.locationCheckInGcj02Supported = capability;
    }
    body.summary.checkedInRegistrations += delta;
    await route.fulfill({ response, json: body });
  });
  // Capture both endpoints so an unexpected GCJ02 request cannot reach the
  // diagnostic server or a real provider. Only the fixed standard path passes.
  await page.route(selfMatcher, route => {
    const job = (async () => {
      const request = route.request(), path = new URL(request.url()).pathname, id = Number(path.split('/')[4]);
      expect(request.method()).toBe('POST'); expect(owned.has(id)).toBe(true);
      const body = request.postDataJSON() as Record<string, unknown>; writes.push({ path, id, body });
      expect(path).toBe(selfPath(id));
      expect(Object.keys(body).sort()).toEqual(['accuracyMeters', 'expectedVersion', 'latitude', 'longitude']);
      expect(body).toEqual({ ...fakeCoordinates, expectedVersion: 0 });
      const original = originals.get(id); expect(original).toBeDefined();
      const changed = { checkedInAt: '2030-01-01T00:00:01Z', checkInMethod: 'SELF_LOCATION' as const, checkInVersion: 1 };
      changes.set(id, changed);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...original, ...changed }) });
    })(); jobs.push(job.then(() => ({}), error => ({ error }))); return job;
  });
  return { writes, capability: (value: typeof capability) => { capability = value; changes.clear(); },
    async close() {
      try { const errors = (await Promise.all(jobs)).flatMap(result => result.error === undefined ? [] : [result.error]);
        if (errors.length) throw new AggregateError(errors, 'Standard-location interface contract failed.');
      } finally { await page.unroute(searchMatcher); await page.unroute(selfMatcher); }
    } };
}
async function unsigned(request: APIRequestContext, fixture: Fixture) {
  const actual = await roster(request, fixture);
  expect(actual.items).toEqual(fixture.before.items); expect(actual.summary).toEqual(fixture.before.summary);
  expect(actual.activity.registeredCount).toBe(fixture.before.activity.registeredCount);
}
test.afterEach(async ({ page, request }) => {
  const outcomes = await Promise.allSettled([logoutApi(page.request), logoutApi(request)]);
  const errors = outcomes.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'Owned standard-location sessions could not all log out.');
});

test('普通我的报名没有坐标模式，旧新能力字段均只允许手动标准签到四字段契约', async ({ page, request }, info) => {
  await nativeContract(page); await loginApi(request); const fixture = await fixtures(request, info), row = ownedRow(fixture);
  const contract = await standardInterfaceContract(page, fixture);
  try {
    await login(page, fixture.accounts[0]); let submitted = 0;
    for (const capability of [undefined, false, true]) {
      contract.capability(capability); await ordinaryPage(page, row); await settle(page);
      expect(await nativeCount(page)).toBe(0); expect(contract.writes).toHaveLength(submitted);
      await expect(myButton(page, row.id)).toBeEnabled(); const url = page.url();
      const index = await beginNative(page, row); expect(contract.writes).toHaveLength(submitted);
      expect(await page.evaluate(index => window.__gatherStandardLocationContract.options(index), index))
        .toEqual({ enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
      await succeed(page, index); await expect(myRow(page, row.id)).toContainText('本人定位');
      expect(contract.writes).toHaveLength(submitted + 1);
      expect(contract.writes[submitted]).toMatchObject({ path: selfPath(row.id), id: row.id, body: { ...fakeCoordinates, expectedVersion: 0 } });
      expect(page.url()).toBe(url); await expect(page.getByRole('combobox', { name: '定位坐标模式', exact: true })).toHaveCount(0);
      submitted++;
    }
    expect(contract.writes.map(write => write.path)).toEqual(Array(3).fill(selfPath(row.id)));
    await unsigned(request, fixture);
  } finally { await contract.close(); }
});

test('默认应用真实禁用GCJ02诊断接口，普通未配置页面无模式无GPS且报名签到字段不变', async ({ page, request }, info) => {
  await nativeContract(page); await loginApi(request); const fixture = await fixtures(request, info), row = ownedRow(fixture);
  await login(page, fixture.accounts[0]); await ordinaryPage(page, row);
  const response = await page.request.get('/api/me/registrations/search?page=1&pageSize=10&status=ALL');
  expect(response.status()).toBe(200); expect((await response.json()).locationCheckInEnabled).toBe(false);
  await expect(myButton(page, row.id)).toBeDisabled(); expect(await nativeCount(page)).toBe(0);
  // This requires the independently verified default diagnostic=false app.
  // APIRequestContext bypasses browser route fixtures: the real server must
  // reject the public synthetic point before any provider request or write.
  const denied = await write(page.request, selfPath(row.id) + '/gcj02', 'POST', { ...fakeCoordinates, expectedVersion: 0 });
  expect(denied.status()).toBe(503); expect((await denied.json()).code).toBe('LOCATION_DIAGNOSTIC_DISABLED');
  expect(await nativeCount(page)).toBe(0); await unsigned(request, fixture);
});
