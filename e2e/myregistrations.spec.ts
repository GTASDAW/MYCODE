import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { databaseConfig, verifyDatabase, trackAccount, recordAccountId, trackFixture, recordFixtureId } from '../scripts/e2e-cleanup.mjs';

// Screenshots contain UI only; never retain Session/CSRF headers in browser traces.
test.use({ trace: 'off' });

type Status = 'ACTIVE' | 'WAITING' | 'CANCELLED';
interface Account { key: string; id: number; username: string; displayName: string }
interface Registration {
  id: number; status: Status; checkedInAt: string | null;
  activity: { id: number; title: string; description: string; closed: boolean; cancelled: boolean; registrationStatus: Status; registeredCount: number; waitingCount: number; cancellationReason: string | null };
}
interface Result {
  items: Registration[]; total: number; page: number; pageSize: number;
  summary: { activeRegistrations: number; waitingRegistrations: number; cancelledRegistrations: number; checkedInRegistrations: number };
}
interface Query { page?: number; pageSize?: number; status?: Status | 'ALL' }
const password = 'Demo123!';
const networkError = '暂时无法连接服务，请检查网络后重试。';

function parameters(query: Query = {}) {
  return new URLSearchParams({ page: String(query.page ?? 1), pageSize: String(query.pageSize ?? 10), status: query.status ?? 'ALL' });
}
function matches(url: URL, query: Query) {
  return url.pathname === '/api/me/registrations/search'
    && [...parameters(query)].every(([key, value]) => url.searchParams.get(key) === value);
}
async function result(request: APIRequestContext, query: Query = {}) {
  const response = await request.get(`/api/me/registrations/search?${parameters(query)}`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<Result>;
}
async function pageResult(page: Page, query: Query = {}) {
  // Strict Mode may cancel its first duplicate GET after headers arrive. Capture only a completed real body.
  const request = await page.waitForEvent('requestfinished', { predicate: request => request.method() === 'GET' && matches(new URL(request.url()), query) });
  const response = await request.response();
  expect(response?.status()).toBe(200);
  return response!.json() as Promise<Result>;
}
async function open(page: Page, query: Query = {}) {
  const loaded = pageResult(page, query);
  await page.goto(`/my-registrations?${parameters(query)}`);
  return loaded;
}
async function assertQuery(page: Page, query: Query = {}) {
  await expect.poll(() => {
    const url = new URL(page.url());
    return { path: url.pathname, page: Number(url.searchParams.get('page') ?? 1), pageSize: Number(url.searchParams.get('pageSize') ?? 10), status: url.searchParams.get('status') ?? 'ALL' };
  }).toEqual({ path: '/my-registrations', page: query.page ?? 1, pageSize: query.pageSize ?? 10, status: query.status ?? 'ALL' });
}
async function assertResult(page: Page, response: Result) {
  await expect(page.locator('.registration-row[data-registration-id]')).toHaveCount(response.items.length);
  await expect.poll(() => page.locator('.registration-row[data-registration-id]').evaluateAll(rows => rows.map(row => Number(row.getAttribute('data-registration-id')))))
    .toEqual(response.items.map(item => item.id));
  await expect(page.getByText(`当前筛选共 ${response.total} 条记录`, { exact: true })).toBeVisible();
  for (const [key, value] of Object.entries(response.summary)) {
    await expect.poll(async () => (await page.getByTestId(`myregistrations-${key}`).locator('.ant-statistic-content-value').innerText()).replace(/[\s,]/g, ''))
      .toBe(String(value));
  }
}
async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ has: page.getByText(option, { exact: true }) }).click();
  await expect(page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')).toHaveCount(0);
}
async function write(request: APIRequestContext, path: string, method: 'POST' | 'DELETE' = 'POST', data?: unknown) {
  const csrf = await request.get('/api/auth/csrf');
  expect(csrf.status()).toBe(200);
  const token = await csrf.json();
  return request.fetch(path, { method, data, headers: { [token.headerName]: token.token } });
}
async function loginApi(request: APIRequestContext, account?: Account) {
  const token = await (await request.get('/api/auth/csrf')).json();
  const response = await request.post('/api/auth/login', { form: { username: account?.username ?? 'admin', password: account ? password : 'Admin123!' }, headers: { [token.headerName]: token.token } });
  expect(response.status()).toBe(200);
}
async function logoutApi(request: APIRequestContext) {
  const me = await request.get('/api/auth/me');
  if (me.status() === 401) return;
  expect(me.status()).toBe(200);
  expect((await write(request, '/api/auth/logout')).status()).toBe(200);
}
async function register(request: APIRequestContext) {
  const account = trackAccount(['个人-']) as Account;
  const response = await write(request, '/api/auth/register', 'POST', { username: account.username, displayName: account.displayName, password });
  expect(response.status()).toBe(201);
  const user = await response.json();
  recordAccountId(account.key, user.id);
  return { ...account, id: user.id };
}
async function loginForm(page: Page, account: Account) {
  await page.getByLabel('账号', { exact: true }).fill(account.username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: `账号菜单，${account.displayName}`, exact: true })).toBeVisible();
}
async function login(page: Page, account: Account) {
  await page.goto('/login');
  await loginForm(page, account);
}
async function logout(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  await page.getByRole('menuitem', { name: /退出登录/ }).click();
  await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
}
async function loginWithinSpa(page: Page, account: Account) {
  if (new URL(page.url()).pathname !== '/login') await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
  await loginForm(page, account);
}
async function capture(page: Page, info: TestInfo, name: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  const path = info.outputPath(`${name}.png`);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
function heldResponse() {
  let release!: () => void; let arrived!: () => void; let delivered!: () => void;
  return { held: new Promise<void>(resolve => { release = resolve; }), fetched: new Promise<void>(resolve => { arrived = resolve; }), completed: new Promise<void>(resolve => { delivered = resolve; }),
    release: () => release(), arrived: () => arrived(), delivered: () => delivered() };
}

async function fixtures(request: APIRequestContext, info: TestInfo, statuses: Status[], options: { checkFirst?: boolean; cancelledLast?: boolean } = {}) {
  const account = await register(request);
  const manifestPath = process.env.E2E_RUN_MANIFEST;
  if (!manifestPath || dirname(resolve(manifestPath)) !== resolve('.runtime/e2e')) throw new Error('Verified fixture manifest is required.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const ownedAccount = manifest.accounts.find((row: Account) => row.key === account.key && row.id === account.id && row.username === account.username && row.displayName === account.displayName);
  if (!ownedAccount) throw new Error('Exact owned account proof is required.');
  const intents = statuses.map((_, index) => trackFixture(`我的报名 ${info.project.name} ${randomUUID().slice(0, 8)} ${index}`, '独立初始化的个人历史记录，仅写本轮精确归属活动及账号。'));
  const config = databaseConfig();
  const connection = await mysql.createConnection(config);
  const ids: number[] = [];
  try {
    await verifyDatabase(connection, config, manifest.target);
    // The global setup UUID probe already bound the API to this exact MySQL server/database.
    const me = await request.get('/api/auth/me');
    expect(me.status()).toBe(200);
    const admin = await me.json();
    expect(admin).toMatchObject({ username: 'admin', role: 'ADMIN' });
    await connection.beginTransaction();
    const [admins] = await connection.execute<any[]>("SELECT id, username, role FROM users WHERE id = ? AND username = 'admin' AND role = 'ADMIN' FOR UPDATE", [admin.id]);
    expect(admins).toEqual([{ id: admin.id, username: 'admin', role: 'ADMIN' }]);
    const [users] = await connection.execute<any[]>('SELECT id, username, display_name AS displayName, role FROM users WHERE id = ? FOR UPDATE', [account.id]);
    expect(users).toEqual([{ id: account.id, username: account.username, displayName: account.displayName, role: 'USER' }]);
    const now = Date.now();
    const utc = (value: number) => new Date(value).toISOString().replace('T', ' ').replace('Z', '');
    for (const [index, status] of statuses.entries()) {
      const intent = intents[index];
      const cancelled = options.cancelledLast === true && index === statuses.length - 1;
      if (cancelled && status !== 'CANCELLED') throw new Error('Cancelled fixtures must contain only cancelled registrations.');
      const [created] = await connection.execute<mysql.ResultSetHeader>(
        'INSERT INTO activities (title, description, location, starts_at, capacity, registered_count, created_by, cancelled_at, cancelled_by, cancellation_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [intent.title, intent.description, '个人报名独立临时场地', utc(now + (options.checkFirst && index === 0 ? -3600000 : 48 * 3600000)),
          status === 'WAITING' ? 1 : 2, status === 'CANCELLED' ? 0 : 1, admin.id,
          cancelled ? utc(now - 3600000) : null, cancelled ? admin.id : null, cancelled ? '本人历史活动取消原因' : null]);
      ids.push(created.insertId);
      const timestamp = utc(now - 2 * 3600000 - index * 1000);
      await connection.execute('INSERT INTO registrations (activity_id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [created.insertId, account.id, status, timestamp, timestamp]);
      if (status === 'WAITING') {
        await connection.execute("INSERT INTO registrations (activity_id, user_id, status, created_at, updated_at) VALUES (?, ?, 'ACTIVE', ?, ?)", [created.insertId, admin.id, timestamp, timestamp]);
      }
    }
    await connection.commit();
    ids.forEach((id, index) => recordFixtureId(intents[index].key, id));
    for (const [index, id] of ids.entries()) {
      const bound = await request.get(`/api/activities/${id}`);
      expect(bound.status()).toBe(200);
      expect(await bound.json()).toMatchObject({ id, title: intents[index].title, description: intents[index].description });
    }
    if (options.checkFirst) {
      expect(statuses[0]).toBe('ACTIVE');
      const roster = await (await request.get(`/api/admin/activities/${ids[0]}/registrations`)).json();
      const owned = roster.items.find((row: { userId: number }) => row.userId === account.id);
      expect((await write(request, `/api/admin/activities/${ids[0]}/registrations/${owned.id}/check-in`)).status()).toBe(200);
    }
    return { account, ids, titles: intents.map(intent => intent.title), admin };
  } catch (error) { await connection.rollback(); throw error; }
  finally { await connection.end(); }
}

test('我的报名真实分页和全量统计一致，本人签到只读，URL刷新历史和详情返回保留条件', async ({ page, request }, info) => {
  const privateWrites: string[] = [];
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.includes('/check-in')) privateWrites.push(request.url()); });
  try {
    await loginApi(request);
    const fixture = await fixtures(request, info, [...Array<Status>(8).fill('ACTIVE'), ...Array<Status>(3).fill('WAITING'), 'CANCELLED', 'CANCELLED'], { checkFirst: true, cancelledLast: true });
    await login(page, fixture.account);
    const first = await open(page);
    expect(first).toMatchObject({ total: 13, page: 1, pageSize: 10, summary: { activeRegistrations: 8, waitingRegistrations: 3, cancelledRegistrations: 2, checkedInRegistrations: 1 } });
    expect(first.items).toHaveLength(10);
    await assertResult(page, first);
    const checked = first.items.find(item => item.activity.id === fixture.ids[0])!;
    expect(Object.keys(checked).sort()).toEqual(['activity', 'checkedInAt', 'id', 'status']);
    expect(checked.checkedInAt).not.toBeNull();
    const checkedRow = page.getByTestId(`myregistration-${checked.id}`);
    await expect(checkedRow).toContainText('已签到');
    const beijing = new Date(Date.parse(checked.checkedInAt!) + 8 * 3600000).toISOString();
    await expect(checkedRow).toContainText(`${Number(beijing.slice(0, 4))}年${Number(beijing.slice(5, 7))}月${Number(beijing.slice(8, 10))}日`);
    await expect(checkedRow).toContainText(beijing.slice(11, 16));
    await expect(checkedRow.getByText('活动已开始', { exact: true })).toBeVisible();
    await expect(checkedRow).not.toContainText(fixture.admin.displayName);
    await expect(page.getByRole('button', { name: /确认.*签到/ })).toHaveCount(0);
    for (const row of first.items.filter(item => item.status === 'ACTIVE' && item.checkedInAt === null)) await expect(page.getByTestId(`myregistration-${row.id}`)).toContainText('未签到');
    const lastLoaded = pageResult(page, { page: 2 });
    await page.locator('[aria-label="报名分页"] .ant-pagination-item[title="2"]').click();
    const last = await lastLoaded;
    expect(last.items).toHaveLength(3);
    expect(new Set([...first.items, ...last.items].map(item => item.id)).size).toBe(13);
    expect([...first.items, ...last.items].map(item => item.activity.id)).toEqual(fixture.ids);
    expect(last.summary).toEqual(first.summary);
    await assertResult(page, last); await assertQuery(page, { page: 2 });
    for (const item of last.items) await expect(page.getByTestId(`myregistration-${item.id}`)).toContainText('不适用');
    await expect(page.getByTestId(`myregistration-${last.items.at(-1)!.id}`).getByTestId('activity-cancellation-notice')).toContainText('本人历史活动取消原因');
    const reload = pageResult(page, { page: 2 });
    await page.reload(); await assertResult(page, await reload);
    await page.getByTestId(`myregistration-${last.items[0].id}`).getByRole('link', { name: '查看活动', exact: true }).click();
    await expect(page.getByRole('heading', { name: last.items[0].activity.title, exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('from')).toBe('/my-registrations?page=2');
    await page.reload();
    await expect(page.getByRole('link', { name: '返回我的报名', exact: true })).toHaveAttribute('href', '/my-registrations?page=2');
    const returned = pageResult(page, { page: 2 });
    await page.getByRole('link', { name: '返回我的报名', exact: true }).click();
    await assertResult(page, await returned);
    await page.goBack();
    await expect(page.getByRole('heading', { name: last.items[0].activity.title, exact: true })).toBeVisible();
    // The previous list entry remains page 2. Navigate back once more before testing browser forward.
    await page.goBack();
    await assertResult(page, await result(page.request, { page: 2 }));
    await page.goForward();
    await expect(page.getByRole('heading', { name: last.items[0].activity.title, exact: true })).toBeVisible();
    const again = pageResult(page, { page: 2 });
    await page.getByRole('link', { name: '返回我的报名', exact: true }).click();
    await assertResult(page, await again);
    const resized = pageResult(page, { pageSize: 20 });
    await choose(page, '每页报名数量', '20 条/页');
    const larger = await resized;
    expect(larger.items).toHaveLength(13); expect(larger.summary).toEqual(first.summary);
    await assertResult(page, larger); await assertQuery(page, { pageSize: 20 });
    expect(privateWrites).toEqual([]);
    await capture(page, info, 'myregistrations-pagination-check-in');
  } finally { await logoutApi(page.request); await logoutApi(request); }
});

test('报名状态筛选读取全量统计，详情取消返回自动修正最后页，同条件刷新反映真实变更', async ({ page, request }, info) => {
  try {
    await loginApi(request);
    const fixture = await fixtures(request, info, Array<Status>(11).fill('ACTIVE'));
    await login(page, fixture.account);
    const last = await open(page, { status: 'ACTIVE', page: 2 });
    expect(last).toMatchObject({ total: 11, summary: { activeRegistrations: 11, waitingRegistrations: 0, cancelledRegistrations: 0, checkedInRegistrations: 0 } });
    await assertResult(page, last);
    const row = last.items[0];
    await page.getByTestId(`myregistration-${row.id}`).getByRole('link', { name: '查看活动', exact: true }).click();
    await page.getByRole('button', { name: '取消报名', exact: true }).click();
    await page.getByRole('button', { name: '确认取消', exact: true }).click();
    await expect(page.getByRole('button', { name: '重新报名', exact: true })).toBeVisible();
    const corrected = pageResult(page, { status: 'ACTIVE' });
    await page.getByRole('link', { name: '返回我的报名', exact: true }).click();
    const current = await corrected;
    expect(current).toMatchObject({ total: 10, page: 1, summary: { activeRegistrations: 10, cancelledRegistrations: 1 } });
    await assertResult(page, current); await assertQuery(page, { status: 'ACTIVE' });
    expect((await write(page.request, `/api/activities/${fixture.ids[0]}/registration`, 'DELETE')).status()).toBe(200);
    const refreshed = pageResult(page, { status: 'ACTIVE' });
    await page.getByRole('button', { name: '刷新报名', exact: true }).click();
    const updated = await refreshed;
    expect(updated).toMatchObject({ total: 9, summary: { activeRegistrations: 9, cancelledRegistrations: 2 } });
    await assertResult(page, updated);
    const cancelled = pageResult(page, { status: 'CANCELLED' });
    await choose(page, '报名状态', '已取消');
    const two = await cancelled;
    expect(two.total).toBe(2); expect(two.summary).toEqual(updated.summary);
    await assertResult(page, two);
    const waiting = pageResult(page, { status: 'WAITING' });
    await choose(page, '报名状态', '候补');
    const empty = await waiting;
    expect(empty).toMatchObject({ items: [], total: 0 }); expect(empty.summary).toEqual(updated.summary);
    await expect(page.getByText('暂无符合条件的报名记录', { exact: true })).toBeVisible();
    const allLoaded = pageResult(page);
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    const all = await allLoaded; expect(all.total).toBe(11); await assertResult(page, all);
    await capture(page, info, 'myregistrations-filter-return');
  } finally { await logoutApi(page.request); await logoutApi(request); }
});

test('匿名先登录不读取私人名单，空集合、非法URL和越界页修正，以及详情来源拒绝外部或管理路径', async ({ page, request }, info) => {
  const reads: string[] = [];
  const listener = (request: { url(): string }) => { if (new URL(request.url()).pathname === '/api/me/registrations/search') reads.push(request.url()); };
  try {
    await loginApi(request);
    const account = await register(request);
    const fixture = await fixtures(request, info, ['ACTIVE']);
    page.on('request', listener);
    await page.goto('/my-registrations?status=WAITING&page=2');
    await expect(page).toHaveURL(/\/login$/);
    expect(reads).toEqual([]);
    expect((await page.request.get('/api/me/registrations/search')).status()).toBe(401);
    page.off('request', listener);
    const corrected = pageResult(page, { status: 'WAITING' });
    await loginForm(page, account);
    await assertQuery(page, { status: 'WAITING' });
    expect(await corrected).toMatchObject({ total: 0, items: [] });
    await expect(page.getByText('暂无符合条件的报名记录', { exact: true })).toBeVisible();
    const all = pageResult(page);
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    expect(await all).toMatchObject({ items: [], total: 0, summary: { activeRegistrations: 0, waitingRegistrations: 0, cancelledRegistrations: 0, checkedInRegistrations: 0 } });
    await expect(page.getByText('还没有报名记录', { exact: true })).toBeVisible();
    const invalid = pageResult(page);
    await page.goto('/my-registrations?status=ADMIN&page=-1&pageSize=101');
    expect((await invalid).total).toBe(0); await assertQuery(page);
    for (const from of ['https://example.com/my-registrations', '//example.com', '/admin/activities', '/my-registrations#x', '/my-registrations\\evil']) {
      await page.goto(`/activities/${fixture.ids[0]}?${new URLSearchParams({ from })}`);
      await expect(page.getByRole('heading', { name: fixture.titles[0], exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: '返回活动列表', exact: true })).toHaveAttribute('href', '/activities');
      await expect(page.getByRole('link', { name: '返回我的报名', exact: true })).toHaveCount(0);
    }
    await capture(page, info, 'myregistrations-safe-detail-source');
  } finally { page.off('request', listener); await logoutApi(page.request); await logoutApi(request); }
});

test('我的报名网络失败不显示伪造人数，可按原条件重试，真实登录过期重新认证', async ({ page, request }, info) => {
  let fail = true;
  try {
    await loginApi(request);
    const fixture = await fixtures(request, info, ['ACTIVE', 'WAITING', 'CANCELLED']);
    await login(page, fixture.account);
    await page.route('**/api/me/registrations/search?**', route => fail ? route.abort('failed') : route.continue());
    await page.goto('/my-registrations?status=WAITING');
    await expect(page.getByText(networkError, { exact: true })).toBeVisible();
    for (const key of ['activeRegistrations', 'waitingRegistrations', 'cancelledRegistrations', 'checkedInRegistrations']) {
      await expect(page.getByTestId(`myregistrations-${key}`).locator('.ant-statistic-content-value')).toHaveText('—');
    }
    fail = false;
    const loaded = pageResult(page, { status: 'WAITING' });
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    const recovered = await loaded;
    expect(recovered).toMatchObject({ total: 1, summary: { activeRegistrations: 1, waitingRegistrations: 1, cancelledRegistrations: 1, checkedInRegistrations: 0 } });
    await assertResult(page, recovered); await assertQuery(page, { status: 'WAITING' });
    await logoutApi(page.request);
    const expired = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me/registrations/search' && response.status() === 401);
    await page.getByRole('button', { name: '刷新报名', exact: true }).click();
    expect((await expired).status()).toBe(401);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('登录已过期，请重新登录后继续。', { exact: true })).toBeVisible();
    const renewed = pageResult(page, { status: 'WAITING' });
    await loginForm(page, fixture.account);
    await assertResult(page, await renewed); await assertQuery(page, { status: 'WAITING' });
    await capture(page, info, 'myregistrations-read-recovery');
  } finally { await page.unrouteAll({ behavior: 'wait' }); await logoutApi(page.request); await logoutApi(request); }
});

test('同账号筛选变化后的真实旧查询迟到，不覆盖当前名单、URL或全量统计', async ({ page, request }, info) => {
  const delay = heldResponse();
  let hold = true;
  try {
    await loginApi(request);
    const fixture = await fixtures(request, info, ['ACTIVE', 'WAITING', 'CANCELLED']);
    await login(page, fixture.account);
    await assertResult(page, await open(page));
    await page.route('**/api/me/registrations/search?**', async route => {
      if (!hold || new URL(route.request().url()).searchParams.get('status') !== 'ALL') { await route.continue(); return; }
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      expect((await response.json()).total).toBe(3);
      delay.arrived(); await delay.held;
      try { await route.fulfill({ response }); } finally { delay.delivered(); }
    });
    await page.getByRole('button', { name: '刷新报名', exact: true }).click();
    await delay.fetched;
    hold = false;
    expect((await write(page.request, `/api/activities/${fixture.ids[0]}/registration`, 'DELETE')).status()).toBe(200);
    const currentLoaded = pageResult(page, { status: 'CANCELLED' });
    await choose(page, '报名状态', '已取消');
    const current = await currentLoaded;
    expect(current).toMatchObject({ total: 2, summary: { activeRegistrations: 0, waitingRegistrations: 1, cancelledRegistrations: 2 } });
    await assertResult(page, current);
    delay.release(); await delay.completed; await settle(page);
    await assertResult(page, current); await assertQuery(page, { status: 'CANCELLED' });
    await capture(page, info, 'myregistrations-late-filter');
  } finally { delay.release(); await page.unrouteAll({ behavior: 'wait' }); await logoutApi(page.request); await logoutApi(request); }
});

for (const outcome of ['success', 'expired'] as const) {
  for (const identity of ['other', 'same'] as const) {
    test(`真实我的报名${outcome === 'success' ? '成功' : '401错误'}迟到后${identity === 'same' ? '同账号重新登录' : '切换账号'}，不覆盖新名单统计或身份`, async ({ page, request }, info) => {
      const delay = heldResponse();
      let hold = true;
      try {
        await loginApi(request);
        const fixture = await fixtures(request, info, ['ACTIVE', 'WAITING']);
        const second = identity === 'same' ? fixture.account : await register(request);
        await login(page, fixture.account);
        await assertResult(page, await open(page));
        if (outcome === 'expired') await logoutApi(page.request);
        await page.route('**/api/me/registrations/search?**', async route => {
          if (!hold) { await route.continue(); return; }
          const response = await route.fetch();
          expect(response.status()).toBe(outcome === 'success' ? 200 : 401);
          if (outcome === 'success') expect((await response.json()).total).toBe(2);
          else expect((await response.json()).code).toBe('UNAUTHENTICATED');
          delay.arrived(); await delay.held;
          try { await route.fulfill({ response }); } finally { delay.delivered(); }
        });
        await page.getByRole('button', { name: '刷新报名', exact: true }).click();
        await delay.fetched; hold = false;
        // Mutate this owned record through a fresh valid token before relogin, so same-ID results differ.
        if (identity === 'same' && outcome === 'success') expect((await write(page.request, `/api/activities/${fixture.ids[0]}/registration`, 'DELETE')).status()).toBe(200);
        await logout(page);
        await loginWithinSpa(page, second);
        if (new URL(page.url()).pathname !== '/my-registrations') {
          const currentLoaded = pageResult(page);
          await page.getByRole('link', { name: '我的报名', exact: true }).click();
          await currentLoaded;
        }
        const current = await result(page.request);
        if (identity === 'other') {
          expect(current).toMatchObject({ items: [], total: 0, summary: { activeRegistrations: 0, waitingRegistrations: 0, cancelledRegistrations: 0, checkedInRegistrations: 0 } });
          await expect(page.getByText('还没有报名记录', { exact: true })).toBeVisible();
        } else {
          expect(current.summary.activeRegistrations).toBe(outcome === 'success' ? 0 : 1);
          await assertResult(page, current);
        }
        delay.release(); await delay.completed; await settle(page);
        await expect(page.getByRole('button', { name: `账号菜单，${second.displayName}`, exact: true })).toBeVisible();
        expect((await (await page.request.get('/api/auth/me')).json()).username).toBe(second.username);
        await expect(page.getByText('登录已过期，请重新登录后继续。', { exact: true })).toHaveCount(0);
        if (identity === 'other') {
          await expect(page.getByText('还没有报名记录', { exact: true })).toBeVisible();
          await expect(page.getByText(fixture.titles[0], { exact: true })).toHaveCount(0);
          for (const key of Object.keys(current.summary)) await expect(page.getByTestId(`myregistrations-${key}`).locator('.ant-statistic-content-value')).toHaveText('0');
        } else await assertResult(page, current);
        await capture(page, info, `myregistrations-late-${outcome}-${identity}`);
      } finally { delay.release(); await page.unrouteAll({ behavior: 'wait' }); await logoutApi(page.request); await logoutApi(request); }
    });
  }
}
