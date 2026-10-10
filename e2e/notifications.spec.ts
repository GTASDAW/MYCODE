import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { trackAccount, recordAccountId, trackFixture, recordFixtureId } from '../scripts/e2e-cleanup.mjs';

// Retain rendered screenshots, never authentication bodies or Session headers.
test.use({ trace: 'off' });

interface Account { key: string; id: number; username: string; displayName: string }
interface Activity { id: number; title: string }
interface NotificationItem {
  id: number;
  type: 'PROMOTED' | 'ACTIVITY_CANCELLED';
  activityId: number;
  activityTitle: string;
  cancellationReason: string | null;
  createdAt: string;
  readAt: string | null;
}
interface NotificationPage {
  items: NotificationItem[];
  total: number;
  page: number;
  pageSize: number;
  unreadCount: number;
}
interface Query { page?: number; pageSize?: number; status?: 'ALL' | 'UNREAD' | 'READ' }
const password = 'Demo123!';

async function write(request: APIRequestContext, path: string, method: 'POST' | 'DELETE', data?: unknown) {
  const csrf = await request.get('/api/auth/csrf');
  expect(csrf.status()).toBe(200);
  const token = await csrf.json();
  return request.fetch(path, { method, data, headers: { [token.headerName]: token.token } });
}

async function loginApi(request: APIRequestContext, username = 'admin', accountPassword = 'Admin123!') {
  const csrf = await (await request.get('/api/auth/csrf')).json();
  const response = await request.post('/api/auth/login', {
    headers: { [csrf.headerName]: csrf.token }, form: { username, password: accountPassword },
  });
  expect(response.status()).toBe(200);
}

async function logoutApi(request: APIRequestContext) {
  const response = await request.get('/api/auth/me');
  if (response.status() === 401) return;
  expect(response.status()).toBe(200);
  expect((await write(request, '/api/auth/logout', 'POST')).status()).toBe(200);
}

async function register(request: APIRequestContext) {
  const account = trackAccount() as Account;
  const response = await write(request, '/api/auth/register', 'POST', {
    username: account.username, displayName: account.displayName, password,
  });
  expect(response.status()).toBe(201);
  const user = await response.json();
  recordAccountId(account.key, user.id);
  return { ...account, id: user.id };
}

async function create(request: APIRequestContext, info: TestInfo, suffix: string) {
  const fixture = trackFixture(`通知 ${info.project.name} ${suffix} ${randomUUID().slice(0, 8)}`, '通知浏览器验证，只写入本轮精确归属活动。');
  const response = await write(request, '/api/admin/activities', 'POST', {
    title: fixture.title, description: fixture.description, location: '通知验证临时场地', capacity: 1,
    startsAt: new Date(Date.now() + 48 * 3600000).toISOString(),
  });
  expect(response.status()).toBe(201);
  const activity = await response.json() as Activity;
  recordFixtureId(fixture.key, activity.id);
  return activity;
}

async function mutateRegistration(request: APIRequestContext, activity: Activity, method: 'POST' | 'DELETE') {
  const response = await write(request, `/api/activities/${activity.id}/registration`, method);
  expect(response.status()).toBe(200);
  return response.json();
}

async function cancelActivity(request: APIRequestContext, activity: Activity, reason: string) {
  const response = await write(request, `/api/admin/activities/${activity.id}/cancel`, 'POST', { reason });
  expect(response.status()).toBe(200);
}

function parameters(query: Query = {}) {
  return new URLSearchParams({ page: String(query.page ?? 1), pageSize: String(query.pageSize ?? 10), status: query.status ?? 'ALL' });
}

async function notifications(request: APIRequestContext, query: Query = {}) {
  const response = await request.get(`/api/me/notifications?${parameters(query)}`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<NotificationPage>;
}

async function pageResult(page: Page, query: Query = {}) {
  // Strict Mode cancels duplicate reads. A completed real request supplies its
  // own body before any subsequent navigation can dispose the browser resource.
  const request = await page.waitForEvent('requestfinished', {
    predicate: request => {
      const url = new URL(request.url());
      return request.method() === 'GET' && url.pathname === '/api/me/notifications'
        && [...parameters(query)].every(([key, value]) => url.searchParams.get(key) === value);
    },
  });
  const response = await request.response();
  expect(response?.status()).toBe(200);
  return response!.json() as Promise<NotificationPage>;
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

async function openNotifications(page: Page) {
  const result = pageResult(page);
  await page.getByTestId('notification-bell').click();
  await expect(page.getByRole('heading', { name: '通知中心', exact: true })).toBeVisible();
  return result;
}

async function assertResults(page: Page, result: NotificationPage) {
  await expect(page.getByTestId('notification-list').locator('[data-notification-id]')).toHaveCount(result.items.length);
  await expect.poll(() => page.getByTestId('notification-list').locator('[data-notification-id]').evaluateAll(
    elements => elements.map(element => Number(element.getAttribute('data-notification-id')))))
    .toEqual(result.items.map(item => item.id));
  await expect(page.getByTestId('notification-unread-count')).toHaveText(String(result.unreadCount));
  for (const item of result.items) {
    const article = page.getByTestId(`notification-${item.id}`);
    await expect(article.getByRole('heading', { name: item.activityTitle, exact: true })).toBeVisible();
    await expect(article.getByText(item.type === 'PROMOTED' ? '候补递补成功' : '活动已取消', { exact: true })).toBeVisible();
    await expect(article.locator('.notification-tags').getByText(item.readAt === null ? '未读' : '已读', { exact: true })).toBeVisible();
    if (item.cancellationReason) await expect(article).toContainText(item.cancellationReason);
  }
}

async function choose(page: Page, label: string, text: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ has: page.getByText(text, { exact: true }) }).click();
  await expect(page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')).toHaveCount(0);
}

async function capture(page: Page, info: TestInfo, name: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  const path = info.outputPath(`${name}.png`);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function makeCancellation(request: APIRequestContext, recipient: APIRequestContext, info: TestInfo, suffix: string) {
  const activity = await create(request, info, suffix);
  await mutateRegistration(recipient, activity, 'POST');
  await cancelActivity(request, activity, `本轮活动取消原因 ${suffix}`);
  return activity;
}

test('真实递补和整场取消只通知对应参与者，重复操作与再次递补保持正确，已读和详情可用', async ({ page, request, playwright }, info) => {
  const clients: APIRequestContext[] = [];
  try {
    await loginApi(request);
    const adminBefore = await notifications(request, { pageSize: 100 });
    const accounts = [];
    for (let index = 0; index < 4; index++) {
      const account = await register(request);
      const client = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
      clients.push(client);
      await loginApi(client, account.username, password);
      accounts.push(account);
    }
    const [seat, recipient, waiting, departed] = clients;
    const activity = await create(request, info, '递补与取消');
    expect((await mutateRegistration(seat, activity, 'POST')).registrationStatus).toBe('ACTIVE');
    expect((await mutateRegistration(recipient, activity, 'POST')).registrationStatus).toBe('WAITING');
    await mutateRegistration(departed, activity, 'POST');
    await mutateRegistration(departed, activity, 'DELETE');
    await mutateRegistration(seat, activity, 'DELETE');
    await mutateRegistration(seat, activity, 'DELETE');
    expect((await notifications(recipient)).items.map(item => item.type)).toEqual(['PROMOTED']);
    await mutateRegistration(recipient, activity, 'DELETE');
    await mutateRegistration(seat, activity, 'POST');
    await mutateRegistration(recipient, activity, 'POST');
    await mutateRegistration(seat, activity, 'DELETE');
    await mutateRegistration(waiting, activity, 'POST');
    const reason = `通知取消公开原因 ${info.project.name}`;
    await cancelActivity(request, activity, reason);
    await cancelActivity(request, activity, '重复取消不能覆盖首次原因');
    const recipientPage = await notifications(recipient);
    expect(recipientPage).toMatchObject({ total: 3, unreadCount: 3 });
    expect(recipientPage.items.map(item => item.type)).toEqual(['ACTIVITY_CANCELLED', 'PROMOTED', 'PROMOTED']);
    expect(new Set(recipientPage.items.map(item => item.id)).size).toBe(3);
    expect(recipientPage.items.every(item => item.activityId === activity.id && item.activityTitle === activity.title && item.createdAt.endsWith('Z'))).toBeTruthy();
    expect(recipientPage.items[0].cancellationReason).toBe(reason);
    const waitingPage = await notifications(waiting);
    expect(waitingPage).toMatchObject({ total: 1, unreadCount: 1 });
    expect(waitingPage.items[0]).toMatchObject({ type: 'ACTIVITY_CANCELLED', cancellationReason: reason });
    for (const outside of [seat, departed]) expect(await notifications(outside)).toMatchObject({ items: [], total: 0, unreadCount: 0 });
    expect(await notifications(request, { pageSize: 100 })).toEqual(adminBefore);
    const ownedId = recipientPage.items[0].id;
    const foreign = await write(waiting, `/api/me/notifications/${ownedId}/read`, 'POST');
    expect(foreign.status()).toBe(404);
    expect((await foreign.json()).code).toBe('NOTIFICATION_NOT_FOUND');

    await login(page, accounts[1]);
    await expect(page.getByTestId('notification-unread-count')).toHaveText('3');
    await assertResults(page, await openNotifications(page));
    const marked = page.waitForResponse(response => new URL(response.url()).pathname === `/api/me/notifications/${ownedId}/read` && response.request().method() === 'POST');
    await page.getByRole('button', { name: `标记通知 ${ownedId} 为已读`, exact: true }).click();
    const readResponse = await marked;
    expect(readResponse.status()).toBe(200);
    const read = await readResponse.json() as NotificationItem;
    expect(read.readAt).not.toBeNull();
    const duplicate = await write(page.request, `/api/me/notifications/${ownedId}/read`, 'POST');
    expect(duplicate.status()).toBe(200);
    expect((await duplicate.json()).readAt).toBe(read.readAt);
    const all = await notifications(page.request);
    expect(all).toMatchObject({ total: 3, unreadCount: 2 });
    await assertResults(page, all);
    const unreadLoaded = pageResult(page, { status: 'UNREAD' });
    await choose(page, '通知状态', '未读通知');
    const unread = await unreadLoaded;
    expect(unread).toMatchObject({ total: 2, unreadCount: 2 });
    await assertResults(page, unread);
    const readLoaded = pageResult(page, { status: 'READ' });
    await choose(page, '通知状态', '已读通知');
    const readPage = await readLoaded;
    expect(readPage.items.map(item => item.id)).toEqual([ownedId]);
    expect(readPage.unreadCount).toBe(2);
    await assertResults(page, readPage);
    await capture(page, info, 'notification-read-filter');
    await page.getByRole('link', { name: `查看通知活动 ${activity.title}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: activity.title, exact: true })).toBeVisible();
    await expect(page.getByText(`取消原因：${reason}`, { exact: true })).toBeVisible();
    await page.goto('/notifications');
    await assertResults(page, await notifications(page.request));
  } finally {
    await logoutApi(page.request);
    await logoutApi(request);
    for (const client of clients) { await logoutApi(client); await client.dispose(); }
  }
});

test('通知分页和筛选使用真实数据，全未读数不受分页影响，刷新直达与移动布局可用', async ({ page, request, playwright }, info) => {
  const client = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  try {
    await loginApi(request);
    const account = await register(request);
    await loginApi(client, account.username, password);
    for (let index = 0; index < 13; index++) await makeCancellation(request, client, info, `分页 ${index}`);
    const first = await notifications(client);
    expect(first).toMatchObject({ total: 13, page: 1, pageSize: 10, unreadCount: 13 });
    expect(first.items).toHaveLength(10);
    const marked = await write(client, `/api/me/notifications/${first.items[0].id}/read`, 'POST');
    expect(marked.status()).toBe(200);
    await login(page, account);
    const initial = await openNotifications(page);
    expect(initial.unreadCount).toBe(12);
    await assertResults(page, initial);
    const lastLoaded = pageResult(page, { page: 2 });
    await page.locator('[aria-label="通知分页"] .ant-pagination-item[title="2"]').click();
    const last = await lastLoaded;
    expect(last).toMatchObject({ total: 13, page: 2, unreadCount: 12 });
    expect(last.items).toHaveLength(3);
    expect(new Set([...initial.items, ...last.items].map(item => item.id)).size).toBe(13);
    await assertResults(page, last);
    const filteredLoaded = pageResult(page, { status: 'READ' });
    await choose(page, '通知状态', '已读通知');
    const filtered = await filteredLoaded;
    expect(filtered).toMatchObject({ total: 1, page: 1, unreadCount: 12 });
    await assertResults(page, filtered);
    const unreadLoaded = pageResult(page, { status: 'UNREAD' });
    await choose(page, '通知状态', '未读通知');
    await assertResults(page, await unreadLoaded);
    const unreadLastLoaded = pageResult(page, { status: 'UNREAD', page: 2 });
    await page.locator('[aria-label="通知分页"] .ant-pagination-item[title="2"]').click();
    const unreadLast = await unreadLastLoaded;
    expect(unreadLast.items).toHaveLength(2);
    for (const item of unreadLast.items) {
      await page.getByRole('button', { name: `标记通知 ${item.id} 为已读`, exact: true }).click();
      await expect(page.getByTestId(`notification-${item.id}`)).toHaveCount(0);
    }
    await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBeNull();
    const corrected = await notifications(page.request, { status: 'UNREAD' });
    expect(corrected).toMatchObject({ total: 10, page: 1, unreadCount: 10 });
    await assertResults(page, corrected);
    const allLoaded = pageResult(page);
    await choose(page, '通知状态', '全部通知');
    await assertResults(page, await allLoaded);
    const resizedLoaded = pageResult(page, { pageSize: 20 });
    await choose(page, '每页通知数量', '20 条/页');
    const resized = await resizedLoaded;
    expect(resized.items).toHaveLength(13);
    expect(resized.unreadCount).toBe(10);
    await assertResults(page, resized);
    await capture(page, info, 'notification-pagination');
    await page.reload();
    await expect(page.getByRole('heading', { name: '通知中心', exact: true })).toBeVisible();
    await assertResults(page, await notifications(page.request, { pageSize: 20 }));
  } finally {
    await logoutApi(page.request); await logoutApi(request); await logoutApi(client); await client.dispose();
  }
});

test('匿名通知页先登录且不读取个人通知，空状态、网络重试和真实登录过期正确', async ({ page, request, playwright }, info) => {
  const client = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  const anonymousReads: string[] = [];
  const listener = (request: { url(): string }) => { if (new URL(request.url()).pathname.startsWith('/api/me/notifications')) anonymousReads.push(request.url()); };
  let fail = false;
  let failWrite = true;
  try {
    await loginApi(request);
    const account = await register(request);
    await loginApi(client, account.username, password);
    page.on('request', listener);
    await page.goto('/notifications');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel('账号', { exact: true })).toBeVisible();
    expect(anonymousReads).toEqual([]);
    page.off('request', listener);
    expect((await page.request.get('/api/me/notifications')).status()).toBe(401);
    expect((await page.request.get('/api/me/notifications/unread-count')).status()).toBe(401);
    await loginForm(page, account);
    await expect(page).toHaveURL(/\/notifications$/);
    await expect(page.getByText('暂无通知', { exact: true })).toBeVisible();
    await expect(page.getByTestId('notification-unread-count')).toHaveText('0');
    const created = await makeCancellation(request, client, info, '失败重试');
    await page.route('**/api/me/notifications?**', route => fail ? route.abort('failed') : route.continue());
    fail = true;
    await page.getByRole('button', { name: '刷新通知', exact: true }).click();
    await expect(page.getByText('暂时无法连接服务，请检查网络后重试。', { exact: true })).toBeVisible();
    fail = false;
    const retryLoaded = pageResult(page);
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    const recovered = await retryLoaded;
    expect(recovered.items[0]).toMatchObject({ activityId: created.id, activityTitle: created.title });
    await assertResults(page, recovered);
    const notification = recovered.items[0];
    await page.route(`**/api/me/notifications/${notification.id}/read`, route => failWrite ? route.abort('failed') : route.continue());
    await page.getByRole('button', { name: `标记通知 ${notification.id} 为已读`, exact: true }).click();
    await expect(page.getByText('暂时无法连接服务，请检查网络后重试。', { exact: true })).toBeVisible();
    expect((await notifications(page.request)).items[0].readAt).toBeNull();
    await expect(page.getByRole('button', { name: `标记通知 ${notification.id} 为已读`, exact: true })).toBeEnabled();
    failWrite = false;
    await page.getByRole('button', { name: `标记通知 ${notification.id} 为已读`, exact: true }).click();
    await expect(page.getByTestId('notification-unread-count')).toHaveText('0');
    await expect(page.getByTestId(`notification-${notification.id}`).locator('.notification-tags').getByText('已读', { exact: true })).toBeVisible();
    await capture(page, info, 'notification-error-recovery');
    await logoutApi(page.request);
    const expired = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me/notifications' && response.status() === 401);
    await page.getByRole('button', { name: '刷新通知', exact: true }).click();
    expect((await expired).status()).toBe(401);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('登录已过期，请重新登录后继续。', { exact: true })).toBeVisible();
    await loginForm(page, account);
    await expect(page).toHaveURL(/\/notifications$/);
    await assertResults(page, await notifications(page.request));
  } finally {
    page.off('request', listener);
    await page.unrouteAll({ behavior: 'wait' });
    await logoutApi(page.request); await logoutApi(request); await logoutApi(client); await client.dispose();
  }
});

for (const outcome of ['success', 'expired'] as const) {
  test(`真实通知读取${outcome === 'success' ? '成功' : '过期错误'}迟到后切换账号，不覆盖新列表、未读数或登录身份`, async ({ page, request, playwright }, info) => {
    const client = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
    let release!: () => void;
    let arrived!: () => void;
    let delivered!: () => void;
    let hold = true;
    const held = new Promise<void>(resolve => { release = resolve; });
    const fetched = new Promise<void>(resolve => { arrived = resolve; });
    const completed = new Promise<void>(resolve => { delivered = resolve; });
    try {
      await loginApi(request);
      const first = await register(request);
      const second = await register(request);
      await loginApi(client, first.username, password);
      const activity = await makeCancellation(request, client, info, `迟到读取 ${outcome}`);
      await login(page, first);
      if (outcome === 'expired') await logoutApi(page.request);
      await page.route('**/api/me/notifications?**', async route => {
        if (!hold) { await route.continue(); return; }
        const response = await route.fetch();
        expect(response.status()).toBe(outcome === 'success' ? 200 : 401);
        if (outcome === 'success') expect((await response.json()).items[0].activityId).toBe(activity.id);
        arrived();
        await held;
        try { await route.fulfill({ response }); }
        finally { delivered(); }
      });
      await page.getByTestId('notification-bell').click();
      await fetched;
      hold = false;
      await logout(page);
      if (!new URL(page.url()).pathname.endsWith('/login')) await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
      await loginForm(page, second);
      if (new URL(page.url()).pathname !== '/notifications') await page.getByTestId('notification-bell').click();
      await expect(page.getByText('暂无通知', { exact: true })).toBeVisible();
      await expect(page.getByTestId('notification-unread-count')).toHaveText('0');
      release();
      await completed;
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.getByText('暂无通知', { exact: true })).toBeVisible();
      await expect(page.getByTestId('notification-unread-count')).toHaveText('0');
      await expect(page.getByRole('button', { name: `账号菜单，${second.displayName}`, exact: true })).toBeVisible();
      expect((await (await page.request.get('/api/auth/me')).json()).username).toBe(second.username);
      expect((await notifications(page.request)).items).toEqual([]);
      await expect(page.getByText(activity.title, { exact: true })).toHaveCount(0);
      await expect(page.getByText('登录已过期，请重新登录后继续。', { exact: true })).toHaveCount(0);
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
      await logoutApi(page.request); await logoutApi(request); await logoutApi(client); await client.dispose();
    }
  });

  test(`真实标记已读${outcome === 'success' ? '成功' : 'CSRF失效错误'}迟到后切换账号，不污染新通知或重放旧操作`, async ({ page, request, playwright }, info) => {
    const client = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
    let release!: () => void;
    let arrived!: () => void;
    let delivered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const fetched = new Promise<void>(resolve => { arrived = resolve; });
    const completed = new Promise<void>(resolve => { delivered = resolve; });
    let writes = 0;
    try {
      await loginApi(request);
      const first = await register(request);
      const second = await register(request);
      await loginApi(client, first.username, password);
      const activity = await makeCancellation(request, client, info, `迟到已读 ${outcome}`);
      const original = (await notifications(client)).items[0];
      await login(page, first);
      await assertResults(page, await openNotifications(page));
      if (outcome === 'expired') await logoutApi(page.request);
      await page.route(`**/api/me/notifications/${original.id}/read`, async route => {
        writes++;
        const response = await route.fetch();
        expect(response.status()).toBe(outcome === 'success' ? 200 : 403);
        if (outcome === 'expired') expect((await response.json()).code).toBe('CSRF_INVALID');
        arrived();
        await held;
        try { await route.fulfill({ response }); }
        finally { delivered(); }
      });
      await page.getByRole('button', { name: `标记通知 ${original.id} 为已读`, exact: true }).click();
      await fetched;
      await logout(page);
      if (!new URL(page.url()).pathname.endsWith('/login')) await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
      await loginForm(page, second);
      if (new URL(page.url()).pathname !== '/notifications') await page.getByTestId('notification-bell').click();
      await expect(page.getByText('暂无通知', { exact: true })).toBeVisible();
      release();
      await completed;
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.getByRole('button', { name: `账号菜单，${second.displayName}`, exact: true })).toBeVisible();
      await expect(page.getByText('暂无通知', { exact: true })).toBeVisible();
      await expect(page.getByTestId('notification-unread-count')).toHaveText('0');
      await expect(page.getByText(activity.title, { exact: true })).toHaveCount(0);
      await expect(page.getByText('登录已过期，请重新登录后继续。', { exact: true })).toHaveCount(0);
      expect((await (await page.request.get('/api/auth/me')).json()).username).toBe(second.username);
      expect((await notifications(page.request)).items).toEqual([]);
      expect(writes).toBe(1);
      const previous = await notifications(client);
      expect(previous.items[0].id).toBe(original.id);
      expect(previous.items[0].readAt === null).toBe(outcome === 'expired');
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
      await logoutApi(page.request); await logoutApi(request); await logoutApi(client); await client.dispose();
    }
  });
}
