import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { trackFixture, recordFixtureId } from '../scripts/e2e-cleanup.mjs';

// Real API requests include CSRF tokens and Session cookies; retain screenshots only.
test.use({ trace: 'off' });

interface Activity {
  id: number;
  title: string;
  location: string;
  capacity: number;
  registeredCount: number;
  registrationStatus: 'ACTIVE' | 'WAITING' | 'CANCELLED' | null;
  cancelled: boolean;
}

interface SearchResult {
  items: Activity[];
  total: number;
  page: number;
  pageSize: number;
  summary: { upcomingActivities: number; availableSeats: number };
}

interface SearchQuery { keyword: string; status?: string; page?: number; pageSize?: number }

function parameters(query: SearchQuery) {
  return new URLSearchParams({
    keyword: query.keyword, status: query.status ?? 'ALL',
    page: String(query.page ?? 1), pageSize: String(query.pageSize ?? 12),
  });
}

function matchesSearch(url: URL, query: SearchQuery) {
  return url.pathname === '/api/activities/search'
    && [...parameters(query)].every(([key, value]) => url.searchParams.get(key) === value);
}

async function searchResponse(page: Page, query: SearchQuery) {
  // Strict Mode can abort a duplicate GET after headers arrive. Only a completed
  // request has a readable body; capture it before later history/navigation steps.
  const request = await page.waitForEvent('requestfinished', {
    predicate: request => request.method() === 'GET' && matchesSearch(new URL(request.url()), query),
  });
  const response = await request.response();
  expect(response).not.toBeNull();
  return { response: response!, result: await response!.json() as SearchResult };
}

async function responseResult(captured: Awaited<ReturnType<typeof searchResponse>>) {
  expect(captured.response.status()).toBe(200);
  return captured.result;
}

async function openSearch(page: Page, query: SearchQuery) {
  const loaded = searchResponse(page, query);
  await page.goto(`/activities?${parameters(query)}`);
  return responseResult(await loaded);
}

async function search(page: Page, query: SearchQuery) {
  const loaded = searchResponse(page, query);
  await page.getByRole('textbox', { name: '搜索活动', exact: true }).fill(query.keyword);
  await page.getByRole('button', { name: '查询', exact: true }).click();
  return responseResult(await loaded);
}

async function selectOption(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ has: page.getByText(option, { exact: true }) }).click();
  await expect(page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')).toHaveCount(0);
}

async function write(request: APIRequestContext, path: string, method: 'POST' | 'DELETE', data?: unknown) {
  const csrf = await request.get('/api/auth/csrf');
  expect(csrf.status()).toBe(200);
  const token = await csrf.json();
  const response = await request.fetch(path, { method, data, headers: { [token.headerName]: token.token } });
  expect(response.ok()).toBeTruthy();
  return response;
}

async function loginApi(request: APIRequestContext) {
  const token = await (await request.get('/api/auth/csrf')).json();
  const response = await request.post('/api/auth/login', {
    headers: { [token.headerName]: token.token }, form: { username: 'admin', password: 'Admin123!' },
  });
  expect(response.status()).toBe(200);
}

async function logoutApi(request: APIRequestContext) {
  const current = await request.get('/api/auth/me');
  if (current.status() === 401) return;
  expect(current.status()).toBe(200);
  expect((await write(request, '/api/auth/logout', 'POST')).ok()).toBeTruthy();
}

async function loginUser(page: Page) {
  await page.getByLabel('账号', { exact: true }).fill('demo');
  await page.getByLabel('密码', { exact: true }).fill('Demo123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: /账号菜单/ })).toBeVisible();
}

function prefix(info: TestInfo, purpose: string) {
  return `发现活动 ${info.project.name} ${purpose} ${randomUUID().slice(0, 8)}`;
}

async function create(request: APIRequestContext, title: string, capacity = 2, location = '发现活动临时场地') {
  const fixture = trackFixture(title, '公开搜索浏览器回归，仅操作本轮精确归属活动。');
  const response = await write(request, '/api/admin/activities', 'POST', {
    title: fixture.title, description: fixture.description, location, capacity,
    startsAt: new Date(Date.now() + 48 * 3600000).toISOString(),
  });
  expect(response.status()).toBe(201);
  const activity = await response.json() as Activity;
  recordFixtureId(fixture.key, activity.id);
  return activity;
}

async function createPageFixtures(request: APIRequestContext, keyword: string, capacity = 2) {
  const activities: Activity[] = [];
  for (let index = 0; index < 13; index++) {
    activities.push(await create(request, `${keyword} ${String(index).padStart(2, '0')}`, capacity));
  }
  return activities;
}

async function assertQuery(page: Page, query: SearchQuery) {
  await expect.poll(() => {
    const url = new URL(page.url());
    return {
      pathname: url.pathname, keyword: url.searchParams.get('keyword') ?? '',
      status: url.searchParams.get('status') ?? 'ALL', page: Number(url.searchParams.get('page') ?? 1),
      pageSize: Number(url.searchParams.get('pageSize') ?? 12),
    };
  }).toEqual({ pathname: '/activities', keyword: query.keyword, status: query.status ?? 'ALL', page: query.page ?? 1, pageSize: query.pageSize ?? 12 });
}

async function assertResults(page: Page, result: SearchResult) {
  await expect(page.locator('.activity-card')).toHaveCount(result.items.length);
  await expect.poll(() => page.locator('.activity-card h3 a').evaluateAll(links => links.map(link => Number(new URL((link as HTMLAnchorElement).href).pathname.split('/').at(-1)))))
    .toEqual(result.items.map(activity => activity.id));
  await expect(page.locator('.section-heading').getByText(`共 ${result.total} 场活动`, { exact: true })).toBeVisible();
  for (const [name, value] of Object.entries(result.summary)) {
    await expect.poll(async () => (await page.getByTestId(`discovery-${name}`).locator('.ant-statistic-content-value').innerText()).replace(/[\s,]/g, ''))
      .toBe(String(value));
  }
}

async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
}

async function capture(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('公开活动分页来自真实数据，URL刷新、历史导航、详情返回和重置保留正确条件', async ({ page, request }, info) => {
  const keyword = prefix(info, '分页');
  try {
    await loginApi(request);
    const fixtures = await createPageFixtures(request, keyword);
    const first = await openSearch(page, { keyword });
    expect(first.total).toBe(13);
    expect(first.items).toHaveLength(12);
    expect(first.summary).toEqual({ upcomingActivities: 13, availableSeats: 26 });
    await assertResults(page, first);
    const lastLoaded = searchResponse(page, { keyword, page: 2 });
    await page.locator('[aria-label="活动分页"] .ant-pagination-item[title="2"]').click();
    const last = await responseResult(await lastLoaded);
    expect(last.items).toHaveLength(1);
    expect(new Set([...first.items, ...last.items].map(activity => activity.id))).toEqual(new Set(fixtures.map(activity => activity.id)));
    expect(last.summary).toEqual(first.summary);
    await assertQuery(page, { keyword, page: 2 });
    await assertResults(page, last);

    const refreshed = searchResponse(page, { keyword, page: 2 });
    await page.reload();
    await assertResults(page, await responseResult(await refreshed));
    const backward = searchResponse(page, { keyword });
    await page.goBack();
    await assertResults(page, await responseResult(await backward));
    await assertQuery(page, { keyword });
    const forward = searchResponse(page, { keyword, page: 2 });
    await page.goForward();
    await assertResults(page, await responseResult(await forward));
    await assertQuery(page, { keyword, page: 2 });

    await page.getByRole('link', { name: `查看${last.items[0].title}的详情`, exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/activities/${last.items[0].id}`);
    const source = new URL(new URL(page.url()).searchParams.get('from')!, new URL(page.url()).origin);
    expect(source.pathname).toBe('/activities');
    expect(source.searchParams.get('keyword')).toBe(keyword);
    expect(source.searchParams.get('page')).toBe('2');
    await page.reload();
    await expect(page.getByRole('heading', { name: last.items[0].title, exact: true })).toBeVisible();
    const returned = searchResponse(page, { keyword, page: 2 });
    await page.getByRole('link', { name: '返回活动列表', exact: true }).click();
    await assertResults(page, await responseResult(await returned));
    await assertQuery(page, { keyword, page: 2 });

    const resized = searchResponse(page, { keyword, pageSize: 24 });
    await selectOption(page, '每页数量', '24 条/页');
    const all = await responseResult(await resized);
    expect(all.items).toHaveLength(13);
    await assertResults(page, all);
    await assertQuery(page, { keyword, pageSize: 24 });
    await noOverflow(page);
    await capture(page, info, 'discovery-pagination');
    const reset = searchResponse(page, { keyword: '', pageSize: 24 });
    await page.getByRole('button', { name: /^重\s*置$/ }).click();
    await assertResults(page, await responseResult(await reset));
    await assertQuery(page, { keyword: '', pageSize: 24 });
    await expect(page.getByRole('textbox', { name: '搜索活动', exact: true })).toHaveValue('');
  } finally { await logoutApi(request); await logoutApi(page.request); }
});

test('标题和地点按字面搜索，活动状态与全筛选范围统计一致', async ({ page, request }, info) => {
  const keyword = prefix(info, '字面%_');
  const literal = `${keyword} %_`;
  try {
    await loginApi(request);
    const open = await create(request, `${literal} 标题`, 3);
    const full = await create(request, `${keyword} 地点命中`, 1, `${literal} 场地`);
    const cancelled = await create(request, `${keyword} 取消活动`, 4);
    const trap = await create(request, `${keyword} XY 普通活动`, 2);
    await write(request, `/api/activities/${full.id}/registration`, 'POST');
    await write(request, `/api/admin/activities/${cancelled.id}/cancel`, 'POST', { reason: '公开筛选验证取消原因' });
    const literalResult = await openSearch(page, { keyword: literal });
    expect(literalResult.total).toBe(2);
    expect(new Set(literalResult.items.map(activity => activity.id))).toEqual(new Set([open.id, full.id]));
    expect(literalResult.items.some(activity => activity.id === trap.id)).toBeFalsy();
    expect(literalResult.summary).toEqual({ upcomingActivities: 2, availableSeats: 3 });
    await assertResults(page, literalResult);
    const all = await search(page, { keyword });
    expect(all.total).toBe(4);
    expect(all.summary).toEqual({ upcomingActivities: 3, availableSeats: 5 });
    await assertResults(page, all);

    for (const filter of [
      { status: 'FULL', label: '已满员', ids: [full.id], upcomingActivities: 1, availableSeats: 0 },
      { status: 'OPEN', label: '报名中', ids: [open.id, trap.id], upcomingActivities: 2, availableSeats: 5 },
      { status: 'CANCELLED', label: '已取消', ids: [cancelled.id], upcomingActivities: 0, availableSeats: 0 },
      { status: 'UPCOMING', label: '即将开始', ids: [open.id, full.id, trap.id], upcomingActivities: 3, availableSeats: 5 },
      { status: 'STARTED', label: '已开始', ids: [], upcomingActivities: 0, availableSeats: 0 },
    ]) {
      const changed = searchResponse(page, { keyword, status: filter.status });
      await selectOption(page, '活动状态', filter.label);
      const result = await responseResult(await changed);
      expect(result.total).toBe(filter.ids.length);
      expect(new Set(result.items.map(activity => activity.id))).toEqual(new Set(filter.ids));
      expect(result.summary).toEqual({ upcomingActivities: filter.upcomingActivities, availableSeats: filter.availableSeats });
      await assertQuery(page, { keyword, status: filter.status });
      await assertResults(page, result);
    }
    await expect(page.getByText('暂无符合条件的活动', { exact: true })).toBeVisible();
    await noOverflow(page);
  } finally { await logoutApi(request); await logoutApi(page.request); }
});

test('参与者报名后返回原分页刷新个人状态，同条件查询与越界修正读取真实人数', async ({ page, request }, info) => {
  const keyword = prefix(info, '报名刷新');
  try {
    await loginApi(request);
    const fixtures = await createPageFixtures(request, keyword, 1);
    const initial = await openSearch(page, { keyword, page: 2 });
    const target = initial.items[0];
    expect(initial.total).toBe(13);
    await assertResults(page, initial);
    await page.getByRole('link', { name: `查看${target.title}的详情`, exact: true }).click();
    await expect(page.getByRole('button', { name: '登录后报名', exact: true })).toBeVisible();
    const detailPath = `${new URL(page.url()).pathname}${new URL(page.url()).search}`;
    await page.getByRole('button', { name: '登录后报名', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await loginUser(page);
    await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe(detailPath);
    await page.getByRole('button', { name: '立即报名', exact: true }).click();
    await expect(page.getByText('已成功报名', { exact: true })).toBeVisible();
    const returned = searchResponse(page, { keyword, page: 2 });
    await page.getByRole('link', { name: '返回活动列表', exact: true }).click();
    const joined = await responseResult(await returned);
    expect(joined.items[0]).toMatchObject({ id: target.id, registeredCount: 1, registrationStatus: 'ACTIVE' });
    expect(joined.summary).toEqual({ upcomingActivities: 13, availableSeats: 12 });
    await assertQuery(page, { keyword, page: 2 });
    await assertResults(page, joined);
    await expect(page.locator('.activity-card')).toContainText('已报名');
    await write(page.request, `/api/activities/${target.id}/registration`, 'DELETE');
    const first = await search(page, { keyword });
    expect(first.summary.availableSeats).toBe(13);
    await assertQuery(page, { keyword });
    await assertResults(page, first);

    await write(request, `/api/activities/${fixtures[0].id}/registration`, 'POST');
    const refreshed = await search(page, { keyword });
    expect(refreshed.summary.availableSeats).toBe(12);
    expect(refreshed.items.find(activity => activity.id === fixtures[0].id)).toMatchObject({ registeredCount: 1, registrationStatus: null });
    await assertResults(page, refreshed);
    await write(request, `/api/activities/${fixtures[0].id}/registration`, 'DELETE');
    const openLoaded = searchResponse(page, { keyword, status: 'OPEN' });
    await selectOption(page, '活动状态', '报名中');
    const open = await responseResult(await openLoaded);
    expect(open.total).toBe(13);
    await assertResults(page, open);

    // The browser still knows about page 2; a real write removes its sole OPEN result.
    await write(request, `/api/activities/${target.id}/registration`, 'POST');
    const outsideLoaded = searchResponse(page, { keyword, status: 'OPEN', page: 2 });
    const correctedLoaded = searchResponse(page, { keyword, status: 'OPEN' });
    await page.locator('[aria-label="活动分页"] .ant-pagination-item[title="2"]').click();
    const outside = await responseResult(await outsideLoaded);
    expect(outside).toMatchObject({ total: 12, page: 2, items: [] });
    const corrected = await responseResult(await correctedLoaded);
    expect(corrected).toMatchObject({ total: 12, page: 1, summary: { upcomingActivities: 12, availableSeats: 12 } });
    await assertQuery(page, { keyword, status: 'OPEN' });
    await assertResults(page, corrected);
    await expect(page.locator('[aria-label="活动分页"] .ant-pagination-item-active')).toHaveAttribute('title', '1');
    const personal = await page.request.get(`/api/activities/search?${parameters({ keyword, status: 'FULL' })}`);
    expect((await personal.json()).items[0]).toMatchObject({ id: target.id, registrationStatus: 'CANCELLED' });
    expect((await (await page.request.get('/api/auth/me')).json()).role).toBe('USER');
    await noOverflow(page);
    await capture(page, info, 'discovery-registration-refresh');
  } finally { await logoutApi(request); await logoutApi(page.request); }
});

test('公开搜索连接失败可按原条件重试，空结果可清除筛选', async ({ page, request }, info) => {
  const keyword = prefix(info, '错误恢复');
  let fail = true;
  try {
    await loginApi(request);
    const fixture = await create(request, `${keyword} 唯一活动`);
    await page.route('**/api/activities/search?**', route => fail ? route.abort('failed') : route.continue());
    await page.goto(`/activities?${parameters({ keyword, status: 'OPEN', pageSize: 24 })}`);
    await expect(page.getByText('暂时无法连接服务，请检查网络后重试。', { exact: true })).toBeVisible();
    await assertQuery(page, { keyword, status: 'OPEN', pageSize: 24 });
    await expect(page.getByRole('textbox', { name: '搜索活动', exact: true })).toHaveValue(keyword);
    await expect(page.getByTestId('discovery-availableSeats').locator('.ant-statistic-content-value')).toHaveText('—');
    fail = false;
    const retried = searchResponse(page, { keyword, status: 'OPEN', pageSize: 24 });
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    const recovered = await responseResult(await retried);
    expect(recovered.items.map(activity => activity.id)).toEqual([fixture.id]);
    await assertResults(page, recovered);
    const emptyKeyword = `${keyword} 不存在`;
    const empty = await search(page, { keyword: emptyKeyword, status: 'OPEN', pageSize: 24 });
    expect(empty).toMatchObject({ total: 0, items: [], summary: { upcomingActivities: 0, availableSeats: 0 } });
    await assertResults(page, empty);
    await assertQuery(page, { keyword: emptyKeyword, status: 'OPEN', pageSize: 24 });
    await expect(page.getByText('暂无符合条件的活动', { exact: true })).toBeVisible();
    const cleared = searchResponse(page, { keyword: '', pageSize: 24 });
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    await assertResults(page, await responseResult(await cleared));
    await assertQuery(page, { keyword: '', pageSize: 24 });
    await noOverflow(page);
    await capture(page, info, 'discovery-error-recovery');
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await logoutApi(request); await logoutApi(page.request);
  }
});

test('真实搜索读取迟到时切换条件，不会覆盖新结果、统计和URL', async ({ page, request }, info) => {
  let release!: () => void;
  let arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const fetched = new Promise<void>(resolve => { arrived = resolve; });
  try {
    await loginApi(request);
    const keyword = prefix(info, '迟到读取');
    const first = await create(request, `${keyword} A`, 1);
    const second = await create(request, `${keyword} B`, 3);
    await page.route('**/api/activities/search?**', async route => {
      if (!matchesSearch(new URL(route.request().url()), { keyword: first.title })) { await route.continue(); return; }
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      arrived();
      await held;
      await route.fulfill({ response });
    });
    await page.goto(`/activities?${parameters({ keyword: first.title })}`);
    await fetched;
    const current = await search(page, { keyword: second.title });
    expect(current.items.map(activity => activity.id)).toEqual([second.id]);
    expect(current.summary).toEqual({ upcomingActivities: 1, availableSeats: 3 });
    await assertResults(page, current);
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await assertResults(page, current);
    await assertQuery(page, { keyword: second.title });
    await expect(page.getByRole('link', { name: `查看${first.title}的详情`, exact: true })).toHaveCount(0);
    await noOverflow(page);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await logoutApi(request); await logoutApi(page.request);
  }
});
