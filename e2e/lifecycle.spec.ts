import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { trackAccount, recordAccountId, trackFixture, recordFixtureId, recordFixtureEditIntent } from '../scripts/e2e-cleanup.mjs';

// Account setup and Session headers must not be retained in traces.
test.use({ trace: 'off' });

interface Activity {
  id: number;
  title: string;
  description: string;
  location: string;
  capacity: number;
  startsAt: string;
  registeredCount: number;
  waitingCount: number;
  registrationStatus: 'ACTIVE' | 'WAITING' | 'CANCELLED' | null;
  closed: boolean;
  cancelled: boolean;
  cancellationReason: string | null;
  cancelledAt: string | null;
}

interface Account { key: string; username: string; displayName: string }

async function write(request: APIRequestContext, path: string, method: 'POST' | 'PATCH' | 'DELETE', data?: unknown) {
  const tokenResponse = await request.get('/api/auth/csrf');
  expect(tokenResponse.status()).toBe(200);
  const token = await tokenResponse.json();
  return request.fetch(path, { method, data, headers: { [token.headerName]: token.token } });
}

async function loginApi(request: APIRequestContext, username: string, password: string) {
  const token = await (await request.get('/api/auth/csrf')).json();
  const response = await request.post('/api/auth/login', {
    headers: { [token.headerName]: token.token }, form: { username, password },
  });
  expect(response.status()).toBe(200);
}

async function logoutApi(request: APIRequestContext) {
  const current = await request.get('/api/auth/me');
  if (current.status() === 401) return;
  expect(current.status()).toBe(200);
  expect((await write(request, '/api/auth/logout', 'POST')).ok()).toBeTruthy();
}

async function register(request: APIRequestContext) {
  const account = trackAccount() as Account;
  const response = await write(request, '/api/auth/register', 'POST', {
    username: account.username, displayName: account.displayName, password: 'Demo123!',
  });
  expect(response.status()).toBe(201);
  recordAccountId(account.key, (await response.json()).id);
  return account;
}

async function login(page: Page, username = 'admin', password = 'Admin123!') {
  await page.goto('/login');
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: /账号菜单/ })).toBeVisible();
}

async function logout(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  await page.getByRole('menuitem', { name: /退出登录/ }).click();
  await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
}

async function create(request: APIRequestContext, title: string) {
  const fixture = trackFixture(title, '活动生命周期浏览器回归，只操作本轮精确归属的数据。');
  const response = await write(request, '/api/admin/activities', 'POST', {
    title: fixture.title, description: fixture.description, location: '生命周期原场地',
    startsAt: new Date(Date.now() + 48 * 3600000).toISOString(), capacity: 1,
  });
  expect(response.status()).toBe(201);
  const activity = await response.json() as Activity;
  recordFixtureId(fixture.key, activity.id);
  return { fixture, activity };
}

function responseFor(page: Page, path: string, method: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method);
}

function managementResponse(page: Page, keyword: string, status: 'ALL' | 'CANCELLED') {
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === '/api/admin/activities'
      && url.searchParams.get('keyword') === keyword && url.searchParams.get('status') === status
      && url.searchParams.get('page') === '1';
  });
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

async function selectOption(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ has: page.getByText(option, { exact: true }) }).click();
  await expect(page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')).toHaveCount(0);
}

test('管理员发布编辑并取消活动，有效报名与候补成为保留原因的历史记录', async ({ page, request, playwright }, info) => {
  const first = await register(request);
  const second = await register(request);
  const contexts: APIRequestContext[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const title = `活动生命周期 ${info.project.name} ${Date.now()}`;
    const fixture = trackFixture(title, '真实页面发布、编辑、报名、候补和组织者取消。');
    await login(page);
    await page.goto('/admin/activities/new');
    await page.getByLabel('活动标题', { exact: true }).fill(title);
    await page.getByLabel('活动介绍', { exact: true }).fill(fixture.description);
    await page.getByLabel('活动地点', { exact: true }).fill('原活动地点');
    const beijing = new Date(Date.now() + 48 * 3600000 + 8 * 3600000).toISOString().slice(0, 16);
    await page.getByLabel('开始时间（北京时间）', { exact: true }).fill(beijing);
    await page.getByRole('spinbutton', { name: '报名名额' }).fill('1');
    const creation = responseFor(page, '/api/admin/activities', 'POST');
    await page.getByRole('main').getByRole('button', { name: '发布活动', exact: true }).click();
    const created = await creation;
    expect(created.status()).toBe(201);
    const original = await created.json() as Activity;
    recordFixtureId(fixture.key, original.id);
    await expect(page).toHaveURL(new RegExp(`/activities/${original.id}$`));
    await page.getByRole('link', { name: '编辑活动', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/activities/${original.id}/edit$`));
    await expect(page.getByLabel('开始时间（北京时间）', { exact: true })).not.toBeEditable();
    await expect(page.getByLabel('报名名额', { exact: true })).not.toBeEditable();
    const edit = recordFixtureEditIntent(fixture.key, `${title} 已编辑`, `已更新的活动介绍\n${fixture.description}`);
    await page.getByLabel('活动标题', { exact: true }).fill(edit.title);
    await page.getByLabel('活动介绍', { exact: true }).fill(edit.description);
    await page.getByLabel('活动地点', { exact: true }).fill('编辑后的活动地点');
    await noOverflow(page);
    await capture(page, info, 'activity-edit');
    const saving = responseFor(page, `/api/admin/activities/${original.id}`, 'PATCH');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    const saved = await saving;
    expect(saved.status()).toBe(200);
    const updated = await saved.json() as Activity;
    expect(updated.capacity).toBe(original.capacity);
    expect(updated.startsAt).toBe(original.startsAt);
    expect(updated.title).toBe(edit.title);
    expect(updated.description).toBe(edit.description);
    await expect(page).toHaveURL(new RegExp(`/activities/${original.id}$`));
    await expect(page.getByText('编辑后的活动地点', { exact: true })).toBeVisible();

    for (const [index, account] of [first, second].entries()) {
      const context = await playwright.request.newContext({ baseURL: new URL(page.url()).origin });
      contexts.push(context);
      await loginApi(context, account.username, 'Demo123!');
      const joined = await write(context, `/api/activities/${original.id}/registration`, 'POST');
      expect(joined.status()).toBe(200);
      expect((await joined.json()).registrationStatus).toBe(index === 0 ? 'ACTIVE' : 'WAITING');
    }
    const beforeRoster = await (await page.request.get(`/api/admin/activities/${original.id}/registrations`)).json();
    const beforeOverview = await (await page.request.get('/api/admin/overview')).json();
    await page.reload();
    await page.getByRole('button', { name: '取消活动', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '取消活动', exact: true });
    const reason = '场地临时维护，本次活动取消';
    await modal.getByLabel('取消原因', { exact: true }).fill(` ${reason} `);
    const cancelling = responseFor(page, `/api/admin/activities/${original.id}/cancel`, 'POST');
    await modal.getByRole('button', { name: '确认取消活动', exact: true }).click();
    const cancellation = await cancelling;
    expect(cancellation.status()).toBe(200);
    const cancelled = await cancellation.json() as Activity;
    expect(cancelled).toMatchObject({ cancelled: true, closed: true, cancellationReason: reason, registeredCount: 0, waitingCount: 0 });
    expect(cancelled.cancelledAt).toMatch(/Z$/);
    await expect(page.getByTestId('activity-cancellation-notice')).toContainText(reason);
    await expect(page.getByRole('button', { name: '活动已取消', exact: true })).toBeDisabled();
    await expect(page.getByRole('link', { name: '编辑活动', exact: true })).toHaveCount(0);
    const repeated = await write(page.request, `/api/admin/activities/${original.id}/cancel`, 'POST', { reason: '重复请求不覆盖首次原因' });
    expect(repeated.status()).toBe(200);
    expect(await repeated.json()).toMatchObject({ cancellationReason: reason, cancelledAt: cancelled.cancelledAt, registeredCount: 0, waitingCount: 0 });

    const list = await (await page.request.get('/api/activities')).json() as Activity[];
    expect(list.find(activity => activity.id === original.id)).toMatchObject({ cancelled: true, cancellationReason: reason });
    await page.goto('/activities');
    const card = page.locator('.activity-card').filter({ hasText: edit.title });
    await expect(card).toContainText('活动已取消');
    await page.goto('/admin/activities');
    await page.getByRole('textbox', { name: '搜索活动', exact: true }).fill(edit.title);
    const filtered = managementResponse(page, edit.title, 'ALL');
    await page.getByRole('button', { name: '查询', exact: true }).click();
    expect((await (await filtered).json()).total).toBe(1);
    const onlyCancelled = managementResponse(page, edit.title, 'CANCELLED');
    await selectOption(page, '活动状态', '已取消');
    expect((await (await onlyCancelled).json()).items[0]).toMatchObject({ id: original.id, cancelled: true });
    const row = page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: edit.title });
    await expect(row).toContainText('已取消');
    await expect(row.getByRole('link', { name: '编辑活动', exact: true })).toHaveCount(0);
    await page.goto(`/admin/activities/${original.id}/registrations`);
    await expect(page.getByTestId('activity-cancellation-notice')).toContainText(reason);
    const roster = await (await page.request.get(`/api/admin/activities/${original.id}/registrations`)).json();
    expect(roster.total).toBe(2);
    expect(roster.items.map((item: { id: number }) => item.id).sort()).toEqual(beforeRoster.items.map((item: { id: number }) => item.id).sort());
    expect(roster.items.every((item: { status: string }) => item.status === 'CANCELLED')).toBeTruthy();
    await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(2);
    await page.goto('/admin/dashboard');
    const afterOverview = await (await page.request.get('/api/admin/overview')).json();
    expect(afterOverview.cancelledActivities).toBe(beforeOverview.cancelledActivities + 1);
    expect(afterOverview.totalActivities).toBe(beforeOverview.totalActivities);
    expect(afterOverview.upcomingActivities).toBe(beforeOverview.upcomingActivities - 1);
    expect(afterOverview.activeRegistrations).toBe(beforeOverview.activeRegistrations - 1);
    expect(afterOverview.waitingRegistrations).toBe(beforeOverview.waitingRegistrations - 1);
    await expect.poll(async () => (await page.getByTestId('overview-cancelledActivities').locator('.ant-statistic-content-value').innerText()).replace(/[\s,]/g, '')).toBe(String(afterOverview.cancelledActivities));
    await logout(page);

    for (const [index, account] of [first, second].entries()) {
      await login(page, account.username, 'Demo123!');
      await page.goto('/my-registrations');
      const record = page.locator('.registration-row').filter({ hasText: edit.title });
      await expect(record).toContainText('活动已取消');
      await expect(record.getByTestId('activity-cancellation-notice')).toContainText(reason);
      await noOverflow(page);
      if (index === 0) await capture(page, info, 'cancelled-registration');
      await record.getByRole('link', { name: '查看活动', exact: true }).click();
      await expect(page.getByTestId('activity-cancellation-notice')).toContainText(reason);
      await expect(page.getByRole('button', { name: '活动已取消', exact: true })).toBeDisabled();
      const view = await (await contexts[index].get(`/api/activities/${original.id}`)).json() as Activity;
      expect(view.registrationStatus).toBe('CANCELLED');
      for (const method of ['POST', 'DELETE'] as const) {
        const closed = await write(contexts[index], `/api/activities/${original.id}/registration`, method);
        expect(closed.status()).toBe(409);
        expect((await closed.json()).code).toBe('ACTIVITY_CANCELLED');
      }
      await logout(page);
    }
    await page.goto(`/activities/${original.id}`);
    await expect(page.getByTestId('activity-cancellation-notice')).toContainText(reason);
    await page.reload();
    await expect(page.getByRole('button', { name: '活动已取消', exact: true })).toBeDisabled();
    await noOverflow(page);
    await capture(page, info, 'cancelled-activity');
    expect(errors).toEqual([]);
  } finally {
    await logoutApi(page.request);
    await logoutApi(request);
    for (const context of contexts) { try { await logoutApi(context); } finally { await context.dispose(); } }
  }
});

test('编辑直达读取及保存失败可重试，取消失败不改变活动并可重新提交', async ({ page }, info) => {
  let failRead = true;
  let failEdit = true;
  let failCancel = true;
  try {
    await login(page);
    const { fixture, activity } = await create(page.request, `活动错误恢复 ${info.project.name} ${Date.now()}`);
    await page.route(`**/api/activities/${activity.id}`, route => failRead ? route.abort('failed') : route.continue());
    await page.goto(`/admin/activities/${activity.id}/edit`);
    await expect(page.getByText('暂时无法连接服务，请检查网络后重试。', { exact: true })).toBeVisible();
    failRead = false;
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await expect(page.getByLabel('活动标题', { exact: true })).toHaveValue(activity.title);
    await page.reload();
    await expect(page.getByLabel('活动标题', { exact: true })).toHaveValue(activity.title);
    const edit = recordFixtureEditIntent(fixture.key, `${activity.title} 重试保存`, `重试后的介绍\n${fixture.description}`);
    await page.getByLabel('活动标题', { exact: true }).fill(edit.title);
    await page.getByLabel('活动介绍', { exact: true }).fill(edit.description);
    await page.getByLabel('活动地点', { exact: true }).fill('重试后地点');
    await page.route(`**/api/admin/activities/${activity.id}`, route => failEdit ? route.abort('failed') : route.continue());
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(page.getByText('暂时无法连接服务，请检查网络后重试。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /保存修改/ })).not.toHaveClass(/ant-btn-loading/);
    expect((await (await page.request.get(`/api/activities/${activity.id}`)).json()).title).toBe(activity.title);
    failEdit = false;
    const saved = responseFor(page, `/api/admin/activities/${activity.id}`, 'PATCH');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/activities/${activity.id}$`));
    await page.route(`**/api/admin/activities/${activity.id}/cancel`, route => failCancel ? route.abort('failed') : route.continue());
    await page.getByRole('button', { name: '取消活动', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '取消活动', exact: true });
    await modal.getByLabel('取消原因', { exact: true }).fill('错误恢复验证取消原因');
    await modal.getByRole('button', { name: '确认取消活动', exact: true }).click();
    await expect(modal.getByText('暂时无法连接服务，请检查网络后重试。', { exact: true })).toBeVisible();
    await expect(modal.getByRole('button', { name: /确认取消活动/ })).not.toHaveClass(/ant-btn-loading/);
    expect((await (await page.request.get(`/api/activities/${activity.id}`)).json()).cancelled).toBe(false);
    failCancel = false;
    const cancelled = responseFor(page, `/api/admin/activities/${activity.id}/cancel`, 'POST');
    await modal.getByRole('button', { name: '确认取消活动', exact: true }).click();
    expect((await cancelled).status()).toBe(200);
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId('activity-cancellation-notice')).toContainText('错误恢复验证取消原因');
    await noOverflow(page);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await logoutApi(page.request);
  }
});

test('活动编辑真实响应迟到时切换页面，不会覆盖新页面或触发旧导航', async ({ page }, info) => {
  let release!: () => void;
  let arrived!: () => void;
  let delivered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const fetched = new Promise<void>(resolve => { arrived = resolve; });
  const completed = new Promise<void>(resolve => { delivered = resolve; });
  try {
    await login(page);
    const first = await create(page.request, `活动迟到响应 ${info.project.name} ${Date.now()} A`);
    const second = await create(page.request, `活动迟到响应 ${info.project.name} ${Date.now()} B`);
    const edit = recordFixtureEditIntent(first.fixture.key, `${first.activity.title} 已保存`, `迟到响应介绍\n${first.fixture.description}`);
    await page.goto(`/admin/activities/${first.activity.id}/edit`);
    await expect(page.getByLabel('活动标题', { exact: true })).toHaveValue(first.activity.title);
    await page.route(`**/api/admin/activities/${first.activity.id}`, async route => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      arrived();
      await held;
      try { await route.fulfill({ response }); } finally { delivered(); }
    });
    await page.getByLabel('活动标题', { exact: true }).fill(edit.title);
    await page.getByLabel('活动介绍', { exact: true }).fill(edit.description);
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await fetched;
    await page.getByRole('link', { name: '返回活动详情', exact: true }).click();
    await page.getByRole('link', { name: /返回全部活动/ }).click();
    await page.locator(`a[href="/activities/${second.activity.id}"]`).first().click();
    await expect(page.getByRole('heading', { name: second.activity.title, exact: true })).toBeVisible();
    release();
    await completed;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page).toHaveURL(new RegExp(`/activities/${second.activity.id}$`));
    await expect(page.getByRole('heading', { name: second.activity.title, exact: true })).toBeVisible();
    await expect(page.getByText('活动信息已更新', { exact: true })).toHaveCount(0);
    const persisted = await (await page.request.get(`/api/activities/${first.activity.id}`)).json() as Activity;
    expect(persisted.title).toBe(edit.title);
    expect(persisted.description).toBe(edit.description);
    await noOverflow(page);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await logoutApi(page.request);
  }
});

test('编辑与取消的管理权限由后端检查，额外时间名额字段不能改变固定值', async ({ page, request }, info) => {
  const account = await register(request);
  try {
    await loginApi(request, 'admin', 'Admin123!');
    const { activity } = await create(request, `生命周期权限 ${info.project.name} ${Date.now()}`);
    await login(page, account.username, 'Demo123!');
    const reads: string[] = [];
    page.on('request', item => {
      const path = new URL(item.url()).pathname;
      if (item.method() === 'GET' && (path.startsWith('/api/admin/') || path === `/api/activities/${activity.id}`)) reads.push(path);
    });
    await page.goto(`/admin/activities/${activity.id}/edit`);
    await expect(page.getByText('此页面仅对活动组织者开放', { exact: true })).toBeVisible();
    expect(reads).toEqual([]);
    for (const [path, method, data] of [
      [`/api/admin/activities/${activity.id}`, 'PATCH', { title: activity.title, description: activity.description, location: '不得写入' }],
      [`/api/admin/activities/${activity.id}/cancel`, 'POST', { reason: '普通用户不得取消' }],
    ] as const) {
      // Each request has a fresh real CSRF token, so FORBIDDEN proves role enforcement.
      const denied = await write(page.request, path, method, data);
      expect(denied.status()).toBe(403);
      expect((await denied.json()).code).toBe('FORBIDDEN');
    }
    await logout(page);
    await page.goto(`/admin/activities/${activity.id}/edit`);
    await expect(page).toHaveURL(/\/login$/);
    expect(reads).toEqual([]);
    const immutable = await write(request, `/api/admin/activities/${activity.id}`, 'PATCH', {
      title: activity.title, description: activity.description, location: activity.location,
      startsAt: new Date(Date.now() + 96 * 3600000).toISOString(), capacity: 999,
    });
    expect(immutable.status()).toBe(200);
    expect(await immutable.json()).toMatchObject({ capacity: activity.capacity, startsAt: activity.startsAt });
    const invalidReason = await write(request, `/api/admin/activities/${activity.id}/cancel`, 'POST', { reason: '   ' });
    expect(invalidReason.status()).toBe(400);
    expect((await (await request.get(`/api/activities/${activity.id}`)).json()).cancelled).toBe(false);
    const cancelled = await write(request, `/api/admin/activities/${activity.id}/cancel`, 'POST', { reason: '管理员权限验证' });
    expect(cancelled.status()).toBe(200);
    const rejectedEdit = await write(request, `/api/admin/activities/${activity.id}`, 'PATCH', {
      title: activity.title, description: activity.description, location: '取消后不能编辑',
    });
    expect(rejectedEdit.status()).toBe(409);
    expect((await rejectedEdit.json()).code).toBe('ACTIVITY_CANCELLED');
    const after = await (await request.get(`/api/activities/${activity.id}`)).json() as Activity;
    expect(after.location).toBe(activity.location);
    expect(after.capacity).toBe(activity.capacity);
    expect(after.startsAt).toBe(activity.startsAt);
    await noOverflow(page);
  } finally {
    await logoutApi(page.request);
    await logoutApi(request);
  }
});
