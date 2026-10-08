import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { trackFixture, recordFixtureId } from '../scripts/e2e-cleanup.mjs';

interface ActivityResponse {
  id: number;
  title: string;
  location: string;
  startsAt: string;
  capacity: number;
  registeredCount: number;
  waitingCount: number;
  registrationStatus: 'ACTIVE' | 'WAITING' | 'CANCELLED' | null;
  closed: boolean;
}

interface RosterResponse {
  activity: ActivityResponse;
  items: { id: number; username: string; displayName: string; status: string; createdAt: string; updatedAt: string }[];
  total: number;
  page: number;
  pageSize: number;
}

async function loginApi(request: APIRequestContext, username = 'admin', password = 'Admin123!') {
  const tokenResponse = await request.get('/api/auth/csrf');
  expect(tokenResponse.ok()).toBeTruthy();
  const token = await tokenResponse.json();
  const response = await request.post('/api/auth/login', {
    headers: { [token.headerName]: token.token }, form: { username, password },
  });
  expect(response.status()).toBe(200);
}

async function writeApi(request: APIRequestContext, path: string, method: 'POST' | 'DELETE', data?: unknown) {
  const tokenResponse = await request.get('/api/auth/csrf');
  expect(tokenResponse.ok()).toBeTruthy();
  const token = await tokenResponse.json();
  const response = await request.fetch(path, { method, headers: { [token.headerName]: token.token }, data });
  expect(response.ok()).toBeTruthy();
  return response;
}

async function createFixture(request: APIRequestContext, title: string, capacity = 3, location = '浏览器测试临时场地') {
  const fixture = trackFixture(title, '仅用于本轮真实浏览器回归，验证后按活动 ID 清理。');
  const response = await writeApi(request, '/api/admin/activities', 'POST', {
    title, description: fixture.description, location,
    startsAt: new Date(Date.now() + 48 * 3600000).toISOString(), capacity,
  });
  expect(response.status()).toBe(201);
  const activity = await response.json() as ActivityResponse;
  recordFixtureId(fixture.key, activity.id);
  return activity;
}

async function noDocumentOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  // Input interaction may scroll the page; capture sticky headers from the top.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function selectOption(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ has: page.getByText(option, { exact: true }) }).click();
  await expect(page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')).toHaveCount(0);
}

function managementResponse(page: Page, keyword: string, status = 'ALL', currentPage = 1) {
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === '/api/admin/activities'
      && url.searchParams.get('keyword') === keyword && url.searchParams.get('status') === status
      && url.searchParams.get('page') === String(currentPage);
  });
}

function rosterResponse(page: Page, activityId: string | number, status: string) {
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === `/api/admin/activities/${activityId}/registrations`
      && url.searchParams.get('status') === status && url.searchParams.get('page') === '1';
  });
}

async function emptyRosterFilter(page: Page, activityId: string | number, status: 'ACTIVE' | 'CANCELLED') {
  const next = rosterResponse(page, activityId, status);
  await selectOption(page, '报名状态', status === 'ACTIVE' ? '已报名' : '已取消');
  const response = await next;
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).total).toBe(0);
  await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(0);
  await expect(page.getByText('暂无符合条件的报名记录', { exact: true })).toBeVisible();
}

async function assertRoster(page: Page, activityId: string | number, status: 'ACTIVE' | 'CANCELLED', testInfo: TestInfo) {
  await page.goto(`/admin/activities/${activityId}/registrations`);
  const response = await page.request.get(`/api/admin/activities/${activityId}/registrations?status=${status}&page=1&pageSize=10`);
  expect(response.ok()).toBeTruthy();
  const roster = await response.json() as RosterResponse;
  expect(roster.total).toBe(1);
  expect(roster.items[0].username).toBe('demo');
  expect(roster.items[0].status).toBe(status);
  expect(roster.items[0].createdAt).toMatch(/Z$/);
  expect(roster.items[0].updatedAt).toMatch(/Z$/);
  const filtered = rosterResponse(page, activityId, status);
  await selectOption(page, '报名状态', status === 'ACTIVE' ? '已报名' : '已取消');
  expect((await filtered).ok()).toBeTruthy();
  await expect(page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: 'demo' })).toContainText(status === 'ACTIVE' ? '已报名' : '已取消');
  await noDocumentOverflow(page);
  await capture(page, testInfo, `admin-roster-${status}`);
  return roster.items[0].id;
}

async function login(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: /账号菜单/ })).toBeVisible();
}

async function logout(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  await page.getByRole('menuitem', { name: /退出登录/ }).click();
  await expect(page.getByRole('button', { name: '登录 / 体验' })).toBeVisible();
}

test('活动列表显示真实接口数据，详情可直接访问且没有横向溢出', async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  const response = await page.request.get('/api/activities');
  expect(response.ok()).toBeTruthy();
  const activities = await response.json();
  expect(activities.length).toBeGreaterThan(0);
  await page.goto('/activities');
  await expect(page.getByText(activities[0].title, { exact: true }).first()).toBeVisible();
  await page.goto(`/activities/${activities[0].id}`);
  await expect(page.getByRole('heading', { name: activities[0].title, exact: true })).toBeVisible();
  await expect(page.getByText(activities[0].location, { exact: true })).toBeVisible();
  const expectedAction = activities[0].closed ? '活动已开始'
    : activities[0].registeredCount >= activities[0].capacity ? '登录后加入候补' : '登录后报名';
  await expect(page.getByRole('button', { name: expectedAction, exact: true })).toBeVisible();
  await noDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test('管理员发布，参与者报名、取消、重新报名，记录与数据库接口一致', async ({ page }, testInfo) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  const title = `浏览器验证 ${testInfo.project.name} ${Date.now()}`;
  const fixture = trackFixture(title, '通过真实页面验证创建、报名、取消和重新报名。');
  await login(page, 'admin', 'Admin123!');
  await page.goto('/admin/activities/new');
  await page.getByLabel('活动标题', { exact: true }).fill(title);
  await page.getByLabel('活动介绍', { exact: true }).fill(fixture.description);
  await page.getByLabel('活动地点', { exact: true }).fill('线上交流室');
  const beijingDate = new Date(Date.now() + 48 * 3600000 + 8 * 3600000).toISOString().slice(0, 16);
  await page.getByLabel('开始时间（北京时间）', { exact: true }).fill(beijingDate);
  await page.getByRole('spinbutton', { name: '报名名额' }).fill('1');
  await capture(page, testInfo, 'admin-create');
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/activities'
    && response.request().method() === 'POST');
  await page.getByRole('main').getByRole('button', { name: '发布活动', exact: true }).click();
  const createdResponse = await created;
  expect(createdResponse.status()).toBe(201);
  recordFixtureId(fixture.key, (await createdResponse.json() as ActivityResponse).id);
  await expect(page).toHaveURL(/\/activities\/\d+$/);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const activityId = page.url().split('/').at(-1);
  await logout(page);
  await login(page, 'demo', 'Demo123!');
  await page.goto(`/activities/${activityId}`);
  await page.getByRole('button', { name: /立即报名/ }).click();
  await expect(page.getByText('已成功报名', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消报名', exact: true }).click();
  await page.getByRole('button', { name: '确认取消', exact: true }).click();
  await expect(page.getByRole('button', { name: /重新报名/ })).toBeVisible();
  let activity = await (await page.request.get(`/api/activities/${activityId}`)).json();
  expect(activity.registeredCount).toBe(0);
  expect(activity.registrationStatus).toBe('CANCELLED');
  await page.goto('/my-registrations');
  const row = page.locator('.registration-row').filter({ hasText: title });
  await expect(row).toContainText('已取消');
  await logout(page);
  await login(page, 'admin', 'Admin123!');
  const registrationId = await assertRoster(page, activityId!, 'CANCELLED', testInfo);
  await emptyRosterFilter(page, activityId!, 'ACTIVE');
  await logout(page);
  await login(page, 'demo', 'Demo123!');
  await page.goto(`/activities/${activityId}`);
  await page.getByRole('button', { name: /重新报名/ }).click();
  await expect(page.getByText('已成功报名', { exact: true })).toBeVisible();
  activity = await (await page.request.get(`/api/activities/${activityId}`)).json();
  expect(activity.registeredCount).toBe(1);
  expect(activity.registrationStatus).toBe('ACTIVE');
  await page.reload();
  await expect(page.getByText('已成功报名', { exact: true })).toBeVisible();
  await page.goto('/my-registrations');
  await expect(page.locator('.registration-row').filter({ hasText: title })).toContainText('已报名');
  await page.goto('/admin/activities/new');
  await expect(page.getByText('此页面仅对活动组织者开放', { exact: true })).toBeVisible();
  await logout(page);
  await login(page, 'admin', 'Admin123!');
  expect(await assertRoster(page, activityId!, 'ACTIVE', testInfo)).toBe(registrationId);
  await emptyRosterFilter(page, activityId!, 'CANCELLED');
  await logout(page);
  await page.goto('/my-registrations');
  await expect(page).toHaveURL(/\/login$/);
  expect(runtimeErrors).toEqual([]);
});

test('错误密码会显示服务端错误，不会进入登录状态', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('账号', { exact: true }).fill('demo');
  await page.getByLabel('密码', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('用户名或密码不正确', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /账号菜单/ })).toHaveCount(0);
});

test('满员后进入候补，取消有效报名后按队列递补', async ({ page }) => {
  await login(page, 'admin', 'Admin123!');
  const activity = await createFixture(page.request, `浏览器验证 ${Date.now()} 候补递补`, 1);
  // The first session takes the only seat through the real detail page.
  await logout(page);
  await login(page, 'demo', 'Demo123!');
  await page.goto(`/activities/${activity.id}`);
  await page.getByRole('button', { name: '立即报名', exact: true }).click();
  await expect(page.getByText('报名成功', { exact: true })).toBeVisible();

  // The administrator is also a normal participant for this isolated fixture.
  await logout(page);
  await login(page, 'admin', 'Admin123!');
  await page.goto(`/activities/${activity.id}`);
  await page.getByRole('button', { name: '加入候补', exact: true }).click();
  await expect(page.locator('#main-content').getByText('已进入候补', { exact: true })).toBeVisible();
  await expect(page.getByText('你已进入候补', { exact: true })).toBeVisible();
  let waiting = await (await page.request.get(`/api/activities/${activity.id}`)).json() as ActivityResponse;
  expect(waiting.registeredCount).toBe(1);
  expect(waiting.waitingCount).toBe(1);
  expect(waiting.registrationStatus).toBe('WAITING');

  // Repeating the same write remains idempotent and does not add another queue row.
  const repeated = await writeApi(page.request, `/api/activities/${activity.id}/registration`, 'POST');
  const repeatedView = await repeated.json() as ActivityResponse;
  expect(repeatedView.registrationStatus).toBe('WAITING');
  expect(repeatedView.waitingCount).toBe(1);
  await page.getByRole('button', { name: '取消候补', exact: true }).click();
  await page.getByRole('button', { name: '确认取消', exact: true }).click();
  await expect(page.getByRole('button', { name: '加入候补', exact: true })).toBeVisible();
  waiting = await (await page.request.get(`/api/activities/${activity.id}`)).json() as ActivityResponse;
  expect(waiting.waitingCount).toBe(0);
  expect(waiting.registeredCount).toBe(1);

  // Rejoin the queue, then cancel the active participant and verify FIFO promotion.
  await page.getByRole('button', { name: '加入候补', exact: true }).click();
  await expect(page.locator('#main-content').getByText('已进入候补', { exact: true })).toBeVisible();
  await logout(page);
  await login(page, 'demo', 'Demo123!');
  await page.goto(`/activities/${activity.id}`);
  await page.getByRole('button', { name: '取消报名', exact: true }).click();
  await page.getByRole('button', { name: '确认取消', exact: true }).click();
  await expect(page.getByRole('button', { name: /加入候补|重新报名/ })).toBeVisible();
  const released = await page.request.get(`/api/activities/${activity.id}`);
  expect((await released.json() as ActivityResponse).registrationStatus).toBe('CANCELLED');
  await logout(page);
  await login(page, 'admin', 'Admin123!');
  await page.goto(`/activities/${activity.id}`);
  await expect(page.getByText('已成功报名', { exact: true })).toBeVisible();
  waiting = await (await page.request.get(`/api/activities/${activity.id}`)).json() as ActivityResponse;
  expect(waiting.registeredCount).toBe(1);
  expect(waiting.waitingCount).toBe(0);
  expect(waiting.registrationStatus).toBe('ACTIVE');

  await page.goto(`/admin/activities/${activity.id}/registrations`);
  await selectOption(page, '报名状态', '已报名');
  await expect(page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: 'admin' })).toContainText('已报名');
  // Global teardown deletes only this run's exact fixtures, even when an assertion fails.
});

test('服务端 Session 失效后能回到登录并继续报名', async ({ page, request }, testInfo) => {
  await loginApi(request);
  const target = await createFixture(request, `浏览器验证 ${testInfo.project.name} ${Date.now()} Session`);
  await login(page, 'demo', 'Demo123!');
  await page.goto(`/activities/${target.id}`);
  await expect(page.getByRole('button', { name: /立即报名|重新报名/ })).toBeVisible();
  // Invalidate the server Session without updating the SPA's cached identity/token.
  const token = await (await page.request.get('/api/auth/csrf')).json();
  const invalidation = await page.request.post('/api/auth/logout', {
    headers: { [token.headerName]: token.token },
  });
  expect(invalidation.ok()).toBeTruthy();
  await page.getByRole('button', { name: /立即报名|重新报名/ }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText('登录已过期，请重新登录后继续。', { exact: true })).toBeVisible();
  await page.getByLabel('账号', { exact: true }).fill('demo');
  await page.getByLabel('密码', { exact: true }).fill('Demo123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/activities/${target.id}$`));
  await page.getByRole('button', { name: /立即报名|重新报名/ }).click();
  await expect(page.getByText('已成功报名', { exact: true })).toBeVisible();
  // Release only this test's temporary activity; seed records are never changed.
  await page.getByRole('button', { name: '取消报名', exact: true }).click();
  await page.getByRole('button', { name: '确认取消', exact: true }).click();
  await expect(page.getByRole('button', { name: /重新报名/ })).toBeVisible();
});

test('报名响应延迟时切换活动，不会覆盖新活动详情', async ({ page, request }, testInfo) => {
  await loginApi(request);
  const prefix = `浏览器验证 ${testInfo.project.name} ${Date.now()} 迟到响应`;
  const first = await createFixture(request, `${prefix} A`);
  const second = await createFixture(request, `${prefix} B`);
  await login(page, 'demo', 'Demo123!');
  let releaseResponse!: () => void;
  let requestArrived!: () => void;
  const held = new Promise<void>(resolve => { releaseResponse = resolve; });
  const arrived = new Promise<void>(resolve => { requestArrived = resolve; });
  await page.route(`**/api/activities/${first.id}/registration`, async route => {
    const response = await route.fetch();
    requestArrived();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.goto(`/activities/${first.id}`);
    await page.getByRole('button', { name: /立即报名|重新报名/ }).click();
    await arrived;
    await page.getByRole('link', { name: /返回全部活动/ }).click();
    await page.locator(`a[href="/activities/${second.id}"]`).first().click();
    await expect(page.getByRole('heading', { name: second.title, exact: true })).toBeVisible();
    const lateResponse = page.waitForResponse(response => response.url().endsWith(`/api/activities/${first.id}/registration`) && response.request().method() === 'POST');
    releaseResponse();
    await lateResponse;
    await expect(page.getByRole('heading', { name: second.title, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: first.title, exact: true })).toHaveCount(0);
  } finally {
    releaseResponse();
    const token = await (await page.request.get('/api/auth/csrf')).json();
    await page.request.delete(`/api/activities/${first.id}/registration`, { headers: { [token.headerName]: token.token } });
  }
});

test('管理概览显示真实统计，桌面侧栏和手机抽屉导航可用，失败可重试', async ({ page }, testInfo) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await login(page, 'admin', 'Admin123!');
  const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/overview' && response.ok());
  await page.goto('/admin/dashboard');
  const overview = await (await loaded).json();
  const all = await (await page.request.get('/api/activities')).json() as ActivityResponse[];
  expect(overview.totalActivities).toBe(all.length);
  expect(overview.upcomingActivities).toBe(all.filter(activity => !activity.closed).length);
  expect(overview.startedActivities).toBe(all.filter(activity => activity.closed).length);
  expect(overview.fullActivities).toBe(all.filter(activity => !activity.closed && activity.registeredCount === activity.capacity).length);
  expect(overview.activeRegistrations).toBe(all.reduce((count, activity) => count + activity.registeredCount, 0));
  expect(overview.availableSeats).toBe(all.filter(activity => !activity.closed).reduce((count, activity) => count + activity.capacity - activity.registeredCount, 0));
  for (const key of ['totalActivities', 'upcomingActivities', 'activeRegistrations', 'availableSeats']) {
    const value = page.getByTestId(`overview-${key}`).locator('.ant-statistic-content-value');
    await expect.poll(async () => (await value.innerText()).replace(/[\s,]/g, '')).toBe(String(overview[key]));
  }
  const upcoming = await (await page.request.get('/api/admin/activities?page=1&pageSize=5&keyword=&status=UPCOMING')).json();
  await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(upcoming.items.length);
  for (const activity of upcoming.items) {
    await expect(page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: activity.title })).toBeVisible();
  }
  await noDocumentOverflow(page);
  await capture(page, testInfo, 'admin-dashboard');
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByRole('link', { name: '概览', exact: true })).toBeVisible();
    await drawer.getByRole('link', { name: '活动管理', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/activities$/);
    await expect(drawer).not.toBeVisible();
  } else {
    await page.getByRole('button', { name: '收起导航', exact: true }).click();
    await expect(page.locator('.sidebar')).toHaveClass(/sidebar-collapsed/);
    await page.getByRole('link', { name: '活动管理', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/activities$/);
    await page.getByRole('button', { name: '展开导航', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: '活动管理', exact: true })).toBeVisible();
  await noDocumentOverflow(page);

  // Control a failed transport, then retry the real server; no successful data is mocked.
  await page.route('**/api/admin/overview', route => route.abort('failed'));
  await page.goto('/admin/dashboard');
  await expect(page.getByText('暂时无法连接服务，请检查网络后重试。', { exact: true })).toBeVisible();
  await page.unroute('**/api/admin/overview');
  const retried = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/overview' && response.ok());
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  const latest = await (await retried).json();
  await expect.poll(async () => (await page.getByTestId('overview-totalActivities').locator('.ant-statistic-content-value').innerText()).replace(/[\s,]/g, '')).toBe(String(latest.totalActivities));
  await noDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test('活动管理使用真实字面搜索、状态和分页，筛选回到第一页', async ({ page, request }, testInfo) => {
  await loginApi(request);
  const prefix = `浏览器验证 ${testInfo.project.name} ${Date.now()} 查询%_`;
  const location = `${prefix} 场地专搜`;
  const fixtures: ActivityResponse[] = [];
  for (let index = 0; index < 11; index++) {
    fixtures.push(await createFixture(request, `${prefix} ${String(index).padStart(2, '0')}`, 1, index === 10 ? location : '临时普通场地'));
  }
  await writeApi(request, `/api/activities/${fixtures[0].id}/registration`, 'POST');
  await login(page, 'admin', 'Admin123!');
  await page.goto('/admin/activities');

  async function search(keyword: string, status = 'ALL') {
    const loaded = managementResponse(page, keyword, status);
    await page.getByRole('textbox', { name: '搜索活动', exact: true }).fill(keyword);
    await page.getByRole('button', { name: '查询', exact: true }).click();
    const response = await loaded;
    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    expect(result.page).toBe(1);
    await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(result.items.length);
    for (const activity of result.items) {
      await expect(page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: activity.title })).toBeVisible();
    }
    return result;
  }

  const first = await search(prefix);
  expect(first.total).toBe(11);
  expect(first.items).toHaveLength(10);
  await capture(page, testInfo, 'admin-activities');
  const secondLoaded = managementResponse(page, prefix, 'ALL', 2);
  await page.locator('.ant-pagination-item[title="2"]').click();
  const second = await (await secondLoaded).json();
  expect(second.page).toBe(2);
  expect(second.items).toHaveLength(1);
  expect(first.items.map((item: ActivityResponse) => item.id).includes(second.items[0].id)).toBeFalsy();
  await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(1);
  await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toContainText(second.items[0].title);

  const filters = [
    { status: 'FULL', label: '已满员', total: 1 },
    { status: 'OPEN', label: '报名中', total: 10 },
    { status: 'UPCOMING', label: '即将开始', total: 11 },
    { status: 'STARTED', label: '已开始', total: 0 },
    { status: 'ALL', label: '全部状态', total: 11 },
  ];
  for (const filter of filters) {
    const loaded = managementResponse(page, prefix, filter.status);
    await selectOption(page, '活动状态', filter.label);
    const response = await loaded;
    expect(response.ok()).toBeTruthy();
    const result = await response.json();
    expect(result.page).toBe(1);
    expect(result.total).toBe(filter.total);
    await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(result.items.length);
    if (filter.total === 0) await expect(page.getByText('暂无符合条件的活动', { exact: true })).toBeVisible();
  }
  const byLocation = await search(location);
  expect(byLocation.total).toBe(1);
  expect(byLocation.items[0].id).toBe(fixtures[10].id);
  const empty = await search(`${prefix} 不存在`);
  expect(empty.total).toBe(0);
  await expect(page.getByText('暂无符合条件的活动', { exact: true })).toBeVisible();
  await noDocumentOverflow(page);
});

test('普通用户的管理页面不查询数据，管理接口均由后端拒绝', async ({ page }) => {
  await login(page, 'demo', 'Demo123!');
  const all = await (await page.request.get('/api/activities')).json() as ActivityResponse[];
  expect(all.length).toBeGreaterThan(0);
  const managementReads: string[] = [];
  page.on('request', request => {
    if (request.method() === 'GET' && new URL(request.url()).pathname.startsWith('/api/admin/')) managementReads.push(request.url());
  });
  for (const path of ['/admin/dashboard', '/admin/monitoring', '/admin/activities', `/admin/activities/${all[0].id}/registrations`, '/admin/activities/new']) {
    await page.goto(path);
    await expect(page.getByText('此页面仅对活动组织者开放', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '活动管理', exact: true })).toHaveCount(0);
    await noDocumentOverflow(page);
  }
  expect(managementReads).toEqual([]);
  for (const path of ['/api/admin/overview', '/api/admin/monitoring', '/api/admin/activities', `/api/admin/activities/${all[0].id}/registrations`]) {
    const response = await page.request.get(path);
    expect(response.status()).toBe(403);
    expect((await response.json()).code).toBe('FORBIDDEN');
    expect(response.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  }
  await logout(page);
  await page.goto('/admin/monitoring');
  await expect(page).toHaveURL(/\/login$/);
  expect(managementReads).toEqual([]);
});

test('运行指标来自真实实例，刷新直达、请求编号和错误重试可用', async ({ page }, testInfo) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await login(page, 'admin', 'Admin123!');
  const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/monitoring' && response.ok());
  await page.goto('/admin/monitoring');
  const response = await loaded;
  expect(response.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  const metrics = await response.json();
  expect(metrics.totalRequests).toBeGreaterThan(0);
  expect(metrics.latencyWindowSeconds).toBe(300);
  expect(metrics.serverErrorRate).toBeGreaterThanOrEqual(0);
  expect(metrics.serverErrorRate).toBeLessThanOrEqual(1);
  expect(Date.parse(metrics.sampledAt)).toBeGreaterThanOrEqual(Date.parse(metrics.startedAt));
  expect(metrics.databasePool.max).toBe(20);
  expect(metrics.routes.some((row: { count: number }) => row.count > 0)).toBeTruthy();
  expect(metrics.routes.some((row: { route: string }) => row.route === '/api/admin/monitoring' || row.route === '/api/health')).toBeFalsy();
  await expect(page.getByRole('heading', { name: '运行指标', exact: true })).toBeVisible();
  await expect(page.getByTestId('monitoring-instance')).toHaveText(metrics.instanceId);
  await expect(page.getByText('统计仅来自当前实例', { exact: false })).toBeVisible();
  await noDocumentOverflow(page);
  await capture(page, testInfo, 'admin-monitoring');
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/monitoring' && response.ok());
  await page.getByRole('button', { name: '刷新指标', exact: true }).click();
  const next = await (await refreshed).json();
  await expect(page.getByTestId('monitoring-instance')).toHaveText(next.instanceId);
  await page.reload();
  await expect(page.getByRole('heading', { name: '运行指标', exact: true })).toBeVisible();
  await expect(page.getByTestId('monitoring-instance')).toBeVisible();

  // Only a controlled failure is injected; successful metric data always comes from the server.
  const requestId = 'b45f3889-6fe5-4c32-8209-c380d0bdc644';
  await page.route('**/api/admin/monitoring', route => route.fulfill({
    status: 500, contentType: 'application/json', headers: { 'X-Request-Id': requestId },
    body: JSON.stringify({ code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试。' }),
  }));
  await page.getByRole('button', { name: '刷新指标', exact: true }).click();
  await expect(page.getByText(`服务暂时不可用，请稍后重试。（问题编号：${requestId}）`, { exact: true })).toBeVisible();
  await page.unroute('**/api/admin/monitoring');
  const recovered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/monitoring' && response.ok());
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.getByTestId('monitoring-instance')).toHaveText((await (await recovered).json()).instanceId);
  await noDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test('相同条件查询刷新真实人数，结果减少时自动回到有效页码', async ({ page, request, playwright }, testInfo) => {
  await loginApi(request);
  const prefix = `浏览器验证 ${testInfo.project.name} ${Date.now()} 刷新与越界`;
  const fixtures: ActivityResponse[] = [];
  for (let index = 0; index < 11; index++) {
    fixtures.push(await createFixture(request, `${prefix} ${String(index).padStart(2, '0')}`, 1));
  }
  await login(page, 'admin', 'Admin123!');
  await page.goto('/admin/activities');
  const participant = await playwright.request.newContext({ baseURL: new URL(page.url()).origin });
  await loginApi(participant, 'demo', 'Demo123!');
  try {
    const initial = managementResponse(page, prefix);
    await page.getByRole('textbox', { name: '搜索活动', exact: true }).fill(prefix);
    await page.getByRole('button', { name: '查询', exact: true }).click();
    expect((await (await initial).json()).total).toBe(11);
    const firstRow = page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: fixtures[0].title });
    await expect(firstRow.getByRole('cell', { name: '0 / 1', exact: true })).toBeVisible();
    await writeApi(participant, `/api/activities/${fixtures[0].id}/registration`, 'POST');
    const joined = managementResponse(page, prefix);
    await page.getByRole('button', { name: '查询', exact: true }).click();
    const joinedResult = await (await joined).json();
    expect(joinedResult.page).toBe(1);
    expect(joinedResult.items.find((activity: ActivityResponse) => activity.id === fixtures[0].id).registeredCount).toBe(1);
    await expect(firstRow.getByRole('cell', { name: '1 / 1', exact: true })).toBeVisible();
    await writeApi(participant, `/api/activities/${fixtures[0].id}/registration`, 'DELETE');
    const cancelled = managementResponse(page, prefix);
    await page.getByRole('button', { name: '查询', exact: true }).click();
    expect((await (await cancelled).json()).page).toBe(1);
    await expect(firstRow.getByRole('cell', { name: '0 / 1', exact: true })).toBeVisible();

    const open = managementResponse(page, prefix, 'OPEN');
    await selectOption(page, '活动状态', '报名中');
    expect((await (await open).json()).total).toBe(11);
    const lastPage = managementResponse(page, prefix, 'OPEN', 2);
    await page.locator('.ant-pagination-item[title="2"]').click();
    const last = await (await lastPage).json();
    expect(last.items).toHaveLength(1);
    expect(last.items[0].id).toBe(fixtures[10].id);
    await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(1);

    // Retain the real total=11 in the browser, then remove the last OPEN result
    // through an isolated user's real API call before requesting the old page 2.
    const back = managementResponse(page, prefix, 'OPEN', 1);
    await page.locator('.ant-pagination-item[title="1"]').click();
    expect((await (await back).json()).total).toBe(11);
    await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(10);
    await writeApi(participant, `/api/activities/${fixtures[10].id}/registration`, 'POST');
    const outsidePage = managementResponse(page, prefix, 'OPEN', 2);
    const correctedPage = managementResponse(page, prefix, 'OPEN', 1);
    await page.locator('.ant-pagination-item[title="2"]').click();
    const outside = await (await outsidePage).json();
    expect(outside.page).toBe(2);
    expect(outside.total).toBe(10);
    expect(outside.items).toEqual([]);
    const corrected = await (await correctedPage).json();
    expect(corrected.page).toBe(1);
    expect(corrected.total).toBe(10);
    expect(corrected.items).toHaveLength(10);
    await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(10);
    await expect(page.locator('.ant-pagination-item-active')).toHaveAttribute('title', '1');
    const browserUser = await (await page.request.get('/api/auth/me')).json();
    expect(browserUser.role).toBe('ADMIN');
    await noDocumentOverflow(page);
    await capture(page, testInfo, 'admin-activities-corrected-page');
  } finally {
    try {
      await writeApi(participant, `/api/activities/${fixtures[0].id}/registration`, 'DELETE');
      await writeApi(participant, `/api/activities/${fixtures[10].id}/registration`, 'DELETE');
    } finally { await participant.dispose(); }
  }
});
