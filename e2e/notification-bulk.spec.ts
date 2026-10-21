import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { test, expect, type APIRequestContext, type APIResponse, type Page, type Request, type TestInfo } from '@playwright/test';
import { databaseConfig, verifyDatabase, trackAccount, recordAccountId, trackFixture, recordFixtureId } from '../scripts/e2e-cleanup.mjs';

// Only screenshots are retained. Never record credentials, Session headers or notification response bodies in traces.
test.use({ trace: 'off' });

type NotificationType = 'PROMOTED' | 'ACTIVITY_CANCELLED';
interface Account { key: string; id: number; username: string; displayName: string; allowedDisplayNames: string[] }
interface Query { page?: number; pageSize?: number; status?: 'ALL' | 'UNREAD' | 'READ'; type?: NotificationType | 'ALL' }
interface NotificationItem { id: number; type: NotificationType; activityId: number; activityTitle: string; readAt: string | null }
interface NotificationPage { items: NotificationItem[]; total: number; page: number; pageSize: number; unreadCount: number }
interface Fixture { key: string; id: number; title: string; description: string; owner: Account; foreign: Account; actorId: number }
interface Event { account: Account; type: NotificationType; read?: boolean; age?: number }
const password = 'Demo123!';
const networkError = '暂时无法连接服务，请检查网络后重试。';
const listPath = '/api/me/notifications';
const bulkPath = `${listPath}/read-all`;
const parameters = (query: Query = {}) => new URLSearchParams({ page: String(query.page ?? 1), pageSize: String(query.pageSize ?? 10),
  status: query.status ?? 'ALL', type: query.type ?? 'ALL' });
function matches(url: URL, query: Query) {
  return [...parameters(query)].every(([key, value]) => (url.searchParams.get(key) ?? (key === 'page' ? '1' : key === 'pageSize' ? '10' : 'ALL')) === value);
}
async function csrf(request: APIRequestContext) {
  const response = await request.get('/api/auth/csrf'); expect(response.status()).toBe(200); return response.json();
}
async function write(request: APIRequestContext, path: string, data?: unknown) {
  const token = await csrf(request);
  return request.post(path, { data, headers: { [token.headerName]: token.token } });
}
async function loginApi(request: APIRequestContext, account?: Account) {
  const token = await csrf(request);
  const response = await request.post('/api/auth/login', { form: { username: account?.username ?? 'admin', password: account ? password : 'Admin123!' },
    headers: { [token.headerName]: token.token } });
  expect(response.status()).toBe(200);
}
async function logoutApi(request: APIRequestContext) {
  const current = await request.get('/api/auth/me'); if (current.status() === 401) return;
  expect(current.status()).toBe(200); expect((await write(request, '/api/auth/logout')).status()).toBe(200);
}
async function loginForm(page: Page, account: Account) {
  await page.getByLabel('账号', { exact: true }).fill(account.username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: `账号菜单，${account.displayName}`, exact: true })).toBeVisible();
}
async function login(page: Page, account: Account) { await page.goto('/login'); await loginForm(page, account); }
async function logout(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  const item = page.getByRole('menuitem', { name: /退出登录/ }); await expect(item).toBeVisible();
  const completed = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/auth/logout' && response.status() === 200);
  // Keyboard activation avoids the fixed-header/dropdown relocation race on mobile.
  await item.press('Enter'); await completed;
  await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
}
async function notifications(request: APIRequestContext, query: Query = {}): Promise<NotificationPage> {
  const response = await request.get(`${listPath}?${parameters(query)}`); expect(response.status()).toBe(200); return response.json();
}
async function pageResult(page: Page, query: Query = {}): Promise<NotificationPage> {
  // Strict Mode may abort an earlier request after its response event.
  const request = await page.waitForEvent('requestfinished', { predicate: request => request.method() === 'GET'
    && new URL(request.url()).pathname === listPath && matches(new URL(request.url()), query) });
  const response = await request.response(); expect(response?.status()).toBe(200); return response!.json();
}
async function assertQuery(page: Page, query: Query = {}) {
  await expect.poll(() => { const url = new URL(page.url()); return url.pathname === '/notifications' && matches(url, query); }).toBe(true);
}
async function assertResults(page: Page, result: NotificationPage) {
  const rows = page.locator('[data-notification-id]');
  await expect(rows).toHaveCount(result.items.length);
  await expect.poll(() => rows.evaluateAll(elements => elements.map(element => Number(element.getAttribute('data-notification-id')))))
    .toEqual(result.items.map(item => item.id));
  await expect(page.getByTestId('notification-unread-count')).toHaveText(String(result.unreadCount));
  for (const item of result.items) {
    const row = page.getByTestId(`notification-${item.id}`);
    await expect(row.getByRole('heading', { name: item.activityTitle, exact: true, includeHidden: true })).toBeVisible();
    await expect(row.locator('.notification-tags').getByText(item.readAt === null ? '未读' : '已读', { exact: true })).toBeVisible();
    await expect(row.getByText(item.type === 'PROMOTED' ? '候补递补成功' : '活动已取消', { exact: true })).toBeVisible();
  }
}
async function open(page: Page, query: Query = {}) {
  const loaded = pageResult(page, query); await page.goto(`/notifications?${parameters(query)}`);
  await expect(page.getByRole('heading', { name: '通知中心', exact: true })).toBeVisible();
  const result = await loaded; await assertResults(page, result); await assertQuery(page, query); return result;
}
async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ has: page.getByText(option, { exact: true }) }).click();
}
async function filter(page: Page, query: Query, label: string, option: string) {
  const loaded = pageResult(page, query); await choose(page, label, option);
  const result = await loaded; await assertResults(page, result); await assertQuery(page, query); return result;
}
const bulkButton = (page: Page) => page.getByRole('button', { name: '全部标为已读', exact: true });
const bulkDialog = (page: Page) => page.getByRole('dialog', { name: '全部标为已读', exact: true });
async function confirmDialog(page: Page) {
  await bulkButton(page).click(); await expect(bulkDialog(page)).toBeVisible();
  await expect(bulkDialog(page)).toContainText(/所有类型|全部类型/);
  await expect(bulkDialog(page)).toContainText(/分页|页面/);
}
async function confirm(page: Page) {
  await confirmDialog(page); await bulkDialog(page).getByRole('button', { name: '确认全部已读', exact: true }).click();
}
async function capture(page: Page, info: TestInfo, name: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const path = info.outputPath(`${name}.png`); await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

function manifest(info: TestInfo) {
  const path = process.env.E2E_RUN_MANIFEST;
  if (!path || dirname(resolve(path)) !== resolve('.runtime/e2e')) throw new Error('A verified local fixture manifest is required.');
  const recorded = JSON.parse(readFileSync(path, 'utf8'));
  if (recorded.baseUrl !== new URL(info.project.use.baseURL!).origin) throw new Error('Fixture API origin differs from the verified run.');
  return recorded;
}
async function seed(request: APIRequestContext, info: TestInfo, fixture: Fixture, events: Event[]) {
  const recorded = manifest(info);
  expect(recorded.fixtures.find((item: Fixture) => item.key === fixture.key)).toMatchObject({ id: fixture.id, title: fixture.title, description: fixture.description });
  for (const account of [fixture.owner, fixture.foreign])
    expect(recorded.accounts.find((item: Account) => item.key === account.key)).toMatchObject({ id: account.id, username: account.username, displayName: account.displayName });
  const bound = await request.get(`/api/activities/${fixture.id}`); expect(bound.status()).toBe(200);
  expect(await bound.json()).toMatchObject({ id: fixture.id, title: fixture.title, description: fixture.description });
  const config = databaseConfig(), connection = await mysql.createConnection(config);
  try {
    await verifyDatabase(connection, config, recorded.target);
    const current = await request.get('/api/auth/me'); expect(current.status()).toBe(200);
    expect(await current.json()).toMatchObject({ id: fixture.actorId, username: 'admin', role: 'ADMIN' });
    await connection.beginTransaction();
    const [activities] = await connection.execute<any[]>('SELECT id,title,description,created_by AS actorId FROM activities WHERE id=? FOR UPDATE', [fixture.id]);
    expect(activities).toEqual([{ id: fixture.id, title: fixture.title, description: fixture.description, actorId: fixture.actorId }]);
    for (const account of [fixture.owner, fixture.foreign].sort((first, second) => first.id - second.id)) {
      const [users] = await connection.execute<any[]>('SELECT id,username,display_name AS displayName,role FROM users WHERE id=? FOR UPDATE', [account.id]);
      expect(users).toEqual([{ id: account.id, username: account.username, displayName: account.displayName, role: 'USER' }]);
    }
    const ids: number[] = [];
    for (const [index, event] of events.entries()) {
      expect([fixture.owner.id, fixture.foreign.id]).toContain(event.account.id);
      const [created] = await connection.execute<mysql.ResultSetHeader>(
        'INSERT INTO notifications(user_id,activity_id,type,activity_title,cancellation_reason,created_at,read_at) '
        + 'VALUES(?,?,?,?,?,UTC_TIMESTAMP(6)-INTERVAL ? SECOND,IF(?,UTC_TIMESTAMP(6)-INTERVAL 1 SECOND,NULL))',
        [event.account.id, fixture.id, event.type, fixture.title, event.type === 'ACTIVITY_CANCELLED' ? '本轮独立活动的取消通知快照' : null,
          event.age ?? index + 60, event.read ?? false]);
      ids.push(created.insertId);
    }
    await connection.commit(); return ids;
  } catch (error) { await connection.rollback(); throw error; } finally { await connection.end(); }
}
async function fixtures(request: APIRequestContext, info: TestInfo, options: { count?: number; read?: number; onlyPromoted?: boolean } = {}): Promise<Fixture> {
  await loginApi(request);
  const accounts: Account[] = [];
  for (let index = 0; index < 2; index++) {
    const intent = trackAccount(['批-']);
    const response = await write(request, '/api/auth/register', { username: intent.username, displayName: intent.displayName, password });
    expect(response.status()).toBe(201); const user = await response.json(); recordAccountId(intent.key, user.id);
    accounts.push({ ...intent, id: user.id });
  }
  const intent = trackFixture(`批量通知 ${info.project.name} ${randomUUID().slice(0, 8)}`, '本轮独立通知类型与全部已读浏览器夹具。');
  const created = await write(request, '/api/admin/activities', { title: intent.title, description: intent.description, location: '通知独立验证场地',
    capacity: 1, startsAt: new Date(Date.now() + 48 * 3600000).toISOString() });
  expect(created.status()).toBe(201); const activity = await created.json(); recordFixtureId(intent.key, activity.id);
  const current = await request.get('/api/auth/me'); expect(current.status()).toBe(200); const actor = await current.json();
  const fixture: Fixture = { ...intent, id: activity.id, owner: accounts[0], foreign: accounts[1], actorId: actor.id };
  await seed(request, info, fixture, [
    ...Array.from({ length: options.count ?? 18 }, (_, index): Event => ({ account: fixture.owner,
      type: options.onlyPromoted || index % 2 === 0 ? 'PROMOTED' : 'ACTIVITY_CANCELLED', read: index < (options.read ?? 2) })),
    ...Array.from({ length: 3 }, (): Event => ({ account: fixture.foreign, type: 'ACTIVITY_CANCELLED' })),
  ]);
  return fixture;
}

async function settle(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
type Held = { ready: Promise<void>; release(): void; stopHolding(): void; delivered(): Promise<void>; cleanup(): Promise<void>; count(): number };
async function hold(page: Page, path: string, query?: Query, method = 'GET', options: { failure?: boolean; expired?: boolean } = {}): Promise<Held> {
  let release!: () => void, ready!: () => void, reject!: (error: unknown) => void, armed = true, count = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetched = new Promise<void>((resolve, failed) => { ready = resolve; reject = failed; });
  const jobs: Promise<{ error?: unknown }>[] = [], outcomes: Promise<{ failed?: string; status?: number }>[] = [];
  const matcher = (url: URL) => url.pathname === path && (query === undefined || matches(url, query));
  let expired: Promise<void> | undefined;
  await page.route(matcher, route => {
    if (route.request().method() !== method) return route.continue();
    count++; if (!armed) return route.continue();
    const target = route.request();
    // Hold every matching GET, including Strict Mode replacements; dispatch the mutation once.
    if (method !== 'GET') armed = false;
    outcomes.push(new Promise(resolve => {
      const clear = () => { page.off('requestfinished', finished); page.off('requestfailed', failed); };
      const finished = async (request: Request) => { if (request !== target) return; clear(); resolve({ status: (await request.response())?.status() }); };
      const failed = (request: Request) => { if (request !== target) return; clear(); resolve({ failed: request.failure()?.errorText }); };
      page.on('requestfinished', finished); page.on('requestfailed', failed);
    }));
    const job = (async () => {
      try {
        // Invalidate the genuine old server Session; route.fetch keeps the intercepted request's old Cookie.
        if (options.expired) await (expired ??= logoutApi(page.request));
        let response: APIResponse;
        try { response = await route.fetch(); }
        catch (error) { if (method === 'GET' && /ERR_ABORTED|cancel/i.test(target.failure()?.errorText ?? '')) return; throw error; }
        expect(response.status()).toBe(options.expired ? 401 : 200);
        if (options.expired) expect((await response.json()).code).toBe('UNAUTHENTICATED');
        ready(); await gate;
        try { if (options.failure) await route.abort('failed'); else await route.fulfill({ response }); }
        catch (error) { if (!target.failure()) throw error; }
      } catch (error) { reject(error); throw error; }
    })();
    jobs.push(job.then(() => ({}), error => ({ error }))); return job;
  });
  const delivered = async () => {
    const errors = (await Promise.all(jobs)).flatMap(result => result.error === undefined ? [] : [result.error]);
    if (errors.length) throw new AggregateError(errors, 'A delayed genuine notification response failed.');
    for (const outcome of await Promise.all(outcomes)) {
      if (outcome.failed) expect(outcome.failed).toMatch(/ERR_ABORTED|ERR_FAILED|cancel/i);
      else expect(outcome.status).toBe(options.expired ? 401 : 200);
    }
    await settle(page);
  };
  return { ready: fetched, release, stopHolding: () => { armed = false; }, delivered, count: () => count,
    cleanup: async () => { armed = false; release(); try { await delivered(); } finally { await page.unroute(matcher); } } };
}

test.afterEach(async ({ page, request }) => {
  const results = await Promise.allSettled([logoutApi(page.request), logoutApi(request)]);
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'Owned notification-bulk sessions could not all log out.');
});

test('通知类型与状态共同筛选分页，全局未读数量不受影响且单条已读仍可用', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info); await login(page, fixture.owner);
  const initial = await open(page, { pageSize: 5 }); expect(initial).toMatchObject({ total: 18, unreadCount: 16 });
  const defaultResponse = await page.request.get(listPath); expect(defaultResponse.status()).toBe(200);
  expect(await defaultResponse.json()).toEqual(await notifications(page.request));
  expect((await page.request.get(`${listPath}?type=INVALID`)).status()).toBe(400);
  const promoted = await filter(page, { type: 'PROMOTED', pageSize: 5 }, '通知类型', '候补递补');
  expect(promoted).toMatchObject({ total: 9, unreadCount: 16 }); expect(promoted.items.every(item => item.type === 'PROMOTED')).toBe(true);
  const lastLoaded = pageResult(page, { type: 'PROMOTED', pageSize: 5, page: 2 });
  await page.locator('[aria-label="通知分页"] .ant-pagination-item[title="2"]').click();
  const last = await lastLoaded; expect(last.items).toHaveLength(4); await assertResults(page, last);
  const unread = await filter(page, { type: 'PROMOTED', pageSize: 5, status: 'UNREAD' }, '通知状态', '未读通知');
  expect(unread).toMatchObject({ total: 8, page: 1, unreadCount: 16 }); expect(unread.items.every(item => item.readAt === null)).toBe(true);
  const target = unread.items[0]; const updated = pageResult(page, { type: 'PROMOTED', pageSize: 5, status: 'UNREAD' });
  await page.getByRole('button', { name: `标记通知 ${target.id} 为已读`, exact: true }).click();
  const afterRead = await updated; expect(afterRead).toMatchObject({ total: 7, unreadCount: 15 }); await assertResults(page, afterRead);
  const read = await filter(page, { type: 'PROMOTED', pageSize: 5, status: 'READ' }, '通知状态', '已读通知');
  expect(read).toMatchObject({ total: 2, unreadCount: 15 }); expect(read.items.every(item => item.readAt !== null)).toBe(true);
  const cancelled = await filter(page, { type: 'ACTIVITY_CANCELLED', pageSize: 5, status: 'READ' }, '通知类型', '活动取消');
  expect(cancelled).toMatchObject({ total: 1, unreadCount: 15 });
  await filter(page, { type: 'ACTIVITY_CANCELLED', pageSize: 10, status: 'READ' }, '每页通知数量', '10 条/页');
  await capture(page, info, 'notification-type-status');
});

test('全部已读确认可取消，单次提交覆盖所有类型分页且保留首次时间和他人通知', { tag: '@redis' }, async ({ page, request, playwright }, info) => {
  const fixture = await fixtures(request, info); await login(page, fixture.owner);
  const query: Query = { type: 'PROMOTED', page: 2, pageSize: 5 };
  await open(page, query); const before = await notifications(page.request, { pageSize: 100 });
  const submissions: Request[] = []; const listener = (request: Request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === bulkPath) submissions.push(request);
  }; page.on('request', listener);
  try {
    await confirmDialog(page); await bulkDialog(page).getByRole('button', { name: '取消全部已读', exact: true }).click();
    await expect(bulkDialog(page)).toHaveCount(0); await settle(page); expect(submissions).toHaveLength(0);
    const written = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === bulkPath);
    const reloaded = pageResult(page, query); await confirm(page);
    const response = await written; expect(response.status()).toBe(200); expect(await response.json()).toEqual({ updatedCount: 16 });
    const result = await reloaded; expect(result).toMatchObject({ total: 9, page: 2, pageSize: 5, unreadCount: 0 });
    await assertResults(page, result); await assertQuery(page, query); expect(submissions).toHaveLength(1);
    expect(new URL(submissions[0].url()).search).toBe(''); expect(submissions[0].postData()).toBeNull();
    const after = await notifications(page.request, { pageSize: 100 }); expect(after.items).toHaveLength(18);
    expect(after.items.every(item => item.readAt !== null)).toBe(true);
    for (const item of before.items.filter(item => item.readAt !== null))
      expect(after.items.find(current => current.id === item.id)?.readAt).toBe(item.readAt);
    const duplicate = await write(page.request, bulkPath); expect(duplicate.status()).toBe(200); expect(await duplicate.json()).toEqual({ updatedCount: 0 });
    expect(await notifications(page.request, { pageSize: 100 })).toEqual(after); await expect(bulkButton(page)).toBeDisabled();
    const foreign = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
    try {
      await loginApi(foreign, fixture.foreign); const untouched = await notifications(foreign);
      expect(untouched).toMatchObject({ total: 3, unreadCount: 3 }); expect(untouched.items.every(item => item.readAt === null)).toBe(true);
    } finally { try { await logoutApi(foreign); } finally { await foreign.dispose(); } }
    await capture(page, info, 'notification-bulk-confirmed');
  } finally { page.off('request', listener); }
});

test('真实全部已读提交后新增通知仍未读，成功重读当前过滤页与非零全局角标', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info); await login(page, fixture.owner);
  const query: Query = { type: 'PROMOTED', page: 2, pageSize: 5 }; await open(page, query);
  const old = await hold(page, bulkPath, undefined, 'POST');
  try {
    await confirm(page); await old.ready;
    // The genuine 200 is held only after the server has committed; this new event was outside its captured set.
    const [newId] = await seed(request, info, fixture, [{ account: fixture.owner, type: 'ACTIVITY_CANCELLED', age: 0 }]);
    const committed = await notifications(page.request, { pageSize: 100 }); expect(committed.unreadCount).toBe(1);
    expect(committed.items.find(item => item.id === newId)?.readAt).toBeNull();
    const reloaded = pageResult(page, query); old.release(); await old.delivered();
    const result = await reloaded; expect(result).toMatchObject({ total: 9, page: 2, unreadCount: 1 });
    await assertResults(page, result); await assertQuery(page, query); await expect(bulkButton(page)).toBeEnabled(); expect(old.count()).toBe(1);
    expect((await notifications(page.request, { status: 'UNREAD' })).items.map(item => item.id)).toEqual([newId]);
    await capture(page, info, 'notification-bulk-new-arrival');
  } finally { await old.cleanup(); }
});

test('空类型状态页仍可全局已读，未读末页清空后replace纠正且返回不循环', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info, { read: 0 }); await login(page, fixture.owner);
  const previous: Query = { type: 'PROMOTED', status: 'READ' };
  const empty = await open(page, previous); expect(empty).toMatchObject({ total: 0, unreadCount: 18 });
  await expect(bulkButton(page)).toBeEnabled(); await expect(page.getByText('暂无已读通知', { exact: true })).toBeVisible();
  const query: Query = { status: 'UNREAD', page: 2 }; const last = await open(page, query); expect(last.items).toHaveLength(8);
  const corrected = pageResult(page, { status: 'UNREAD' }); await confirm(page);
  const result = await corrected; expect(result).toMatchObject({ total: 0, page: 1, unreadCount: 0 });
  await assertResults(page, result); await assertQuery(page, { status: 'UNREAD' });
  await expect(page.getByText('暂无未读通知', { exact: true })).toBeVisible(); await expect(bulkButton(page)).toBeDisabled();
  const returned = pageResult(page, previous); await page.goBack(); const back = await returned;
  await assertResults(page, back); await assertQuery(page, previous); expect(back.total).toBe(9);
  await capture(page, info, 'notification-bulk-empty-last-page');
});

test('尾斜杠未读末页真实提交后丢失响应，纠正页码仍保留网络错误', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info); await login(page, fixture.owner);
  const initial = pageResult(page, { status: 'UNREAD', page: 2 });
  // A legal trailing slash must not remount the page when correcting its query.
  await page.goto('/notifications/?status=UNREAD&page=2');
  const before = await initial; expect(before).toMatchObject({ total: 16, page: 2, unreadCount: 16 });
  await assertResults(page, before); await expect.poll(() => new URL(page.url()).pathname).toBe('/notifications/');
  const lost = await hold(page, bulkPath, undefined, 'POST', { failure: true });
  try {
    const corrected = pageResult(page, { status: 'UNREAD' });
    await confirm(page); await lost.ready; lost.release(); await lost.delivered();
    const result = await corrected; expect(result).toMatchObject({ total: 0, page: 1, unreadCount: 0 });
    await assertResults(page, result);
    await expect.poll(() => new URL(page.url()).pathname).toBe('/notifications/');
    await expect.poll(() => new URL(page.url()).search).toBe('?status=UNREAD');
    await expect(page.getByText(networkError, { exact: true })).toBeVisible();
    await expect(bulkButton(page)).toBeDisabled(); expect(lost.count()).toBe(1);
    const persisted = await notifications(page.request, { status: 'UNREAD' });
    expect(persisted).toMatchObject({ items: [], total: 0, unreadCount: 0 });
  } finally { await lost.cleanup(); }
});

test('类型状态分页URL在登录直达刷新与历史中保留，非法类型规范回全部', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info); const query: Query = { type: 'PROMOTED', status: 'UNREAD', page: 2, pageSize: 5 };
  const anonymousReads: string[] = []; const listener = (request: Request) => {
    if (new URL(request.url()).pathname.startsWith(listPath)) anonymousReads.push(new URL(request.url()).pathname);
  }; page.on('request', listener);
  await page.goto(`/notifications?${parameters(query)}`); await expect(page).toHaveURL(/\/login$/);
  expect(anonymousReads).toEqual([]); page.off('request', listener);
  const loggedIn = pageResult(page, query); await loginForm(page, fixture.owner); await assertResults(page, await loggedIn); await assertQuery(page, query);
  const refreshed = pageResult(page, query); await page.reload(); await assertResults(page, await refreshed); await assertQuery(page, query);
  const changed: Query = { type: 'ACTIVITY_CANCELLED', status: 'UNREAD', pageSize: 5 };
  const result = await filter(page, changed, '通知类型', '活动取消'); expect(result).toMatchObject({ total: 8, page: 1, unreadCount: 16 });
  const back = pageResult(page, query); await page.goBack(); await assertResults(page, await back); await assertQuery(page, query);
  const forward = pageResult(page, changed); await page.goForward(); await assertResults(page, await forward); await assertQuery(page, changed);
  const normalized = pageResult(page); await page.goto('/notifications?type=INVALID&status=INVALID&page=-1&pageSize=invalid');
  await assertResults(page, await normalized); await assertQuery(page);
  await expect.poll(() => new URL(page.url()).search).toBe(''); await capture(page, info, 'notification-type-url');
});

test('网络失败保留未读可手动恢复，真实CSRF错误只重试一次，未知和零未读禁用', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info); await login(page, fixture.owner); await open(page);
  const fail = (url: URL) => url.pathname === bulkPath;
  let failedPosts = 0;
  await page.route(fail, route => { if (route.request().method() !== 'POST') return route.continue(); failedPosts++; return route.abort('failed'); });
  try {
    await confirm(page); await expect(page.getByText(networkError, { exact: true })).toBeVisible();
    await expect(bulkButton(page)).toBeEnabled(); expect(failedPosts).toBe(1); expect((await notifications(page.request)).unreadCount).toBe(16);
  } finally { await page.unroute(fail); }
  const token = await csrf(page.request); let csrfPosts = 0; const statuses: number[] = [];
  const recovering = (url: URL) => url.pathname === bulkPath;
  await page.route(recovering, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    csrfPosts++;
    const response = await route.fetch(csrfPosts === 1 ? { headers: { ...route.request().headers(), [token.headerName.toLowerCase()]: 'invalid-e2e-csrf' } } : {});
    statuses.push(response.status()); if (csrfPosts === 1) { expect(response.status()).toBe(403); expect((await response.json()).code).toBe('CSRF_INVALID'); }
    await route.fulfill({ response });
  });
  try {
    const reloaded = pageResult(page); await confirm(page); const result = await reloaded;
    expect(result.unreadCount).toBe(0); await assertResults(page, result); expect(statuses).toEqual([403, 200]); expect(csrfPosts).toBe(2);
    await expect(bulkButton(page)).toBeDisabled();
  } finally { await page.unroute(recovering); }
  await seed(request, info, fixture, [{ account: fixture.owner, type: 'PROMOTED', age: 0 }]);
  const broken = await hold(page, listPath, {}, 'GET', { failure: true });
  try {
    await page.getByRole('button', { name: '刷新通知', exact: true }).click(); await broken.ready;
    await expect(page.getByTestId('notification-unread-count')).toHaveText('—'); await expect(bulkButton(page)).toBeDisabled();
    broken.stopHolding(); broken.release(); await broken.delivered();
    await expect(page.getByText(networkError, { exact: true })).toBeVisible(); await expect(bulkButton(page)).toBeDisabled();
    const recovered = pageResult(page); await page.getByRole('button', { name: '重新加载', exact: true }).click();
    const result = await recovered; expect(result.unreadCount).toBe(1); await assertResults(page, result); await expect(bulkButton(page)).toBeEnabled();
  } finally { await broken.cleanup(); }
});

test('切换通知类型时旧读取成功或失败不覆盖当前加载、角标或筛选', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info); await login(page, fixture.owner); await open(page);
  for (const failure of [false, true]) {
    const old = await hold(page, listPath, { type: 'PROMOTED' }, 'GET', { failure });
    const current = await hold(page, listPath, { type: 'ACTIVITY_CANCELLED' });
    try {
      await choose(page, '通知类型', '候补递补'); await old.ready;
      await choose(page, '通知类型', '活动取消'); await current.ready;
      old.stopHolding(); old.release(); await old.delivered();
      await expect(page.getByRole('button', { name: '刷新通知', exact: true })).toHaveClass(/ant-btn-loading/);
      await expect(page.getByTestId('notification-unread-count')).toHaveText('—'); await expect(bulkButton(page)).toBeDisabled();
      await expect(page.getByText(networkError, { exact: true })).toHaveCount(0);
      const loaded = pageResult(page, { type: 'ACTIVITY_CANCELLED' }); current.stopHolding(); current.release(); await current.delivered();
      const result = await loaded; expect(result).toMatchObject({ total: 9, unreadCount: 16 }); await assertResults(page, result);
      await assertQuery(page, { type: 'ACTIVITY_CANCELLED' }); await expect(bulkButton(page)).toBeEnabled();
    } finally { await old.cleanup(); await current.cleanup(); }
  }
});

test('旧全部已读成功与真实旧读取401迟到不污染切换账号或同账号重登后的通知和确认框', { tag: '@redis' }, async ({ page, request }, info) => {
  const fixture = await fixtures(request, info); await login(page, fixture.owner); await open(page);
  await filter(page, { type: 'PROMOTED' }, '通知类型', '候补递补');
  const loginInApp = async (account: Account) => {
    await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
    await loginForm(page, account);
  };
  const openInApp = async () => {
    const loaded = pageResult(page);
    await page.getByTestId('notification-bell').click();
    await assertResults(page, await loaded); await assertQuery(page);
  };
  const oldWrite = await hold(page, bulkPath, undefined, 'POST');
  try {
    await confirm(page); await oldWrite.ready;
    // Query history stays in the same document and leaves the busy modal before logout.
    await page.goBack(); await expect(bulkDialog(page)).toHaveCount(0);
    await logout(page); await loginInApp(fixture.foreign); await openInApp();
    const current = await filter(page, { type: 'ACTIVITY_CANCELLED' }, '通知类型', '活动取消');
    expect(current).toMatchObject({ total: 3, unreadCount: 3 });
    await confirmDialog(page); oldWrite.release(); await oldWrite.delivered();
    await assertResults(page, current); await assertQuery(page, { type: 'ACTIVITY_CANCELLED' });
    await expect(bulkDialog(page)).toBeVisible(); await expect(bulkDialog(page).getByRole('button', { name: '确认全部已读', exact: true })).toBeEnabled();
    expect(oldWrite.count()).toBe(1); await bulkDialog(page).getByRole('button', { name: '取消全部已读', exact: true }).click();
  } finally { await oldWrite.cleanup(); }
  await seed(request, info, fixture, [{ account: fixture.owner, type: 'PROMOTED', age: 0 }, { account: fixture.owner, type: 'ACTIVITY_CANCELLED', age: 0 }]);
  await logout(page); await loginInApp(fixture.owner); await openInApp();
  const expired = await hold(page, listPath, { type: 'PROMOTED' }, 'GET', { expired: true });
  try {
    await choose(page, '通知类型', '候补递补'); await expired.ready; expired.stopHolding();
    await logout(page); await loginInApp(fixture.owner); await openInApp();
    await filter(page, { status: 'UNREAD' }, '通知状态', '未读通知');
    const current = await filter(page, { type: 'ACTIVITY_CANCELLED', status: 'UNREAD' }, '通知类型', '活动取消');
    expect(current).toMatchObject({ total: 1, unreadCount: 2 }); await confirmDialog(page);
    expired.release(); await expired.delivered(); await assertResults(page, current); await assertQuery(page, { type: 'ACTIVITY_CANCELLED', status: 'UNREAD' });
    expect((await page.request.get('/api/auth/me')).status()).toBe(200);
    await expect(bulkDialog(page)).toBeVisible(); await expect(bulkDialog(page).getByRole('button', { name: '确认全部已读', exact: true })).toBeEnabled();
    await bulkDialog(page).getByRole('button', { name: '取消全部已读', exact: true }).click();
    await expect(page.getByRole('button', { name: `账号菜单，${fixture.owner.displayName}`, exact: true })).toBeVisible();
    await capture(page, info, 'notification-bulk-auth-generation');
  } finally { await expired.cleanup(); }
});
