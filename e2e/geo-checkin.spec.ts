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
  items: Mine[]; total: number; locationCheckInEnabled: boolean;
  summary: { activeRegistrations: number; checkedInRegistrations: number; waitingRegistrations: number; cancelledRegistrations: number };
}
interface Fixture { id: number; title: string; accounts: Account[]; before: Roster; admin: { id: number; displayName: string } }
interface MockNative {
  count: () => number;
  options: (index: number) => PositionOptions;
  succeed: (index: number, accuracy?: number) => void;
  fail: (index: number, code: number) => void;
  secure: (value: boolean) => void;
}
declare global { interface Window { __gatherGeoCheckInContract: MockNative } }
const password = 'Demo123!';
const fakeCoordinates = { longitude: 116.397, latitude: 39.908, accuracyMeters: 20 };
const selfPath = (id: number) => `/api/me/registrations/${id}/check-in`;
const adminPath = (fixture: Fixture, id: number) => `/api/admin/activities/${fixture.id}/registrations/${id}/check-in`;
const myRow = (page: Page, id: number) => page.getByTestId(`myregistration-${id}`);
const myButton = (page: Page, id: number) => page.getByRole('button', { name: `到场签到 ${id}`, exact: true });
const adminRow = (page: Page, id: number) => page.locator(`.roster-row[data-registration-id="${id}"]`);
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
  for (const _ of statuses) accounts.push(await register(request));
  const manifestPath = process.env.E2E_RUN_MANIFEST;
  if (!manifestPath || dirname(resolve(manifestPath)) !== resolve('.runtime/e2e')) throw new Error('Verified fixture manifest is required.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const account of accounts) {
    if (!manifest.accounts.some((owned: Account) => owned.key === account.key && owned.id === account.id && owned.username === account.username && owned.displayName === account.displayName))
      throw new Error('Exact owned account proof is required.');
  }
  const config = databaseConfig(), connection = await mysql.createConnection(config);
  const intent = trackFixture(`定位签到 ${info.project.name} ${randomUUID().slice(0, 8)}`, '定位签到及管理员更正专项：仅本轮精确归属活动与账号，原生定位和自助接口替身不写数据库。');
  try {
    await verifyDatabase(connection, config, manifest.target);
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
async function reloginWithinSpa(page: Page, account: Account) {
  await logout(page);
  if (new URL(page.url()).pathname !== '/login') await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
  await loginForm(page, account);
  if (new URL(page.url()).pathname !== '/my-registrations') {
    const mobile = page.getByRole('button', { name: '打开导航', exact: true });
    if (await mobile.isVisible()) await mobile.click();
    await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('link', { name: '我的报名', exact: true }).click();
  }
}
async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ has: page.getByText(option, { exact: true }) }).click();
  await expect(page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')).toHaveCount(0);
}
async function openMine(page: Page, row: Registration) {
  await page.goto('/my-registrations');
  await expect(myRow(page, row.id)).toBeVisible();
}
async function openRoster(page: Page, fixture: Fixture) {
  await page.goto(`/admin/activities/${fixture.id}/registrations`);
  await expect(adminRow(page, ownedRow(fixture).id)).toBeVisible();
}
async function assertStatistics(page: Page, checked: number, active: number) {
  await expect(page.getByTestId('roster-active-count')).toHaveText(String(active));
  await expect(page.getByTestId('roster-checked-in-count')).toHaveText(String(checked));
  await expect(page.getByTestId('roster-not-checked-in-count')).toHaveText(String(active - checked));
}
async function mineStatistics(page: Page, checked: number) {
  await expect(page.getByTestId('myregistrations-checkedInRegistrations').locator('.ant-statistic-content-value')).toHaveText(String(checked));
}
async function openCorrection(page: Page, row: Registration) {
  await page.getByRole('button', { name: `更正报名 ${row.id} 签到`, exact: true }).click();
  const modal = page.getByRole('dialog', { name: '更正签到', exact: true });
  await expect(modal).toBeVisible();
  return modal;
}
async function correct(page: Page, fixture: Fixture, row: Registration, reason: string) {
  const modal = await openCorrection(page, row);
  await modal.getByLabel('更正原因', { exact: true }).fill(reason);
  const response = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === adminPath(fixture, row.id));
  await modal.getByRole('button', { name: '保存更正', exact: true }).click();
  const completed = await response;
  expect(completed.status()).toBe(200);
  await expect(modal).toHaveCount(0);
  return completed.json() as Promise<Registration>;
}
async function capture(page: Page, info: TestInfo, name: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function nativeContract(page: Page, secure = true) {
  await page.addInitScript(({ initiallySecure }) => {
    let secureContext = initiallySecure;
    const calls: { success: PositionCallback; failure: PositionErrorCallback; options: PositionOptions }[] = [];
    Object.defineProperty(window, 'isSecureContext', { configurable: true, get: () => secureContext });
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition(success: PositionCallback, failure: PositionErrorCallback, options: PositionOptions) { calls.push({ success, failure, options }); },
      watchPosition() { throw new Error('The test forbids background location tracking.'); },
    } });
    window.__gatherGeoCheckInContract = {
      count: () => calls.length,
      options: index => calls[index].options,
      succeed: (index, accuracy = 20) => calls[index].success({ coords: { longitude: 116.397, latitude: 39.908, accuracy }, timestamp: Date.now() } as GeolocationPosition),
      fail: (index, code) => calls[index].failure({ code, message: 'contract-only browser error' } as GeolocationPositionError),
      secure: value => { secureContext = value; },
    };
  }, { initiallySecure: secure });
}
async function nativeCount(page: Page) { return page.evaluate(() => window.__gatherGeoCheckInContract.count()); }
async function beginNative(page: Page, row: Registration) {
  const index = await nativeCount(page);
  await myButton(page, row.id).click();
  await expect.poll(() => nativeCount(page)).toBe(index + 1);
  return index;
}
async function succeed(page: Page, index: number, accuracy = 20) {
  await page.evaluate(({ index, accuracy }) => window.__gatherGeoCheckInContract.succeed(index, accuracy), { index, accuracy });
}
async function nativeFail(page: Page, index: number, code: number) {
  await page.evaluate(({ index, code }) => window.__gatherGeoCheckInContract.fail(index, code), { index, code });
}

type Outcome = 200 | 401 | 500;
interface HeldWrite { id: number; body: Record<string, unknown>; release: (status: Outcome, commit?: boolean) => void; done: Promise<void> }
async function selfInterfaceContract(page: Page, fixture: Fixture) {
  const owned = new Set(fixture.before.items.map(row => row.id));
  const original = new Map<number, Mine>();
  const changes = new Map<number, { checkedInAt: string; checkInMethod: 'SELF_LOCATION'; checkInVersion: number }>();
  const writes: HeldWrite[] = [];
  let mode: 'success' | 'abort' | 'hold' = 'success';
  // Read the real authenticated projection first. Only the explicitly owned
  // rows' attendance fields, the feature flag and matching checked total differ.
  await page.route('**/api/me/registrations/search?**', async route => {
    const response = await route.fetch();
    if (response.status() !== 200) { await route.fulfill({ response }); return; }
    const body = await response.json() as MinePage;
    let delta = 0;
    for (const row of body.items) {
      if (!owned.has(row.id)) continue;
      original.set(row.id, structuredClone(row));
      const changed = changes.get(row.id);
      if (changed) { if (!row.checkedInAt) delta++; Object.assign(row, changed); }
    }
    if (body.items.some(row => owned.has(row.id))) body.locationCheckInEnabled = true;
    body.summary.checkedInRegistrations += delta;
    await route.fulfill({ response, json: body });
  });
  // No request in this route is forwarded to the self check-in endpoint.
  await page.route('**/api/me/registrations/*/check-in', async route => {
    expect(route.request().method()).toBe('POST');
    const id = Number(new URL(route.request().url()).pathname.split('/')[4]);
    expect(owned.has(id)).toBe(true);
    const body = route.request().postDataJSON();
    expect(Object.keys(body).sort()).toEqual(['accuracyMeters', 'expectedVersion', 'latitude', 'longitude']);
    expect(body).toMatchObject(fakeCoordinates);
    let release!: HeldWrite['release'];
    let delivered!: () => void;
    const done = new Promise<void>(resolve => { delivered = resolve; });
    const decision = new Promise<{ status: Outcome; commit: boolean }>(resolve => { release = (status, commit = true) => resolve({ status, commit }); });
    writes.push({ id, body, release, done });
    try {
      if (mode === 'abort') { await route.abort('failed'); return; }
      if (mode === 'success') release(200);
      const { status, commit } = await decision;
      if (status === 200) {
        const base = original.get(id);
        expect(base).toBeDefined();
        const changed = { checkedInAt: '2030-01-01T00:00:01Z', checkInMethod: 'SELF_LOCATION' as const, checkInVersion: Number(body.expectedVersion) + 1 };
        if (commit) changes.set(id, changed);
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ ...base, ...changed }) });
      } else {
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ code: status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL_ERROR', message: '旧签到错误不得出现' }) });
      }
    } finally { delivered(); }
  });
  return { writes, mode: (next: typeof mode) => { mode = next; }, reset: () => changes.clear(),
    releaseAll: () => { for (const write of writes) write.release(500, false); } };
}
async function assertDatabaseUnsigned(request: APIRequestContext, fixture: Fixture) {
  const after = await roster(request, fixture);
  expect(after.items.map(row => ({ id: row.id, checkedInAt: row.checkedInAt, method: row.checkInMethod, version: row.checkInVersion, updatedAt: row.updatedAt })))
    .toEqual(fixture.before.items.map(row => ({ id: row.id, checkedInAt: null, method: null, version: 0, updatedAt: row.updatedAt })));
  expect(after.summary).toEqual(fixture.before.summary);
  expect(after.activity.registeredCount).toBe(fixture.before.activity.registeredCount);
}

test('真实未配置定位服务时本人分页关闭入口，不请求原生GPS或签到POST', async ({ page, request }, info) => {
  await nativeContract(page);
  let posts = 0;
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/me\/registrations\/\d+\/check-in$/.test(new URL(request.url()).pathname)) posts++; });
  try {
    await loginApi(request);
    const fixture = await fixtures(request, info, { statuses: ['ACTIVE'] }), row = ownedRow(fixture);
    await login(page, fixture.accounts[0]);
    const response = await page.request.get('/api/me/registrations/search?page=1&pageSize=10&status=ALL');
    expect(response.status()).toBe(200);
    expect((await response.json()).locationCheckInEnabled).toBe(false);
    await openMine(page, row);
    await expect(myButton(page, row.id)).toBeDisabled();
    await expect(myRow(page, row.id)).toContainText('到场定位签到暂不可用，请联系管理员确认到场。');
    expect(await nativeCount(page)).toBe(0); expect(posts).toBe(0);
    await assertDatabaseUnsigned(request, fixture);
    await capture(page, info, 'geo-checkin-disabled-real');
  } finally { await logoutApi(page.request); await logoutApi(request); }
});

test('真实管理员结束后补签和撤销保留版本审计，统计CSV真实变化且报名名额候补不变', async ({ page, request }, info) => {
  try {
    await loginApi(request);
    const fixture = await fixtures(request, info, { ended: true }), row = ownedRow(fixture);
    await login(page); await openRoster(page, fixture);
    const modal = await openCorrection(page, row);
    await expect(modal.getByRole('button', { name: '保存更正', exact: true })).toBeDisabled();
    await modal.getByLabel('更正原因', { exact: true }).fill('   ');
    await expect(modal.getByRole('button', { name: '保存更正', exact: true })).toBeDisabled();
    await choose(page, '更正后的签到状态', '未签到（撤销）');
    await modal.getByLabel('更正原因', { exact: true }).fill('同状态不提交');
    await expect(modal.getByRole('button', { name: '保存更正', exact: true })).toBeDisabled();
    await modal.getByRole('button', { name: '取消', exact: true }).click();
    const signed = await correct(page, fixture, row, '核对独立现场记录后补签');
    expect(signed).toMatchObject({ checkedInBy: fixture.admin.id, checkInMethod: 'ADMIN', checkInVersion: 1, status: row.status, updatedAt: row.updatedAt });
    expect(signed.checkedInAt).not.toBeNull();
    await assertStatistics(page, 1, 2);
    await expect(adminRow(page, row.id)).toContainText('管理员确认');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
    const exported = await download, path = info.outputPath('geo-admin-only.csv');
    await exported.saveAs(path);
    expect(await exported.failure()).toBeNull();
    const csv = readFileSync(path, 'utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.split('\r\n')[0]).toMatch(/,"签到方式"$/);
    expect(csv.split('\r\n').find(line => line.startsWith(`"\t${row.id}",`))).toMatch(/,"管理员签到"$/);
    const revoked = await correct(page, fixture, signed, '核对原记录后撤销误签');
    expect(revoked).toMatchObject({ checkedInAt: null, checkedInBy: null, checkInMethod: null, checkInVersion: 2, status: row.status, updatedAt: row.updatedAt });
    await assertStatistics(page, 0, 2);
    const after = await roster(request, fixture);
    expect(after.activity.registeredCount).toBe(fixture.before.activity.registeredCount);
    expect(after.activity.waitingCount).toBe(fixture.before.activity.waitingCount);
    expect(after.items.map(item => [item.id, item.status, item.createdAt, item.updatedAt])).toEqual(fixture.before.items.map(item => [item.id, item.status, item.createdAt, item.updatedAt]));
    const audits = await request.get(`/api/admin/audit-logs?activityId=${fixture.id}&action=ALL&page=1&pageSize=100`);
    expect(audits.status()).toBe(200);
    const events = (await audits.json()).items as { id: number; action: string }[];
    expect(events.map(event => event.action).sort()).toEqual(['CHECK_IN', 'CHECK_IN_REVOKE']);
    for (const event of events) {
      const detail = await request.get(`/api/admin/audit-logs/${event.id}`);
      expect(detail.status()).toBe(200);
      const body = await detail.json() as { actorUserId: number; changes: { field: string; after: string | null }[] };
      expect(body.actorUserId).toBe(fixture.admin.id);
      expect(body.changes.find(change => change.field === 'checkInReason')?.after).toBe(event.action === 'CHECK_IN' ? '核对独立现场记录后补签' : '核对原记录后撤销误签');
    }
    await capture(page, info, 'geo-admin-correction-real');
  } finally { await logoutApi(page.request); await logoutApi(request); }
});

test('真实更正版本冲突刷新名单，筛选清空理由且普通用户和非ACTIVE不能更正', async ({ page, request }, info) => {
  try {
    await loginApi(request);
    const fixture = await fixtures(request, info, { statuses: ['ACTIVE', 'WAITING', 'CANCELLED'] }), row = ownedRow(fixture);
    await login(page); await openRoster(page, fixture);
    for (const inactive of fixture.before.items.filter(item => item.status !== 'ACTIVE')) {
      await expect(page.getByRole('button', { name: `更正报名 ${inactive.id} 签到`, exact: true })).toHaveCount(0);
      const denied = await write(request, adminPath(fixture, inactive.id), 'PATCH', { checkedIn: true, reason: '不应更正非有效报名', expectedVersion: inactive.checkInVersion });
      expect(denied.status()).toBe(409);
    }
    let modal = await openCorrection(page, row);
    await modal.getByLabel('更正原因', { exact: true }).fill('旧版本补签');
    const concurrent = await write(request, adminPath(fixture, row.id), 'POST', { expectedVersion: 0 });
    expect(concurrent.status()).toBe(200);
    const failed = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === adminPath(fixture, row.id));
    await modal.getByRole('button', { name: '保存更正', exact: true }).click();
    expect((await failed).status()).toBe(409);
    await expect(modal).toHaveCount(0);
    await assertStatistics(page, 1, 1);
    await expect(adminRow(page, row.id)).toContainText('管理员确认');
    await choose(page, '报名状态', '已报名');
    modal = await openCorrection(page, row);
    await modal.getByLabel('更正原因', { exact: true }).fill('切换筛选应清除');
    // Browser history can change the submitted condition while the dialog is
    // still open. The scope change must unmount it and discard its reason.
    await page.goBack();
    await expect(modal).toHaveCount(0);
    await expect(adminRow(page, row.id)).toBeVisible();
    modal = await openCorrection(page, row);
    await expect(modal.getByLabel('更正原因', { exact: true })).toHaveValue('');
    await modal.getByRole('button', { name: '取消', exact: true }).click();
    for (const reason of ['', '含\n换行', '字'.repeat(501)]) {
      const invalid = await write(request, adminPath(fixture, row.id), 'PATCH', { checkedIn: false, reason, expectedVersion: 1 });
      expect(invalid.status()).toBe(400);
    }
    await logout(page);
    if (new URL(page.url()).pathname !== '/login') await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
    await loginForm(page, fixture.accounts[0]);
    const denied = await write(page.request, adminPath(fixture, row.id), 'PATCH', { checkedIn: false, reason: '普通用户不能更正', expectedVersion: 1 });
    expect(denied.status()).toBe(403);
    const after = await roster(request, fixture);
    expect(after.items.find(item => item.id === row.id)).toMatchObject({ checkInMethod: 'ADMIN', checkInVersion: 1 });
    expect(after.summary).toEqual({ activeRegistrations: 1, checkedInRegistrations: 1, notCheckedInRegistrations: 0 });
  } finally { await logoutApi(page.request); await logoutApi(request); }
});

test('定位及接口契约替身：权限精度超时可手动重试，成功刷新方式统计但真实数据库仍未签到', async ({ page, request }, info) => {
  await nativeContract(page);
  let contract: Awaited<ReturnType<typeof selfInterfaceContract>> | undefined;
  try {
    await loginApi(request);
    const fixture = await fixtures(request, info), row = ownedRow(fixture);
    contract = await selfInterfaceContract(page, fixture);
    await login(page, fixture.accounts[0]); await openMine(page, row);
    for (const [code, message] of [[1, '定位权限未开启'], [2, '暂时无法获取位置'], [3, '定位超时']] as const) {
      const index = await beginNative(page, row);
      expect(await page.evaluate(index => window.__gatherGeoCheckInContract.options(index), index)).toEqual({ enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
      await nativeFail(page, index, code);
      await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible();
      await expect(myButton(page, row.id)).toBeEnabled(); expect(contract.writes).toHaveLength(0);
    }
    for (const accuracy of [0, 101]) {
      const index = await beginNative(page, row); await succeed(page, index, accuracy);
      await expect(page.getByRole('alert').filter({ hasText: '定位精度不足' })).toBeVisible();
      await expect(myButton(page, row.id)).toBeEnabled(); expect(contract.writes).toHaveLength(0);
    }
    const index = await beginNative(page, row); await succeed(page, index);
    await expect(myRow(page, row.id)).toContainText('本人定位');
    await mineStatistics(page, 1);
    expect(contract.writes).toHaveLength(1);
    expect(contract.writes[0].body).toEqual({ ...fakeCoordinates, expectedVersion: 0 });
    expect(await myRow(page, row.id).innerText()).not.toContain('签到管理员');
    await assertDatabaseUnsigned(request, fixture);
    await capture(page, info, 'geo-self-contract-only');
  } finally { contract?.releaseAll(); await page.unrouteAll({ behavior: 'wait' }); await logoutApi(page.request); await logoutApi(request); }
});

test('定位及接口契约替身：不安全上下文不请求GPS，未知写结果不自动重提且可人工核对', async ({ page, request }, info) => {
  await nativeContract(page, false);
  let contract: Awaited<ReturnType<typeof selfInterfaceContract>> | undefined;
  try {
    await loginApi(request);
    const fixture = await fixtures(request, info), row = ownedRow(fixture);
    contract = await selfInterfaceContract(page, fixture); contract.mode('abort');
    await login(page, fixture.accounts[0]); await openMine(page, row);
    await myButton(page, row.id).click();
    await expect(page.getByRole('alert').filter({ hasText: '安全连接' })).toBeVisible();
    expect(await nativeCount(page)).toBe(0); expect(contract.writes).toHaveLength(0);
    await page.evaluate(() => window.__gatherGeoCheckInContract.secure(true));
    const index = await beginNative(page, row); await succeed(page, index);
    await expect(page.getByRole('alert').filter({ hasText: '签到结果未确认，请刷新查看后再决定是否重试。' })).toBeVisible();
    await mineStatistics(page, 0); await expect(myButton(page, row.id)).toBeEnabled();
    expect(contract.writes).toHaveLength(1);
    await page.getByRole('button', { name: '刷新报名', exact: true }).click();
    await expect(myButton(page, row.id)).toBeEnabled(); await settle(page);
    expect(contract.writes).toHaveLength(1);
    await assertDatabaseUnsigned(request, fixture);
  } finally { contract?.releaseAll(); await page.unrouteAll({ behavior: 'wait' }); await logoutApi(page.request); await logoutApi(request); }
});

test('定位及接口契约替身：筛选和站内离页使旧native回调失效且不清除新的定位busy', async ({ page, request }, info) => {
  await nativeContract(page);
  let contract: Awaited<ReturnType<typeof selfInterfaceContract>> | undefined;
  try {
    await loginApi(request);
    const fixture = await fixtures(request, info), row = ownedRow(fixture);
    contract = await selfInterfaceContract(page, fixture);
    await login(page, fixture.accounts[0]); await openMine(page, row);
    for (const change of ['condition', 'leave'] as const) {
      const old = await beginNative(page, row);
      if (change === 'condition') await choose(page, '报名状态', '已报名');
      else { await myRow(page, row.id).getByRole('link', { name: '查看活动', exact: true }).click(); await page.goBack(); }
      await expect(myButton(page, row.id)).toBeEnabled();
      const fresh = await beginNative(page, row);
      await succeed(page, old); await nativeFail(page, old, 1); await settle(page);
      expect(contract.writes).toHaveLength(0);
      await expect(myButton(page, row.id)).toContainText('正在定位');
      await expect(myButton(page, row.id)).toBeDisabled();
      await nativeFail(page, fresh, 1);
      await expect(myButton(page, row.id)).toBeEnabled();
    }
    await assertDatabaseUnsigned(request, fixture);
  } finally { contract?.releaseAll(); await page.unrouteAll({ behavior: 'wait' }); await logoutApi(page.request); await logoutApi(request); }
});

test('定位及接口契约替身：同账号重登和换身份后旧native回调不能发POST或覆盖新busy', async ({ page, request }, info) => {
  await nativeContract(page);
  let contract: Awaited<ReturnType<typeof selfInterfaceContract>> | undefined;
  try {
    await loginApi(request);
    const fixture = await fixtures(request, info);
    contract = await selfInterfaceContract(page, fixture);
    await login(page, fixture.accounts[0]); await openMine(page, ownedRow(fixture));
    for (const account of fixture.accounts) {
      const currentAccount = await page.request.get('/api/auth/me');
      const identity = await currentAccount.json();
      const source = fixture.accounts.find(item => item.id === identity.id)!;
      const old = await beginNative(page, ownedRow(fixture, source));
      await reloginWithinSpa(page, account);
      const target = ownedRow(fixture, account);
      await expect(myButton(page, target.id)).toBeEnabled();
      const fresh = await beginNative(page, target);
      await succeed(page, old); await nativeFail(page, old, 1); await settle(page);
      expect(contract.writes).toHaveLength(0);
      await expect(myButton(page, target.id)).toContainText('正在定位');
      await expect(page.getByRole('button', { name: `账号菜单，${account.displayName}`, exact: true })).toBeVisible();
      await nativeFail(page, fresh, 1); await expect(myButton(page, target.id)).toBeEnabled();
    }
    await assertDatabaseUnsigned(request, fixture);
  } finally { contract?.releaseAll(); await page.unrouteAll({ behavior: 'wait' }); await logoutApi(page.request); await logoutApi(request); }
});

for (const outcome of [200, 500, 401] as const) {
  test(`定位及接口契约替身：旧POST ${outcome}及finally跨条件或身份不覆盖新签到busy`, async ({ page, request }, info) => {
    await nativeContract(page);
    let contract: Awaited<ReturnType<typeof selfInterfaceContract>> | undefined;
    try {
      await loginApi(request);
      const fixture = await fixtures(request, info);
      contract = await selfInterfaceContract(page, fixture); contract.mode('hold');
      let account = fixture.accounts[0];
      await login(page, account); await openMine(page, ownedRow(fixture, account));
      for (const change of ['condition', 'same-account-login', 'different-account-login'] as const) {
        contract.reset();
        await page.getByRole('button', { name: '刷新报名', exact: true }).click();
        const source = ownedRow(fixture, account);
        await expect(myButton(page, source.id)).toBeEnabled();
        const before = contract.writes.length;
        const oldNative = await beginNative(page, source); await succeed(page, oldNative);
        await expect.poll(() => contract!.writes.length).toBe(before + 1);
        await expect(myButton(page, source.id)).toContainText('正在签到');
        if (change === 'condition') await choose(page, '报名状态', '已报名');
        else {
          if (change === 'different-account-login') account = fixture.accounts[1];
          await reloginWithinSpa(page, account);
        }
        const target = ownedRow(fixture, account);
        await expect(myButton(page, target.id)).toBeEnabled();
        const freshNative = await beginNative(page, target); await succeed(page, freshNative);
        await expect.poll(() => contract!.writes.length).toBe(before + 2);
        await expect(myButton(page, target.id)).toContainText('正在签到');
        contract.writes[before].release(outcome, false);
        await contract.writes[before].done;
        await settle(page);
        await expect(myButton(page, target.id)).toContainText('正在签到');
        await expect(myButton(page, target.id)).toBeDisabled();
        await expect(page.getByRole('button', { name: `账号菜单，${account.displayName}`, exact: true })).toBeVisible();
        await expect(page.getByText('旧签到错误不得出现', { exact: true })).toHaveCount(0);
        contract.writes[before + 1].release(200);
        await expect(myRow(page, target.id)).toContainText('本人定位');
        await mineStatistics(page, 1);
        expect(contract.writes).toHaveLength(before + 2);
      }
      await assertDatabaseUnsigned(request, fixture);
    } finally { contract?.releaseAll(); await page.unrouteAll({ behavior: 'wait' }); await logoutApi(page.request); await logoutApi(request); }
  });
}
