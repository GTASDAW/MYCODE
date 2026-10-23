import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { test, expect, type APIRequestContext, type APIResponse, type Page, type Request, type TestInfo } from '@playwright/test';
import { databaseConfig, verifyDatabase, trackAccount, recordAccountId, trackFixture, recordFixtureId } from '../scripts/e2e-cleanup.mjs';

// Only UI screenshots are retained. Session/CSRF headers and credentials never enter traces.
test.use({ trace: 'off' });

type Status = 'ACTIVE' | 'WAITING' | 'CANCELLED';
interface Account { key: string; id: number; username: string; displayName: string }
interface Registration {
  id: number; status: Status; checkedInAt: string | null;
  activity: { id: number; title: string; location: string; waitingCount: number };
}
interface Result {
  items: Registration[]; total: number; page: number; pageSize: number;
  summary: { activeRegistrations: number; waitingRegistrations: number; cancelledRegistrations: number; checkedInRegistrations: number };
}
interface Query { keyword?: string; status?: Status | 'ALL'; page?: number; pageSize?: number }
interface Seed { account: number; status: Status; title: string; location: string; checked?: boolean }
interface Fixture { accounts: Account[]; ids: number[]; registrationIds: number[]; titles: string[]; keyword: string }
const path = '/api/me/registrations/search';
const password = 'Demo123!';
const networkError = '暂时无法连接服务，请检查网络后重试。';
const tooLongNotice = '链接中的搜索关键词超过 200 个字符，已清空关键词；其他有效筛选条件保留。';
let fixture: Fixture;

function parameters(query: Query = {}) {
  return new URLSearchParams({ keyword: query.keyword ?? '', status: query.status ?? 'ALL', page: String(query.page ?? 1), pageSize: String(query.pageSize ?? 10) });
}
function listPath(query: Query = {}) {
  const params = new URLSearchParams();
  if (query.keyword) params.set('keyword', query.keyword);
  if (query.status && query.status !== 'ALL') params.set('status', query.status);
  if (query.page && query.page !== 1) params.set('page', String(query.page));
  if (query.pageSize && query.pageSize !== 10) params.set('pageSize', String(query.pageSize));
  return `/my-registrations${params.size ? `?${params}` : ''}`;
}
function matches(url: URL, query: Query) {
  return url.pathname === path && [...parameters(query)].every(([key, value]) =>
    (url.searchParams.get(key) ?? (key === 'keyword' ? '' : key === 'page' ? '1' : key === 'pageSize' ? '10' : 'ALL')) === value)
    && url.searchParams.getAll('keyword').length <= 1;
}
async function result(request: APIRequestContext, query: Query = {}): Promise<Result> {
  const response = await request.get(`${path}?${parameters(query)}`);
  expect(response.status()).toBe(200); return response.json();
}
async function pageResult(page: Page, query: Query = {}): Promise<Result> {
  // Strict Mode may cancel its first GET after headers. Only consume a completed genuine body.
  const request = await page.waitForEvent('requestfinished', { predicate: request => request.method() === 'GET' && matches(new URL(request.url()), query) });
  const response = await request.response(); expect(response?.status()).toBe(200); return response!.json();
}
async function assertQuery(page: Page, query: Query = {}) {
  await expect(page).toHaveURL(url => `${url.pathname}${url.search}` === listPath(query));
  await expect(page.getByLabel('搜索报名活动', { exact: true })).toHaveValue(query.keyword ?? '');
}
async function assertResult(page: Page, data: Result) {
  await expect.poll(() => page.locator('.registration-row[data-registration-id]').evaluateAll(rows =>
    rows.map(row => Number(row.getAttribute('data-registration-id'))))).toEqual(data.items.map(item => item.id));
  if (data.total > 0) await expect(page.getByText(`当前筛选共 ${data.total} 条记录`, { exact: true })).toBeVisible();
  for (const [key, value] of Object.entries(data.summary)) {
    await expect.poll(async () => (await page.getByTestId(`myregistrations-${key}`).locator('.ant-statistic-content-value').innerText()).replace(/[\s,]/g, '')).toBe(String(value));
  }
}
async function open(page: Page, query: Query = {}) {
  const loaded = pageResult(page, query); await page.goto(listPath(query));
  const data = await loaded; await assertResult(page, data); await assertQuery(page, query); return data;
}
async function search(page: Page, keyword: string, query: Query = {}, enter = false) {
  await page.getByLabel('搜索报名活动', { exact: true }).fill(keyword);
  const next = { ...query, keyword, page: 1 };
  const loaded = pageResult(page, next);
  if (enter) await page.getByLabel('搜索报名活动', { exact: true }).press('Enter');
  else await page.getByRole('button', { name: /^查\s*询$/ }).click();
  const data = await loaded; await assertResult(page, data); await assertQuery(page, next); return data;
}
async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ has: page.getByText(option, { exact: true }) }).click();
  await expect(page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')).toHaveCount(0);
}
async function write(request: APIRequestContext, target: string, data?: unknown, method = 'POST') {
  const csrf = await request.get('/api/auth/csrf'); expect(csrf.status()).toBe(200);
  const token = await csrf.json(); return request.fetch(target, { method, data, headers: { [token.headerName]: token.token } });
}
async function loginApi(request: APIRequestContext, account?: Account) {
  const csrf = await request.get('/api/auth/csrf'); expect(csrf.status()).toBe(200);
  const token = await csrf.json();
  const response = await request.post('/api/auth/login', { form: { username: account?.username ?? 'admin', password: account ? password : 'Admin123!' }, headers: { [token.headerName]: token.token } });
  expect(response.status()).toBe(200);
}
async function logoutApi(request: APIRequestContext) {
  const me = await request.get('/api/auth/me'); if (me.status() === 401) return;
  expect(me.status()).toBe(200); expect((await write(request, '/api/auth/logout')).status()).toBe(200);
}
async function loginForm(page: Page, account: Account) {
  await page.getByLabel('账号', { exact: true }).fill(account.username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: `账号菜单，${account.displayName}`, exact: true })).toBeVisible();
}
async function login(page: Page, account = fixture.accounts[0]) { await page.goto('/login'); await loginForm(page, account); }
async function logout(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  const item = page.getByRole('menuitem', { name: /退出登录/ }); await expect(item).toBeVisible();
  const completed = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/auth/logout' && response.status() === 200);
  await item.press('Enter'); await completed;
  await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
}
async function loginWithinSpa(page: Page, account: Account) {
  if (new URL(page.url()).pathname !== '/login') await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
  await loginForm(page, account);
}
async function settle(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function capture(page: Page, info: TestInfo, name: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  const screenshot = info.outputPath(`${name}.png`); await page.screenshot({ path: screenshot });
  await info.attach(name, { path: screenshot, contentType: 'image/png' });
}

async function seed(request: APIRequestContext, info: TestInfo): Promise<Fixture> {
  // Exactly two declared accounts per project keep the real registration limiter in scope.
  const accounts: Account[] = [];
  const accountIntents = [trackAccount(['主-']), trackAccount(['次-'])];
  for (const intent of accountIntents) {
    expect(intent.username.length).toBeLessThanOrEqual(40);
    const response = await write(request, '/api/auth/register', { username: intent.username, displayName: intent.displayName, password });
    expect(response.status()).toBe(201); const user = await response.json();
    expect(user).toMatchObject({ username: intent.username, displayName: intent.displayName, role: 'USER' });
    expect(Number.isSafeInteger(user.id) && user.id > 0).toBe(true);
    recordAccountId(intent.key, user.id); accounts.push({ ...intent, id: user.id });
  }
  const keyword = `范围匹配${randomUUID().slice(0, 8)}`;
  const seeds: Seed[] = [
    ...Array.from({ length: 12 }, (_, index): Seed => ({ account: 0, status: 'ACTIVE', title: `${keyword} 活动 ${index}`, location: '个人报名独立场地', checked: index === 0 })),
    { account: 0, status: 'WAITING', title: `${keyword} 候补标题`, location: '独立候补场地' },
    { account: 0, status: 'WAITING', title: '通过地点匹配的候补', location: `${keyword} 匹配场地` },
    { account: 0, status: 'CANCELLED', title: `${keyword} 已取消历史`, location: '独立取消场地' },
    { account: 0, status: 'ACTIVE', title: '字面 %_!\\ 特殊符号', location: '独立符号场地' },
    { account: 0, status: 'ACTIVE', title: '字面 abX!z 对照', location: '独立普通场地' },
    { account: 0, status: 'ACTIVE', title: '保留空白的报名', location: '位置  双空格 专项' },
    { account: 1, status: 'ACTIVE', title: `${keyword} 第二账号专属`, location: '第二账号独立场地' },
  ];
  const intents = seeds.map(row => trackFixture(row.title, `我的报名关键词 ${info.project.name}：只写本轮精确归属活动和两个已声明账号。`));
  const manifestPath = process.env.E2E_RUN_MANIFEST;
  if (!manifestPath || dirname(resolve(manifestPath)) !== resolve('.runtime/e2e')) throw new Error('The verified fixture manifest is required.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const account of accounts) if (!manifest.accounts.some((row: Account) => row.key === account.key && row.id === account.id && row.username === account.username && row.displayName === account.displayName)) throw new Error('Exact account ownership is required.');
  const config = databaseConfig(), connection = await mysql.createConnection(config);
  const ids: number[] = [], registrationIds: number[] = [];
  try {
    await verifyDatabase(connection, config, manifest.target);
    // Global setup already bound this API to the manifest's exact MySQL UUID and V12 schema.
    const me = await request.get('/api/auth/me'); expect(me.status()).toBe(200);
    const admin = await me.json(); expect(admin).toMatchObject({ username: 'admin', role: 'ADMIN' });
    await connection.beginTransaction();
    const [admins] = await connection.execute<any[]>("SELECT id, username, role FROM users WHERE id=? AND username='admin' AND role='ADMIN' FOR UPDATE", [admin.id]);
    expect(admins).toEqual([{ id: admin.id, username: 'admin', role: 'ADMIN' }]);
    for (const account of [...accounts].sort((a, b) => a.id - b.id)) {
      const [users] = await connection.execute<any[]>('SELECT id, username, display_name AS displayName, role FROM users WHERE id=? FOR UPDATE', [account.id]);
      expect(users).toEqual([{ id: account.id, username: account.username, displayName: account.displayName, role: 'USER' }]);
      const [[references]] = await connection.execute<any[]>(`SELECT
        (SELECT COUNT(*) FROM registrations WHERE user_id=? OR checked_in_by=?) AS registrations,
        (SELECT COUNT(*) FROM notifications WHERE user_id=?) AS notifications,
        (SELECT COUNT(*) FROM activity_audit_logs WHERE actor_user_id=?) AS audits,
        (SELECT COUNT(*) FROM activities WHERE created_by=? OR cancelled_by=?) AS activities,
        (SELECT COUNT(*) FROM activity_favorites WHERE user_id=?) AS favorites`, Array(7).fill(account.id));
      expect(references).toEqual({ registrations: 0, notifications: 0, audits: 0, activities: 0, favorites: 0 });
    }
    const now = Date.now(), utc = (time: number) => new Date(time).toISOString().replace('T', ' ').replace('Z', '');
    for (const [index, row] of seeds.entries()) {
      const [created] = await connection.execute<mysql.ResultSetHeader>('INSERT INTO activities(title,description,location,starts_at,capacity,registered_count,created_by) VALUES(?,?,?,?,?,?,?)',
        [intents[index].title, intents[index].description, row.location, utc(now + (row.checked ? -3600000 : 48 * 3600000)), row.status === 'WAITING' ? 1 : 2, row.status === 'CANCELLED' ? 0 : 1, admin.id]);
      ids.push(created.insertId);
      // The first two updates tie, so descending registration ID must break that tie.
      const timestamp = utc(now - 2 * 3600000 - Math.max(1, index) * 1000);
      const [registration] = await connection.execute<mysql.ResultSetHeader>('INSERT INTO registrations(activity_id,user_id,status,created_at,updated_at) VALUES(?,?,?,?,?)',
        [created.insertId, accounts[row.account].id, row.status, timestamp, timestamp]);
      registrationIds.push(registration.insertId);
      // A second declared user fills only these owned activities; existing admin/demo data is untouched.
      if (row.status === 'WAITING') await connection.execute("INSERT INTO registrations(activity_id,user_id,status,created_at,updated_at) VALUES(?,?,'ACTIVE',?,?)", [created.insertId, accounts[1].id, timestamp, timestamp]);
    }
    await connection.commit(); ids.forEach((id, index) => recordFixtureId(intents[index].key, id));
    for (const [index, id] of ids.entries()) {
      const bound = await request.get(`/api/activities/${id}`); expect(bound.status()).toBe(200);
      expect(await bound.json()).toMatchObject({ id, title: intents[index].title, description: intents[index].description, location: seeds[index].location, registeredCount: seeds[index].status === 'CANCELLED' ? 0 : 1 });
    }
    const rosterResponse = await request.get(`/api/admin/activities/${ids[0]}/registrations`); expect(rosterResponse.status()).toBe(200);
    const owned = (await rosterResponse.json()).items.find((row: { id: number; userId: number }) => row.id === registrationIds[0] && row.userId === accounts[0].id);
    expect(owned).toBeTruthy(); expect((await write(request, `/api/admin/activities/${ids[0]}/registrations/${owned.id}/check-in`)).status()).toBe(200);
    return { accounts, ids, registrationIds, titles: intents.map(row => row.title), keyword };
  } catch (error) { await connection.rollback(); throw error; }
  finally { await connection.end(); }
}

test.beforeAll(async ({ playwright }, info) => {
  const request = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  let failure: unknown;
  try { await loginApi(request); fixture = await seed(request, info); }
  catch (error) { failure = error; }
  try { await logoutApi(request); } catch (error) { failure = failure ? new AggregateError([failure, error], 'Fixture setup and logout failed.') : error; }
  await request.dispose(); if (failure) throw failure;
});

test.afterEach(async ({ page, request }) => {
  const cleanup = await Promise.allSettled([logoutApi(page.request), logoutApi(request)]);
  const errors = cleanup.flatMap(value => value.status === 'rejected' ? [value.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'Owned keyword-search sessions could not all log out.');
});

interface Held { ready: Promise<void>; release(): void; stopHolding(): void; delivered(): Promise<void>; cleanup(): Promise<void> }
async function hold(page: Page, query: Query, outcome: 'success' | 'failure' | 'expired' = 'success'): Promise<Held> {
  let release!: () => void, ready!: () => void, reject!: (error: unknown) => void, armed = true;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetched = new Promise<void>((resolve, failed) => { ready = resolve; reject = failed; });
  const jobs: Promise<{ error?: unknown }>[] = [], outcomes: Promise<{ failed?: string; status?: number }>[] = [];
  const matcher = (url: URL) => matches(url, query);
  let expired: Promise<void> | undefined;
  await page.route(matcher, route => {
    if (!armed || route.request().method() !== 'GET') return route.continue();
    const target = route.request();
    outcomes.push(new Promise(resolve => {
      const clear = () => { page.off('requestfinished', finished); page.off('requestfailed', failed); };
      const finished = async (request: Request) => { if (request !== target) return; clear(); resolve({ status: (await request.response())?.status() }); };
      const failed = (request: Request) => { if (request !== target) return; clear(); resolve({ failed: request.failure()?.errorText }); };
      page.on('requestfinished', finished); page.on('requestfailed', failed);
    }));
    // Gate all matching Strict Mode reads, and retain each first error for the final assertion.
    const job = (async () => {
      try {
        if (outcome === 'expired') await (expired ??= logoutApi(page.request));
        let response: APIResponse;
        try { response = await route.fetch(); }
        catch (error) { if (/ERR_ABORTED|cancel/i.test(target.failure()?.errorText ?? '')) return; throw error; }
        expect(response.status()).toBe(outcome === 'expired' ? 401 : 200);
        if (outcome === 'expired') expect((await response.json()).code).toBe('UNAUTHENTICATED');
        ready(); await gate;
        try { if (outcome === 'failure') await route.abort('failed'); else await route.fulfill({ response }); }
        catch (error) { if (!target.failure()) throw error; }
      } catch (error) { reject(error); throw error; }
    })();
    const recorded = job.then(() => ({}), error => ({ error })); jobs.push(recorded);
    return recorded.then(() => undefined);
  });
  const delivered = async () => {
    const errors = (await Promise.all(jobs)).flatMap(value => value.error === undefined ? [] : [value.error]);
    if (errors.length) throw new AggregateError(errors, 'A delayed genuine registration response failed.');
    for (const value of await Promise.all(outcomes)) {
      if (value.failed) expect(value.failed).toMatch(/ERR_ABORTED|ERR_FAILED|cancel/i);
      else expect(value.status).toBe(outcome === 'expired' ? 401 : 200);
    }
    await settle(page);
  };
  return { ready: fetched, release, stopHolding: () => { armed = false; }, delivered,
    cleanup: async () => { armed = false; release(); try { await delivered(); } finally { await page.unroute(matcher); } } };
}
async function withHeld(page: Page, query: Query, outcome: 'success' | 'failure' | 'expired', run: (held: Held) => Promise<void>) {
  const held = await hold(page, query, outcome); let failure: unknown;
  try { await run(held); } catch (error) { failure = error; }
  try { await held.cleanup(); } catch (error) { failure = failure ? new AggregateError([failure, error], 'The original assertion and held-response cleanup failed.') : error; }
  if (failure) throw failure;
}

test('报名关键词按标题地点字面匹配，保留空白与UTF16长度，草稿独立且查询可重复刷新重置', async ({ page }, info) => {
  await login(page); const initial = await open(page);
  expect(initial).toMatchObject({ total: 18, summary: { activeRegistrations: 15, waitingRegistrations: 2, cancelledRegistrations: 1, checkedInRegistrations: 1 } });
  let reads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === path) reads++; });
  const beforeDraft = reads;
  await page.getByLabel('搜索报名活动', { exact: true }).fill('仅草稿不会读取'); await settle(page);
  expect(reads).toBe(beforeDraft); await assertResult(page, initial);
  expect(new URL(page.url()).search).toBe('');
  for (const [keyword, index] of [['%_!\\', 15], ['%', 15], ['_', 15], ['\\', 15], ['匹配场地', 13], ['  ', 17]] as const) {
    const found = await search(page, keyword, {}, keyword === '匹配场地');
    expect(found.total).toBe(1); expect(found.items[0].activity.id).toBe(fixture.ids[index]); expect(found.summary).toEqual(initial.summary);
  }
  const missing = await search(page, '  范围匹配  '); expect(missing).toMatchObject({ items: [], total: 0 });
  await expect(page.getByText('暂无符合条件的报名记录', { exact: true })).toBeVisible();
  const boundary = '😀'.repeat(100); expect(boundary.length).toBe(200);
  expect((await result(page.request, { keyword: boundary })).total).toBe(0);
  expect((await page.request.get(`${path}?${parameters({ keyword: `${boundary}x` })}`)).status()).toBe(400);
  const repeated = await search(page, fixture.keyword); expect(repeated.total).toBe(15);
  expect((await search(page, fixture.keyword, {}, true)).items).toEqual(repeated.items);
  const reset = pageResult(page); await page.getByRole('button', { name: /^重\s*置$/ }).click();
  await assertResult(page, await reset); await assertQuery(page);
  await capture(page, info, 'myregistrations-keyword-literal');
});

test('报名关键词和状态共同筛选，分页数量与顶部刷新使用已提交条件，四项统计始终覆盖本人全部', async ({ page }, info) => {
  await login(page); const query = { keyword: fixture.keyword };
  const first = await open(page, query); expect(first.total).toBe(15);
  const lastLoaded = pageResult(page, { ...query, page: 2 });
  await page.locator('[aria-label="报名分页"] .ant-pagination-item[title="2"]').click();
  const last = await lastLoaded; expect(last.items).toHaveLength(5); await assertResult(page, last); await assertQuery(page, { ...query, page: 2 });
  expect([...first.items, ...last.items].map(row => row.id)).toEqual([fixture.registrationIds[1], fixture.registrationIds[0], ...fixture.registrationIds.slice(2, 15)]);
  const toFirst = await search(page, fixture.keyword, { page: 2 }); expect(toFirst.page).toBe(1);
  await page.getByLabel('搜索报名活动', { exact: true }).fill('未提交的不存在关键词');
  const waitingLoaded = pageResult(page, { ...query, status: 'WAITING' }); await choose(page, '报名状态', '候补');
  const waiting = await waitingLoaded; expect(waiting.total).toBe(2); expect(waiting.summary).toEqual(first.summary); await assertResult(page, waiting);
  // URL changes restore the committed keyword rather than committing the unrelated draft.
  await assertQuery(page, { ...query, status: 'WAITING' });
  await page.getByLabel('搜索报名活动', { exact: true }).fill('刷新仍不提交此草稿');
  const refreshed = pageResult(page, { ...query, status: 'WAITING' }); await page.getByRole('button', { name: '刷新报名', exact: true }).click();
  await assertResult(page, await refreshed); expect(new URL(page.url()).searchParams.get('keyword')).toBe(fixture.keyword);
  const resized = pageResult(page, { ...query, status: 'WAITING', pageSize: 20 }); await choose(page, '每页报名数量', '20 条/页');
  const larger = await resized; expect(larger.total).toBe(2); expect(larger.summary).toEqual(first.summary); await assertQuery(page, { ...query, status: 'WAITING', pageSize: 20 });
  const empty = await search(page, '精确不存在关键词', { status: 'WAITING', pageSize: 20 }); expect(empty.total).toBe(0);
  const clear = pageResult(page, { pageSize: 20 }); await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  const all = await clear; expect(all.total).toBe(18); await assertResult(page, all); await assertQuery(page, { pageSize: 20 });
  const reset = pageResult(page, { pageSize: 20 }); await page.getByRole('button', { name: /^重\s*置$/ }).click();
  await assertResult(page, await reset); await assertQuery(page, { pageSize: 20 });
  await capture(page, info, 'myregistrations-keyword-filters');
});

test('报名关键词直达刷新和浏览器历史保留条件，详情from与匿名登录返回保留规范关键词路径', async ({ page }, info) => {
  const query: Query = { keyword: fixture.keyword, status: 'ACTIVE', page: 2, pageSize: 10 };
  const privateReads: string[] = [];
  const listen = (request: Request) => { if (new URL(request.url()).pathname === path) privateReads.push(request.url()); };
  page.on('request', listen);
  await page.goto(listPath(query)); await expect(page).toHaveURL(/\/login$/); expect(privateReads).toEqual([]);
  page.off('request', listen);
  const returned = pageResult(page, query); await loginForm(page, fixture.accounts[0]);
  const data = await returned; expect(data.items).toHaveLength(2); await assertResult(page, data); await assertQuery(page, query);
  const reloaded = pageResult(page, query); await page.reload(); await assertResult(page, await reloaded); await assertQuery(page, query);
  await page.getByTestId(`myregistration-${data.items[0].id}`).getByRole('link', { name: '查看活动', exact: true }).click();
  await expect(page.getByRole('heading', { name: data.items[0].activity.title, exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('from')).toBe(listPath(query));
  await page.reload(); await expect(page.getByRole('link', { name: '返回我的报名', exact: true })).toHaveAttribute('href', listPath(query));
  const back = pageResult(page, query); await page.getByRole('link', { name: '返回我的报名', exact: true }).click(); await assertResult(page, await back);
  const special = await search(page, '%', { status: 'ACTIVE' }); expect(special.total).toBe(1);
  const historyBack = pageResult(page, query); await page.goBack(); await assertResult(page, await historyBack); await assertQuery(page, query);
  const historyForward = pageResult(page, { keyword: '%', status: 'ACTIVE' }); await page.goForward(); await assertResult(page, await historyForward); await assertQuery(page, { keyword: '%', status: 'ACTIVE' });
  await page.getByTestId(`myregistration-${special.items[0].id}`).getByRole('link', { name: '查看活动', exact: true }).click();
  await expect(page.getByRole('link', { name: '返回我的报名', exact: true })).toHaveAttribute('href', listPath({ keyword: '%', status: 'ACTIVE' }));
  const safe = new URLSearchParams({ from: '/my-registrations?keyword=%25&status=ADMIN&page=-1&pageSize=20' });
  await page.goto(`/activities/${fixture.ids[15]}?${safe}`);
  await expect(page.getByRole('link', { name: '返回我的报名', exact: true })).toHaveAttribute('href', listPath({ keyword: '%', pageSize: 20 }));
  await capture(page, info, 'myregistrations-keyword-navigation');
});

test('超长与非法报名URL规范化，空态和网络错误按原条件重试，旧成功失败及越界响应不覆盖新关键词', async ({ page }, info) => {
  await login(page);
  const invalid = pageResult(page); await page.goto('/my-registrations?status=ADMIN&page=-1&pageSize=101'); await assertResult(page, await invalid); await assertQuery(page);
  const normalized: Query = { status: 'ACTIVE', page: 2, pageSize: 5 };
  const longLoaded = pageResult(page, normalized);
  await page.goto(`/my-registrations?${parameters({ ...normalized, keyword: '😀'.repeat(101) })}`);
  await assertResult(page, await longLoaded); await assertQuery(page, normalized); await expect(page.getByText(tooLongNotice, { exact: true })).toBeVisible();
  const query: Query = { keyword: fixture.keyword, status: 'WAITING', pageSize: 20 };
  let failing = true;
  const failMatcher = (url: URL) => matches(url, query);
  await page.route(failMatcher, route => failing ? route.abort('failed') : route.continue());
  try {
    await page.goto(listPath(query)); await expect(page.getByText(networkError, { exact: true })).toBeVisible();
    for (const key of ['activeRegistrations', 'waitingRegistrations', 'cancelledRegistrations', 'checkedInRegistrations']) await expect(page.getByTestId(`myregistrations-${key}`).locator('.ant-statistic-content-value')).toHaveText('—');
    failing = false; const recovered = pageResult(page, query); await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await assertResult(page, await recovered); await assertQuery(page, query);
  } finally { failing = false; await page.unroute(failMatcher); }
  for (const outcome of ['success', 'failure'] as const) {
    await open(page, { keyword: fixture.keyword });
    await withHeld(page, { keyword: fixture.keyword }, outcome, async held => {
      await page.getByRole('button', { name: '刷新报名', exact: true }).click(); await held.ready; held.stopHolding();
      const current = await search(page, '%'); expect(current.total).toBe(1);
      held.release(); await held.delivered(); await assertResult(page, current); await assertQuery(page, { keyword: '%' });
      await expect(page.getByText(networkError, { exact: true })).toHaveCount(0);
    });
  }
  const oldPage: Query = { keyword: fixture.keyword, page: 99 };
  await withHeld(page, oldPage, 'success', async held => {
    await page.goto(listPath(oldPage)); await held.ready; held.stopHolding();
    const current = await search(page, '%'); held.release(); await held.delivered();
    await assertResult(page, current); await assertQuery(page, { keyword: '%' });
  });
  const corrected = pageResult(page, { keyword: fixture.keyword, page: 2 });
  await page.goto(listPath(oldPage)); const last = await corrected; expect(last.total).toBe(15); await assertResult(page, last); await assertQuery(page, { keyword: fixture.keyword, page: 2 });
  const previous = pageResult(page, { keyword: '%' }); await page.goBack(); await assertResult(page, await previous); await assertQuery(page, { keyword: '%' });
  await capture(page, info, 'myregistrations-keyword-recovery');
});

test('旧关键词真实成功或401迟到，同账号重新登录与切换账号均保留新身份和新查询', async ({ page }, info) => {
  for (const outcome of ['success', 'expired'] as const) for (const identity of ['same', 'other'] as const) {
    await login(page); const oldQuery = { keyword: fixture.keyword };
    await open(page, oldQuery);
    await withHeld(page, oldQuery, outcome, async held => {
      await page.getByRole('button', { name: '刷新报名', exact: true }).click(); await held.ready; held.stopHolding();
      await logout(page); const account = fixture.accounts[identity === 'same' ? 0 : 1]; await loginWithinSpa(page, account);
      if (new URL(page.url()).pathname !== '/my-registrations') {
        const loaded = pageResult(page); await page.getByRole('link', { name: '我的报名', exact: true }).click(); await loaded;
      }
      const current = await search(page, identity === 'same' ? '%' : '第二账号专属');
      expect(current.total).toBe(1); expect(current.items[0].activity.id).toBe(fixture.ids[identity === 'same' ? 15 : 18]);
      expect(current.summary).toEqual(identity === 'same'
        ? { activeRegistrations: 15, waitingRegistrations: 2, cancelledRegistrations: 1, checkedInRegistrations: 1 }
        : { activeRegistrations: 3, waitingRegistrations: 0, cancelledRegistrations: 0, checkedInRegistrations: 0 });
      held.release(); await held.delivered(); await assertResult(page, current); await assertQuery(page, { keyword: identity === 'same' ? '%' : '第二账号专属' });
      await expect(page.getByRole('button', { name: `账号菜单，${account.displayName}`, exact: true })).toBeVisible();
      await expect(page.getByText('登录已过期，请重新登录后继续。', { exact: true })).toHaveCount(0);
      const me = await page.request.get('/api/auth/me'); expect(me.status()).toBe(200); expect(await me.json()).toMatchObject({ id: account.id, username: account.username });
    });
    await logout(page);
  }
  await login(page, fixture.accounts[1]); await open(page, { keyword: '第二账号专属' });
  await capture(page, info, 'myregistrations-keyword-auth-generation');
});
