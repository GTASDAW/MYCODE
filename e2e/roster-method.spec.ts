import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { test, expect, type APIRequestContext, type APIResponse, type Page, type Request, type TestInfo } from '@playwright/test';
import { databaseConfig, verifyDatabase, trackAccount, recordAccountId, trackFixture, recordFixtureId } from '../scripts/e2e-cleanup.mjs';

// V15 SQL fixtures describe stored attendance shapes only: no native GPS, self API or provider conversion.
// Never retain Session headers, credentials or roster/export bodies in traces.
test.use({ trace: 'off' });

type Status = 'ACTIVE' | 'WAITING' | 'CANCELLED';
type Method = 'ALL' | 'SELF_LOCATION' | 'ADMIN';
type CheckIn = 'ALL' | 'CHECKED_IN' | 'NOT_CHECKED_IN';
interface Account { key: string; id: number; username: string; displayName: string; allowedDisplayNames: string[] }
interface Registration { id: number; userId: number; username: string; displayName: string; status: Status; checkedInAt: string | null; checkInMethod: 'ADMIN' | 'SELF_LOCATION' | null; checkInVersion: number; checkedInBy: number | null; createdAt: string; updatedAt: string }
interface Roster {
  activity: { id: number; title: string }; items: Registration[]; total: number; page: number; pageSize: number;
  summary: { activeRegistrations: number; checkedInRegistrations: number; notCheckedInRegistrations: number };
}
interface Query { page?: number; pageSize?: number; keyword?: string; status?: Status | 'ALL'; checkInStatus?: CheckIn; checkInMethod?: Method }
interface Person { status?: Status; prefixes?: string[]; method?: Exclude<Method, 'ALL'> }
const password = 'Demo123!';
const networkError = '暂时无法连接服务，请检查网络后重试。';
function parameters(query: Query = {}) {
  const params = new URLSearchParams();
  if (query.keyword) params.set('keyword', query.keyword.trim());
  if (query.status && query.status !== 'ALL') params.set('status', query.status);
  if (query.checkInStatus && query.checkInStatus !== 'ALL') params.set('checkInStatus', query.checkInStatus);
  if (query.checkInMethod && query.checkInMethod !== 'ALL') params.set('checkInMethod', query.checkInMethod);
  if (query.page && query.page !== 1) params.set('page', String(query.page));
  if (query.pageSize && query.pageSize !== 10) params.set('pageSize', String(query.pageSize));
  return params;
}
const apiPath = (id: number) => `/api/admin/activities/${id}/registrations`;
const uiPath = (id: number, query: Query = {}) => `/admin/activities/${id}/registrations${parameters(query).size ? '?' + parameters(query) : ''}`;
function matches(url: URL, query: Query) {
  const defaults = { keyword: '', status: 'ALL', checkInStatus: 'ALL', checkInMethod: 'ALL', page: '1', pageSize: '10' };
  const expected = parameters(query);
  return Object.entries(defaults).every(([key, value]) => (url.searchParams.get(key) ?? value) === (expected.get(key) ?? value));
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
  await expect.poll(() => { const url = new URL(page.url()); return url.pathname + url.search === uiPath(id, query); }).toBe(true);
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
  const manifestPath = process.env.E2E_RUN_MANIFEST;
  if (!manifestPath || dirname(resolve(manifestPath)) !== resolve('.runtime/e2e')) throw new Error('The verified local fixture manifest is required.');
  const config = databaseConfig(), connection = await mysql.createConnection(config);
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    await verifyDatabase(connection, config, manifest.target);
    await loginApi(request);
    const accounts: Account[] = [];
    for (const person of people) {
      const intent = trackAccount(person.prefixes ?? ['同-']);
      const response = await write(request, '/api/auth/register', { username: intent.username, displayName: intent.displayName, password });
      expect(response.status()).toBe(201); const user = await response.json(); recordAccountId(intent.key, user.id);
      accounts.push({ ...intent, id: user.id });
    }
    const owned = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const account of accounts) if (!owned.accounts.some((proof: Account) => proof.key === account.key && proof.id === account.id && proof.username === account.username && proof.displayName === account.displayName))
      throw new Error('Exact owned roster-method account proof is required.');
    const activity = trackFixture(`签到方式 ${info.project.name} ${randomUUID().slice(0, 8)}`, '独立V15方式筛选SQL结构样本，不代表真实GPS签到或高德转换，不补造历史签到审计。');
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
      [activity.title, activity.description, '签到方式独立场地', Math.max(1, active), active, actor.id]);
    for (const [index, account] of accounts.entries()) await connection.execute(
      'INSERT INTO registrations(activity_id,user_id,status,created_at,updated_at,checked_in_at,checked_in_by,check_in_method,check_in_version) VALUES(?,?,?,UTC_TIMESTAMP(6)-INTERVAL 2 HOUR+INTERVAL ? SECOND,UTC_TIMESTAMP(6)-INTERVAL 2 HOUR+INTERVAL ? SECOND,IF(? IS NULL,NULL,UTC_TIMESTAMP(6)-INTERVAL 30 MINUTE),?,?,?)',
      [created.insertId, account.id, people[index].status ?? 'ACTIVE', index, index, people[index].method ?? null, people[index].method === 'ADMIN' ? actor.id : null, people[index].method ?? null, people[index].method ? 1 : 0]);
    await connection.commit(); recordFixtureId(activity.key, created.insertId);
    const bound = await request.get(`/api/activities/${created.insertId}`); expect(bound.status()).toBe(200);
    expect(await bound.json()).toMatchObject({ id: created.insertId, title: activity.title, description: activity.description, registeredCount: active, registrationDeadline: null });
    const before = await roster(request, created.insertId, { pageSize: 100 });
    expect(before.items).toHaveLength(people.length);
    for (const [index, person] of people.entries()) expect(before.items.find(row => row.userId === accounts[index].id)).toMatchObject({
      status: person.status ?? 'ACTIVE', checkInMethod: person.method ?? null, checkInVersion: person.method ? 1 : 0,
      checkedInBy: person.method === 'ADMIN' ? actor.id : null,
    });
    return { id: created.insertId, title: activity.title, accounts, before };
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
  expect(rows.every(row => row.length === 11)).toBe(true);
  expect(rows[0]).toEqual(['报名记录ID', '用户名', '昵称', '报名状态', '签到状态', '首次报名时间（北京时间）',
    '报名更新时间（北京时间）', '签到时间（北京时间）', '签到管理员ID', '签到管理员昵称', '签到方式']);
  return rows;
}
async function exportCsv(page: Page, id: number) {
  const received = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
  const download = await received; expect(download.suggestedFilename()).toBe(`activity-${id}-registrations.csv`);
  expect(await download.failure()).toBeNull(); return parseCsv(readFileSync((await download.path())!));
}
async function settle(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
type Held = { ready: Promise<void>; release(): void; stopHolding(): void; delivered(): Promise<void>; cleanup(): Promise<void>; count(): number };
async function hold(page: Page, path: string, checkInMethod: Method, method = 'GET', options: { failure?: boolean } = {}): Promise<Held> {
  let release!: () => void, ready!: () => void, reject!: (error: unknown) => void, armed = true, count = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetched = new Promise<void>((resolve, failed) => { ready = resolve; reject = failed; });
  const jobs: Promise<{ error?: unknown }>[] = [];
  const outcomes: Promise<{ failed?: string; status?: number }>[] = [];
  const matcher = (url: URL) => url.pathname === path && (url.searchParams.get('checkInMethod') ?? 'ALL') === checkInMethod;
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
        let response: APIResponse;
        try { response = await route.fetch(); }
        catch (error) { if (method === 'GET' && /ERR_ABORTED|cancel/i.test(target.failure()?.errorText ?? '')) return; throw error; }
        expect(response.status()).toBe(200);
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
      else expect(outcome.status).toBe(200);
    }
    await settle(page);
  };
  return { ready: fetched, release, stopHolding: () => { armed = false; }, delivered, count: () => count,
    cleanup: async () => { armed = false; release(); try { await delivered(); } finally { await page.unroute(matcher); } } };
}

const mixed = (selfCount = 1): Person[] => [
  ...Array.from({ length: selfCount }, (): Person => ({ method: 'SELF_LOCATION' })),
  { method: 'ADMIN' }, {}, { status: 'WAITING' }, { status: 'CANCELLED' },
];
async function filterMethod(page: Page, id: number, checkInMethod: Method, query: Query = {}) {
  const next = { ...query, checkInMethod, page: 1 };
  const loaded = pageRoster(page, id, next);
  await choose(page, '签到方式', checkInMethod === 'ALL' ? '全部方式' : checkInMethod === 'SELF_LOCATION' ? '本人定位' : '管理员确认');
  const result = await loaded; await assertRoster(page, result); await assertQuery(page, id, next); return result;
}
async function correction(page: Page, id: number, row: Registration, checkedIn: boolean): Promise<Registration> {
  await page.getByRole('button', { name: `更正报名 ${row.id} 签到`, exact: true }).click();
  const modal = page.getByRole('dialog', { name: '更正签到', exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.getByText(checkedIn ? '已签到（补签）' : '未签到（撤销）', { exact: true })).toBeVisible();
  await modal.getByLabel('更正原因', { exact: true }).fill(checkedIn ? '方式筛选专项：管理员补签' : '方式筛选专项：撤销结构样本');
  const saved = page.waitForResponse(response => response.request().method() === 'PATCH'
    && new URL(response.url()).pathname === `${apiPath(id)}/${row.id}/check-in`);
  await modal.getByRole('button', { name: '保存更正', exact: true }).click();
  const result = await saved; expect(result.status()).toBe(200); await expect(modal).toHaveCount(0); return result.json();
}
test.afterEach(async ({ page, request }) => {
  const results = await Promise.allSettled([logoutApi(page.request), logoutApi(request)]);
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'Owned roster-method sessions could not all log out.');
});

test('方式与三类条件AND筛选，整场统计不变且跨页CSV导出方式全集', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info, mixed(13));
  await login(page); await open(page, fixture.id);
  const selected = await filterMethod(page, fixture.id, 'SELF_LOCATION');
  expect(selected.total).toBe(13); expect(selected.items).toHaveLength(10);
  expect(selected.summary).toEqual({ activeRegistrations: 15, checkedInRegistrations: 14, notCheckedInRegistrations: 1 });
  expect(selected.items.every(row => row.checkInMethod === 'SELF_LOCATION' && row.checkedInBy === null)).toBe(true);
  const query: Query = { keyword: '同-', status: 'ACTIVE', checkInStatus: 'CHECKED_IN', checkInMethod: 'SELF_LOCATION' };
  const combined = await open(page, fixture.id, query);
  expect(combined.total).toBe(13); expect(combined.summary).toEqual(selected.summary);
  const second = pageRoster(page, fixture.id, { ...query, page: 2 });
  await page.locator('.roster-table .ant-pagination-item-2').click();
  expect((await second).items).toHaveLength(3); await assertQuery(page, fixture.id, { ...query, page: 2 });
  const expected = fixture.before.items.filter(row => row.checkInMethod === 'SELF_LOCATION');
  const exportRequest = page.waitForRequest(request => new URL(request.url()).pathname === `${apiPath(fixture.id)}/export`);
  const csv = await exportCsv(page, fixture.id);
  expect(new URL((await exportRequest).url()).searchParams.get('checkInMethod')).toBe('SELF_LOCATION');
  expect(csv.slice(1).map(row => row[0])).toEqual(expected.map(row => `\t${row.id}`));
  expect(csv.slice(1).every(row => row[8] === '' && row[9] === '' && row[10] === '定位签到')).toBe(true);
  expect((await search(page, fixture.id, fixture.accounts[0].username, query)).items.map(row => row.userId)).toEqual([fixture.accounts[0].id]);
  const empty = await open(page, fixture.id, { ...query, status: 'WAITING' });
  expect(empty.total).toBe(0); expect(empty.summary).toEqual(selected.summary); expect(await exportCsv(page, fixture.id)).toHaveLength(1);
  const admin = await open(page, fixture.id, { keyword: '同-', status: 'ACTIVE', checkInStatus: 'CHECKED_IN', checkInMethod: 'ADMIN' });
  expect(admin.items.map(row => row.id)).toEqual(fixture.before.items.filter(row => row.checkInMethod === 'ADMIN').map(row => row.id));
  expect((await exportCsv(page, fixture.id))[1][10]).toBe('管理员签到');
  await capture(page, info, 'roster-method-combined-csv');
});

test('方式URL直达登录刷新历史与详情返回，非法方式和越界页准确规范化', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info, mixed(12));
  const saved: Query = { keyword: '同-', status: 'ACTIVE', checkInStatus: 'CHECKED_IN', checkInMethod: 'SELF_LOCATION', page: 2, pageSize: 5 };
  await page.goto(uiPath(fixture.id, saved)); await expect(page).toHaveURL(/\/login$/);
  const afterLogin = pageRoster(page, fixture.id, saved); await loginForm(page); await assertRoster(page, await afterLogin); await assertQuery(page, fixture.id, saved);
  const reloaded = pageRoster(page, fixture.id, saved); await page.reload(); await assertRoster(page, await reloaded);
  await filterMethod(page, fixture.id, 'ADMIN', saved);
  const back = pageRoster(page, fixture.id, saved); await page.goBack(); await assertRoster(page, await back); await assertQuery(page, fixture.id, saved);
  const forward = pageRoster(page, fixture.id, { ...saved, checkInMethod: 'ADMIN', page: 1 }); await page.goForward(); await assertRoster(page, await forward);
  const backAgain = pageRoster(page, fixture.id, saved); await page.goBack(); await backAgain;
  await page.getByRole('link', { name: fixture.title, exact: true }).click();
  await expect(page.getByRole('heading', { name: fixture.title, exact: true })).toBeVisible();
  const returned = pageRoster(page, fixture.id, saved); await page.getByRole('link', { name: '返回报名名单', exact: true }).click();
  await assertRoster(page, await returned); await assertQuery(page, fixture.id, saved);
  const bounded = pageRoster(page, fixture.id, { ...saved, page: 3 }); await page.goto(uiPath(fixture.id, { ...saved, page: 999 }));
  await assertRoster(page, await bounded); await assertQuery(page, fixture.id, { ...saved, page: 3 });
  const prior = pageRoster(page, fixture.id, saved); await page.goBack(); await prior; await assertQuery(page, fixture.id, saved);
  const normalized = pageRoster(page, fixture.id, { keyword: '同-' });
  await page.goto(`/admin/activities/${fixture.id}/registrations?checkInMethod=INVALID&keyword=${encodeURIComponent('同-')}`);
  await assertRoster(page, await normalized); await assertQuery(page, fixture.id, { keyword: '同-' });
  for (const value of ['INVALID', 'self_location', '']) for (const suffix of ['', '/export'])
    expect((await request.get(`${apiPath(fixture.id)}${suffix}?checkInMethod=${value}`)).status()).toBe(400);
  expect((await request.get(`${apiPath(fixture.id)}?checkInMethod=ALL`)).status()).toBe(200);
  expect((await roster(request, fixture.id, { checkInMethod: 'ALL' })).total).toBe(fixture.before.total);
});

test('当前方式读取失败可恢复，普通用户无管理读取及名单CSV权限', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info, mixed());
  await login(page); await open(page, fixture.id);
  const broken = await hold(page, apiPath(fixture.id), 'SELF_LOCATION', 'GET', { failure: true });
  try {
    await choose(page, '签到方式', '本人定位'); await broken.ready;
    broken.stopHolding(); broken.release(); await broken.delivered();
    await expect(page.getByText(networkError, { exact: true })).toBeVisible();
    await expect(page.getByTestId('roster-active-count')).toHaveText('—');
    const recovered = pageRoster(page, fixture.id, { checkInMethod: 'SELF_LOCATION' });
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    expect((await recovered).total).toBe(1); await assertQuery(page, fixture.id, { checkInMethod: 'SELF_LOCATION' });
  } finally { await broken.cleanup(); }
  await logout(page); await login(page, fixture.accounts[0]);
  const adminReads: string[] = [];
  page.on('request', request => { const pathname = new URL(request.url()).pathname;
    if (request.method() === 'GET' && (pathname.startsWith('/api/admin/') || pathname.startsWith('/assets/AdminRegistrationsPage'))) adminReads.push(pathname); });
  await page.goto(uiPath(fixture.id, { checkInMethod: 'SELF_LOCATION' }));
  await expect(page.getByText('此页面仅对活动组织者开放', { exact: true })).toBeVisible(); expect(adminReads).toEqual([]);
  for (const suffix of ['', '/export']) expect((await page.request.get(`${apiPath(fixture.id)}${suffix}?checkInMethod=SELF_LOCATION`)).status()).toBe(403);
});

test('跨方式迟到名单成功或失败不覆盖新状态，旧CSV不下载而新方式可导出', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info, mixed());
  await login(page); await open(page, fixture.id);
  for (const failure of [false, true]) {
    const old = await hold(page, apiPath(fixture.id), 'SELF_LOCATION', 'GET', { failure });
    const current = await hold(page, apiPath(fixture.id), 'ADMIN');
    try {
      await choose(page, '签到方式', '本人定位'); await old.ready;
      await choose(page, '签到方式', '管理员确认'); await current.ready;
      old.stopHolding(); old.release(); await old.delivered();
      await expect(page.getByRole('button', { name: '刷新名单', exact: true })).toHaveClass(/ant-btn-loading/);
      await expect(page.getByText(networkError, { exact: true })).toHaveCount(0);
      const loaded = pageRoster(page, fixture.id, { checkInMethod: 'ADMIN' }); current.stopHolding(); current.release(); await current.delivered();
      const result = await loaded; expect(result.items.map(row => row.id)).toEqual(fixture.before.items.filter(row => row.checkInMethod === 'ADMIN').map(row => row.id));
      await assertRoster(page, result); await assertQuery(page, fixture.id, { checkInMethod: 'ADMIN' });
    } finally { await Promise.all([old.cleanup(), current.cleanup()]); }
  }
  const downloads: string[] = []; page.on('download', download => downloads.push(download.suggestedFilename()));
  const oldCsv = await hold(page, `${apiPath(fixture.id)}/export`, 'ADMIN');
  try {
    await page.getByRole('button', { name: '导出 CSV', exact: true }).click(); await oldCsv.ready;
    const current = await filterMethod(page, fixture.id, 'SELF_LOCATION');
    oldCsv.stopHolding(); oldCsv.release(); await oldCsv.delivered(); expect(downloads).toEqual([]); await assertRoster(page, current);
    const csv = await exportCsv(page, fixture.id); expect(csv).toHaveLength(2); expect(csv[1][10]).toBe('定位签到');
  } finally { await oldCsv.cleanup(); }
});

test('撤销移出方式末页后replace修正，补签变为管理员方式且报名字段保留', async ({ page, request }, info) => {
  const fixture = await fixtures(request, info, mixed(11));
  await login(page);
  const last = await open(page, fixture.id, { checkInMethod: 'SELF_LOCATION', page: 2 }); expect(last.items).toHaveLength(1);
  const target = last.items[0], bounded = pageRoster(page, fixture.id, { checkInMethod: 'SELF_LOCATION' });
  const revoked = await correction(page, fixture.id, target, false);
  expect(revoked).toMatchObject({ status: target.status, createdAt: target.createdAt, updatedAt: target.updatedAt,
    checkedInAt: null, checkedInBy: null, checkInMethod: null, checkInVersion: target.checkInVersion + 1 });
  const remaining = await bounded; expect(remaining.total).toBe(10); await assertRoster(page, remaining); await assertQuery(page, fixture.id, { checkInMethod: 'SELF_LOCATION' });
  expect(remaining.summary).toEqual({ activeRegistrations: 13, checkedInRegistrations: 11, notCheckedInRegistrations: 2 });
  expect((await roster(request, fixture.id, { checkInMethod: 'SELF_LOCATION', pageSize: 100 })).items.some(row => row.id === target.id)).toBe(false);
  await open(page, fixture.id, { keyword: target.username });
  const refreshed = pageRoster(page, fixture.id, { keyword: target.username }); const corrected = await correction(page, fixture.id, revoked, true);
  expect(corrected).toMatchObject({ status: target.status, createdAt: target.createdAt, updatedAt: target.updatedAt,
    checkInMethod: 'ADMIN', checkInVersion: target.checkInVersion + 2 }); expect(corrected.checkedInBy).not.toBeNull();
  await assertRoster(page, await refreshed);
  expect((await filterMethod(page, fixture.id, 'SELF_LOCATION', { keyword: target.username })).total).toBe(0);
  const admin = await filterMethod(page, fixture.id, 'ADMIN', { keyword: target.username }); expect(admin.items.map(row => row.id)).toEqual([target.id]);
  expect(admin.summary).toEqual(fixture.before.summary); await capture(page, info, 'roster-method-correction-page');
});
