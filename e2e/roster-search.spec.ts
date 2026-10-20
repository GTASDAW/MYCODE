import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { test, expect, type APIRequestContext, type APIResponse, type Page, type Request, type TestInfo } from '@playwright/test';
import { databaseConfig, verifyDatabase, trackAccount, recordAccountId, trackFixture, recordFixtureId } from '../scripts/e2e-cleanup.mjs';

// Reuse checkin.spec.ts's declared account/activity ownership and real HTTP/SQL fixture pattern.
// Never retain Session headers, credentials or roster/export bodies in traces.
test.use({ trace: 'off' });

type Status = 'ACTIVE' | 'WAITING' | 'CANCELLED';
type CheckIn = 'ALL' | 'CHECKED_IN' | 'NOT_CHECKED_IN';
interface Account { key: string; id: number; username: string; displayName: string; allowedDisplayNames: string[] }
interface Registration { id: number; userId: number; username: string; displayName: string; status: Status; checkedInAt: string | null }
interface Roster {
  activity: { id: number; title: string }; items: Registration[]; total: number; page: number; pageSize: number;
  summary: { activeRegistrations: number; checkedInRegistrations: number; notCheckedInRegistrations: number };
}
interface Query { page?: number; pageSize?: number; keyword?: string; status?: Status | 'ALL'; checkInStatus?: CheckIn }
interface Person { status?: Status; prefixes?: string[]; checked?: boolean }
const password = 'Demo123!';
const networkError = '暂时无法连接服务，请检查网络后重试。';
const parameters = (query: Query = {}) => new URLSearchParams({ page: String(query.page ?? 1), pageSize: String(query.pageSize ?? 10),
  status: query.status ?? 'ALL', checkInStatus: query.checkInStatus ?? 'ALL', keyword: query.keyword ?? '' });
const apiPath = (id: number) => `/api/admin/activities/${id}/registrations`;
const uiPath = (id: number, query: Query = {}) => `/admin/activities/${id}/registrations?${parameters(query)}`;
function matches(url: URL, query: Query) {
  return [...parameters(query)].every(([key, value]) => (url.searchParams.get(key) ?? (key === 'keyword' ? '' : key === 'page' ? '1' : key === 'pageSize' ? '10' : 'ALL')) === value);
}
async function csrf(request: APIRequestContext) {
  const response = await request.get('/api/auth/csrf'); expect(response.status()).toBe(200); return response.json();
}
async function write(request: APIRequestContext, path: string, data?: unknown, method = 'POST') {
  const token = await csrf(request);
  return request.fetch(path, { method, data, headers: { [token.headerName]: token.token } });
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
async function loginForm(page: Page, account?: Account) {
  await page.getByLabel('账号', { exact: true }).fill(account?.username ?? 'admin');
  await page.getByLabel('密码', { exact: true }).fill(account ? password : 'Admin123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: /账号菜单/ })).toBeVisible();
}
async function login(page: Page, account?: Account) { await page.goto('/login'); await loginForm(page, account); }
async function logout(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  const item = page.getByRole('menuitem', { name: /退出登录/ }); await expect(item).toBeVisible();
  const completed = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/auth/logout' && response.status() === 200);
  // Keyboard activation avoids the already reproduced fixed-header/dropdown scroll relocation race.
  await item.press('Enter'); await completed;
  await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
}
async function roster(request: APIRequestContext, id: number, query: Query = {}): Promise<Roster> {
  const response = await request.get(`${apiPath(id)}?${parameters(query)}`); expect(response.status()).toBe(200); return response.json();
}
async function pageRoster(page: Page, id: number, query: Query = {}): Promise<Roster> {
  // A Strict Mode read can be aborted after its response event; await a fully completed request.
  const request = await page.waitForEvent('requestfinished', { predicate: request => request.method() === 'GET'
    && new URL(request.url()).pathname === apiPath(id) && matches(new URL(request.url()), query) });
  const response = await request.response(); expect(response?.status()).toBe(200); return response!.json();
}
async function assertRoster(page: Page, result: Roster) {
  await expect(page.locator('.roster-row[data-registration-id]')).toHaveCount(result.items.length);
  await expect.poll(() => page.locator('.roster-row[data-registration-id]').evaluateAll(rows => rows.map(row => Number(row.getAttribute('data-registration-id')))))
    .toEqual(result.items.map(row => row.id));
  await expect(page.getByTestId('roster-active-count')).toHaveText(String(result.summary.activeRegistrations));
  await expect(page.getByTestId('roster-checked-in-count')).toHaveText(String(result.summary.checkedInRegistrations));
  await expect(page.getByTestId('roster-not-checked-in-count')).toHaveText(String(result.summary.notCheckedInRegistrations));
}
async function assertQuery(page: Page, id: number, query: Query) {
  await expect.poll(() => { const url = new URL(page.url()); return url.pathname === `/admin/activities/${id}/registrations` && matches(url, query); }).toBe(true);
}
async function open(page: Page, id: number, query: Query = {}) {
  const loaded = pageRoster(page, id, query); await page.goto(uiPath(id, query));
  await expect(page.getByRole('heading', { name: '报名名单', exact: true })).toBeVisible();
  const result = await loaded; await assertRoster(page, result); await assertQuery(page, id, query); return result;
}
async function search(page: Page, id: number, keyword: string, filters: Query = {}) {
  await page.getByLabel('搜索报名人员', { exact: true }).fill(keyword);
  const query = { ...filters, keyword: keyword.trim(), page: 1 };
  const loaded = pageRoster(page, id, query); await page.getByRole('button', { name: '查询', exact: true }).click();
  const result = await loaded; await assertRoster(page, result); await assertQuery(page, id, query); return result;
}
async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ has: page.getByText(option, { exact: true }) }).click();
}
async function capture(page: Page, info: TestInfo, name: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const path = info.outputPath(`${name}.png`); await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function fixtures(request: APIRequestContext, info: TestInfo, people: Person[]) {
  await loginApi(request);
  const accounts: Account[] = [];
  for (const person of people) {
    const intent = trackAccount(person.prefixes ?? ['中-']);
    const response = await write(request, '/api/auth/register', { username: intent.username, displayName: intent.displayName, password });
    expect(response.status()).toBe(201); const user = await response.json(); recordAccountId(intent.key, user.id);
    accounts.push({ ...intent, id: user.id });
  }
  const manifestPath = process.env.E2E_RUN_MANIFEST;
  if (!manifestPath || dirname(resolve(manifestPath)) !== resolve('.runtime/e2e')) throw new Error('The verified local fixture manifest is required.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const activity = trackFixture(`名单搜索 ${info.project.name} ${randomUUID().slice(0, 8)}`, '本轮独立报名人员搜索与签到夹具。');
  const config = databaseConfig(), connection = await mysql.createConnection(config);
  try {
    await verifyDatabase(connection, config, manifest.target);
    const response = await request.get('/api/auth/me'); expect(response.status()).toBe(200);
    const actor = await response.json(); expect(actor.role).toBe('ADMIN');
    await connection.beginTransaction();
    const [admins] = await connection.execute<any[]>("SELECT id FROM users WHERE id=? AND username='admin' AND role='ADMIN' FOR UPDATE", [actor.id]);
    expect(admins).toHaveLength(1);
    for (const account of [...accounts].sort((first, second) => first.id - second.id)) {
      const [users] = await connection.execute<any[]>('SELECT id, username, display_name AS displayName, role FROM users WHERE id=? FOR UPDATE', [account.id]);
      expect(users).toEqual([{ id: account.id, username: account.username, displayName: account.displayName, role: 'USER' }]);
    }
    const active = people.filter(person => (person.status ?? 'ACTIVE') === 'ACTIVE').length;
    const [created] = await connection.execute<mysql.ResultSetHeader>(
      'INSERT INTO activities(title,description,location,starts_at,capacity,registered_count,created_by) VALUES(?,?,?,UTC_TIMESTAMP(6)-INTERVAL 1 HOUR,?,?,?)',
      [activity.title, activity.description, '名单搜索独立场地', Math.max(1, active), active, actor.id]);
    for (const [index, account] of accounts.entries()) await connection.execute(
      'INSERT INTO registrations(activity_id,user_id,status,created_at,updated_at) VALUES(?,?,?,UTC_TIMESTAMP(6)-INTERVAL 2 HOUR+INTERVAL ? SECOND,UTC_TIMESTAMP(6)-INTERVAL 2 HOUR+INTERVAL ? SECOND)',
      [created.insertId, account.id, people[index].status ?? 'ACTIVE', index, index]);
    await connection.commit(); recordFixtureId(activity.key, created.insertId);
    const bound = await request.get(`/api/activities/${created.insertId}`); expect(bound.status()).toBe(200);
    expect(await bound.json()).toMatchObject({ id: created.insertId, title: activity.title, description: activity.description, registeredCount: active, registrationDeadline: null });
    const initial = await roster(request, created.insertId, { pageSize: 100 });
    for (const [index, person] of people.entries()) if (person.checked) {
      const registration = initial.items.find(row => row.userId === accounts[index].id)!;
      expect((await write(request, `${apiPath(created.insertId)}/${registration.id}/check-in`)).status()).toBe(200);
    }
    return { id: created.insertId, title: activity.title, accounts, before: await roster(request, created.insertId, { pageSize: 100 }) };
  } catch (error) { await connection.rollback(); throw error; } finally { await connection.end(); }
}

function parseCsv(bytes: Buffer) {
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const source = bytes.toString('utf8').slice(1), rows: string[][] = []; let cursor = 0;
  while (cursor < source.length) {
    const row: string[] = [];
    while (true) {
      expect(source[cursor++]).toBe('"'); let cell = '';
      while (true) {
        if (source[cursor] === '"') {
          if (source[cursor + 1] === '"') { cell += '"'; cursor += 2; }
          else { cursor++; break; }
        } else { if (cursor >= source.length) throw new Error('Unterminated roster CSV field.'); cell += source[cursor++]; }
      }
      row.push(cell); if (source[cursor] === ',') { cursor++; continue; }
      expect(source.slice(cursor, cursor + 2)).toBe('\r\n'); cursor += 2; break;
    }
    rows.push(row);
  }
  expect(rows.every(row => row.length === 10)).toBe(true); return rows;
}
async function exportCsv(page: Page, id: number) {
  const received = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
  const download = await received; expect(download.suggestedFilename()).toBe(`activity-${id}-registrations.csv`);
  expect(await download.failure()).toBeNull(); return parseCsv(readFileSync((await download.path())!));
}
async function settle(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
type Held = { ready: Promise<void>; release(): void; stopHolding(): void; delivered(): Promise<void>; cleanup(): Promise<void>; count(): number };
async function hold(page: Page, path: string, keyword: string | undefined, method = 'GET', options: { failure?: boolean; expired?: boolean } = {}): Promise<Held> {
  let release!: () => void, ready!: () => void, reject!: (error: unknown) => void, armed = true, count = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetched = new Promise<void>((resolve, failed) => { ready = resolve; reject = failed; });
  const jobs: Promise<{ error?: unknown }>[] = [];
  const outcomes: Promise<{ failed?: string; status?: number }>[] = [];
  const matcher = (url: URL) => url.pathname === path && (keyword === undefined || (url.searchParams.get('keyword') ?? '') === keyword);
  let expired: Promise<void> | undefined;
  await page.route(matcher, route => {
    if (route.request().method() !== method) return route.continue();
    count++; if (!armed) return route.continue();
    const target = route.request();
    // Hold every matching read, including Strict Mode replacements. Mutations remain single submissions.
    if (method !== 'GET') armed = false;
    outcomes.push(new Promise(resolve => {
      const clear = () => { page.off('requestfinished', finished); page.off('requestfailed', failed); };
      const finished = async (request: Request) => { if (request !== target) return; clear(); resolve({ status: (await request.response())?.status() }); };
      const failed = (request: Request) => { if (request !== target) return; clear(); resolve({ failed: request.failure()?.errorText }); };
      page.on('requestfinished', finished); page.on('requestfailed', failed);
    }));
    const job = (async () => {
      try {
        // The first old read invalidates its genuine server Session; route.fetch retains that request's old cookie.
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
    if (errors.length) throw new AggregateError(errors, 'A delayed genuine roster response failed.');
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
  if (errors.length) throw new AggregateError(errors, 'Owned roster-search sessions could not all log out.');
});

test('中文、用户名及特殊字符按字面搜索当前昵称，草稿不提交且同条件可刷新重置', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info, [{ prefixes: ['=%_\\', '改-'] }, { prefixes: ['中文-'] }, { status: 'WAITING', prefixes: ['候-'] }]);
  await login(page); const initial = await open(page, fixture.id);
  let reads = 0;
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === apiPath(fixture.id)) reads++; });
  const beforeDraft = reads;
  await page.getByLabel('搜索报名人员', { exact: true }).fill('不会自动提交'); await settle(page);
  expect(reads).toBe(beforeDraft); await assertRoster(page, initial); await assertQuery(page, fixture.id, {});
  for (const [keyword, account] of [['=%_\\', fixture.accounts[0]], ['%', fixture.accounts[0]], ['\\', fixture.accounts[0]],
    ['中文-', fixture.accounts[1]], [fixture.accounts[2].username, fixture.accounts[2]]] as const) {
    const result = await search(page, fixture.id, keyword); expect(result.items.map(row => row.userId)).toEqual([account.id]);
  }
  const current = fixture.accounts[0]; await loginApi(request, current);
  const renamed = current.allowedDisplayNames[1];
  expect((await write(request, '/api/me/profile', { displayName: renamed }, 'PATCH')).status()).toBe(200);
  await logoutApi(request); await loginApi(request);
  expect((await search(page, fixture.id, '=%_\\')).total).toBe(0);
  const result = await search(page, fixture.id, renamed); expect(result.items[0].displayName).toBe(renamed);
  const same = pageRoster(page, fixture.id, { keyword: renamed }); await page.getByRole('button', { name: '查询', exact: true }).click(); await assertRoster(page, await same);
  const refreshed = pageRoster(page, fixture.id, { keyword: renamed }); await page.getByRole('button', { name: '刷新名单', exact: true }).click(); await assertRoster(page, await refreshed);
  const reset = pageRoster(page, fixture.id); await page.getByRole('button', { name: '重置', exact: true }).click();
  expect((await reset).total).toBe(3); await expect(page.getByLabel('搜索报名人员', { exact: true })).toHaveValue('');
  await capture(page, info, 'roster-literal-current-name');
});

test('关键词与报名签到筛选共同分页，统计整场人数且CSV导出匹配全集', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info, [...Array.from({ length: 13 }, (_, index) => ({ prefixes: ['同-'], checked: index === 0 })),
    { prefixes: ['同-'], status: 'WAITING' }, { prefixes: ['他-'], status: 'CANCELLED' }]);
  await login(page); await open(page, fixture.id);
  const result = await search(page, fixture.id, '同-'); expect(result.total).toBe(14); expect(result.items).toHaveLength(10);
  expect(result.summary).toEqual({ activeRegistrations: 13, checkedInRegistrations: 1, notCheckedInRegistrations: 12 });
  const next = pageRoster(page, fixture.id, { keyword: '同-', page: 2 }); await page.locator('.roster-table .ant-pagination-item-2').click();
  await assertRoster(page, await next); await assertQuery(page, fixture.id, { keyword: '同-', page: 2 });
  const all = await roster(request, fixture.id, { keyword: '同-', pageSize: 100 }), csv = await exportCsv(page, fixture.id);
  expect(csv.slice(1).map(row => row[0])).toEqual(all.items.map(row => `\t${row.id}`)); expect(csv).toHaveLength(15);
  const resized = pageRoster(page, fixture.id, { keyword: '同-', pageSize: 20 }); await choose(page, '每页名单数量', '20 条/页');
  await assertRoster(page, await resized); await assertQuery(page, fixture.id, { keyword: '同-', pageSize: 20 });
  const marked = pageRoster(page, fixture.id, { keyword: '同-', pageSize: 20, checkInStatus: 'CHECKED_IN' }); await choose(page, '签到状态', '已签到');
  const checked = await marked; expect(checked.total).toBe(1); expect(checked.summary).toEqual(result.summary); await assertRoster(page, checked);
  const empty = pageRoster(page, fixture.id, { keyword: '同-', pageSize: 20, status: 'WAITING', checkInStatus: 'CHECKED_IN' }); await choose(page, '报名状态', '候补中');
  const none = await empty; expect(none.total).toBe(0); expect(none.summary).toEqual(result.summary); await assertRoster(page, none);
  expect(await exportCsv(page, fixture.id)).toHaveLength(1); await capture(page, info, 'roster-search-combined');
});

test('名单URL保留关键词分页筛选，刷新历史登录和同活动详情返回一致', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info, Array.from({ length: 12 }, () => ({ prefixes: ['返-'] })));
  const saved: Query = { keyword: '返-', page: 2, pageSize: 5, status: 'ACTIVE', checkInStatus: 'NOT_CHECKED_IN' };
  await page.goto(uiPath(fixture.id, saved)); await expect(page).toHaveURL(/\/login$/);
  const afterLogin = pageRoster(page, fixture.id, saved); await loginForm(page); await assertRoster(page, await afterLogin); await assertQuery(page, fixture.id, saved);
  const reload = pageRoster(page, fixture.id, saved); await page.reload(); await assertRoster(page, await reload);
  const edited = await search(page, fixture.id, fixture.accounts[0].username, { pageSize: 5, status: 'ACTIVE', checkInStatus: 'NOT_CHECKED_IN' }); expect(edited.total).toBe(1);
  const back = pageRoster(page, fixture.id, saved); await page.goBack(); await assertRoster(page, await back); await assertQuery(page, fixture.id, saved);
  const forward = pageRoster(page, fixture.id, { keyword: fixture.accounts[0].username, pageSize: 5, status: 'ACTIVE', checkInStatus: 'NOT_CHECKED_IN' });
  await page.goForward(); await assertRoster(page, await forward);
  const backAgain = pageRoster(page, fixture.id, saved); await page.goBack(); await backAgain;
  await page.getByRole('link', { name: fixture.title, exact: true }).click();
  await expect(page.getByRole('heading', { name: fixture.title, exact: true })).toBeVisible();
  const returned = pageRoster(page, fixture.id, saved); await page.getByRole('link', { name: '返回报名名单', exact: true }).click();
  await assertRoster(page, await returned); await assertQuery(page, fixture.id, saved);
  await expect(page.getByRole('button', { name: '导出 CSV', exact: true })).toBeEnabled();
  await capture(page, info, 'roster-url-return');
});

test('非法URL与越界页规范化不循环，当前读取错误可恢复且普通用户不加载管理资源', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info, [{ prefixes: ['错-'] }, { status: 'WAITING', prefixes: ['错-'] }]);
  await login(page);
  const normalized = pageRoster(page, fixture.id); await page.goto(`/admin/activities/${fixture.id}/registrations?page=-1&pageSize=bogus&status=INVALID&checkInStatus=INVALID&keyword=${'x'.repeat(201)}`);
  await assertRoster(page, await normalized); await assertQuery(page, fixture.id, {});
  await expect(page.getByLabel('搜索报名人员', { exact: true })).toHaveAttribute('maxlength', '200');
  const target: Query = { keyword: '错-', page: 999 };
  await page.goto(uiPath(fixture.id, target)); await assertQuery(page, fixture.id, { keyword: '错-' });
  await expect(page.locator('.roster-row')).toHaveCount(2);
  // The correction replaces this history entry; back returns to the prior normalized list, not page 999 again.
  await page.goBack(); await assertQuery(page, fixture.id, {}); await expect(page.getByLabel('搜索报名人员', { exact: true })).toHaveValue('');
  const broken = await hold(page, apiPath(fixture.id), '失败-', 'GET', { failure: true });
  try {
    await page.getByLabel('搜索报名人员', { exact: true }).fill('失败-'); await page.getByRole('button', { name: '查询', exact: true }).click();
    await broken.ready; broken.stopHolding(); broken.release(); await broken.delivered();
    await expect(page.getByText(networkError, { exact: true })).toBeVisible();
    await expect(page.getByTestId('roster-active-count')).toHaveText('—');
    const recovered = pageRoster(page, fixture.id, { keyword: '失败-' }); await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await assertRoster(page, await recovered);
  } finally { await broken.cleanup(); }
  await logout(page); await login(page, fixture.accounts[0]);
  const adminReads: string[] = [];
  page.on('request', request => { const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && (path.startsWith('/api/admin/') || path.startsWith('/assets/AdminRegistrationsPage'))) adminReads.push(path); });
  await page.goto(uiPath(fixture.id, { keyword: '错-' }));
  await expect(page.getByText('此页面仅对活动组织者开放', { exact: true })).toBeVisible(); expect(adminReads).toEqual([]);
  expect((await page.request.get(`${apiPath(fixture.id)}?keyword=错-`)).status()).toBe(403);
  expect((await page.request.get(`${apiPath(fixture.id)}/export?keyword=错-`)).status()).toBe(403);
});

test('关键词切换后旧名单成功或网络错误均不清除新条件的加载状态或数据', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info, [{ prefixes: ['旧-'] }, { prefixes: ['新-'] }]);
  await login(page); await open(page, fixture.id);
  for (const failure of [false, true]) {
    const old = await hold(page, apiPath(fixture.id), '旧-', 'GET', { failure }), current = await hold(page, apiPath(fixture.id), '新-');
    try {
      await page.getByLabel('搜索报名人员', { exact: true }).fill('旧-'); await page.getByRole('button', { name: '查询', exact: true }).click(); await old.ready;
      await page.getByLabel('搜索报名人员', { exact: true }).fill('新-'); await page.getByRole('button', { name: '查询', exact: true }).click(); await current.ready;
      old.stopHolding(); old.release(); await old.delivered();
      await expect(page.getByRole('button', { name: '刷新名单', exact: true })).toHaveClass(/ant-btn-loading/);
      await expect(page.getByText(networkError, { exact: true })).toHaveCount(0);
      const loaded = pageRoster(page, fixture.id, { keyword: '新-' }); current.stopHolding(); current.release(); await current.delivered();
      const result = await loaded; expect(result.items.map(row => row.userId)).toEqual([fixture.accounts[1].id]); await assertRoster(page, result);
      await assertQuery(page, fixture.id, { keyword: '新-' }); await expect(page.getByLabel('搜索报名人员', { exact: true })).toHaveValue('新-');
    } finally { await old.cleanup(); await current.cleanup(); }
  }
});

test('真实旧名单401迟到后同账号重登并切换关键词，不退出或覆盖新代次', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info, [{ prefixes: ['旧-'] }, { prefixes: ['新-'] }]);
  await login(page); await open(page, fixture.id);
  const old = await hold(page, apiPath(fixture.id), '旧-', 'GET', { expired: true });
  try {
    await page.getByLabel('搜索报名人员', { exact: true }).fill('旧-'); await page.getByRole('button', { name: '查询', exact: true }).click(); await old.ready;
    old.stopHolding(); await logout(page);
    if (!await page.getByLabel('账号', { exact: true }).isVisible()) await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
    await loginForm(page);
    const current = await open(page, fixture.id, { keyword: '新-' }); old.release(); await old.delivered();
    await expect(page.getByRole('button', { name: /账号菜单/ })).toBeVisible(); expect((await page.request.get('/api/auth/me')).status()).toBe(200);
    await assertRoster(page, current); await assertQuery(page, fixture.id, { keyword: '新-' });
    await expect(page.getByText('请先登录', { exact: true })).toHaveCount(0);
  } finally { await old.cleanup(); }
});

test('旧关键词CSV真实响应迟到不下载，当前关键词仍能导出', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info, [{ prefixes: ['旧-'] }, { prefixes: ['新-'] }]);
  await login(page); await open(page, fixture.id); await search(page, fixture.id, '旧-');
  const downloads: string[] = []; page.on('download', download => downloads.push(download.suggestedFilename()));
  const old = await hold(page, `${apiPath(fixture.id)}/export`, '旧-');
  try {
    await page.getByRole('button', { name: '导出 CSV', exact: true }).click(); await old.ready;
    const current = await search(page, fixture.id, '新-'); old.stopHolding(); old.release(); await old.delivered();
    expect(downloads).toEqual([]); await assertRoster(page, current);
    const csv = await exportCsv(page, fixture.id); expect(csv).toHaveLength(2); expect(csv[1][1]).toBe(`\t${fixture.accounts[1].username}`);
  } finally { await old.cleanup(); }
});

test('真实签到成功迟到后返回另一关键词，不刷新新名单或显示旧成功', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info, [{ prefixes: ['签-'] }, { prefixes: ['留-'] }]);
  const target = fixture.before.items.find(row => row.userId === fixture.accounts[0].id)!;
  await login(page); await open(page, fixture.id, { keyword: '留-' }); await search(page, fixture.id, '签-');
  const old = await hold(page, `${apiPath(fixture.id)}/${target.id}/check-in`, undefined, 'POST');
  let currentReads = 0;
  page.on('request', request => { const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === apiPath(fixture.id) && url.searchParams.get('keyword') === '留-') currentReads++; });
  try {
    await page.getByRole('button', { name: `确认报名 ${target.id} 签到`, exact: true }).click();
    await page.getByRole('dialog', { name: '确认签到', exact: true }).getByRole('button', { name: '确认签到', exact: true }).click(); await old.ready;
    const returned = pageRoster(page, fixture.id, { keyword: '留-' }); await page.goBack(); const current = await returned; await assertRoster(page, current);
    const beforeRelease = currentReads; old.release(); await old.delivered(); expect(currentReads).toBe(beforeRelease); expect(old.count()).toBe(1);
    await assertQuery(page, fixture.id, { keyword: '留-' }); await assertRoster(page, current);
    await expect(page.getByText('签到成功，名单已刷新', { exact: true })).toHaveCount(0);
    expect((await roster(request, fixture.id, { keyword: fixture.accounts[0].username })).items[0].checkedInAt).not.toBeNull();
    await capture(page, info, 'roster-search-late-check-in');
  } finally { await old.cleanup(); }
});
