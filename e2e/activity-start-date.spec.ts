import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { test, expect, type APIRequestContext, type Page, type Request, type TestInfo } from '@playwright/test';
import { databaseConfig, verifyDatabase, trackFixture, recordFixtureId } from '../scripts/e2e-cleanup.mjs';

// Real sessions and SQL fixtures; never record credentials or response bodies in traces.
// A different browser timezone proves these inputs describe Beijing calendar dates.
test.use({ trace: 'off', timezoneId: 'America/New_York' });
type Surface = 'public' | 'admin';
type Query = { keyword?: string; status?: string; category?: string; startDateFrom?: string; startDateTo?: string; page?: number; pageSize?: number };
type Activity = { id: number; title: string };
type Result = { items: Activity[]; total: number; page: number; pageSize: number; summary?: { upcomingActivities: number; availableSeats: number } };
const leapDay = '2088-02-29', nextDay = '2088-03-01';
const endpoint = (surface: Surface) => surface === 'public' ? '/api/activities/search' : '/api/admin/activities';
const pathname = (surface: Surface) => surface === 'public' ? '/activities' : '/admin/activities';
const defaultSize = (surface: Surface) => surface === 'public' ? 12 : 10;

function parameters(surface: Surface, query: Query, canonical = false) {
  const defaults = { keyword: '', status: 'ALL', category: 'ALL', startDateFrom: '', startDateTo: '', page: 1, pageSize: defaultSize(surface) };
  const values = { ...defaults, ...query }, params = new URLSearchParams();
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const value = values[key];
    if ((key === 'startDateFrom' || key === 'startDateTo') && !value) continue;
    if (!canonical || value !== defaults[key]) params.set(key, String(value));
  }
  return params;
}
function path(surface: Surface, query: Query) {
  const search = parameters(surface, query, true).toString();
  return `${pathname(surface)}${search ? `?${search}` : ''}`;
}
function matches(request: Request, surface: Surface, query: Query) {
  const url = new URL(request.url());
  return request.method() === 'GET' && url.pathname === endpoint(surface)
    && [...parameters(surface, query)].every(([key, value]) => url.searchParams.get(key) === value)
    && (url.searchParams.get('startDateFrom') ?? '') === (query.startDateFrom ?? '')
    && (url.searchParams.get('startDateTo') ?? '') === (query.startDateTo ?? '');
}
async function completed(page: Page, surface: Surface, query: Query): Promise<Result> {
  const request = await page.waitForEvent('requestfinished', { predicate: request => matches(request, surface, query) });
  const response = await request.response();
  expect(response?.status()).toBe(200);
  return response!.json();
}
async function open(page: Page, surface: Surface, query: Query) {
  const loaded = completed(page, surface, query);
  await page.goto(path(surface, query));
  return loaded;
}
async function assertUrl(page: Page, surface: Surface, query: Query) {
  await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe(path(surface, query));
}
async function assertView(page: Page, surface: Surface, result: Result, ids: number[], total: number, summary?: [number, number]) {
  expect(result.total).toBe(total);
  expect(result.items.map(item => item.id)).toEqual(ids);
  await expect.poll(() => page.locator('[data-activity-id]').evaluateAll(rows => rows.map(row => Number(row.getAttribute('data-activity-id'))))).toEqual(ids);
  if (surface === 'public') {
    if (summary) expect(result.summary).toEqual({ upcomingActivities: summary[0], availableSeats: summary[1] });
    for (const [key, value] of Object.entries(result.summary!))
      await expect.poll(async () => (await page.getByTestId(`discovery-${key}`).locator('.ant-statistic-content-value').innerText()).replace(/[\s,]/g, '')).toBe(String(value));
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function dates(page: Page, from = '', to = '') {
  await page.getByLabel('开始日期（起）', { exact: true }).fill(from);
  await page.getByLabel('开始日期（止）', { exact: true }).fill(to);
}
async function assertDates(page: Page, from = '', to = '') {
  await expect(page.getByLabel('开始日期（起）', { exact: true })).toHaveValue(from);
  await expect(page.getByLabel('开始日期（止）', { exact: true })).toHaveValue(to);
}
async function choose(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ has: page.getByText(value, { exact: true }) }).click();
  await expect(page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')).toHaveCount(0);
}
async function loginForm(page: Page, username = 'admin') {
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(username === 'admin' ? 'Admin123!' : 'Demo123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: /账号菜单/ })).toBeVisible();
}
async function login(page: Page) { await page.goto('/login'); await loginForm(page); }
async function logout(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  await page.getByRole('menuitem', { name: /退出登录/ }).click();
  await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
}
async function fixtures(request: APIRequestContext, info: TestInfo) {
  const csrfResponse = await request.get('/api/auth/csrf'); expect(csrfResponse.status()).toBe(200);
  const csrf = await csrfResponse.json();
  expect((await request.post('/api/auth/login', { headers: { [csrf.headerName]: csrf.token },
    form: { username: 'admin', password: 'Admin123!' } })).status()).toBe(200);
  const me = await request.get('/api/auth/me'); expect(me.status()).toBe(200);
  const actor = await me.json(); expect(actor.role).toBe('ADMIN');
  const keyword = `日期%_ ${info.project.name} ${randomUUID().slice(0, 8)}`;
  const cases = [
    { key: 'past', label: '历史不限日期', start: '2000-02-28 16:00:00.000000', capacity: 2, category: 'TECHNOLOGY' },
    { key: 'before', label: '北京时间前一日末', start: '2088-02-28 15:59:59.999999', capacity: 2, category: 'TECHNOLOGY' },
    { key: 'lower', label: '北京时间闰日零点', start: '2088-02-28 16:00:00.000000', capacity: 2, category: 'TECHNOLOGY' },
    { key: 'middle', label: '北京时间闰日中午', start: '2088-02-29 04:00:00.000000', capacity: 3, category: 'TECHNOLOGY' },
    { key: 'other', label: '北京时间闰日其他类', start: '2088-02-29 05:00:00.000000', capacity: 7, category: 'OTHER' },
    { key: 'cancelled', label: '北京时间闰日已取消', start: '2088-02-29 06:00:00.000000', capacity: 2, category: 'TECHNOLOGY' },
    { key: 'trap', label: '字面搜索陷阱', start: '2088-02-29 07:00:00.000000', capacity: 9, category: 'TECHNOLOGY' },
    { key: 'upper', label: '北京时间闰日末', start: '2088-02-29 15:59:59.999999', capacity: 4, category: 'TECHNOLOGY' },
    { key: 'next', label: '北京时间次月零点', start: '2088-02-29 16:00:00.000000', capacity: 5, category: 'TECHNOLOGY' },
  ] as const;
  const declared = cases.map(item => ({ ...item, intent: trackFixture(`${item.key === 'trap' ? keyword.replace('%_', 'ZZ') : keyword} ${item.label}`,
    '独立归属的北京时间开始日期筛选样本；直接创建精确微秒边界，不修改样例活动或已有时间。') }));
  const config = databaseConfig(), db = await mysql.createConnection(config);
  const rows = {} as Record<typeof cases[number]['key'], Activity>;
  try {
    await verifyDatabase(db, config, JSON.parse(readFileSync(process.env.E2E_RUN_MANIFEST!, 'utf8')).target);
    await db.beginTransaction();
    const [actors] = await db.execute<any[]>("SELECT id FROM users WHERE id=? AND username='admin' AND role='ADMIN' FOR UPDATE", [actor.id]);
    expect(actors).toHaveLength(1);
    const inserted: { key: typeof cases[number]['key']; fixtureKey: string; activity: Activity }[] = [];
    for (const item of declared) {
      const [result] = await db.execute<mysql.ResultSetHeader>(
        'INSERT INTO activities(title,description,location,starts_at,ends_at,capacity,registered_count,created_by,category,cancelled_at,cancelled_by,cancellation_reason) VALUES(?,?,?,?,?,?,0,?,?,?,?,?)',
        [item.intent.title, item.intent.description, '日期筛选独立场地', item.start,
          item.key === 'past' ? '2000-02-29 16:00:00.000000' : null, item.capacity, actor.id, item.category,
          item.key === 'cancelled' ? '2000-01-01 00:00:00.000000' : null,
          item.key === 'cancelled' ? actor.id : null, item.key === 'cancelled' ? '日期筛选取消样本' : null]);
      inserted.push({ key: item.key, fixtureKey: item.intent.key, activity: { id: result.insertId, title: item.intent.title } });
    }
    await db.commit();
    for (const item of inserted) { recordFixtureId(item.fixtureKey, item.activity.id); rows[item.key] = item.activity; }
  } catch (error) { await db.rollback(); throw error; } finally { await db.end(); }
  return { keyword, ...rows };
}

// Hold every matching read, including Strict Mode's cancelled first read. Responses
// are fetched from the real server; only delivery or a genuine network failure waits.
async function hold(page: Page, surface: Surface, query: Query, fail: boolean) {
  let release!: () => void, ready!: () => void, rejectReady!: (error: unknown) => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  const jobs: Promise<{ error?: unknown }>[] = [];
  const pattern = `**${endpoint(surface)}?**`;
  await page.route(pattern, route => {
    if (!matches(route.request(), surface, query)) return route.continue();
    const job = (async () => {
      try {
        let response;
        try { response = await route.fetch(); }
        catch {
          if (route.request().failure()) return;
          throw new Error('The delayed start-date query could not fetch its genuine server response.');
        }
        expect(response.status()).toBe(200);
        const result = await response.json() as Result;
        expect(result.page).toBe(query.page); expect(result.total).toBe(3); expect(result.items).toHaveLength(0);
        ready(); await gate;
        try { if (fail) await route.abort('failed'); else await route.fulfill({ response }); }
        catch (error) { if (!route.request().failure()) throw error; }
      } catch (error) { rejectReady(error); throw error; }
    })();
    const outcome = job.then(() => ({}), error => ({ error })); jobs.push(outcome);
    return outcome.then(() => undefined);
  });
  async function delivered() {
    const errors = (await Promise.all(jobs)).flatMap(result => result.error === undefined ? [] : [result.error]);
    if (errors.length) throw new AggregateError(errors, 'A delayed real start-date response failed.');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  return { ready: arrived, release, delivered, cleanup: async () => { release(); await page.unrouteAll({ behavior: 'wait' }); await delivered(); } };
}

for (const surface of ['public', 'admin'] as const) {
  test(`${surface} 开始日期按北京时间包含闰日两端，草稿提交、单侧、组合分页和全集统计`, async ({ page, request }, info) => {
    const data = await fixtures(request, info); if (surface === 'admin') await login(page);
    const baseline = { keyword: data.keyword, pageSize: 2 };
    await assertView(page, surface, await open(page, surface, baseline), [data.past.id, data.before.id], 8, [6, 23]);
    let query: Query = { ...baseline, status: 'UPCOMING', category: 'TECHNOLOGY', startDateFrom: leapDay, startDateTo: leapDay, page: 2 };
    await assertView(page, surface, await open(page, surface, query), [data.upper.id], 3, [3, 9]);
    await assertDates(page, leapDay, leapDay); await assertUrl(page, surface, query);
    await expect(page.getByText('按北京时间，包含首尾日期', { exact: true })).toBeVisible();
    let requests = 0; page.on('request', request => { if (new URL(request.url()).pathname === endpoint(surface)) requests++; });
    const before = requests;
    await dates(page, nextDay, nextDay); await page.getByLabel('搜索活动', { exact: true }).fill(`${data.keyword} 未提交`);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(requests).toBe(before); await assertUrl(page, surface, query);
    await expect(page.locator('[data-activity-id]')).toHaveAttribute('data-activity-id', String(data.upper.id));
    await page.getByLabel('搜索活动', { exact: true }).fill(data.keyword);
    query = { ...query, startDateFrom: '', page: 1 };
    await dates(page, '', leapDay);
    let loaded = completed(page, surface, query); await page.getByLabel('搜索活动', { exact: true }).press('Enter');
    await assertView(page, surface, await loaded, [data.before.id, data.lower.id], 4, [4, 11]); await assertUrl(page, surface, query);
    query = { ...query, startDateFrom: leapDay, startDateTo: '' }; await dates(page, leapDay, '');
    loaded = completed(page, surface, query); await page.getByRole('button', { name: '查询', exact: true }).click();
    await assertView(page, surface, await loaded, [data.lower.id, data.middle.id], 4, [4, 14]);
    query = { ...query, startDateTo: leapDay }; await dates(page, leapDay, leapDay);
    loaded = completed(page, surface, query); await page.getByRole('button', { name: '查询', exact: true }).click();
    await assertView(page, surface, await loaded, [data.lower.id, data.middle.id], 3, [3, 9]);
    query = { ...query, status: 'ALL' }; loaded = completed(page, surface, query); await choose(page, '活动状态', '全部状态');
    await assertView(page, surface, await loaded, [data.lower.id, data.middle.id], 4, [3, 9]);
    query = { ...query, category: 'OTHER' }; loaded = completed(page, surface, query); await choose(page, '活动分类', '其他');
    await assertView(page, surface, await loaded, [data.other.id], 1, [1, 7]); await assertDates(page, leapDay, leapDay);
    query = { ...query, status: 'UPCOMING', category: 'TECHNOLOGY', page: 2 };
    await assertView(page, surface, await open(page, surface, query), [data.upper.id], 3, [3, 9]);
    const pageSize = surface === 'public' ? 24 : 20; query = { ...query, page: 1, pageSize };
    loaded = completed(page, surface, query); await choose(page, surface === 'public' ? '每页数量' : '每页管理活动数量', `${pageSize} 条/页`);
    await assertView(page, surface, await loaded, [data.lower.id, data.middle.id, data.upper.id], 3, [3, 9]); await assertUrl(page, surface, query);
    loaded = completed(page, surface, query); await page.getByRole('button', { name: '查询', exact: true }).click();
    await assertView(page, surface, await loaded, [data.lower.id, data.middle.id, data.upper.id], 3, [3, 9]);
    const reset = completed(page, surface, { pageSize }); await page.getByRole('button', { name: /^重\s*置$/ }).click();
    const unfiltered = await reset; await assertView(page, surface, unfiltered, unfiltered.items.map(item => item.id), unfiltered.total);
    await assertUrl(page, surface, { pageSize }); await assertDates(page); await expect(page.getByLabel('搜索活动', { exact: true })).toHaveValue('');
    await page.screenshot({ path: info.outputPath(`${surface}-start-date-filters.png`), fullPage: true });
  });

  test(`${surface} 日期URL直达刷新历史与登录返回保留条件，非法日期、空结果及网络错误可恢复`, async ({ page, request }, info) => {
    const data = await fixtures(request, info);
    const query: Query = { keyword: data.keyword, status: 'UPCOMING', category: 'TECHNOLOGY', startDateFrom: leapDay, startDateTo: leapDay, page: 2, pageSize: 2 };
    if (surface === 'admin') {
      let adminReads = 0; page.on('request', request => { if (new URL(request.url()).pathname === endpoint('admin')) adminReads++; });
      await page.goto(path(surface, query)); await expect(page).toHaveURL(/\/login$/); await loginForm(page, 'demo');
      await expect(page.getByText('此页面仅对活动组织者开放', { exact: true })).toBeVisible(); expect(adminReads).toBe(0);
      expect((await page.request.get(`${endpoint(surface)}?${parameters(surface, query)}`)).status()).toBe(403);
      await logout(page); await page.goto(path(surface, query)); await expect(page).toHaveURL(/\/login$/);
      const loaded = completed(page, surface, query); await loginForm(page);
      await assertView(page, surface, await loaded, [data.upper.id], 3, [3, 9]);
    } else await assertView(page, surface, await open(page, surface, query), [data.upper.id], 3, [3, 9]);
    await assertUrl(page, surface, query);
    let loaded = completed(page, surface, query); await page.reload(); await assertView(page, surface, await loaded, [data.upper.id], 3, [3, 9]);
    await page.getByRole('link', { name: surface === 'public' ? `查看${data.upper.title}的详情` : data.upper.title, exact: true }).click();
    await expect(page.getByRole('heading', { name: data.upper.title, exact: true })).toBeVisible();
    if (surface === 'public') {
      await page.getByRole('button', { name: '登录后收藏', exact: true }).click(); await loginForm(page, 'demo');
      await expect(page.getByRole('heading', { name: data.upper.title, exact: true })).toBeVisible();
      loaded = completed(page, surface, query); await page.getByRole('link', { name: '返回活动列表', exact: true }).click();
    } else { loaded = completed(page, surface, query); await page.goBack(); }
    await assertView(page, surface, await loaded, [data.upper.id], 3, [3, 9]); await assertUrl(page, surface, query);
    const next: Query = { ...query, startDateFrom: nextDay, startDateTo: nextDay, page: 1 };
    await dates(page, nextDay, nextDay); loaded = completed(page, surface, next); await page.getByRole('button', { name: '查询', exact: true }).click();
    await assertView(page, surface, await loaded, [data.next.id], 1, [1, 5]);
    loaded = completed(page, surface, query); await page.goBack(); await assertView(page, surface, await loaded, [data.upper.id], 3, [3, 9]); await assertDates(page, leapDay, leapDay);
    loaded = completed(page, surface, next); await page.goForward(); await assertView(page, surface, await loaded, [data.next.id], 1, [1, 5]); await assertDates(page, nextDay, nextDay);
    const invalid = [
      { from: '2088-02-30', to: leapDay, corrected: { ...query, startDateFrom: '' }, ids: [data.middle.id, data.upper.id], total: 4, summary: [4, 11] },
      { from: leapDay, to: '2101-01-01', corrected: { ...query, startDateTo: '' }, ids: [data.upper.id, data.next.id], total: 4, summary: [4, 14] },
      { from: '1999-12-31', to: leapDay, corrected: { ...query, startDateFrom: '' }, ids: [data.middle.id, data.upper.id], total: 4, summary: [4, 11] },
      { from: nextDay, to: leapDay, corrected: { ...query, startDateFrom: '', startDateTo: '' }, ids: [data.middle.id, data.upper.id], total: 5, summary: [5, 16] },
    ];
    for (const item of invalid) {
      loaded = completed(page, surface, item.corrected); await page.goto(path(surface, { ...query, startDateFrom: item.from, startDateTo: item.to }));
      await assertView(page, surface, await loaded, item.ids, item.total, item.summary as [number, number]); await assertUrl(page, surface, item.corrected);
      await assertDates(page, item.corrected.startDateFrom, item.corrected.startDateTo);
      await expect(page.locator('.discovery-notice').filter({ hasText: /日期/ })).toBeVisible();
    }
    const empty = { ...query, startDateFrom: '2088-03-02', startDateTo: '2088-03-02', page: 1 };
    await assertView(page, surface, await open(page, surface, empty), [], 0, [0, 0]);
    await expect(page.getByText('暂无符合条件的活动', { exact: true })).toBeVisible();
    const pattern = `**${endpoint(surface)}?**`;
    try {
      await page.route(pattern, route => route.abort('failed')); await page.goto(path(surface, query));
      await expect(page.getByRole('button', { name: '重新加载', exact: true })).toBeVisible(); await assertDates(page, leapDay, leapDay);
      if (surface === 'public') for (const key of ['upcomingActivities', 'availableSeats'])
        await expect(page.getByTestId(`discovery-${key}`).locator('.ant-statistic-content-value')).toHaveText('—');
    } finally { await page.unrouteAll({ behavior: 'wait' }); }
    loaded = completed(page, surface, query); await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await assertView(page, surface, await loaded, [data.upper.id], 3, [3, 9]); await assertUrl(page, surface, query);
  });

  test(`${surface} 日期越界分页使用replace，旧真实成功或失败迟到不能覆盖新日期或排队纠页`, async ({ page, request }, info) => {
    const data = await fixtures(request, info); if (surface === 'admin') await login(page);
    const baseline: Query = { keyword: data.keyword, status: 'UPCOMING', category: 'TECHNOLOGY', pageSize: 2 };
    await assertView(page, surface, await open(page, surface, baseline), [data.before.id, data.lower.id], 5, [5, 16]);
    const stale: Query = { ...baseline, startDateFrom: leapDay, startDateTo: leapDay, page: 99 };
    let loaded = completed(page, surface, { ...stale, page: 2 }); await page.goto(path(surface, stale));
    await assertView(page, surface, await loaded, [data.upper.id], 3, [3, 9]); await assertUrl(page, surface, { ...stale, page: 2 });
    loaded = completed(page, surface, baseline); await page.goBack();
    await assertView(page, surface, await loaded, [data.before.id, data.lower.id], 5, [5, 16]); await assertUrl(page, surface, baseline);
    const next: Query = { ...baseline, startDateFrom: nextDay, startDateTo: nextDay };
    for (const fail of [false, true]) {
      const pending = await hold(page, surface, stale, fail);
      try {
        await page.goto(path(surface, stale)); await pending.ready;
        if (surface === 'public') for (const key of ['upcomingActivities', 'availableSeats'])
          await expect(page.getByTestId(`discovery-${key}`).locator('.ant-statistic-content-value')).toHaveText('—');
        await dates(page, nextDay, nextDay); loaded = completed(page, surface, next);
        await page.getByRole('button', { name: '查询', exact: true }).click();
        const current = await loaded; await assertView(page, surface, current, [data.next.id], 1, [1, 5]);
        pending.release(); await pending.delivered();
        await assertView(page, surface, current, [data.next.id], 1, [1, 5]); await assertUrl(page, surface, next); await assertDates(page, nextDay, nextDay);
        await expect(page.getByRole('button', { name: '重新加载', exact: true })).toHaveCount(0);
      } finally { await pending.cleanup(); }
    }
  });
}
