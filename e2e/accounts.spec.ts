import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { trackAccount, recordAccountId, trackFixture, recordFixtureId } from '../scripts/e2e-cleanup.mjs';

// Avoid retaining account request bodies, session cookies or DOM snapshots in traces.
// Screenshots contain the rendered page only; password inputs remain masked.
test.use({ trace: 'off' });

interface AccountFixture {
  key: string;
  id: number | null;
  username: string;
  displayName: string;
  allowedDisplayNames: string[];
}

const accountPassword = 'Demo123!';

async function write(request: APIRequestContext, path: string, method: 'POST' | 'PATCH', data?: unknown) {
  const csrf = await request.get('/api/auth/csrf', { timeout: 10000 });
  expect(csrf.ok()).toBeTruthy();
  const token = await csrf.json();
  return request.fetch(path, { method, headers: { [token.headerName]: token.token }, data, timeout: 10000 });
}

async function registerApi(request: APIRequestContext, account: AccountFixture) {
  const response = await write(request, '/api/auth/register', 'POST', {
    username: account.username, password: accountPassword, displayName: account.displayName,
  });
  expect(response.status()).toBe(201);
  const user = await response.json();
  recordAccountId(account.key, user.id);
  expect(user.username).toBe(account.username);
  expect(user.role).toBe('USER');
  return user;
}

async function logoutApi(request: APIRequestContext) {
  const current = await request.get('/api/auth/me', { timeout: 10000 });
  if (current.status() === 401) return;
  expect(current.status()).toBe(200);
  expect((await write(request, '/api/auth/logout', 'POST')).ok()).toBeTruthy();
}

async function loginApi(request: APIRequestContext, username: string, password: string) {
  const token = await (await request.get('/api/auth/csrf')).json();
  const response = await request.post('/api/auth/login', {
    headers: { [token.headerName]: token.token }, form: { username, password },
  });
  expect(response.status()).toBe(200);
}

async function loginForm(page: Page, account: AccountFixture) {
  await page.getByLabel('账号', { exact: true }).fill(account.username);
  await page.getByLabel('密码', { exact: true }).fill(accountPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: `账号菜单，${account.displayName}`, exact: true })).toBeVisible();
}

async function login(page: Page, account: AccountFixture) {
  await page.goto('/login');
  await loginForm(page, account);
}

async function logout(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  await page.getByRole('menuitem', { name: /退出登录/ }).click();
  await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
}

async function openProfile(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  await page.getByRole('menuitem', { name: '个人中心', exact: true }).click();
  await expect(page.getByRole('heading', { name: '个人中心', exact: true })).toBeVisible();
}

async function fillRegistration(page: Page, account: AccountFixture) {
  await page.getByLabel('账号', { exact: true }).fill(account.username.toUpperCase());
  await page.getByLabel('昵称', { exact: true }).fill(` ${account.displayName} `);
  await page.getByLabel('密码', { exact: true }).fill(accountPassword);
  await page.getByLabel('确认密码', { exact: true }).fill(accountPassword);
}

function registrationResponse(page: Page) {
  return page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/register' && response.request().method() === 'POST', { timeout: 10000 });
}

async function assertRegistered(page: Page, account: AccountFixture, response: Awaited<ReturnType<typeof registrationResponse>>) {
  expect(response.status()).toBe(201);
  const user = await response.json();
  recordAccountId(account.key, user.id);
  expect(user.username).toBe(account.username);
  expect(user.displayName).toBe(account.displayName);
  expect(user.role).toBe('USER');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText('注册成功，请登录你的账号。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('账号', { exact: true })).toHaveValue(account.username);
  // Registration deliberately leaves the session anonymous.
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
}

async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('新用户注册、登录、报名、修改昵称并重新登录，权限与资料正确', async ({ page, request }, testInfo) => {
  const account = trackAccount() as AccountFixture;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await loginApi(request, 'admin', 'Admin123!');
    const fixture = trackFixture(`新账号报名 ${testInfo.project.name} ${Date.now()}`, '本轮新注册用户的真实报名流程。');
    const created = await write(request, '/api/admin/activities', 'POST', {
      title: fixture.title, description: fixture.description, location: '新用户浏览器回归场地',
      startsAt: new Date(Date.now() + 48 * 3600000).toISOString(), capacity: 2,
    });
    expect(created.status()).toBe(201);
    const activity = await created.json();
    recordFixtureId(fixture.key, activity.id);
    await logoutApi(request);

    await page.goto('/login');
    await page.getByRole('link', { name: '注册账号', exact: true }).click();
    await expect(page.getByRole('heading', { name: '注册集会', exact: true })).toBeVisible();
    await fillRegistration(page, account);
    await noOverflow(page);
    await capture(page, testInfo, 'register');
    const registered = registrationResponse(page);
    await page.getByRole('button', { name: '注册账号', exact: true }).click();
    await assertRegistered(page, account, await registered);
    await loginForm(page, account);
    await page.goto(`/activities/${activity.id}`);
    await page.getByRole('button', { name: '立即报名', exact: true }).click();
    await expect(page.getByText('已成功报名', { exact: true })).toBeVisible();
    await page.goto('/my-registrations');
    await expect(page.locator('.registration-row').filter({ hasText: fixture.title })).toContainText('已报名');

    await openProfile(page);
    await expect(page.getByLabel('昵称', { exact: true })).toHaveValue(account.displayName);
    await page.getByLabel('昵称', { exact: true }).fill(` ${account.allowedDisplayNames[1]} `);
    await page.getByRole('button', { name: '保存昵称', exact: true }).click();
    await expect(page.getByText('昵称已更新', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: `账号菜单，${account.allowedDisplayNames[1]}`, exact: true })).toBeVisible();
    const changed = await (await page.request.get('/api/auth/me')).json();
    expect(changed.username).toBe(account.username);
    expect(changed.displayName).toBe(account.allowedDisplayNames[1]);
    expect(changed.role).toBe('USER');
    await page.reload();
    await expect(page.getByLabel('昵称', { exact: true })).toHaveValue(account.allowedDisplayNames[1]);
    await noOverflow(page);
    await capture(page, testInfo, 'profile');
    await page.goto('/admin/dashboard');
    await expect(page.getByText('此页面仅对活动组织者开放', { exact: true })).toBeVisible();
    const denied = await page.request.get('/api/admin/overview');
    expect(denied.status()).toBe(403);
    expect((await denied.json()).code).toBe('FORBIDDEN');

    await logout(page);
    await login(page, { ...account, displayName: account.allowedDisplayNames[1] });
    await page.goto('/profile');
    await expect(page.getByLabel('昵称', { exact: true })).toHaveValue(account.allowedDisplayNames[1]);
    const persisted = await (await page.request.get(`/api/activities/${activity.id}`)).json();
    expect(persisted.registrationStatus).toBe('ACTIVE');
    expect(persisted.registeredCount).toBe(1);
    expect(errors).toEqual([]);
    await logout(page);
  } finally {
    await logoutApi(page.request);
    await logoutApi(request);
  }
});

test('注册表单拒绝无效输入，网络失败可重试，重复用户名返回真实错误', async ({ page }) => {
  const account = trackAccount() as AccountFixture;
  let failureEnabled = true;
  try {
    await page.goto('/register');
    await fillRegistration(page, account);
    await page.getByLabel('账号', { exact: true }).fill('12invalid');
    await page.getByLabel('确认密码', { exact: true }).fill('Different123!');
    let submissions = 0;
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/auth/register' && request.method() === 'POST') submissions++;
    });
    await page.getByRole('button', { name: '注册账号', exact: true }).click();
    await expect(page.locator('.ant-form-item-explain-error').first()).toBeVisible();
    expect(submissions).toBe(0);
    await fillRegistration(page, account);
    await page.route('**/api/auth/register', route => failureEnabled ? route.abort('failed') : route.continue());
    await page.getByRole('button', { name: '注册账号', exact: true }).click();
    await expect(page.getByText('暂时无法连接服务，请检查网络后重试。', { exact: true })).toBeVisible();
    // Wait until the previous submission releases the submit control.
    await expect(page.getByRole('button', { name: /注册账号/ })).not.toHaveClass(/ant-btn-loading/);
    failureEnabled = false;
    const [registered] = await Promise.all([
      registrationResponse(page),
      page.getByRole('button', { name: /注册账号$/ }).click(),
    ]);
    await assertRegistered(page, account, registered);

    await page.goto('/register');
    await fillRegistration(page, account);
    const [response] = await Promise.all([
      registrationResponse(page),
      page.getByRole('button', { name: /注册账号$/ }).click(),
    ]);
    expect(response.status()).toBe(409);
    expect((await response.json()).code).toBe('USERNAME_TAKEN');
    await expect(page.getByText('用户名已被使用', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/register$/);
    expect((await page.request.get('/api/auth/me')).status()).toBe(401);
    await noOverflow(page);
  } finally {
    await page.unroute('**/api/auth/register');
    await logoutApi(page.request);
  }
});

test('个人中心处理读取与保存失败，登录过期后回到登录且未登录不能修改资料', async ({ page, request }) => {
  const account = trackAccount() as AccountFixture;
  let failRead = true;
  let failWrite = true;
  try {
    await registerApi(request, account);
    await page.goto('/profile');
    await expect(page).toHaveURL(/\/login$/);
    const unauthenticated = await write(page.request, '/api/me/profile', 'PATCH', { displayName: account.displayName });
    expect(unauthenticated.status()).toBe(401);
    await loginForm(page, account);
    await page.goto('/activities');
    await expect(page.getByRole('button', { name: `账号菜单，${account.displayName}`, exact: true })).toBeVisible();
    await page.route('**/api/auth/me', route => failRead ? route.abort('failed') : route.continue());
    await openProfile(page);
    await expect(page.getByText('暂时无法连接服务，请检查网络后重试。', { exact: true })).toBeVisible();
    failRead = false;
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await expect(page.getByLabel('昵称', { exact: true })).toHaveValue(account.displayName);
    await page.getByLabel('昵称', { exact: true }).fill(account.allowedDisplayNames[1]);
    await page.route('**/api/me/profile', route => failWrite ? route.abort('failed') : route.continue());
    await page.getByRole('button', { name: '保存昵称', exact: true }).click();
    await expect(page.getByText('暂时无法连接服务，请检查网络后重试。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /保存昵称/ })).not.toHaveClass(/ant-btn-loading/);
    expect((await (await page.request.get('/api/auth/me')).json()).displayName).toBe(account.displayName);
    failWrite = false;
    const [saved] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/me/profile' && response.request().method() === 'PATCH', { timeout: 10000 }),
      page.getByRole('button', { name: /保存昵称$/ }).click(),
    ]);
    expect(saved.status()).toBe(200);
    await expect(page.getByText('昵称已更新', { exact: true })).toBeVisible();
    await logoutApi(page.request); // Expire the server session while the SPA still has its cached identity.
    await page.getByLabel('昵称', { exact: true }).fill(account.displayName);
    await expect(page.getByRole('button', { name: /保存昵称$/ })).not.toHaveClass(/ant-btn-loading/);
    const [expired] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/me/profile' && response.request().method() === 'PATCH' && response.status() === 401, { timeout: 10000 }),
      page.getByRole('button', { name: /保存昵称$/ }).click(),
    ]);
    expect(expired.status()).toBe(401);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('登录已过期，请重新登录后继续。', { exact: true })).toBeVisible();
    await loginForm(page, { ...account, displayName: account.allowedDisplayNames[1] });
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByLabel('昵称', { exact: true })).toHaveValue(account.allowedDisplayNames[1]);
    await noOverflow(page);
  } finally {
    await page.unroute('**/api/auth/me');
    await page.unroute('**/api/me/profile');
    await logoutApi(page.request);
    await logoutApi(request);
  }
});

test('真实个人资料读取迟到时切换账号，不会覆盖当前账号', async ({ page, request }) => {
  const first = trackAccount() as AccountFixture;
  const second = trackAccount() as AccountFixture;
  let release!: () => void;
  let arrived!: () => void;
  let delivered!: () => void;
  let holdReads = true;
  const held = new Promise<void>(resolve => { release = resolve; });
  const fetched = new Promise<void>(resolve => { arrived = resolve; });
  const completed = new Promise<void>(resolve => { delivered = resolve; });
  try {
    await registerApi(request, first);
    await registerApi(request, second);
    await login(page, first);
    await page.route('**/api/auth/me', async route => {
      if (!holdReads) { await route.continue(); return; }
      const response = await route.fetch();
      expect((await response.json()).username).toBe(first.username);
      arrived();
      await held;
      try { await route.fulfill({ response }); }
      finally { delivered(); }
    });
    await openProfile(page);
    await fetched;
    holdReads = false;
    await logout(page);
    await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
    await loginForm(page, second); // SPA navigation preserves the existing AuthProvider generation.
    await openProfile(page);
    await expect(page.getByLabel('昵称', { exact: true })).toHaveValue(second.displayName);
    release();
    await completed;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('button', { name: `账号菜单，${second.displayName}`, exact: true })).toBeVisible();
    await expect(page.getByLabel('昵称', { exact: true })).toHaveValue(second.displayName);
    expect((await (await page.request.get('/api/auth/me')).json()).username).toBe(second.username);
  } finally {
    release();
    await page.unroute('**/api/auth/me');
    await logoutApi(page.request);
    await logoutApi(request);
  }
});

test('真实昵称保存响应迟到时切换账号，不会覆盖当前账号或另一个人的资料', async ({ page, request }) => {
  const first = trackAccount() as AccountFixture;
  const second = trackAccount() as AccountFixture;
  let release!: () => void;
  let arrived!: () => void;
  let delivered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const fetched = new Promise<void>(resolve => { arrived = resolve; });
  const completed = new Promise<void>(resolve => { delivered = resolve; });
  try {
    await registerApi(request, first);
    await registerApi(request, second);
    await login(page, first);
    await openProfile(page);
    await expect(page.getByLabel('昵称', { exact: true })).toHaveValue(first.displayName);
    await page.route('**/api/me/profile', async route => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      expect((await response.json()).username).toBe(first.username);
      arrived();
      await held;
      try { await route.fulfill({ response }); }
      finally { delivered(); }
    });
    await page.getByLabel('昵称', { exact: true }).fill(first.allowedDisplayNames[1]);
    await page.getByRole('button', { name: '保存昵称', exact: true }).click();
    await fetched;
    await logout(page);
    await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
    await loginForm(page, second);
    await openProfile(page);
    await expect(page.getByLabel('昵称', { exact: true })).toHaveValue(second.displayName);
    release();
    await completed;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('button', { name: `账号菜单，${second.displayName}`, exact: true })).toBeVisible();
    await expect(page.getByLabel('昵称', { exact: true })).toHaveValue(second.displayName);
    const current = await (await page.request.get('/api/auth/me')).json();
    expect(current.username).toBe(second.username);
    expect(current.displayName).toBe(second.displayName);
    await logout(page);
    await login(page, { ...first, displayName: first.allowedDisplayNames[1] });
    expect((await (await page.request.get('/api/auth/me')).json()).displayName).toBe(first.allowedDisplayNames[1]);
  } finally {
    release();
    await page.unroute('**/api/me/profile');
    await logoutApi(page.request);
    await logoutApi(request);
  }
});
