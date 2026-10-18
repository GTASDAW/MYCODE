import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import {
  databaseConfig, verifyDatabase, trackAccount, recordAccountId, trackFixture, recordFixtureId,
  renameManifestWithRetry,
} from '../scripts/e2e-cleanup.mjs';

// Keep screenshots of the public UI, never credentials, Session headers or export bodies in traces.
test.use({ trace: 'off' });

interface Account { key: string; id: number; username: string; displayName: string }
type RegistrationStatus = 'ACTIVE' | 'WAITING' | 'CANCELLED';
interface Registration {
  id: number; userId: number; username: string; displayName: string; status: RegistrationStatus;
  createdAt: string; updatedAt: string; checkedInAt: string | null;
  checkedInBy: number | null; checkedInByDisplayName: string | null;
}
interface Roster {
  activity: { id: number; title: string; startsAt: string; registeredCount: number; waitingCount: number; cancelled: boolean };
  items: Registration[]; total: number; page: number; pageSize: number;
  summary: { activeRegistrations: number; checkedInRegistrations: number; notCheckedInRegistrations: number };
}
interface Query { page?: number; pageSize?: number; status?: RegistrationStatus | 'ALL'; checkInStatus?: 'ALL' | 'CHECKED_IN' | 'NOT_CHECKED_IN' }
const accountPassword = 'Demo123!';
const networkError = '暂时无法连接服务，请检查网络后重试。';

async function write(request: APIRequestContext, path: string, data?: unknown) {
  const csrf = await request.get('/api/auth/csrf');
  expect(csrf.status()).toBe(200);
  const token = await csrf.json();
  return request.post(path, { data, headers: { [token.headerName]: token.token } });
}

async function loginApi(request: APIRequestContext, username = 'admin', password = 'Admin123!') {
  const token = await (await request.get('/api/auth/csrf')).json();
  const response = await request.post('/api/auth/login', {
    form: { username, password }, headers: { [token.headerName]: token.token },
  });
  expect(response.status()).toBe(200);
}

async function logoutApi(request: APIRequestContext) {
  const me = await request.get('/api/auth/me');
  if (me.status() === 401) return;
  expect(me.status()).toBe(200);
  expect((await write(request, '/api/auth/logout')).status()).toBe(200);
}

async function register(request: APIRequestContext, prefixes = ['中-', '改-']) {
  const account = trackAccount(prefixes) as Account;
  const response = await write(request, '/api/auth/register', {
    username: account.username, displayName: account.displayName, password: accountPassword,
  });
  expect(response.status()).toBe(201);
  const user = await response.json();
  recordAccountId(account.key, user.id);
  return { ...account, id: user.id };
}

function queryParameters(query: Query = {}) {
  return new URLSearchParams({ page: String(query.page ?? 1), pageSize: String(query.pageSize ?? 10),
    status: query.status ?? 'ALL', checkInStatus: query.checkInStatus ?? 'ALL' });
}

function rosterPath(id: number, query: Query = {}) {
  return `/api/admin/activities/${id}/registrations?${queryParameters(query)}`;
}

async function roster(request: APIRequestContext, id: number, query: Query = {}) {
  const response = await request.get(rosterPath(id, query));
  expect(response.status()).toBe(200);
  return response.json() as Promise<Roster>;
}

async function pageRoster(page: Page, id: number, query: Query = {}) {
  // Only a fully completed read can supply its body. Strict Mode may cancel the first duplicate GET.
  const request = await page.waitForEvent('requestfinished', { predicate: request => {
    const url = new URL(request.url());
    return request.method() === 'GET' && url.pathname === `/api/admin/activities/${id}/registrations`
      && [...queryParameters(query)].every(([key, value]) => url.searchParams.get(key) === value);
  } });
  const response = await request.response();
  expect(response?.status()).toBe(200);
  return response!.json() as Promise<Roster>;
}

async function login(page: Page, account?: Account) {
  await page.goto('/login');
  await loginForm(page, account);
}

async function loginForm(page: Page, account?: Account) {
  await page.getByLabel('账号', { exact: true }).fill(account?.username ?? 'admin');
  await page.getByLabel('密码', { exact: true }).fill(account ? accountPassword : 'Admin123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: /账号菜单/ })).toBeVisible();
}

async function loginViaUi(page: Page, account: Account) {
  await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
  await loginForm(page, account);
}

async function logout(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  const [response] = await Promise.all([
    page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/auth/logout'),
    page.getByRole('menuitem', { name: /退出登录/ }).click(),
  ]);
  expect(response.status()).toBe(200);
  await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
}

async function choose(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ has: page.getByText(value, { exact: true }) }).click();
  await expect(page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')).toHaveCount(0);
}

async function assertRoster(page: Page, result: Roster) {
  await expect(page.locator('.roster-row[data-registration-id]')).toHaveCount(result.items.length);
  await expect.poll(() => page.locator('.roster-row[data-registration-id]').evaluateAll(
    rows => rows.map(row => Number(row.getAttribute('data-registration-id')))))
    .toEqual(result.items.map(item => item.id));
  await expect(page.getByTestId('roster-active-count')).toHaveText(String(result.summary.activeRegistrations));
  await expect(page.getByTestId('roster-checked-in-count')).toHaveText(String(result.summary.checkedInRegistrations));
  await expect(page.getByTestId('roster-not-checked-in-count')).toHaveText(String(result.summary.notCheckedInRegistrations));
}

async function openRoster(page: Page, id: number) {
  const result = pageRoster(page, id);
  await page.goto(`/admin/activities/${id}/registrations`);
  await expect(page.getByRole('heading', { name: '报名名单', exact: true })).toBeVisible();
  const loaded = await result;
  await assertRoster(page, loaded);
  return loaded;
}

async function capture(page: Page, info: TestInfo, name: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  const path = info.outputPath(`${name}.png`);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function fixtures(request: APIRequestContext, info: TestInfo, statuses: RegistrationStatus[], options: {
  future?: boolean; cancelled?: boolean; specialText?: boolean;
} = {}) {
  const accounts: Account[] = [];
  for (let index = 0; index < statuses.length; index++) {
    accounts.push(await register(request, options.specialText && index === 0 ? ['=q,"'] : ['中-']));
  }
  const manifestPath = process.env.E2E_RUN_MANIFEST;
  if (!manifestPath || dirname(resolve(manifestPath)) !== resolve('.runtime/e2e')) throw new Error('Verified fixture manifest is required.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (options.specialText && accounts.length > 1) {
    // A legacy database value containing a newline is deliberately NOT accepted by registration/profile APIs.
    // Record this one exact owned account value before writing it; retain its original proof for failed writes.
    const account = accounts[1];
    const owned = manifest.accounts.find((item: Account) => item.key === account.key && item.id === account.id
      && item.username === account.username && item.displayName === account.displayName);
    if (!owned) throw new Error('Exact owned account intent is missing.');
    const legacyName = `q,\n${account.key}`;
    owned.allowedDisplayNames.push(legacyName);
    const temporary = `${manifestPath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    renameManifestWithRetry(temporary, manifestPath);
  }
  const config = databaseConfig();
  const connection = await mysql.createConnection(config);
  const fixture = trackFixture(`签到 ${info.project.name} ${randomUUID().slice(0, 8)}`, '仅本轮精确归属的已开始活动和历史报名用于签到验证。');
  let id = 0;
  try {
    await verifyDatabase(connection, config, manifest.target);
    // The setup UUID probe bound this database to the API before any business fixture write.
    const response = await request.get('/api/auth/me');
    expect(response.status()).toBe(200);
    const admin = await response.json();
    expect(admin.role).toBe('ADMIN');
    await connection.beginTransaction();
    const [admins] = await connection.execute<any[]>("SELECT id, username, role FROM users WHERE id = ? AND username = 'admin' AND role = 'ADMIN' FOR UPDATE", [admin.id]);
    expect(admins).toHaveLength(1);
    for (const account of [...accounts].sort((first, second) => first.id - second.id)) {
      const [users] = await connection.execute<any[]>(
        'SELECT id, username, display_name AS displayName, role FROM users WHERE id = ? FOR UPDATE', [account.id]);
      expect(users).toEqual([{ id: account.id, username: account.username, displayName: account.displayName, role: 'USER' }]);
    }
    if (options.specialText && accounts.length > 1) {
      const account = accounts[1];
      const changedName = `q,\n${account.key}`;
      const [changed] = await connection.execute<mysql.ResultSetHeader>(
        "UPDATE users SET display_name = ? WHERE id = ? AND CAST(username AS BINARY) = CAST(? AS BINARY) AND role = 'USER' AND CAST(display_name AS BINARY) = CAST(? AS BINARY)",
        [changedName, account.id, account.username, account.displayName]);
      expect(changed.affectedRows).toBe(1);
      accounts[1] = { ...account, displayName: changedName };
    }
    const activeCount = statuses.filter(status => status === 'ACTIVE').length;
    const startsAt = new Date(Date.now() + (options.future ? 48 * 3600000 : -3600000)).toISOString();
    const utc = (date: string) => date.replace('T', ' ').replace('Z', '');
    const [created] = await connection.execute<mysql.ResultSetHeader>(
      'INSERT INTO activities (title, description, location, starts_at, capacity, registered_count, created_by, cancelled_at, cancelled_by, cancellation_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [fixture.title, fixture.description, '签到独立临时场地', utc(startsAt), Math.max(1, activeCount), activeCount,
        admin.id, options.cancelled ? utc(new Date(Date.now() - 2 * 3600000).toISOString()) : null,
        options.cancelled ? admin.id : null, options.cancelled ? '本轮已取消活动签到验证' : null]);
    id = created.insertId;
    for (const [index, account] of accounts.entries()) {
      await connection.execute(
        'INSERT INTO registrations (activity_id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [id, account.id, statuses[index], utc(new Date(Date.now() - 2 * 3600000 - index * 1000).toISOString()),
          utc(new Date(Date.now() - 2 * 3600000 - index * 1000).toISOString())]);
    }
    await connection.commit();
    recordFixtureId(fixture.key, id);
    const bound = await request.get(`/api/activities/${id}`);
    expect(bound.status()).toBe(200);
    expect(await bound.json()).toMatchObject({ id, title: fixture.title, description: fixture.description, registeredCount: activeCount });
    return { id, title: fixture.title, accounts, admin, before: await roster(request, id, { pageSize: 100 }) };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { await connection.end(); }
}

async function confirm(page: Page, id: number, registrationId: number) {
  await page.getByRole('button', { name: `确认报名 ${registrationId} 签到`, exact: true }).click();
  const modal = page.getByRole('dialog', { name: '确认签到', exact: true });
  await expect(modal).toContainText('成功后不可撤销');
  const completed = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/admin/activities/${id}/registrations/${registrationId}/check-in`);
  await modal.getByRole('button', { name: '确认签到', exact: true }).click();
  const response = await completed;
  expect(response.status()).toBe(200);
  const checked = await response.json() as Registration;
  await expect(modal).toHaveCount(0);
  return checked;
}

function parseCsv(bytes: Buffer) {
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const source = bytes.toString('utf8').slice(1);
  const rows: string[][] = [];
  let index = 0;
  while (index < source.length) {
    const cells: string[] = [];
    while (true) {
      expect(source[index++]).toBe('"');
      let cell = '';
      while (true) {
        if (source[index] === '"') {
          if (source[index + 1] === '"') { cell += '"'; index += 2; }
          else { index++; break; }
        } else {
          if (index >= source.length) throw new Error('Unterminated CSV field.');
          cell += source[index++];
        }
      }
      cells.push(cell);
      if (source[index] === ',') { index++; continue; }
      expect(source.slice(index, index + 2)).toBe('\r\n');
      index += 2;
      break;
    }
    rows.push(cells);
  }
  expect(rows.every(row => row.length === 10)).toBeTruthy();
  expect(rows[0]).toEqual(['报名记录ID', '用户名', '昵称', '报名状态', '签到状态', '首次报名时间（北京时间）',
    '报名更新时间（北京时间）', '签到时间（北京时间）', '签到管理员ID', '签到管理员昵称']);
  return rows;
}

async function exportCsv(page: Page, id: number) {
  const received = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
  const download = await received;
  expect(download.suggestedFilename()).toBe(`activity-${id}-registrations.csv`);
  const path = resolve('.runtime/e2e', `export-${randomUUID()}.csv`);
  mkdirSync(dirname(path), { recursive: true });
  await download.saveAs(path);
  expect(await download.failure()).toBeNull();
  return parseCsv(readFileSync(path));
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

function heldResponse() {
  let release!: () => void; let arrived!: () => void; let delivered!: () => void;
  return {
    held: new Promise<void>(resolve => { release = resolve; }),
    fetched: new Promise<void>(resolve => { arrived = resolve; }),
    completed: new Promise<void>(resolve => { delivered = resolve; }),
    release: () => release(), arrived: () => arrived(), delivered: () => delivered(),
  };
}

test('管理员确认签到保留首次信息，筛选和分页统计整场人数，最后一页减少后自动修正', async ({ page, request }, info) => {
  try {
    await loginApi(request);
    const fixture = await fixtures(request, info, [...Array<RegistrationStatus>(13).fill('ACTIVE'), 'WAITING', 'CANCELLED']);
    const before = fixture.before;
    expect(before.summary).toEqual({ activeRegistrations: 13, checkedInRegistrations: 0, notCheckedInRegistrations: 13 });
    await login(page);
    const initial = await openRoster(page, fixture.id);
    expect(initial).toMatchObject({ total: 15, page: 1, pageSize: 10 });
    const filtered = pageRoster(page, fixture.id, { checkInStatus: 'NOT_CHECKED_IN' });
    await choose(page, '签到状态', '未签到');
    const unmarked = await filtered;
    expect(unmarked.total).toBe(13);
    await assertRoster(page, unmarked);
    const secondPage = pageRoster(page, fixture.id, { page: 2, checkInStatus: 'NOT_CHECKED_IN' });
    await page.locator('.roster-table .ant-pagination-item-2').click();
    const lastPage = await secondPage;
    await assertRoster(page, lastPage);
    expect(lastPage.items).toHaveLength(3);
    for (const [index, row] of lastPage.items.entries()) {
      const result = confirm(page, fixture.id, row.id);
      const refreshed = pageRoster(page, fixture.id, { page: index === 2 ? 1 : 2, checkInStatus: 'NOT_CHECKED_IN' });
      const checked = await result;
      expect(checked).toMatchObject({ id: row.id, status: 'ACTIVE', updatedAt: row.updatedAt,
        createdAt: row.createdAt, checkedInBy: fixture.admin.id, checkedInByDisplayName: fixture.admin.displayName });
      expect(checked.checkedInAt).toMatch(/Z$/);
      const duplicate = await write(request, `/api/admin/activities/${fixture.id}/registrations/${row.id}/check-in`);
      expect(duplicate.status()).toBe(200);
      expect(await duplicate.json()).toEqual(checked);
      const refreshedData = await refreshed;
      expect(refreshedData.summary).toEqual({ activeRegistrations: 13, checkedInRegistrations: index + 1, notCheckedInRegistrations: 12 - index });
      expect(refreshedData.total).toBe(12 - index);
      await assertRoster(page, refreshedData);
    }
    await expect(page.locator('.roster-table .ant-pagination-item-active')).toHaveText('1');
    const checkedOnly = pageRoster(page, fixture.id, { checkInStatus: 'CHECKED_IN' });
    await choose(page, '签到状态', '已签到');
    const marked = await checkedOnly;
    expect(marked.total).toBe(3);
    await assertRoster(page, marked);
    expect(marked.items.every(item => item.checkedInAt && item.checkedInBy === fixture.admin.id)).toBeTruthy();
    const latest = pageRoster(page, fixture.id, { checkInStatus: 'CHECKED_IN' });
    await page.getByRole('button', { name: '刷新名单', exact: true }).click();
    await assertRoster(page, await latest);
    const combined = pageRoster(page, fixture.id, { status: 'WAITING', checkInStatus: 'CHECKED_IN' });
    await choose(page, '报名状态', '候补中');
    const empty = await combined;
    expect(empty).toMatchObject({ items: [], total: 0, summary: { activeRegistrations: 13, checkedInRegistrations: 3, notCheckedInRegistrations: 10 } });
    await assertRoster(page, empty);
    const waitingLoaded = pageRoster(page, fixture.id, { status: 'WAITING' });
    await choose(page, '签到状态', '全部签到状态');
    const waiting = await waitingLoaded;
    await assertRoster(page, waiting);
    await expect(page.locator(`[data-registration-id="${waiting.items[0].id}"]`)).toContainText('不适用');
    await expect(page.getByRole('button', { name: `确认报名 ${waiting.items[0].id} 签到`, exact: true })).toHaveCount(0);
    const after = await roster(request, fixture.id, { pageSize: 100 });
    expect(after.activity.registeredCount).toBe(before.activity.registeredCount);
    expect(after.activity.waitingCount).toBe(before.activity.waitingCount);
    expect(after.items.map(item => [item.id, item.status, item.createdAt, item.updatedAt])).toEqual(
      before.items.map(item => [item.id, item.status, item.createdAt, item.updatedAt]));
    await capture(page, info, 'check-in-roster');
  } finally { await logoutApi(page.request); await logoutApi(request); }
});

test('签到资格和管理权限由后端验证，前未开始和已取消名单阻止操作', async ({ page, request, playwright }, info) => {
  const guest = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  try {
    await loginApi(request);
    const started = await fixtures(request, info, ['ACTIVE', 'WAITING', 'CANCELLED']);
    const upcoming = await fixtures(request, info, ['ACTIVE'], { future: true });
    const cancelled = await fixtures(request, info, ['CANCELLED'], { cancelled: true });
    await login(page);
    const upcomingRoster = await openRoster(page, upcoming.id);
    await expect(page.getByRole('button', { name: `确认报名 ${upcomingRoster.items[0].id} 签到`, exact: true })).toBeDisabled();
    await expect(page.getByText('活动开始后开放签到。', { exact: true })).toBeVisible();
    const cancelledRoster = await openRoster(page, cancelled.id);
    await expect(page.getByRole('button', { name: /确认报名 .* 签到/ })).toHaveCount(0);
    await expect(page.locator(`[data-registration-id="${cancelledRoster.items[0].id}"]`)).toContainText('不适用');
    for (const [id, row, code, status] of [
      [upcoming.id, upcomingRoster.items[0], 'CHECK_IN_NOT_OPEN', 409],
      [cancelled.id, cancelledRoster.items[0], 'ACTIVITY_CANCELLED', 409],
      [started.id, started.before.items.find(item => item.status === 'WAITING')!, 'REGISTRATION_NOT_ACTIVE', 409],
      [started.id, started.before.items.find(item => item.status === 'CANCELLED')!, 'REGISTRATION_NOT_ACTIVE', 409],
      [started.id, upcomingRoster.items[0], 'REGISTRATION_NOT_FOUND', 404],
    ] as const) {
      const response = await write(request, `/api/admin/activities/${id}/registrations/${row.id}/check-in`);
      expect(response.status()).toBe(status);
      expect((await response.json()).code).toBe(code);
    }
    await logout(page);
    const reads: string[] = [];
    page.on('request', request => {
      if (request.method() === 'GET' && new URL(request.url()).pathname.startsWith('/api/admin/')) reads.push(request.url());
    });
    await page.goto(`/admin/activities/${started.id}/registrations`);
    await expect(page).toHaveURL(/\/login$/);
    expect(reads).toEqual([]);
    await login(page, started.accounts[0]);
    await page.goto(`/admin/activities/${started.id}/registrations`);
    await expect(page.getByText('此页面仅对活动组织者开放', { exact: true })).toBeVisible();
    expect(reads).toEqual([]);
    const active = started.before.items.find(item => item.status === 'ACTIVE')!;
    const denied = await write(page.request, `/api/admin/activities/${started.id}/registrations/${active.id}/check-in`);
    expect(denied.status()).toBe(403);
    expect((await denied.json()).code).toBe('FORBIDDEN');
    for (const client of [guest, page.request]) {
      const response = await client.get(`/api/admin/activities/${started.id}/registrations/export`);
      expect(response.status()).toBe(client === guest ? 401 : 403);
      expect((await response.json()).code).toBe(client === guest ? 'UNAUTHENTICATED' : 'FORBIDDEN');
    }
    expect(await roster(request, started.id, { pageSize: 100 })).toEqual(started.before);
    await capture(page, info, 'check-in-access-denied');
  } finally { await guest.dispose(); await logoutApi(page.request); await logoutApi(request); }
});

test('CSV下载导出筛选全集而非当前页，中文、公式前缀、引号和单元格内换行安全，空筛选仅有表头', async ({ page, request }, info) => {
  try {
    await loginApi(request);
    const fixture = await fixtures(request, info, [...Array<RegistrationStatus>(13).fill('ACTIVE'), 'WAITING', 'CANCELLED'], { specialText: true });
    const first = fixture.before.items.find(item => item.userId === fixture.accounts[0].id)!;
    expect((await write(request, `/api/admin/activities/${fixture.id}/registrations/${first.id}/check-in`)).status()).toBe(200);
    await login(page);
    await openRoster(page, fixture.id);
    const secondPage = pageRoster(page, fixture.id, { page: 2 });
    await page.locator('.roster-table .ant-pagination-item-2').click();
    await assertRoster(page, await secondPage);
    const all = await roster(request, fixture.id, { pageSize: 100 });
    const csv = await exportCsv(page, fixture.id);
    expect(csv).toHaveLength(16);
    expect(csv.slice(1).map(row => row[0])).toEqual(all.items.map(item => `\t${item.id}`));
    for (const item of all.items) {
      const row = csv.find(row => row[0] === `\t${item.id}`)!;
      expect(row[1]).toBe(`\t${item.username}`);
      expect(row[2]).toBe(`\t${item.displayName}`);
      expect(row[3]).toBe(item.status === 'ACTIVE' ? '有效报名' : item.status === 'WAITING' ? '候补' : '已取消');
      expect(row[4]).toBe(item.status !== 'ACTIVE' ? '不适用' : item.checkedInAt ? '已签到' : '未签到');
      const beijing = (utc: string | null) => utc ? new Date(Date.parse(utc) + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') : '';
      expect(row[5]).toBe(beijing(item.createdAt));
      expect(row[6]).toBe(beijing(item.updatedAt));
      expect(row[7]).toBe(beijing(item.checkedInAt));
      expect(row[8]).toBe(item.checkedInBy ? `\t${item.checkedInBy}` : '');
      expect(row[9]).toBe(item.checkedInByDisplayName ? `\t${item.checkedInByDisplayName}` : '');
    }
    expect(csv.find(row => row[0] === `\t${first.id}`)![2]).toBe(`\t=q,"${fixture.accounts[0].key}`);
    expect(csv.find(row => row[1] === `\t${fixture.accounts[1].username}`)![2]).toBe(`\tq,\n${fixture.accounts[1].key}`);
    const unmarkedLoaded = pageRoster(page, fixture.id, { checkInStatus: 'NOT_CHECKED_IN' });
    await choose(page, '签到状态', '未签到');
    expect((await unmarkedLoaded).total).toBe(12);
    const unmarked = await exportCsv(page, fixture.id);
    expect(unmarked).toHaveLength(13);
    expect(unmarked.slice(1).every(row => row[3] === '有效报名' && row[4] === '未签到')).toBeTruthy();
    const emptyLoaded = pageRoster(page, fixture.id, { status: 'WAITING', checkInStatus: 'NOT_CHECKED_IN' });
    await choose(page, '报名状态', '候补中');
    const empty = await emptyLoaded;
    expect(empty).toMatchObject({ items: [], total: 0 });
    await assertRoster(page, empty);
    expect(await exportCsv(page, fixture.id)).toHaveLength(1);
    await capture(page, info, 'check-in-export-filter');
  } finally { await logoutApi(page.request); await logoutApi(request); }
});

test('名单、签到和下载网络失败可重试，失败不写入签到也不产生下载', async ({ page, request }, info) => {
  let failRead = true; let failCheckIn = true; let failExport = true;
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  try {
    await loginApi(request);
    const fixture = await fixtures(request, info, ['ACTIVE']);
    const row = fixture.before.items[0];
    await login(page);
    await page.route(`**/api/admin/activities/${fixture.id}/registrations?**`, route => failRead ? route.abort('failed') : route.continue());
    await page.goto(`/admin/activities/${fixture.id}/registrations`);
    await expect(page.getByText(networkError, { exact: true })).toBeVisible();
    await expect(page.getByTestId('roster-active-count')).toHaveText('—');
    failRead = false;
    const loaded = pageRoster(page, fixture.id);
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await assertRoster(page, await loaded);
    await page.route(`**/api/admin/activities/${fixture.id}/registrations/${row.id}/check-in`, route => failCheckIn ? route.abort('failed') : route.continue());
    await page.getByRole('button', { name: `确认报名 ${row.id} 签到`, exact: true }).click();
    const modal = page.getByRole('dialog', { name: '确认签到', exact: true });
    await modal.getByRole('button', { name: '确认签到', exact: true }).click();
    await expect(modal.getByText(networkError, { exact: true })).toBeVisible();
    expect((await roster(request, fixture.id)).items[0].checkedInAt).toBeNull();
    failCheckIn = false;
    const checked = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith(`/registrations/${row.id}/check-in`));
    await modal.getByRole('button', { name: '确认签到', exact: true }).click();
    expect((await checked).status()).toBe(200);
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId('roster-checked-in-count')).toHaveText('1');
    await page.route(`**/api/admin/activities/${fixture.id}/registrations/export?**`, route => failExport ? route.abort('failed') : route.continue());
    await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
    await expect(page.getByText(networkError, { exact: true })).toBeVisible();
    expect(downloads).toEqual([]);
    failExport = false;
    expect(await exportCsv(page, fixture.id)).toHaveLength(2);
    expect(downloads).toEqual([`activity-${fixture.id}-registrations.csv`]);
    await capture(page, info, 'check-in-errors-recovered');
  } finally { await page.unrouteAll({ behavior: 'wait' }); await logoutApi(page.request); await logoutApi(request); }
});

test('签到真实成功响应迟到时浏览器返回并切换账号，不覆盖新身份或显示旧成功', async ({ page, request }, info) => {
  const delay = heldResponse();
  try {
    await loginApi(request);
    const fixture = await fixtures(request, info, ['ACTIVE']);
    const row = fixture.before.items[0];
    await login(page);
    await page.goto(`/activities/${fixture.id}`);
    const loaded = pageRoster(page, fixture.id);
    await page.getByRole('link', { name: '报名名单', exact: true }).click();
    await assertRoster(page, await loaded);
    await page.route(`**/api/admin/activities/${fixture.id}/registrations/${row.id}/check-in`, async route => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      delay.arrived(); await delay.held;
      try { await route.fulfill({ response }); } finally { delay.delivered(); }
    });
    await page.getByRole('button', { name: `确认报名 ${row.id} 签到`, exact: true }).click();
    await page.getByRole('dialog', { name: '确认签到', exact: true }).getByRole('button', { name: '确认签到', exact: true }).click();
    await delay.fetched;
    await expect(page.getByRole('dialog', { name: '确认签到', exact: true }).getByRole('button', { name: '确认签到', exact: true })).toBeDisabled();
    await page.goBack();
    await expect(page.getByRole('heading', { name: fixture.title, exact: true })).toBeVisible();
    await logout(page);
    await loginViaUi(page, fixture.accounts[0]);
    delay.release(); await delay.completed; await settle(page);
    await expect(page.getByRole('button', { name: `账号菜单，${fixture.accounts[0].displayName}`, exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '确认签到', exact: true })).toHaveCount(0);
    await expect(page.getByText('签到成功，名单已刷新', { exact: true })).toHaveCount(0);
    const after = await roster(request, fixture.id);
    expect(after.items[0]).toMatchObject({ checkedInBy: fixture.admin.id, updatedAt: row.updatedAt });
    expect(after.items[0].checkedInAt).not.toBeNull();
    await capture(page, info, 'check-in-late-success');
  } finally { delay.release(); await page.unrouteAll({ behavior: 'wait' }); await logoutApi(page.request); await logoutApi(request); }
});

test('CSV真实成功响应迟到后筛选变更，不下载旧筛选文件，当前筛选仍能导出', async ({ page, request }, info) => {
  const delay = heldResponse();
  let hold = true;
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  try {
    await loginApi(request);
    const fixture = await fixtures(request, info, ['ACTIVE', 'WAITING']);
    await login(page);
    await openRoster(page, fixture.id);
    await page.route(`**/api/admin/activities/${fixture.id}/registrations/export?**`, async route => {
      if (!hold) { await route.continue(); return; }
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      delay.arrived(); await delay.held;
      try { await route.fulfill({ response }); } finally { delay.delivered(); }
    });
    await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
    await delay.fetched;
    const current = pageRoster(page, fixture.id, { status: 'WAITING' });
    await choose(page, '报名状态', '候补中');
    const filtered = await current;
    expect(filtered.total).toBe(1);
    await assertRoster(page, filtered);
    delay.release(); await delay.completed; await settle(page);
    expect(downloads).toEqual([]);
    hold = false;
    const csv = await exportCsv(page, fixture.id);
    expect(csv).toHaveLength(2);
    expect(csv[1][3]).toBe('候补');
    await capture(page, info, 'export-late-filter-response');
  } finally { delay.release(); await page.unrouteAll({ behavior: 'wait' }); await logoutApi(page.request); await logoutApi(request); }
});

test('CSV真实401迟到后重新登录新账号，不显示旧错误也不下载名单', async ({ page, request }, info) => {
  const delay = heldResponse();
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  try {
    await loginApi(request);
    const fixture = await fixtures(request, info, ['ACTIVE']);
    await login(page);
    await openRoster(page, fixture.id);
    await page.route(`**/api/admin/activities/${fixture.id}/registrations/export?**`, async route => {
      await logoutApi(page.request);
      const response = await route.fetch();
      expect(response.status()).toBe(401);
      expect((await response.json()).code).toBe('UNAUTHENTICATED');
      delay.arrived(); await delay.held;
      try { await route.fulfill({ response }); } finally { delay.delivered(); }
    });
    await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
    await delay.fetched;
    // The old server Session has expired. Stay inside the SPA while replacing its trusted identity.
    await logout(page);
    await loginViaUi(page, fixture.accounts[0]);
    delay.release(); await delay.completed; await settle(page);
    await expect(page.getByRole('button', { name: `账号菜单，${fixture.accounts[0].displayName}`, exact: true })).toBeVisible();
    expect(downloads).toEqual([]);
    await expect(page.getByText('请先登录', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '报名名单', exact: true })).toHaveCount(0);
    await capture(page, info, 'export-late-expired-session');
  } finally { delay.release(); await page.unrouteAll({ behavior: 'wait' }); await logoutApi(page.request); await logoutApi(request); }
});

test('签到真实CSRF错误迟到后浏览器返回并切换账号，不显示旧错误且数据库未签到', async ({ page, request }, info) => {
  const delay = heldResponse();
  let writes = 0;
  try {
    await loginApi(request);
    const fixture = await fixtures(request, info, ['ACTIVE']);
    const row = fixture.before.items[0];
    await login(page);
    await page.goto(`/activities/${fixture.id}`);
    const loaded = pageRoster(page, fixture.id);
    await page.getByRole('link', { name: '报名名单', exact: true }).click();
    await assertRoster(page, await loaded);
    await page.route(`**/api/admin/activities/${fixture.id}/registrations/${row.id}/check-in`, async route => {
      writes++;
      // A real expired Session invalidates its previously issued CSRF token. No status/body is fabricated.
      await logoutApi(page.request);
      const response = await route.fetch();
      expect(response.status()).toBe(403);
      expect((await response.json()).code).toBe('CSRF_INVALID');
      delay.arrived(); await delay.held;
      try { await route.fulfill({ response }); } finally { delay.delivered(); }
    });
    await page.getByRole('button', { name: `确认报名 ${row.id} 签到`, exact: true }).click();
    await page.getByRole('dialog', { name: '确认签到', exact: true }).getByRole('button', { name: '确认签到', exact: true }).click();
    await delay.fetched;
    await page.goBack();
    await expect(page.getByRole('heading', { name: fixture.title, exact: true })).toBeVisible();
    // The detail's private favorite read now detects the Session invalidated above.
    await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '登录后收藏', exact: true })).toBeVisible();
    await loginViaUi(page, fixture.accounts[0]);
    delay.release(); await delay.completed; await settle(page);
    await expect(page.getByRole('button', { name: `账号菜单，${fixture.accounts[0].displayName}`, exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '确认签到', exact: true })).toHaveCount(0);
    await expect(page.getByText('安全凭证已失效，请刷新后重试', { exact: true })).toHaveCount(0);
    expect(writes).toBe(1);
    expect(await roster(request, fixture.id, { pageSize: 100 })).toEqual(fixture.before);
    await capture(page, info, 'check-in-late-expired-csrf');
  } finally { delay.release(); await page.unrouteAll({ behavior: 'wait' }); await logoutApi(page.request); await logoutApi(request); }
});

test('CSV真实成功响应迟到后退出并切换账号，不下载上一身份的报名名单', async ({ page, request }, info) => {
  const delay = heldResponse();
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  try {
    await loginApi(request);
    const fixture = await fixtures(request, info, ['ACTIVE']);
    await login(page);
    await openRoster(page, fixture.id);
    await page.route(`**/api/admin/activities/${fixture.id}/registrations/export?**`, async route => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      delay.arrived(); await delay.held;
      try { await route.fulfill({ response }); } finally { delay.delivered(); }
    });
    await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
    await delay.fetched;
    await logout(page);
    await loginViaUi(page, fixture.accounts[0]);
    delay.release(); await delay.completed; await settle(page);
    await expect(page.getByRole('button', { name: `账号菜单，${fixture.accounts[0].displayName}`, exact: true })).toBeVisible();
    expect(downloads).toEqual([]);
    await expect(page.getByRole('heading', { name: '报名名单', exact: true })).toHaveCount(0);
    await capture(page, info, 'export-late-account-response');
  } finally { delay.release(); await page.unrouteAll({ behavior: 'wait' }); await logoutApi(page.request); await logoutApi(request); }
});
