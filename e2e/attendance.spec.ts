import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { databaseConfig, verifyDatabase, trackAccount, recordAccountId, trackFixture, recordFixtureId } from '../scripts/e2e-cleanup.mjs';

test.use({ trace: 'off' }); // No Cookie, password, CSRF or request bodies in traces.
const endpoint = '/api/admin/attendance';
const dashboard = '/admin/dashboard';
const panel = (page: Page) => page.getByTestId('attendance-panel');
const networkError = '暂时无法连接服务，请检查网络后重试。';
interface Counts { totalActivities: number; activeRegistrations: number; checkedInRegistrations: number;
  notCheckedInRegistrations: number; checkInRate: number | null }
interface Item { id: number; title: string; location: string; startsAt: string; capacity: number;
  activeRegistrations: number; checkedInRegistrations: number; notCheckedInRegistrations: number; checkInRate: number | null }
interface Result { items: Item[]; total: number; page: number; pageSize: number; from: string; to: string; asOf: string; summary: Counts }
interface Seed { active?: number; checked?: number; waiting?: number; cancelledRegistrations?: number; cancelled?: boolean; startsAt?: string }
interface Seeded { id: number; title: string; registrationIds: number[]; active: number; checked: number; startsAt: string }
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const midnight = (day: string) => Date.parse(`${day}T00:00:00+08:00`);
const sqlTime = (time: number) => new Date(time).toISOString().replace('T', ' ').replace('Z', '000');
const scenarioDay = (info: TestInfo, scenario: number) => addDays('2004-01-01', scenario * 4 + (info.project.name === 'mobile' ? 100 : 0));

async function write(request: APIRequestContext, path: string, data?: unknown) {
  const csrf = await request.get('/api/auth/csrf');
  expect(csrf.status()).toBe(200);
  const token = await csrf.json();
  return request.post(path, { headers: { [token.headerName]: token.token }, data });
}

async function loginApi(request: APIRequestContext, username = 'admin') {
  const token = await (await request.get('/api/auth/csrf')).json();
  const response = await request.post('/api/auth/login', { headers: { [token.headerName]: token.token },
    form: { username, password: username === 'admin' ? 'Admin123!' : 'Demo123!' } });
  expect(response.status()).toBe(200);
  return response.json();
}

async function logoutApi(request: APIRequestContext) {
  const current = await request.get('/api/auth/me');
  if (current.status() === 401) return;
  expect(current.status()).toBe(200);
  expect((await write(request, '/api/auth/logout')).status()).toBe(200);
}

async function finish(primaryError: unknown, operations: Array<() => Promise<unknown>>) {
  const errors = primaryError === undefined ? [] : [primaryError];
  for (const operation of operations) try { await operation(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Attendance verification failed; the first error preserves the original failure.');
}

async function loginForm(page: Page, username = 'admin') {
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(username === 'admin' ? 'Admin123!' : 'Demo123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: /账号菜单/ })).toBeVisible();
}

async function login(page: Page, username = 'admin') { await page.goto('/login'); await loginForm(page, username); }
async function logout(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  await page.getByRole('menuitem', { name: /退出登录/ }).click();
  await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
}

async function api(request: APIRequestContext, from?: string, to = from, currentPage = 1, pageSize = 10) {
  const query = new URLSearchParams({ page: String(currentPage), pageSize: String(pageSize) });
  if (from !== undefined) { query.set('from', from); query.set('to', to!); }
  const response = await request.get(`${endpoint}?${query}`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<Result>;
}

function url(from: string, to = from, currentPage = 1, pageSize = 10) {
  const query = new URLSearchParams({ from, to });
  if (currentPage !== 1) query.set('page', String(currentPage));
  if (pageSize !== 10) query.set('pageSize', String(pageSize));
  return `${dashboard}?${query}`;
}

async function assertView(page: Page, result: Result) {
  await expect(panel(page).locator('[data-attendance-activity-id]')).toHaveCount(result.items.length);
  await expect.poll(() => panel(page).locator('[data-attendance-activity-id]').evaluateAll(rows =>
    rows.map(row => Number(row.getAttribute('data-attendance-activity-id'))))).toEqual(result.items.map(item => item.id));
  await expect(page.getByTestId('attendance-total')).toHaveText(`当前筛选共 ${result.total} 场活动`);
  for (const key of ['totalActivities', 'activeRegistrations', 'checkedInRegistrations', 'notCheckedInRegistrations'] as const) {
    await expect(page.getByTestId(`attendance-summary-${key}`).locator('.ant-statistic-content-value'))
      .toHaveText(String(result.summary[key]));
  }
  await expect(page.getByTestId('attendance-summary-checkInRate')).toHaveText(result.summary.checkInRate === null
    ? '不适用（无有效报名）' : `${result.summary.checkInRate.toFixed(2)}%`);
  await expect(page.getByTestId('attendance-asOf')).toContainText('截至查询时间（北京时间）：');
  await expect(page.getByTestId('attendance-asOf')).toContainText(/\d{2}:\d{2}:\d{2}\.\d{6}/);
}

async function capture(page: Page, info: TestInfo, name: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function choose(page: Page, option: string) {
  await page.getByRole('combobox', { name: '每页签到活动数量', exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ has: page.getByText(option, { exact: true }) }).click();
  await expect(page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')).toHaveCount(0);
}

async function query(page: Page, from: string, to = from) {
  await page.getByLabel('签到分析开始日期', { exact: true }).fill(from);
  await page.getByLabel('签到分析结束日期', { exact: true }).fill(to);
  await page.getByRole('button', { name: '查询签到分析', exact: true }).click();
}

async function openOverview(page: Page) {
  const mobile = page.getByRole('button', { name: '打开导航', exact: true });
  if (await mobile.isVisible()) await mobile.click();
  await page.getByRole('link', { name: '概览', exact: true }).click();
  await expect(page.getByRole('heading', { name: '活动签到分析', exact: true })).toBeVisible();
}

async function seed(request: APIRequestContext, info: TestInfo, scenario: number, specs: Seed[]) {
  const from = scenarioDay(info, scenario);
  const base = midnight(from);
  const config = databaseConfig();
  const manifest = JSON.parse(readFileSync(process.env.E2E_RUN_MANIFEST!, 'utf8'));
  const db = await mysql.createConnection(config);
  try {
    await verifyDatabase(db, config, manifest.target);
    const [[existing]] = await db.execute<any[]>(
      'SELECT COUNT(*) AS total FROM activities WHERE starts_at >= ? AND starts_at < ?', [sqlTime(base - 86400000), sqlTime(base + 3 * 86400000)]);
    expect(Number(existing.total)).toBe(0); // Every scenario owns a separate historical interval.
    const [users] = await db.execute<any[]>("SELECT id, username, display_name AS displayName, role FROM users WHERE username IN ('admin','demo') ORDER BY id");
    const administrator = users.find(user => user.username === 'admin' && user.role === 'ADMIN');
    expect(administrator).toBeTruthy();
    const me = await (await request.get('/api/auth/me')).json();
    expect(me).toMatchObject({ id: administrator.id, username: 'admin', role: 'ADMIN' });
    const needed = Math.max(2, ...specs.map(spec => (spec.active ?? 0) + (spec.waiting ?? 0) + (spec.cancelledRegistrations ?? 0)));
    while (users.length < needed) {
      const account = trackAccount(['析-']);
      const response = await write(request, '/api/auth/register', { username: account.username,
        displayName: account.displayName, password: 'Demo123!' });
      expect(response.status()).toBe(201);
      const user = await response.json();
      recordAccountId(account.key, user.id);
      users.push(user);
    }
    const intents = specs.map((_, index) => trackFixture(`签到分析 ${info.project.name} ${scenario}-${index} ${randomUUID().slice(0, 8)}`,
      '当前场景独立初始化的已开始活动，按精确归属清理；不改任何已发布活动的时间。'));
    const rows: Seeded[] = [];
    await db.beginTransaction();
    for (const [index, spec] of specs.entries()) {
      const active = spec.active ?? 0;
      const checked = spec.checked ?? 0;
      expect(checked <= active).toBeTruthy();
      const startsAt = spec.startsAt ?? sqlTime(base + 3600000 + index * 60000);
      const [created] = await db.execute<mysql.ResultSetHeader>(
        'INSERT INTO activities(title,description,location,starts_at,capacity,registered_count,created_by,cancelled_at,cancelled_by,cancellation_reason) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [intents[index].title, intents[index].description, `签到分析独立场地 ${index}`, startsAt, Math.max(1, active), active,
          administrator.id, spec.cancelled ? sqlTime(base - 3600000) : null, spec.cancelled ? administrator.id : null,
          spec.cancelled ? '本轮分析筛选的已取消独立活动' : null]);
      const statuses = [...Array(active).fill('ACTIVE'), ...Array(spec.waiting ?? 0).fill('WAITING'),
        ...Array(spec.cancelledRegistrations ?? 0).fill('CANCELLED')];
      const registrationIds: number[] = [];
      for (const [position, status] of statuses.entries()) {
        const signed = status === 'ACTIVE' && position < checked;
        const [record] = await db.execute<mysql.ResultSetHeader>(
          'INSERT INTO registrations(activity_id,user_id,status,created_at,updated_at,checked_in_at,checked_in_by) VALUES (?,?,?,?,?,?,?)',
          [created.insertId, users[position].id, status, sqlTime(base - 7200000), sqlTime(base - 7200000),
            signed ? sqlTime(base + 7200000) : null, signed ? administrator.id : null]);
        registrationIds.push(record.insertId);
      }
      rows.push({ id: created.insertId, title: intents[index].title, startsAt, active, checked, registrationIds });
    }
    await db.commit();
    for (const [index, row] of rows.entries()) recordFixtureId(intents[index].key, row.id);
    const proof = await request.get(`/api/activities/${rows[0].id}`);
    expect(proof.status()).toBe(200);
    expect(await proof.json()).toMatchObject({ id: rows[0].id, title: rows[0].title });
    return { from, to: from, rows, administrator };
  } catch (error) { await db.rollback(); throw error; }
  finally { await db.end(); }
}

test('签到分析按全量人数加权，11场真实活动稳定分页，零分母不伪造比例', async ({ page, request }, info) => {
  await loginApi(request);
  const specs: Seed[] = [{ active: 1, checked: 1 }, { active: 3, checked: 1, waiting: 1, cancelledRegistrations: 1 }, {},
    ...Array.from({ length: 8 }, () => ({ active: 1 }))];
  const fixture = await seed(request, info, 0, specs);
  const first = await api(request, fixture.from);
  expect(first.total).toBe(11);
  expect(first.items).toHaveLength(10);
  expect(first.summary).toEqual({ totalActivities: 11, activeRegistrations: 12, checkedInRegistrations: 2,
    notCheckedInRegistrations: 10, checkInRate: 16.67 });
  const all = await api(request, fixture.from, fixture.to, 1, 100);
  const rates = all.items.map(item => item.checkInRate).filter((value): value is number => value !== null);
  expect(Math.round(rates.reduce((sum, value) => sum + value, 0) / rates.length * 100) / 100).not.toBe(first.summary.checkInRate);
  expect(all.items.map(item => item.id)).toEqual([...fixture.rows].reverse().map(item => item.id));
  expect(all.items.find(item => item.id === fixture.rows[2].id)?.checkInRate).toBeNull();
  await login(page);
  await page.goto(url(fixture.from));
  await assertView(page, first);
  await expect(page.getByTestId('overview-totalActivities')).toBeVisible();
  await expect(page.getByText('近期活动', { exact: true })).toBeVisible();
  await capture(page, info, 'attendance-weighted-first-page');
  const pagination = panel(page).getByLabel('签到分析分页', { exact: true });
  await pagination.locator('.ant-pagination-item[title="2"]').click();
  await expect(page).toHaveURL(new RegExp(`${url(fixture.from, fixture.to, 2).replace('?', '\\?')}$`));
  const second = await api(request, fixture.from, fixture.to, 2);
  expect(second.items).toHaveLength(1);
  expect(second.summary).toEqual(first.summary);
  await assertView(page, second);
  await choose(page, '20 条/页');
  await expect(page).toHaveURL(new RegExp(`${url(fixture.from, fixture.to, 1, 20).replace('?', '\\?')}$`));
  await assertView(page, await api(request, fixture.from, fixture.to, 1, 20));
  await expect(panel(page).locator(`[data-attendance-activity-id="${fixture.rows[2].id}"]`)).toContainText('不适用（无有效报名）');
  await page.goto(url(fixture.from, fixture.to, 999, 20));
  await expect(page).toHaveURL(new RegExp(`${url(fixture.from, fixture.to, 1, 20).replace('?', '\\?')}$`));
  await assertView(page, await api(request, fixture.from, fixture.to, 1, 20));
  await logoutApi(page.request); await logoutApi(request);
});

test('从签到分析进入名单真实签到，浏览器返回和手动刷新读取最新结果', async ({ page, request }, info) => {
  await loginApi(request);
  const fixture = await seed(request, info, 1, [{ active: 2 }]);
  const activity = fixture.rows[0];
  await login(page);
  await page.goto(url(fixture.from));
  await assertView(page, await api(request, fixture.from));
  await page.getByRole('link', { name: `查看活动 ${activity.id} 报名名单`, exact: true }).click();
  await expect(page.getByRole('heading', { name: '报名名单', exact: true })).toBeVisible();
  await page.getByRole('button', { name: `确认报名 ${activity.registrationIds[0]} 签到`, exact: true }).click();
  const modal = page.getByRole('dialog', { name: '确认签到', exact: true });
  await modal.getByRole('button', { name: '确认签到', exact: true }).click();
  await expect(modal).not.toBeVisible();
  await expect(page.getByTestId('roster-checked-in-count')).toHaveText('1');
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${url(fixture.from).replace('?', '\\?')}$`));
  const half = await api(request, fixture.from);
  expect(half.summary.checkInRate).toBe(50);
  await assertView(page, half);
  expect((await write(request, `/api/admin/activities/${activity.id}/registrations/${activity.registrationIds[1]}/check-in`)).status()).toBe(200);
  await page.getByRole('button', { name: '刷新签到分析', exact: true }).click();
  const complete = await api(request, fixture.from);
  expect(complete.summary).toEqual({ totalActivities: 1, activeRegistrations: 2, checkedInRegistrations: 2,
    notCheckedInRegistrations: 0, checkInRate: 100 });
  await assertView(page, complete);
  await capture(page, info, 'attendance-real-checkin-refresh');
  await logoutApi(page.request); await logoutApi(request);
});

test('北京时间日期边界、草稿提交、历史刷新、默认30天与无结果保持正确URL', async ({ page, request }, info) => {
  await loginApi(request);
  const from = scenarioDay(info, 2);
  const start = midnight(from);
  const specs: Seed[] = [
    { startsAt: sqlTime(start - 1).replace('.999000', '.999999') }, { startsAt: sqlTime(start) },
    { startsAt: sqlTime(start + 86400000 - 1).replace('.999000', '.999999') }, { startsAt: sqlTime(start + 86400000) },
    { cancelled: true }, { startsAt: '2100-01-01 00:00:00.000000' },
  ];
  const fixture = await seed(request, info, 2, specs);
  const first = await api(request, from);
  expect(first.items.map(item => item.id)).toEqual([fixture.rows[2].id, fixture.rows[1].id]);
  expect(first.summary).toEqual({ totalActivities: 2, activeRegistrations: 0, checkedInRegistrations: 0,
    notCheckedInRegistrations: 0, checkInRate: null });
  await login(page);
  await page.goto(url(from));
  await assertView(page, first);
  let reads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === endpoint) reads++; });
  await page.getByLabel('签到分析结束日期', { exact: true }).fill(addDays(from, 1));
  await expect(page).toHaveURL(new RegExp(`${url(from).replace('?', '\\?')}$`));
  await assertView(page, first);
  await expect(page.getByTestId('attendance-effective-range')).toContainText(`${from} 至 ${from}`);
  expect(reads).toBe(0);
  await page.getByRole('button', { name: '查询签到分析', exact: true }).click();
  const next = await api(request, from, addDays(from, 1));
  expect(next.total).toBe(3);
  await assertView(page, next);
  await page.goBack(); await assertView(page, first);
  await page.goForward(); await assertView(page, next);
  await page.reload(); await assertView(page, next);
  await query(page, addDays(from, 1), from);
  await expect(panel(page).getByText('开始日期不能晚于结束日期。', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${url(from, addDays(from, 1)).replace('?', '\\?')}$`));
  await query(page, from, addDays(from, 366));
  await expect(panel(page).getByText('日期范围最多包含 366 天，请缩小范围。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重置日期', exact: true }).click();
  const recent = await api(request);
  expect((Date.parse(`${recent.to}T00:00:00Z`) - Date.parse(`${recent.from}T00:00:00Z`)) / 86400000).toBe(29);
  await expect(page).toHaveURL(new RegExp(`${url(recent.from, recent.to).replace('?', '\\?')}$`));
  await assertView(page, recent);
  await query(page, '2100-01-01');
  const future = await api(request, '2100-01-01');
  expect(future.total).toBe(0); // Even an activity in the date range is excluded until its real start.
  await assertView(page, future);
  await expect(panel(page).getByText('暂无符合条件的活动', { exact: true })).toBeVisible();
  await capture(page, info, 'attendance-beijing-boundary-empty');
  await logoutApi(page.request); await logoutApi(request);
});

test('签到分析权限、参数错误和独立失败重试正确，不伪造零统计或影响旧概览', async ({ page, request }, info) => {
  await loginApi(request);
  const fixture = await seed(request, info, 3, [{ active: 1 }]);
  let unauthorizedReads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === endpoint) unauthorizedReads++; });
  await page.goto(dashboard);
  await expect(page).toHaveURL(/\/login$/);
  expect(unauthorizedReads).toBe(0);
  expect((await page.request.get(endpoint)).status()).toBe(401);
  await loginForm(page, 'demo');
  await page.goto(dashboard);
  await expect(page.getByText('此页面仅对活动组织者开放', { exact: true })).toBeVisible();
  expect(unauthorizedReads).toBe(0);
  expect((await page.request.get(endpoint)).status()).toBe(403);
  await logout(page);
  await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
  await loginForm(page);
  await page.route('**/api/admin/attendance?**', route => route.abort('failed'));
  await page.goto(url(fixture.from));
  await expect(panel(page).getByText(networkError, { exact: true })).toBeVisible();
  for (const key of ['totalActivities', 'activeRegistrations', 'checkedInRegistrations', 'notCheckedInRegistrations'])
    await expect(page.getByTestId(`attendance-summary-${key}`).locator('.ant-statistic-content-value')).toHaveText('—');
  await expect(page.getByTestId('attendance-summary-checkInRate')).toHaveText('—');
  await expect(page.getByTestId('attendance-asOf')).toContainText('暂时不可用');
  await expect(page.getByTestId('overview-totalActivities').locator('.ant-statistic-content-value')).not.toHaveText('—');
  await page.unroute('**/api/admin/attendance?**');
  await panel(page).getByRole('button', { name: '重新加载', exact: true }).click();
  await assertView(page, await api(request, fixture.from));
  for (const parameters of [
    'from=2004-01-01', 'from=2004-02-30&to=2004-03-01', 'from=1999-12-31&to=2000-01-01',
    'from=2004-01-01&to=2005-01-01', 'page=0', 'pageSize=101',
  ]) {
    const response = await request.get(`${endpoint}?${parameters}`);
    expect(response.status()).toBe(400);
    expect((await response.json()).code).toBe('VALIDATION_ERROR');
    expect(response.headers()['x-request-id']).toBeTruthy();
  }
  await capture(page, info, 'attendance-independent-error-retry');
  await logoutApi(page.request); await logoutApi(request);
});

for (const [index, lateStatus, sameAccount] of [[4, 200, false], [5, 401, false], [6, 200, true], [7, 401, true]] as const) {
  test(`签到分析真实迟到${lateStatus}后${sameAccount ? '同管理员重新登录' : '切换普通用户'}不污染当前页面或身份`, async ({ page, request }, info) => {
    await loginApi(request);
    const fixture = await seed(request, info, index, [{ active: 1 }]);
    const first = await api(request, fixture.from);
    await login(page);
    await page.goto(url(fixture.from));
    await assertView(page, first);
    const initialUser = await (await page.request.get('/api/auth/me')).json();
    let revokedCookie: string | undefined;
    if (lateStatus === 401) {
      const state = await request.storageState();
      const session = state.cookies.find(cookie => cookie.name === 'JSESSIONID');
      expect(!!session?.value).toBeTruthy();
      revokedCookie = `JSESSIONID=${session!.value}`;
      await logoutApi(request);
      expect((await request.get('/api/auth/me', { headers: { Cookie: revokedCookie } })).status()).toBe(401);
    }
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let fetched!: () => void;
    let rejectFetched!: (reason: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { fetched = resolve; rejectFetched = reject; });
    const jobs: Promise<void>[] = [];
    let firstRequest = true;
    const pattern = '**/api/admin/attendance?**';
    await page.route(pattern, route => {
      if (!firstRequest) return route.continue();
      firstRequest = false;
      const job = (async () => {
        try {
          let response;
          try { response = await route.fetch(revokedCookie ? { headers: { ...route.request().headers(), cookie: revokedCookie } } : undefined); }
          catch { throw new Error('The held attendance request could not read a genuine server response.'); }
          expect(response.status()).toBe(lateStatus);
          if (lateStatus === 200) expect((await response.json()).summary).toEqual(first.summary);
          else expect((await response.json()).code).toBe('UNAUTHENTICATED');
          fetched(); await held;
          try { await route.fulfill({ response }); } catch { /* The old page's cancellation already discarded this real response. */ }
        } catch (error) { rejectFetched(error); throw error; }
      })();
      jobs.push(job);
      return job;
    });
    let primaryError: unknown;
    try {
      await page.getByRole('button', { name: '刷新签到分析', exact: true }).click();
      await ready;
      for (const key of ['totalActivities', 'activeRegistrations', 'checkedInRegistrations', 'notCheckedInRegistrations'])
        await expect(page.getByTestId(`attendance-summary-${key}`).locator('.ant-statistic-content-value')).toHaveText('—');
      await logout(page);
      await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
      await loginForm(page, sameAccount ? 'admin' : 'demo');
      if (sameAccount) {
        await openOverview(page);
        const newDay = addDays(fixture.from, 2);
        await query(page, newDay);
        const current = await api(page.request, newDay);
        expect(current.total).toBe(0);
        await assertView(page, current);
        release(); await Promise.all(jobs);
        await assertView(page, current);
        await expect(page).toHaveURL(new RegExp(`${url(newDay).replace('?', '\\?')}$`));
      } else {
        await page.getByRole('button', { name: /账号菜单/ }).click();
        await page.getByRole('menuitem', { name: '个人中心', exact: true }).click();
        await expect(page.getByRole('heading', { name: '个人中心', exact: true })).toBeVisible();
        release(); await Promise.all(jobs);
        await expect(page).toHaveURL(/\/profile$/);
        await expect(page.getByTestId('attendance-panel')).toHaveCount(0);
      }
      const me = await page.request.get('/api/auth/me');
      expect(me.status()).toBe(200);
      const user = await me.json();
      expect(user).toMatchObject({ username: sameAccount ? 'admin' : 'demo', role: sameAccount ? 'ADMIN' : 'USER' });
      if (sameAccount) expect(user.id).toBe(initialUser.id);
      else expect(user.id).not.toBe(initialUser.id);
      await expect(page.getByText(fixture.rows[0].title, { exact: true })).toHaveCount(0);
      await capture(page, info, `attendance-late-${lateStatus}-${sameAccount ? 'same-admin' : 'new-user'}`);
    } catch (error) { primaryError = error; }
    finally {
      release();
      await finish(primaryError, [() => Promise.all(jobs), () => page.unroute(pattern),
        () => logoutApi(page.request), () => logoutApi(request)]);
    }
  });
}
