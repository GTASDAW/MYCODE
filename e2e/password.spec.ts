import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { trackAccount, recordAccountId } from '../scripts/e2e-cleanup.mjs';

test.use({ trace: 'off' });
const oldPassword = 'Demo123!';
const newPassword = 'UpdatedPassword123!';
const endpoint = '/api/me/password';
const card = (page: Page) => page.getByTestId('password-change-card');
interface Account { key: string; id: number; username: string; displayName: string }

async function csrf(request: APIRequestContext) {
  const response = await request.get('/api/auth/csrf');
  expect(response.status()).toBe(200);
  return response.json();
}
async function write(request: APIRequestContext, path: string, data?: unknown) {
  const token = await csrf(request);
  return request.post(path, { headers: { [token.headerName]: token.token }, data });
}
async function register(request: APIRequestContext): Promise<Account> {
  const account = trackAccount(['密-']);
  const response = await write(request, '/api/auth/register', { username: account.username,
    displayName: account.displayName, password: oldPassword });
  expect(response.status()).toBe(201);
  const user = await response.json(); recordAccountId(account.key, user.id);
  return { ...account, id: user.id };
}
async function loginApi(request: APIRequestContext, account: Account, password = oldPassword) {
  const token = await csrf(request);
  return request.post('/api/auth/login', { headers: { [token.headerName]: token.token },
    form: { username: account.username, password } });
}
async function logoutApi(request: APIRequestContext) {
  const me = await request.get('/api/auth/me');
  if (me.status() === 401) return;
  expect(me.status()).toBe(200);
  expect((await write(request, '/api/auth/logout')).status()).toBe(200);
}
async function finish(primaryError: unknown, operations: Array<() => Promise<unknown>>) {
  const errors: unknown[] = primaryError === undefined ? [] : [primaryError];
  for (const operation of operations) try { await operation(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Password verification and cleanup failed; first error is the original failure.');
}
async function loginForm(page: Page, account: Account, password = oldPassword) {
  await page.getByLabel('账号', { exact: true }).fill(account.username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: `账号菜单，${account.displayName}`, exact: true })).toBeVisible();
}
async function login(page: Page, account: Account, password = oldPassword) {
  await page.goto('/login'); await loginForm(page, account, password);
}
async function profile(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  await page.getByRole('menuitem', { name: '个人中心', exact: true }).click();
  await expect(card(page)).toBeVisible();
}
async function logout(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  await page.getByRole('menuitem', { name: /退出登录/ }).click();
  await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
}
async function fill(page: Page, current = oldPassword, next = newPassword, confirmation = next) {
  await page.getByLabel('当前密码', { exact: true }).fill(current);
  await page.getByLabel('新密码', { exact: true }).fill(next);
  await page.getByLabel('确认新密码', { exact: true }).fill(confirmation);
}
function response(page: Page) {
  return page.waitForResponse(result => new URL(result.url()).pathname === endpoint && result.request().method() === 'POST');
}
async function capture(page: Page, info: TestInfo, name: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('本人修改密码后两个真实浏览器会话均失效，旧密码被拒绝，新密码完整保留空格并重新登录', { tag: '@redis' }, async ({ page, request, browser }, info) => {
  const account = await register(request);
  const otherContext = await browser.newContext({ baseURL: info.project.use.baseURL,
    viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch,
    userAgent: info.project.use.userAgent });
  const otherPage = await otherContext.newPage();
  const spacedPassword = ` ${newPassword} `;
  let primaryError: unknown;
  try {
    await login(page, account); await profile(page);
    await login(otherPage, account); await profile(otherPage);
    await expect(card(page)).toContainText('修改后所有登录均需重新登录');
    await fill(page, oldPassword, spacedPassword);
    const changed = response(page);
    await page.getByRole('button', { name: '修改密码', exact: true }).click();
    expect((await changed).status()).toBe(200);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('密码已更新，请重新登录。', { exact: true })).toBeVisible();
    await expect(page.getByLabel('账号', { exact: true })).toHaveValue(account.username);
    expect((await page.request.get('/api/auth/me')).status()).toBe(401);
    const revoked = await otherPage.request.get('/api/me/profile');
    expect(revoked.status()).toBe(401); expect((await revoked.json()).code).toBe('SESSION_REVOKED');
    const publicList = await (await otherPage.request.get('/api/activities')).json();
    expect(publicList.every((activity: { registrationStatus: string | null }) => activity.registrationStatus === null)).toBeTruthy();
    await otherPage.reload(); await expect(otherPage).toHaveURL(/\/login$/);
    await page.getByLabel('密码', { exact: true }).fill(oldPassword);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByText('用户名或密码不正确', { exact: true })).toBeVisible();
    const trimmed = await loginApi(request, account, spacedPassword.trim());
    expect(trimmed.status()).toBe(401); expect((await trimmed.json()).code).toBe('INVALID_CREDENTIALS');
    await loginForm(page, account, spacedPassword);
    await expect(page).toHaveURL(/\/profile$/);
    await expect(card(page)).toBeVisible();
    for (const label of ['当前密码', '新密码', '确认新密码']) await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
    await capture(page, info, 'password-updated-new-session');
  } catch (error) { primaryError = error; }
  finally { await finish(primaryError, [() => logoutApi(page.request), () => logoutApi(otherPage.request),
    () => otherContext.close(), () => logoutApi(request)]); }
});

test('改密校验拒绝不匹配与超UTF8输入，真实错误密码和相同密码不更新凭据，匿名与CSRF由后端拒绝', { tag: '@redis' }, async ({ page, request }, info) => {
  const account = await register(request);
  let primaryError: unknown;
  try {
    expect((await write(request, endpoint, { currentPassword: oldPassword, newPassword })).status()).toBe(401);
    await login(page, account); await profile(page);
    let posts = 0; page.on('request', request => { if (new URL(request.url()).pathname === endpoint && request.method() === 'POST') posts++; });
    await fill(page, oldPassword, newPassword, 'Different123!');
    await page.getByRole('button', { name: '修改密码', exact: true }).click();
    await expect(card(page).locator('.ant-form-item-explain-error').first()).toBeVisible(); expect(posts).toBe(0);
    await fill(page, oldPassword, `${'中'.repeat(25)}Ab1`);
    await page.getByRole('button', { name: '修改密码', exact: true }).click();
    await expect(card(page).locator('.ant-form-item-explain-error').first()).toBeVisible(); expect(posts).toBe(0);
    await fill(page, 'Incorrect123!');
    const wrong = response(page); await page.getByRole('button', { name: '修改密码', exact: true }).click();
    const wrongResponse = await wrong; expect(wrongResponse.status()).toBe(400);
    expect((await wrongResponse.json()).code).toBe('CURRENT_PASSWORD_INCORRECT');
    await expect(card(page).getByRole('alert')).toBeVisible();
    await fill(page, oldPassword, oldPassword);
    const unchanged = response(page); await page.getByRole('button', { name: '修改密码', exact: true }).click();
    const unchangedResponse = await unchanged; expect(unchangedResponse.status()).toBe(400);
    expect((await unchangedResponse.json()).code).toBe('PASSWORD_UNCHANGED');
    const invalidCsrf = await page.request.post(endpoint, { headers: { 'X-CSRF-TOKEN': 'invalid' },
      data: { currentPassword: oldPassword, newPassword } });
    expect(invalidCsrf.status()).toBe(403); expect((await invalidCsrf.json()).code).toBe('CSRF_INVALID');
    expect((await loginApi(request, account)).status()).toBe(200);
    await capture(page, info, 'password-validation-real-errors');
  } catch (error) { primaryError = error; }
  finally { await finish(primaryError, [() => logoutApi(page.request), () => logoutApi(request)]); }
});

test('改密真实提交成功但响应连接中断时不重发，手动重新登录确认可用新密码', { tag: '@redis' }, async ({ page, request }, info) => {
  const account = await register(request);
  let posts = 0;
  let primaryError: unknown;
  let committed!: () => void;
  let rejectCommit!: (reason: unknown) => void;
  const submitted = new Promise<void>((resolve, reject) => { committed = resolve; rejectCommit = reject; });
  try {
    await login(page, account); await profile(page); await fill(page);
    await page.route(`**${endpoint}`, async route => {
      posts++;
      try {
        const actual = await route.fetch(); expect(actual.status()).toBe(200); expect(await actual.json()).toEqual({ success: true });
        committed(); await route.abort('failed');
      } catch (error) { rejectCommit(error); throw error; }
    });
    await page.getByRole('button', { name: '修改密码', exact: true }).click(); await submitted;
    await expect(card(page)).toContainText('结果未确认，请重新登录确认。');
    await expect(page.getByRole('button', { name: '修改密码', exact: true })).toBeDisabled();
    expect(posts).toBe(1);
    await capture(page, info, 'password-committed-response-lost');
    await page.getByRole('button', { name: '重新登录确认', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    expect(posts).toBe(1);
    await loginForm(page, account, newPassword);
    await expect(page).toHaveURL(/\/profile$/);
    expect((await loginApi(request, account)).status()).toBe(401);
  } catch (error) { primaryError = error; }
  finally { await finish(primaryError, [() => page.unroute(`**${endpoint}`), () => logoutApi(page.request), () => logoutApi(request)]); }
});

test('同账号会话轮换导致真实CSRF失效时只刷新一次再提交改密', { tag: '@redis' }, async ({ page, request }) => {
  const account = await register(request);
  let primaryError: unknown;
  try {
    await login(page, account); await profile(page);
    // Rotate only this owned Session through real APIs while the SPA retains
    // its previous token. This reproduces a genuine explicit CSRF_INVALID.
    await logoutApi(page.request);
    expect((await loginApi(page.request, account)).status()).toBe(200);
    await csrf(page.request);
    const outcomes: number[] = [];
    const completed: Promise<unknown>[] = [];
    page.on('response', response => {
      if (new URL(response.url()).pathname === endpoint && response.request().method() === 'POST') {
        completed.push((async () => {
          const body = await response.json(); outcomes.push(response.status());
          if (response.status() === 403) expect(body.code).toBe('CSRF_INVALID');
          else expect(body).toEqual({ success: true });
        })());
      }
    });
    await fill(page);
    await page.getByRole('button', { name: '修改密码', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('密码已更新，请重新登录。', { exact: true })).toBeVisible();
    await Promise.all(completed);
    expect(outcomes).toEqual([403, 200]);
    expect((await loginApi(request, account, newPassword)).status()).toBe(200);
  } catch (error) { primaryError = error; }
  finally { await finish(primaryError, [() => logoutApi(page.request), () => logoutApi(request)]); }
});

test('改密响应处理中离开页面取消读取不承诺回滚，返回时字段清空且新凭据真实生效', { tag: '@redis' }, async ({ page, request }, info) => {
  const account = await register(request);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let fetched!: () => void; const ready = new Promise<void>(resolve => { fetched = resolve; });
  const jobs: Promise<void>[] = [];
  let primaryError: unknown;
  try {
    await login(page, account); await profile(page); await fill(page);
    await page.route(`**${endpoint}`, route => {
      const job = (async () => {
        const actual = await route.fetch(); expect(actual.status()).toBe(200); fetched(); await held;
        try { await route.fulfill({ response: actual }); } catch { /* The old view cancelled the genuine committed response. */ }
      })(); jobs.push(job); return job;
    });
    await page.getByRole('button', { name: '修改密码', exact: true }).click(); await ready;
    await page.getByRole('link', { name: '集会 Gather 首页', exact: true }).click();
    await expect(page).toHaveURL(/\/activities$/);
    release(); await Promise.all(jobs);
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByText('密码已更新，请重新登录。', { exact: true })).toHaveCount(0);
    expect((await loginApi(request, account)).status()).toBe(401);
    expect((await loginApi(request, account, newPassword)).status()).toBe(200);
    await capture(page, info, 'password-leave-after-commit');
  } catch (error) { primaryError = error; }
  finally { release(); await finish(primaryError, [() => Promise.all(jobs), () => page.unroute(`**${endpoint}`),
    () => logoutApi(page.request), () => logoutApi(request)]); }
});

for (const [lateStatus, sameAccount] of [[200, false], [401, false], [200, true], [401, true]] as const) {
  test(`真实改密${lateStatus}迟到后${sameAccount ? '相同账号重新登录' : '切换账号'}不清除新会话或覆盖新页面`, { tag: '@redis' }, async ({ page, request, playwright }, info) => {
    const account = await register(request);
    const nextAccount = sameAccount ? account : await register(request);
    let revokedCookie: string | undefined;
    let revokedCsrf: { headerName: string; token: string } | undefined;
    if (lateStatus === 401) {
      expect((await loginApi(request, account)).status()).toBe(200);
      revokedCsrf = await csrf(request);
      const state = await request.storageState();
      const cookie = state.cookies.find(cookie => cookie.name === 'JSESSIONID'); expect(cookie?.value).toBeTruthy();
      revokedCookie = `JSESSIONID=${cookie!.value}`;
      const revoker = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
      try {
        expect((await loginApi(revoker, account)).status()).toBe(200);
        const changed = await write(revoker, endpoint, { currentPassword: oldPassword, newPassword });
        expect(changed.status()).toBe(200);
      } finally { await revoker.dispose(); }
    }
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let fetched!: () => void; let rejectFetch!: (reason: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { fetched = resolve; rejectFetch = reject; });
    const jobs: Promise<void>[] = [];
    let primaryError: unknown;
    try {
      await login(page, account, lateStatus === 401 ? newPassword : oldPassword); await profile(page);
      await fill(page, lateStatus === 401 ? newPassword : oldPassword, lateStatus === 401 ? 'AnotherPassword123!' : newPassword);
      await page.route(`**${endpoint}`, route => {
        const job = (async () => {
          try {
            const actual = await route.fetch(revokedCookie ? { headers: { ...route.request().headers(), cookie: revokedCookie,
              [revokedCsrf!.headerName.toLowerCase()]: revokedCsrf!.token } } : undefined);
            expect(actual.status()).toBe(lateStatus);
            if (lateStatus === 401) expect((await actual.json()).code).toBe('SESSION_REVOKED');
            expect(actual.headersArray().some(header => header.name.toLowerCase() === 'set-cookie'
              && /^JSESSIONID=;/i.test(header.value))).toBeFalsy();
            fetched(); await held;
            try { await route.fulfill({ response: actual }); } catch { /* Old view cancellation discards its response. */ }
          } catch (error) { rejectFetch(error); throw error; }
        })(); jobs.push(job); return job;
      });
      await page.getByRole('button', { name: '修改密码', exact: true }).click(); await ready;
      await page.getByRole('link', { name: '集会 Gather 首页', exact: true }).click();
      await logout(page);
      await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
      await loginForm(page, nextAccount, sameAccount ? newPassword : oldPassword);
      await profile(page);
      const current = await page.request.get('/api/auth/me'); expect(current.status()).toBe(200);
      expect((await current.json()).id).toBe(nextAccount.id);
      release(); await Promise.all(jobs);
      await expect(page).toHaveURL(/\/profile$/);
      await expect(page.getByRole('button', { name: `账号菜单，${nextAccount.displayName}`, exact: true })).toBeVisible();
      for (const label of ['当前密码', '新密码', '确认新密码']) await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
      const after = await page.request.get('/api/auth/me'); expect(after.status()).toBe(200); expect((await after.json()).id).toBe(nextAccount.id);
      await expect(page.getByText('密码已更新，请重新登录。', { exact: true })).toHaveCount(0);
      await capture(page, info, `password-late-${lateStatus}-${sameAccount ? 'same-account' : 'other-account'}`);
    } catch (error) { primaryError = error; }
    finally { release(); await finish(primaryError, [() => Promise.all(jobs), () => page.unroute(`**${endpoint}`),
      () => logoutApi(page.request), () => logoutApi(request)]); }
  });
}

for (const sameAccount of [false, true]) {
  test(`真实403后的CSRF旧401迟到不会清除${sameAccount ? '同账号重新登录' : '新账号'}的会话或令牌`, { tag: '@redis' }, async ({ page, request }, info) => {
    const account = await register(request);
    const next = sameAccount ? account : await register(request);
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let fetched!: () => void; let rejected!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { fetched = resolve; rejected = reject; });
    const jobs: Promise<void>[] = [];
    let firstCsrf = true;
    let oldRefresh: import('@playwright/test').Request | undefined;
    let passwordPosts = 0;
    let primaryError: unknown;
    try {
      await login(page, account); await profile(page); await fill(page);
      expect((await loginApi(request, account)).status()).toBe(200);
      const changed = await write(request, endpoint, { currentPassword: oldPassword, newPassword });
      expect(changed.status()).toBe(200);
      await page.route(`**${endpoint}`, async route => {
        passwordPosts++;
        // Send a truly invalid token to the real CSRF filter; the old Session
        // remains until its subsequent credential-version checked CSRF read.
        const actual = await route.fetch({ headers: { ...route.request().headers(), 'x-csrf-token': 'controlled-expired-token' } });
        expect(actual.status()).toBe(403); expect((await actual.json()).code).toBe('CSRF_INVALID');
        await route.fulfill({ response: actual });
      });
      await page.route('**/api/auth/csrf', route => {
        if (!firstCsrf) return route.continue();
        firstCsrf = false;
        oldRefresh = route.request();
        const job = (async () => {
          try {
            const actual = await route.fetch();
            expect(actual.status()).toBe(401); expect((await actual.json()).code).toBe('SESSION_REVOKED');
            expect(actual.headersArray().some(header => header.name.toLowerCase() === 'set-cookie')).toBeFalsy();
            fetched(); await held;
            try { await route.fulfill({ response: actual }); } catch { /* A newer authentication cancelled this old refresh. */ }
          } catch (error) { rejected(error); throw error; }
        })(); jobs.push(job); return job;
      });
      await page.getByRole('button', { name: '修改密码', exact: true }).click(); await ready;
      expect(passwordPosts).toBe(1);
      const cancelled = page.waitForEvent('requestfailed', { predicate: request => request === oldRefresh });
      await page.getByRole('link', { name: '集会 Gather 首页', exact: true }).click();
      await logout(page);
      await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
      await loginForm(page, next, sameAccount ? newPassword : oldPassword); await profile(page);
      const cancelledRequest = await cancelled;
      expect(/abort|cancel/i.test(cancelledRequest.failure()?.errorText ?? '')).toBeTruthy();
      release(); await Promise.all(jobs);
      await expect(page).toHaveURL(/\/profile$/);
      await expect(page.getByRole('button', { name: `账号菜单，${next.displayName}`, exact: true })).toBeVisible();
      expect(passwordPosts).toBe(1);
      const current = await page.request.get('/api/auth/me'); expect(current.status()).toBe(200); expect((await current.json()).id).toBe(next.id);
      // Prove the current CSRF state still supports a legitimate write; only
      // the editable nickname of this exact owned account is submitted.
      const token = await csrf(page.request);
      const safeWrite = await page.request.patch('/api/me/profile', { headers: { [token.headerName]: token.token }, data: { displayName: next.displayName } });
      expect(safeWrite.status()).toBe(200);
      await capture(page, info, `password-csrf-late-401-${sameAccount ? 'same' : 'different'}-account`);
    } catch (error) { primaryError = error; }
    finally { release(); await finish(primaryError, [() => Promise.all(jobs), () => page.unroute(`**${endpoint}`),
      () => page.unroute('**/api/auth/csrf'), () => logoutApi(page.request), () => logoutApi(request)]); }
  });
}
