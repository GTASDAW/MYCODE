import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { trackAccount, recordAccountId } from '../scripts/e2e-cleanup.mjs';

// Auth requests contain credentials and cookies; retain only rendered screenshots.
test.use({ trace: 'off' });

const windowSeconds = Number(process.env.AUTH_RATE_LIMIT_TEST_WINDOW_SECONDS ?? '8');
const password = 'Demo123!';
const loginPath = '/api/auth/login';
const registrationPath = '/api/auth/register';

test.beforeEach(async () => {
  test.skip(process.env.AUTH_RATE_LIMIT_E2E !== '1', 'Requires the explicitly isolated strict-limit stage.');
  expect(Number.isInteger(windowSeconds) && windowSeconds >= 3 && windowSeconds <= 30).toBeTruthy();
  // Let this stage's owned buckets expire naturally; never clear shared Redis keys.
  await new Promise(resolve => setTimeout(resolve, (windowSeconds + 1) * 1000));
});

async function token(request: APIRequestContext) {
  const response = await request.get('/api/auth/csrf');
  expect(response.status()).toBe(200);
  return response.json();
}

async function exhaustLogin(request: APIRequestContext) {
  const csrf = await token(request);
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request.post(loginPath, {
      headers: { [csrf.headerName]: csrf.token }, form: { username: 'demo', password: 'Incorrect123!' },
    });
    expect(response.status()).toBe(401);
    expect((await response.json()).code).toBe('INVALID_CREDENTIALS');
  }
}

async function exhaustRegistration(request: APIRequestContext) {
  const csrf = await token(request);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request.post(registrationPath, {
      headers: { [csrf.headerName]: csrf.token },
      data: { username: '1invalid', password, displayName: '限流验证，不创建账号' },
    });
    expect(response.status()).toBe(400);
  }
}

async function logout(request: APIRequestContext) {
  const current = await request.get('/api/auth/me');
  if (current.status() === 401) return;
  expect(current.status()).toBe(200);
  const csrf = await token(request);
  expect((await request.post('/api/auth/logout', { headers: { [csrf.headerName]: csrf.token } })).status()).toBe(200);
}

async function fillLogin(page: Page) {
  await page.getByLabel('账号', { exact: true }).fill('demo');
  await page.getByLabel('密码', { exact: true }).fill(password);
}

async function fillRegistration(page: Page, account: ReturnType<typeof trackAccount>) {
  await page.getByLabel('账号', { exact: true }).fill(account.username);
  await page.getByLabel('昵称', { exact: true }).fill(account.displayName);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByLabel('确认密码', { exact: true }).fill(password);
}

async function limited(response: { status(): number; json(): Promise<any>; headers(): Record<string, string> }) {
  expect(response.status()).toBe(429);
  const body = await response.json();
  expect(body.code).toBe('AUTH_RATE_LIMITED');
  expect(Number.isInteger(body.retryAfterSeconds) && body.retryAfterSeconds > 0).toBeTruthy();
  expect(response.headers()['retry-after']).toBe(String(body.retryAfterSeconds));
  expect(response.headers()['x-request-id']).toBeTruthy();
}

async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
}

test('登录遇到真实限流保留输入，禁止重复提交，到期后手动登录', async ({ page }, testInfo) => {
  try {
    await page.goto('/login');
    await exhaustLogin(page.request);
    await fillLogin(page);
    let submissions = 0;
    page.on('request', request => {
      if (new URL(request.url()).pathname === loginPath && request.method() === 'POST') submissions++;
    });
    const response = page.waitForResponse(response => new URL(response.url()).pathname === loginPath && response.request().method() === 'POST');
    const submit = page.getByRole('button', { name: '登录', exact: true });
    await submit.click();
    await limited(await response);
    await expect(page.getByText(/请求过于频繁，请等待 \d+ 秒后再试。/)).toBeVisible();
    await expect(submit).toBeDisabled();
    await expect(page.getByLabel('账号', { exact: true })).toHaveValue('demo');
    await expect(page.getByLabel('密码', { exact: true })).toHaveValue(password);
    await page.getByLabel('密码', { exact: true }).fill('StillEditable123!');
    await page.getByLabel('密码', { exact: true }).press('Enter');
    await page.getByLabel('密码', { exact: true }).fill(password);
    expect(submissions).toBe(1);
    await noOverflow(page);
    const screenshot = testInfo.outputPath('login-real-rate-limit.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach('login-real-rate-limit', { path: screenshot, contentType: 'image/png' });
    await expect(submit).toBeEnabled({ timeout: (windowSeconds + 2) * 1000 });
    expect(submissions).toBe(1); // A countdown must never automatically resend credentials.
    await submit.click();
    await expect(page.getByRole('button', { name: /账号菜单/ })).toBeVisible();
    expect(submissions).toBe(2);
    expect((await page.request.get('/api/auth/me')).status()).toBe(200);
  } finally { await logout(page.request); }
});

test('注册遇到真实限流保留四项输入，到期重试创建一个普通账号且不自动登录', async ({ page }, testInfo) => {
  const account = trackAccount();
  await page.goto('/register');
  await exhaustRegistration(page.request);
  await fillRegistration(page, account);
  let submissions = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === registrationPath && request.method() === 'POST') submissions++;
  });
  const response = page.waitForResponse(response => new URL(response.url()).pathname === registrationPath && response.request().method() === 'POST');
  const submit = page.getByRole('button', { name: '注册账号', exact: true });
  await submit.click();
  await limited(await response);
  await expect(page.getByText(/请求过于频繁，请等待 \d+ 秒后再试。/)).toBeVisible();
  await expect(submit).toBeDisabled();
  await expect(page.getByLabel('账号', { exact: true })).toHaveValue(account.username);
  await expect(page.getByLabel('昵称', { exact: true })).toHaveValue(account.displayName);
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue(password);
  await expect(page.getByLabel('确认密码', { exact: true })).toHaveValue(password);
  await page.getByLabel('昵称', { exact: true }).fill(account.allowedDisplayNames[1]);
  await page.getByLabel('确认密码', { exact: true }).press('Enter');
  expect(submissions).toBe(1);
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
  await noOverflow(page);
  const screenshot = testInfo.outputPath('registration-real-rate-limit.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('registration-real-rate-limit', { path: screenshot, contentType: 'image/png' });
  await expect(submit).toBeEnabled({ timeout: (windowSeconds + 2) * 1000 });
  expect(submissions).toBe(1);
  const registeredResponse = page.waitForResponse(response => new URL(response.url()).pathname === registrationPath && response.request().method() === 'POST');
  await submit.click();
  const registered = await registeredResponse;
  expect(registered.status()).toBe(201);
  const user = await registered.json();
  recordAccountId(account.key, user.id);
  expect(user.username).toBe(account.username);
  expect(user.displayName).toBe(account.allowedDisplayNames[1]);
  expect(user.role).toBe('USER');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText('注册成功，请登录你的账号。', { exact: true })).toBeVisible();
  expect(submissions).toBe(2);
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
});

for (const kind of ['login', 'register'] as const) {
  test(`${kind === 'login' ? '登录' : '注册'}离页后真实迟到 429 不覆盖新页面或退出新会话`, async ({ page }) => {
    const path = kind === 'login' ? loginPath : registrationPath;
    const account = kind === 'register' ? trackAccount() : null;
    await page.goto(`/${kind}`);
    if (kind === 'login') { await exhaustLogin(page.request); await fillLogin(page); }
    else { await exhaustRegistration(page.request); await fillRegistration(page, account!); }
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let fetched!: () => void;
    const fetchedResponse = new Promise<void>(resolve => { fetched = resolve; });
    let delivered!: () => void;
    const delivery = new Promise<void>(resolve => { delivered = resolve; });
    let holdFirst = true;
    await page.route(`**${path}`, async route => {
      if (!holdFirst) { await route.continue(); return; }
      holdFirst = false;
      try {
        const response = await route.fetch();
        await limited(response);
        fetched();
        await hold;
        // Page cleanup aborts the request; some browsers reject fulfillment then.
        try { await route.fulfill({ response }); } catch { /* The old page already cancelled this genuine response. */ }
      } finally { delivered(); }
    });
    try {
      await page.getByRole('button', { name: kind === 'login' ? '登录' : '注册账号', exact: true }).click();
      await fetchedResponse;
      await page.getByRole('link', { name: '返回全部活动', exact: true }).click();
      await expect(page).toHaveURL(/\/activities$/);
      // Keep the same SPA/AuthProvider alive and establish a new authenticated
      // generation while the old real 429 is held. A full reload would erase the
      // state being checked and would not prove account-generation protection.
      await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
      await page.getByLabel('账号', { exact: true }).fill('admin');
      await page.getByLabel('密码', { exact: true }).fill('Admin123!');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.getByRole('button', { name: /账号菜单/ })).toBeVisible();
      await page.getByRole('button', { name: /账号菜单/ }).click();
      await page.getByRole('menuitem', { name: '个人中心', exact: true }).click();
      await expect(page.getByRole('heading', { name: '个人中心', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /账号菜单/ })).toBeVisible();
      release();
      await delivery;
      await expect(page.getByRole('button', { name: '保存昵称', exact: true })).toBeEnabled();
      await expect(page.getByText(/请求过于频繁/)).toHaveCount(0);
      await expect(page).toHaveURL(/\/profile$/);
      const current = await page.request.get('/api/auth/me');
      expect(current.status()).toBe(200);
      expect((await current.json()).username).toBe('admin');
      await noOverflow(page);
    } finally {
      release();
      await delivery;
      await page.unroute(`**${path}`);
      await logout(page.request);
    }
  });
}

async function passwordAccount(request: APIRequestContext) {
  const account = trackAccount();
  const csrf = await token(request);
  const registered = await request.post(registrationPath, { headers: { [csrf.headerName]: csrf.token },
    data: { username: account.username, displayName: account.displayName, password } });
  expect(registered.status()).toBe(201);
  const user = await registered.json(); recordAccountId(account.key, user.id);
  return { ...account, id: user.id };
}

async function passwordLogin(page: Page, account: Awaited<ReturnType<typeof passwordAccount>>) {
  await page.goto('/login');
  await page.getByLabel('账号', { exact: true }).fill(account.username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: `账号菜单，${account.displayName}`, exact: true })).toBeVisible();
  await passwordProfile(page);
}

async function passwordProfile(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  await page.getByRole('menuitem', { name: '个人中心', exact: true }).click();
  await expect(page.getByTestId('password-change-card')).toBeVisible();
}

async function fillPassword(page: Page) {
  await page.getByLabel('当前密码', { exact: true }).fill(password);
  await page.getByLabel('新密码', { exact: true }).fill('UpdatedPassword123!');
  await page.getByLabel('确认新密码', { exact: true }).fill('UpdatedPassword123!');
}

async function exhaustPassword(request: APIRequestContext) {
  const csrf = await token(request);
  for (let index = 0; index < 2; index++) {
    const response = await request.post('/api/me/password', { headers: { [csrf.headerName]: csrf.token },
      data: { currentPassword: 'Incorrect123!', newPassword: 'UpdatedPassword123!' } });
    expect(response.status()).toBe(400); expect((await response.json()).code).toBe('CURRENT_PASSWORD_INCORRECT');
  }
}

test('改密真实429保留输入与可编辑状态，到期手动提交只更新一次且要求重新登录', async ({ page, request }) => {
  const account = await passwordAccount(request);
  await passwordLogin(page, account);
  await exhaustPassword(page.request); await fillPassword(page);
  let posts = 0; page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/me/password' && request.method() === 'POST') posts++;
  });
  const completed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me/password' && response.request().method() === 'POST');
  const submit = page.getByRole('button', { name: '修改密码', exact: true });
  await submit.click(); await limited(await completed);
  await expect(page.getByTestId('password-change-card')).toContainText(/请求过于频繁，请等待 \d+ 秒后再试。/);
  await expect(submit).toBeDisabled();
  expect(await page.getByLabel('当前密码', { exact: true }).inputValue() === password).toBeTruthy();
  expect(await page.getByLabel('新密码', { exact: true }).inputValue() === 'UpdatedPassword123!').toBeTruthy();
  await page.getByLabel('确认新密码', { exact: true }).fill('StillEditable123!');
  await page.getByLabel('确认新密码', { exact: true }).fill('UpdatedPassword123!');
  expect(posts).toBe(1);
  await expect(submit).toBeEnabled({ timeout: (windowSeconds + 2) * 1000 });
  expect(posts).toBe(1);
  await submit.click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText('密码已更新，请重新登录。', { exact: true })).toBeVisible();
  expect(posts).toBe(2);
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
});

for (const sameAccount of [false, true]) {
  test(`改密真实429迟到后${sameAccount ? '同账号重登' : '切换新账号'}不添加旧倒计时或退出新会话`, async ({ page, request }) => {
    const account = await passwordAccount(request);
    const next = sameAccount ? account : await passwordAccount(request);
    await passwordLogin(page, account); await exhaustPassword(page.request); await fillPassword(page);
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    let fetched!: () => void; let rejected!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { fetched = resolve; rejected = reject; });
    const jobs: Promise<void>[] = [];
    await page.route('**/api/me/password', route => {
      const job = (async () => {
        try {
          const response = await route.fetch(); await limited(response); fetched(); await hold;
          try { await route.fulfill({ response }); } catch { /* The replaced form cancelled the old request. */ }
        } catch (error) { rejected(error); throw error; }
      })(); jobs.push(job); return job;
    });
    let primaryError: unknown;
    try {
      await page.getByRole('button', { name: '修改密码', exact: true }).click(); await ready;
      await page.getByRole('link', { name: '集会 Gather 首页', exact: true }).click();
      await page.getByRole('button', { name: /账号菜单/ }).click();
      await page.getByRole('menuitem', { name: /退出登录/ }).click();
      await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
      await page.getByLabel('账号', { exact: true }).fill(next.username);
      await page.getByLabel('密码', { exact: true }).fill(password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.getByRole('button', { name: `账号菜单，${next.displayName}`, exact: true })).toBeVisible();
      await passwordProfile(page);
      release(); await Promise.all(jobs);
      await expect(page).toHaveURL(/\/profile$/);
      await expect(page.getByRole('button', { name: '修改密码', exact: true })).toBeEnabled();
      await expect(page.getByTestId('password-change-card').getByText(/请求过于频繁/)).toHaveCount(0);
      for (const label of ['当前密码', '新密码', '确认新密码']) await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
      const me = await page.request.get('/api/auth/me'); expect(me.status()).toBe(200); expect((await me.json()).id).toBe(next.id);
    } catch (error) { primaryError = error; }
    finally {
      release(); const errors = primaryError === undefined ? [] : [primaryError];
      for (const cleanup of [() => Promise.all(jobs), () => page.unroute('**/api/me/password'), () => logout(page.request)])
        try { await cleanup(); } catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Password rate-limit test and cleanup failed.');
    }
  });
}
