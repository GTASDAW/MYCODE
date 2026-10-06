import { test, expect, type Page } from '@playwright/test';

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
  await expect(page.getByRole('button', { name: /登录后报名|活动已开始/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  expect(overflow).toBeFalsy();
  expect(runtimeErrors).toEqual([]);
});

test('管理员发布，参与者报名、取消、重新报名，记录与数据库接口一致', async ({ page }, testInfo) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  const title = `浏览器验证 ${testInfo.project.name} ${Date.now()}`;
  await login(page, 'admin', 'Admin123!');
  await page.goto('/admin/activities/new');
  await page.getByLabel('活动标题', { exact: true }).fill(title);
  await page.getByLabel('活动介绍', { exact: true }).fill('通过真实页面验证创建、报名、取消和重新报名。');
  await page.getByLabel('活动地点', { exact: true }).fill('线上交流室');
  const beijingDate = new Date(Date.now() + 48 * 3600000 + 8 * 3600000).toISOString().slice(0, 16);
  await page.getByLabel('开始时间（北京时间）', { exact: true }).fill(beijingDate);
  await page.getByRole('spinbutton', { name: '报名名额' }).fill('1');
  await page.getByRole('main').getByRole('button', { name: '发布活动', exact: true }).click();
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

test('服务端 Session 失效后能回到登录并继续报名', async ({ page }) => {
  await login(page, 'demo', 'Demo123!');
  const all = await (await page.request.get('/api/activities')).json();
  const target = all.find((activity: { closed: boolean; registeredCount: number; capacity: number; registrationStatus: string | null }) =>
    !activity.closed && activity.registeredCount < activity.capacity && activity.registrationStatus !== 'ACTIVE');
  expect(target).toBeTruthy();
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
  // Keep sample activities available for the next browser project/run.
  await page.getByRole('button', { name: '取消报名', exact: true }).click();
  await page.getByRole('button', { name: '确认取消', exact: true }).click();
  await expect(page.getByRole('button', { name: /重新报名/ })).toBeVisible();
});

test('报名响应延迟时切换活动，不会覆盖新活动详情', async ({ page }) => {
  await login(page, 'demo', 'Demo123!');
  const all = await (await page.request.get('/api/activities')).json();
  const first = all.find((activity: { closed: boolean; registeredCount: number; capacity: number; registrationStatus: string | null }) =>
    !activity.closed && activity.registeredCount < activity.capacity && activity.registrationStatus !== 'ACTIVE');
  const second = all.find((activity: { id: number }) => activity.id !== first.id);
  expect(first).toBeTruthy();
  expect(second).toBeTruthy();
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
