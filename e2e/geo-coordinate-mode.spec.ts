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
interface Fixture { id: number; title: string; accounts: Account[]; before: Roster; admin: { id: number; displayName: string } }
interface ModeNative {
  count: () => number;
  options: (index: number) => PositionOptions;
  succeed: (index: number, accuracy?: number) => void;
  fail: (index: number, code: number) => void;
  secure: (value: boolean) => void;
}
declare global { interface Window { __gatherCoordinateModeNative: ModeNative } }
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
async function fixtures(request: APIRequestContext, info: TestInfo, options: { ended?: boolean; statuses?: Status[] } = {}): Promise<Fixture> {
  const statuses = options.statuses ?? ['ACTIVE', 'ACTIVE'];
  const accounts: Account[] = [];
  const manifestPath = process.env.E2E_RUN_MANIFEST;
  if (!manifestPath || dirname(resolve(manifestPath)) !== resolve('.runtime/e2e')) throw new Error('Verified fixture manifest is required.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const config = databaseConfig(), connection = await mysql.createConnection(config);
  const intent = trackFixture(`坐标模式 ${info.project.name} ${randomUUID().slice(0, 8)}`, '显式坐标模式契约专项：原生点和两签到响应均为替身，不调用真实高德，不代表真实设备坐标校准，不写入自助签到。');
  try {
    await verifyDatabase(connection, config, manifest.target);
    for (const _ of statuses) accounts.push(await register(request));
    const recorded = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const account of accounts) {
      if (!recorded.accounts.some((owned: Account) => owned.key === account.key && owned.id === account.id && owned.username === account.username && owned.displayName === account.displayName))
        throw new Error('Exact owned coordinate-mode account proof is required.');
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
        utc(now + (options.ended ? -3600000 : 3600000)), Math.max(1, active), active, admin.id]);
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
    return { id: created.insertId, title: intent.title, accounts, before, admin };
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
async function logout(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  await page.getByRole('menuitem', { name: /退出登录/ }).click();
  await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
}

async function settle(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function nativeContract(page: Page) {
  await page.addInitScript(() => {
    const calls: { success: PositionCallback; failure: PositionErrorCallback; options: PositionOptions }[] = [];
    Object.defineProperty(window, 'isSecureContext', { configurable: true, get: () => true });
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition(success: PositionCallback, failure: PositionErrorCallback, options: PositionOptions) { calls.push({ success, failure, options }); },
      watchPosition() { throw new Error('Coordinate-mode contract forbids background GPS.'); },
    } });
    window.__gatherCoordinateModeNative = {
      count: () => calls.length, options: index => calls[index].options,
      succeed: (index, accuracy = 20) => calls[index].success({ coords: { longitude: 116.397, latitude: 39.908, accuracy }, timestamp: Date.now() } as GeolocationPosition),
      fail: (index, code) => calls[index].failure({ code, message: 'synthetic coordinate-mode contract' } as GeolocationPositionError),
      secure() { /* This suite uses an explicitly synthetic secure native contract. */ },
    };
  });
}
async function nativeCount(page: Page) { return page.evaluate(() => window.__gatherCoordinateModeNative.count()); }
async function beginNative(page: Page, row: Registration) {
  const index = await nativeCount(page); await myButton(page, row.id).click();
  await expect.poll(() => nativeCount(page)).toBe(index + 1); return index;
}
async function succeed(page: Page, index: number) { await page.evaluate(index => window.__gatherCoordinateModeNative.succeed(index), index); }
async function fail(page: Page, index: number) { await page.evaluate(index => window.__gatherCoordinateModeNative.fail(index, 1), index); }
async function openMine(page: Page, row: Registration) {
  await page.goto('/my-registrations'); await expect(myRow(page, row.id)).toBeVisible(); await settings(page);
}
async function settings(page: Page) {
  const disclosure = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^定位兼容设置$/ }) });
  await expect(disclosure).toBeVisible();
  if (!await disclosure.evaluate(element => (element as HTMLDetailsElement).open)) await disclosure.locator('summary').click();
  await expect(page.getByRole('combobox', { name: '定位坐标模式', exact: true })).toBeVisible(); return disclosure;
}
async function chooseMode(page: Page, mode: 'WGS84' | 'GCJ02') {
  await settings(page); await page.getByRole('combobox', { name: '定位坐标模式', exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ has: page.getByText(mode === 'WGS84' ? '标准定位（默认）' : '高德坐标兼容（已校准设备）', { exact: true }) }).click();
  await expect(page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')).toHaveCount(0);
}
async function assertMode(page: Page, mode: 'WGS84' | 'GCJ02') {
  const disclosure = await settings(page);
  await expect(disclosure.getByTitle(mode === 'WGS84' ? '标准定位（默认）' : '高德坐标兼容（已校准设备）', { exact: true })).toBeVisible();
}
async function relogin(page: Page, account: Account) {
  await logout(page);
  if (!await page.getByLabel('账号', { exact: true }).isVisible()) await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
  await loginForm(page, account);
  if (new URL(page.url()).pathname !== '/my-registrations') {
    const mobile = page.getByRole('button', { name: '打开导航', exact: true }); if (await mobile.isVisible()) await mobile.click();
    await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('link', { name: '我的报名', exact: true }).click();
  }
}
interface ContractWrite { path: string; id: number; body: Record<string, unknown>; release(status?: 200 | 404 | 500): void; done: Promise<void> }
async function coordinateContract(page: Page, fixture: Fixture) {
  const owned = new Set(fixture.before.items.map(row => row.id)), originals = new Map<number, Mine>();
  const changes = new Map<number, { checkedInAt: string; checkInMethod: 'SELF_LOCATION'; checkInVersion: number }>();
  const writes: ContractWrite[] = []; const jobs: Promise<{ error?: unknown }>[] = [];
  let capability: true | false | undefined = true, enabled = true, responseStatus: 200 | 404 | 500 = 200, held = false;
  const searchMatcher = '**/api/me/registrations/search?**';
  const selfMatcher = (url: URL) => /^\/api\/me\/registrations\/\d+\/check-in(?:\/gcj02)?$/.test(url.pathname);
  await page.route(searchMatcher, async route => {
    const response = await route.fetch(); if (response.status() !== 200) { await route.fulfill({ response }); return; }
    const body = await response.json() as MinePage; let delta = 0;
    for (const row of body.items) {
      if (!owned.has(row.id)) continue; originals.set(row.id, structuredClone(row));
      const change = changes.get(row.id); if (change) { if (!row.checkedInAt) delta++; Object.assign(row, change); }
    }
    body.locationCheckInEnabled = enabled;
    if (capability === undefined) delete body.locationCheckInGcj02Supported; else body.locationCheckInGcj02Supported = capability;
    body.summary.checkedInRegistrations += delta; await route.fulfill({ response, json: body });
  });
  // Both endpoints are always captured, including accidental fallback requests.
  // Neither route forwards a native sample or invokes the real conversion service.
  await page.route(selfMatcher, route => {
    const job = (async () => {
      const request = route.request(), path = new URL(request.url()).pathname, id = Number(path.split('/')[4]);
      expect(request.method()).toBe('POST'); expect(owned.has(id)).toBe(true);
      const body = request.postDataJSON() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['accuracyMeters', 'expectedVersion', 'latitude', 'longitude']);
      expect(body).toEqual({ ...fakeCoordinates, expectedVersion: 0 });
      let release!: ContractWrite['release'], finished!: () => void;
      const done = new Promise<void>(resolve => { finished = resolve; });
      const status = new Promise<200 | 404 | 500>(resolve => { release = (value = 200) => resolve(value); });
      writes.push({ path, id, body, release, done }); if (!held) release(responseStatus);
      try {
        const outcome = await status;
        if (outcome === 200) {
          const original = originals.get(id); expect(original).toBeDefined();
          const changed = { checkedInAt: '2030-01-01T00:00:01Z', checkInMethod: 'SELF_LOCATION' as const, checkInVersion: Number(body.expectedVersion) + 1 };
          changes.set(id, changed); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...original, ...changed }) });
        } else await route.fulfill({ status: outcome, contentType: 'application/json', body: JSON.stringify({ code: outcome === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR', message: '坐标模式契约替身拒绝' }) });
      } catch (error) { if (!request.failure() && !/cancel|abort|closed|handled/i.test(String(error))) throw error; }
      finally { finished(); }
    })(); jobs.push(job.then(() => ({}), error => ({ error }))); return job;
  });
  return { writes, capability: (value: typeof capability, locationEnabled = true) => { capability = value; enabled = locationEnabled; },
    status: (value: typeof responseStatus) => { responseStatus = value; }, hold: (value: boolean) => { held = value; },
    reset: () => changes.clear(),
    async close() {
      for (const write of writes) write.release(500);
      try { const errors = (await Promise.all(jobs)).flatMap(result => result.error === undefined ? [] : [result.error]);
        if (errors.length) throw new AggregateError(errors, 'Coordinate-mode interface contract failed.');
      } finally { await page.unroute(searchMatcher); await page.unroute(selfMatcher); }
    } };
}
async function unsigned(request: APIRequestContext, fixture: Fixture) {
  const actual = await roster(request, fixture); expect(actual.items).toEqual(fixture.before.items); expect(actual.summary).toEqual(fixture.before.summary);
  expect(actual.activity.registeredCount).toBe(fixture.before.activity.registeredCount);
}
test.afterEach(async ({ page, request }) => {
  const outcomes = await Promise.allSettled([logoutApi(page.request), logoutApi(request)]);
  const errors = outcomes.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'Coordinate-mode owned sessions could not all log out.');
});

test('显式坐标模式契约：默认旧路径，主动兼容新路径，不自动定位或增加正文标识', async ({ page, request }, info) => {
  await nativeContract(page); await loginApi(request); const fixture = await fixtures(request, info), row = ownedRow(fixture);
  const contract = await coordinateContract(page, fixture);
  try {
    await login(page, fixture.accounts[0]); await openMine(page, row); await assertMode(page, 'WGS84');
    const url = page.url(); await chooseMode(page, 'GCJ02'); await chooseMode(page, 'WGS84');
    expect(await nativeCount(page)).toBe(0); expect(contract.writes).toHaveLength(0); expect(page.url()).toBe(url);
    const normal = await beginNative(page, row); await succeed(page, normal);
    await expect(myRow(page, row.id)).toContainText('本人定位'); expect(contract.writes.map(write => write.path)).toEqual([selfPath(row.id)]);
    contract.reset(); await page.getByRole('button', { name: '刷新报名', exact: true }).click(); await expect(myButton(page, row.id)).toBeEnabled();
    await chooseMode(page, 'GCJ02'); expect(await nativeCount(page)).toBe(1);
    const compatible = await beginNative(page, row); await succeed(page, compatible);
    await expect(myRow(page, row.id)).toContainText('本人定位');
    expect(contract.writes.map(write => write.path)).toEqual([selfPath(row.id), selfPath(row.id) + '/gcj02']);
    expect(contract.writes[1].body).toEqual(contract.writes[0].body); expect(page.url()).toBe(url);
    await unsigned(request, fixture);
  } finally { await contract.close(); }
});

test('显式坐标模式契约：缺少或关闭能力禁止兼容，旧服务404不回退重放标准入口', async ({ page, request }, info) => {
  await nativeContract(page); await loginApi(request); const fixture = await fixtures(request, info), row = ownedRow(fixture);
  const contract = await coordinateContract(page, fixture);
  try {
    await login(page, fixture.accounts[0]);
    for (const capability of [undefined, false]) {
      contract.capability(capability); await openMine(page, row); await assertMode(page, 'WGS84');
      await chooseMode(page, 'GCJ02'); await assertMode(page, 'GCJ02');
      await expect(myButton(page, row.id)).toBeDisabled();
      await expect(await settings(page)).toContainText('当前服务暂不支持高德坐标兼容签到');
      expect(await nativeCount(page)).toBe(0); expect(contract.writes).toHaveLength(0);
    }
    contract.capability(true, false); await openMine(page, row); await chooseMode(page, 'GCJ02');
    await expect(myButton(page, row.id)).toBeDisabled(); expect(await nativeCount(page)).toBe(0); expect(contract.writes).toHaveLength(0);
    // Both genuine capability gates are advertised only by this declared UI
    // contract. It makes no claim about the host's private service-key state.
    contract.capability(true); contract.status(404); await openMine(page, row); await chooseMode(page, 'GCJ02');
    const index = await beginNative(page, row); await succeed(page, index);
    await expect(myRow(page, row.id).getByRole('alert')).toBeVisible(); await expect(myButton(page, row.id)).toBeEnabled(); await settle(page);
    expect(contract.writes.map(write => write.path)).toEqual([selfPath(row.id) + '/gcj02']);
    await unsigned(request, fixture);
  } finally { await contract.close(); }
});

test('显式坐标模式契约：采集中切换丢弃旧点，旧回调不清新busy且POST期间禁止改模式', async ({ page, request }, info) => {
  await nativeContract(page); await loginApi(request); const fixture = await fixtures(request, info), row = ownedRow(fixture);
  const contract = await coordinateContract(page, fixture);
  try {
    contract.hold(true); await login(page, fixture.accounts[0]); await openMine(page, row);
    const old = await beginNative(page, row); await chooseMode(page, 'GCJ02');
    expect(await nativeCount(page)).toBe(1); expect(contract.writes).toHaveLength(0); await expect(myButton(page, row.id)).toBeEnabled();
    const current = await beginNative(page, row); await succeed(page, old); await fail(page, old); await settle(page);
    expect(contract.writes).toHaveLength(0); await expect(myButton(page, row.id)).toContainText('正在定位');
    await expect(myRow(page, row.id).getByRole('alert')).toHaveCount(0);
    await succeed(page, current); await expect.poll(() => contract.writes.length).toBe(1);
    expect(contract.writes[0].path).toBe(selfPath(row.id) + '/gcj02');
    await expect(page.getByRole('combobox', { name: '定位坐标模式', exact: true })).toBeDisabled();
    await expect(myButton(page, row.id)).toContainText('正在签到');
    contract.writes[0].release(); await contract.writes[0].done; await expect(myRow(page, row.id)).toContainText('本人定位');
    await unsigned(request, fixture);
  } finally { await contract.close(); }
});

test('显式坐标模式契约：同账号重登换身份及离页重置默认，旧采集晚回调隔离新页面', async ({ page, request }, info) => {
  await nativeContract(page); await loginApi(request); const fixture = await fixtures(request, info), first = ownedRow(fixture), second = ownedRow(fixture, fixture.accounts[1]);
  const contract = await coordinateContract(page, fixture);
  try {
    await login(page, fixture.accounts[0]); await openMine(page, first); await chooseMode(page, 'GCJ02');
    const sameAccount = await beginNative(page, first); await relogin(page, fixture.accounts[0]);
    await expect(myRow(page, first.id)).toBeVisible(); await assertMode(page, 'WGS84');
    await succeed(page, sameAccount); await fail(page, sameAccount); await settle(page); expect(contract.writes).toHaveLength(0);
    await expect(myButton(page, first.id)).toBeEnabled(); await chooseMode(page, 'GCJ02');
    const oldIdentity = await beginNative(page, first); await relogin(page, fixture.accounts[1]);
    await expect(myRow(page, second.id)).toBeVisible(); await assertMode(page, 'WGS84');
    const fresh = await beginNative(page, second); await succeed(page, oldIdentity); await fail(page, oldIdentity); await settle(page);
    expect(contract.writes).toHaveLength(0); await expect(myButton(page, second.id)).toContainText('正在定位');
    await fail(page, fresh); await expect(myButton(page, second.id)).toBeEnabled(); await chooseMode(page, 'GCJ02');
    const departed = await beginNative(page, second);
    await page.getByRole('link', { name: '集会 Gather 首页', exact: true }).click(); await expect(page).toHaveURL(/\/activities(?:\?|$)/);
    const mobile = page.getByRole('button', { name: '打开导航', exact: true }); if (await mobile.isVisible()) await mobile.click();
    await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('link', { name: '我的报名', exact: true }).click();
    await expect(myRow(page, second.id)).toBeVisible(); await assertMode(page, 'WGS84');
    await succeed(page, departed); await fail(page, departed); await settle(page); expect(contract.writes).toHaveLength(0);
    await expect(myRow(page, second.id).getByRole('alert')).toHaveCount(0); await expect(myButton(page, second.id)).toBeEnabled();
    await unsigned(request, fixture);
  } finally { await contract.close(); }
});
