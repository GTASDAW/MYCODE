import { crc32, deflateSync } from 'node:zlib';
import { test, expect, type APIRequestContext, type APIResponse, type Page, type Route } from '@playwright/test';
import { trackAccount, recordAccountId } from '../scripts/e2e-cleanup.mjs';

// Account bodies, session cookies and image bytes must not enter trace artifacts.
test.use({ trace: 'off' });

interface AccountFixture {
  key: string;
  id: number | null;
  username: string;
  displayName: string;
  allowedDisplayNames: string[];
}

const avatarPath = '**/api/me/avatar*';
const password = 'Demo123!';
function png(red: number, width = 320, height = 180) {
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * (width * 3 + 1) + 1 + x * 3;
    rows[index] = red; rows[index + 1] = 60 + Math.floor(y / height * 150); rows[index + 2] = 200;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const firstImage = png(30), secondImage = png(170);

async function csrf(request: APIRequestContext) {
  const response = await request.get('/api/auth/csrf');
  expect(response.status()).toBe(200);
  const token = await response.json();
  return { [token.headerName]: token.token };
}
async function createAccount(request: APIRequestContext) {
  const account = trackAccount() as AccountFixture;
  const response = await request.post('/api/auth/register', { headers: await csrf(request),
    data: { username: account.username, displayName: account.displayName, password } });
  expect(response.status()).toBe(201);
  const user = await response.json();
  recordAccountId(account.key, user.id);
  expect(user.role).toBe('USER'); expect(user.avatarUrl).toBeNull();
  return account;
}
async function logoutApi(request: APIRequestContext) {
  const current = await request.get('/api/auth/me');
  if (current.status() === 401) return;
  expect(current.status()).toBe(200);
  expect((await request.post('/api/auth/logout', { headers: await csrf(request) })).status()).toBe(200);
}
async function loginForm(page: Page, account: AccountFixture) {
  await page.getByLabel('账号', { exact: true }).fill(account.username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: `账号菜单，${account.displayName}`, exact: true })).toBeVisible();
}
async function login(page: Page, account: AccountFixture) {
  await page.goto('/login'); await loginForm(page, account);
}
async function logout(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  await page.getByRole('menuitem', { name: /退出登录/ }).click();
  await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
}
async function relogin(page: Page, account: AccountFixture) {
  await logout(page);
  await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
  await loginForm(page, account);
}
async function openProfile(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  await page.getByRole('menuitem', { name: '个人中心', exact: true }).press('Enter');
  await expect(page.getByTestId('avatar-editor')).toBeVisible();
}
async function select(page: Page, buffer = firstImage) {
  await page.getByLabel('选择头像', { exact: true }).setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer });
  await expect(page.getByRole('img', { name: '待上传头像', exact: true })).toBeVisible();
}
async function upload(page: Page, buffer = firstImage) {
  await select(page, buffer);
  await page.getByRole('button', { name: '上传头像', exact: true }).click();
  await expect(page.getByTestId('avatar-editor').getByRole('status')).toHaveText('头像已更新');
}
async function user(request: APIRequestContext) {
  const response = await request.get('/api/auth/me'); expect(response.status()).toBe(200); return response.json();
}
async function avatarVisible(page: Page) {
  const profile = page.getByTestId('profile-avatar').getByRole('img', { name: '我的头像', exact: true });
  const menu = page.getByTestId('menu-avatar').getByRole('img', { name: '我的头像', exact: true });
  await expect(profile).toBeVisible(); await expect(menu).toBeVisible();
  await expect(profile).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => profile.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight])).toEqual([256, 256]);
  await expect(menu).toHaveAttribute('src', (await profile.getAttribute('src'))!);
  return (await profile.getAttribute('src'))!;
}
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Cleanup still awaits/rethrows errors, even when an earlier assertion fails.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

async function holdNext(page: Page, path: string, method: string, outcome: 'success' | 'error' = 'success', beforeFetch?: Promise<void>) {
  const requested = deferred(), arrived = deferred<APIResponse>(), released = deferred(), completed = deferred();
  let captured = false;
  const handler = async (route: Route) => {
    if (captured || route.request().method() !== method) { await route.continue(); return; }
    captured = true;
    requested.resolve();
    try {
      if (beforeFetch) await beforeFetch;
      const response = await route.fetch();
      arrived.resolve(response);
      await released.promise;
      if (outcome === 'success') await route.fulfill({ response });
      else await route.abort('failed');
      completed.resolve();
    } catch (error) {
      arrived.reject(error); completed.reject(error);
    }
  };
  await page.route(path, handler);
  return {
    requested: requested.promise,
    arrived: arrived.promise,
    release: () => released.resolve(),
    done: completed.promise,
    async close() {
      released.resolve();
      try { if (captured) await completed.promise; }
      finally { await page.unroute(path, handler); }
    },
  };
}

test('头像上传更换移除和重登持久化，仅本人可读标准JPEG，菜单同步且保留昵称草稿', async ({ page, request }, info) => {
  const account = await createAccount(request), other = await createAccount(request);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    expect((await request.get('/api/me/avatar')).status()).toBe(401);
    await login(page, account); await openProfile(page);
    expect((await page.request.get('/api/me/avatar')).status()).toBe(404);
    await expect(page.getByTestId('profile-avatar').locator('img')).toHaveCount(0);
    await page.getByLabel('昵称', { exact: true }).fill(account.allowedDisplayNames[1]);
    let imageReads = 0;
    page.on('response', response => {
      if (new URL(response.url()).pathname === '/api/me/avatar' && response.request().method() === 'GET' && response.status() === 200) imageReads++;
    });
    await upload(page); await avatarVisible(page);
    expect(imageReads).toBe(1);
    await expect(page.getByLabel('昵称', { exact: true })).toHaveValue(account.allowedDisplayNames[1]);
    const first = await user(page.request); expect(first.avatarUrl).toMatch(/^\/api\/me\/avatar\?v=[a-f0-9]{64}$/);
    const image = await page.request.get(first.avatarUrl);
    expect(image.status()).toBe(200); expect(image.headers()['content-type']).toContain('image/jpeg');
    expect(image.headers()['cache-control']).toContain('no-store'); expect(image.headers()['x-content-type-options']).toBe('nosniff');
    expect((await image.body()).subarray(0, 3)).toEqual(Buffer.from([255, 216, 255]));
    expect((await request.get(first.avatarUrl)).status()).toBe(401);
    expect((await request.post('/api/auth/login', { headers: await csrf(request), form: { username: other.username, password } })).status()).toBe(200);
    expect((await request.get(first.avatarUrl)).status()).toBe(404);
    await select(page, secondImage); await page.getByRole('button', { name: '取消头像选择', exact: true }).click();
    await expect(page.getByRole('img', { name: '待上传头像', exact: true })).toHaveCount(0);
    expect((await user(page.request)).avatarUrl).toBe(first.avatarUrl);
    await upload(page, secondImage); const changed = await user(page.request); expect(changed.avatarUrl).not.toBe(first.avatarUrl);
    await expect(page.getByLabel('昵称', { exact: true })).toHaveValue(account.allowedDisplayNames[1]);
    await avatarVisible(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const screenshot = info.outputPath('profile-avatar.png'); await page.screenshot({ path: screenshot, fullPage: true });
    await info.attach('profile-avatar', { path: screenshot, contentType: 'image/png' });
    await relogin(page, account); await openProfile(page); await avatarVisible(page);
    expect((await user(page.request)).avatarUrl).toBe(changed.avatarUrl);
    await page.getByRole('button', { name: '移除头像', exact: true }).click();
    await expect(page.getByTestId('avatar-editor').getByRole('status')).toHaveText('头像已移除');
    await expect(page.getByTestId('profile-avatar').locator('img')).toHaveCount(0);
    await expect(page.getByTestId('menu-avatar').locator('img')).toHaveCount(0);
    expect((await page.request.get(changed.avatarUrl)).status()).toBe(404);
    await relogin(page, account); await openProfile(page);
    expect((await user(page.request)).avatarUrl).toBeNull(); expect(errors).toEqual([]);
  } finally { await logoutApi(page.request); await logoutApi(request); }
});

test('非法超大坏图不替换原头像，私有图片读取失败退回默认并可刷新恢复', async ({ page, request }) => {
  const account = await createAccount(request);
  try {
    await login(page, account); await openProfile(page); await upload(page); await avatarVisible(page);
    const original = (await user(page.request)).avatarUrl;
    const input = page.getByLabel('选择头像', { exact: true }), editor = page.getByTestId('avatar-editor');
    await input.setInputFiles({ name: 'unsafe.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
    await expect(editor.getByRole('alert')).toContainText('PNG 或 JPEG');
    await expect(page.getByRole('button', { name: '上传头像', exact: true })).toBeDisabled();
    await input.setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024 + 1) });
    await expect(editor.getByRole('alert')).toContainText('2 MB');
    await input.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
    await expect(editor.getByRole('alert')).toContainText('无法预览');
    for (const buffer of [Buffer.from('not an image'), png(20, 4097, 1)]) {
      const response = await page.request.post('/api/me/avatar', { headers: await csrf(page.request),
        multipart: { file: { name: 'invalid.png', mimeType: 'image/png', buffer } } });
      expect(response.status()).toBe(400);
    }
    const oversized = await page.request.post('/api/me/avatar', { headers: await csrf(page.request),
      multipart: { file: { name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(4 * 1024 * 1024) } } });
    expect(oversized.status()).toBe(413); expect((await oversized.json()).code).toBe('UPLOAD_TOO_LARGE');
    expect((await user(page.request)).avatarUrl).toBe(original);
    const pendingRead = await holdNext(page, avatarPath, 'GET');
    try {
      await page.reload(); await expect(page.getByTestId('avatar-editor')).toBeVisible();
      expect((await pendingRead.arrived).status()).toBe(200);
      await select(page, png(20, 4097, 1));
      const rejected = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me/avatar' && response.request().method() === 'POST');
      await page.getByRole('button', { name: '上传头像', exact: true }).click();
      expect((await rejected).status()).toBe(400);
      await expect(page.getByTestId('avatar-editor').getByRole('alert')).toBeVisible();
      await expect(page.getByRole('button', { name: '上传头像', exact: true })).toBeEnabled();
      await avatarVisible(page); // A rejected write must restart the superseded original read.
      pendingRead.release(); await pendingRead.done; await settle(page);
      await avatarVisible(page); expect((await user(page.request)).avatarUrl).toBe(original);
    } finally { await pendingRead.close(); }
    await page.route(avatarPath, route => route.request().method() === 'GET' ? route.abort('failed') : route.continue());
    await page.reload(); await expect(page.getByTestId('avatar-editor')).toBeVisible();
    await expect(page.getByTestId('profile-avatar').locator('img')).toHaveCount(0);
    await expect(page.getByTestId('menu-avatar').locator('img')).toHaveCount(0);
    await expect(page.getByTestId('profile-avatar')).toContainText(account.displayName[0]);
    await page.unroute(avatarPath); await page.reload(); await expect(page.getByTestId('avatar-editor')).toBeVisible();
    await avatarVisible(page); expect((await user(page.request)).avatarUrl).toBe(original);
  } finally { await page.unroute(avatarPath); await logoutApi(page.request); }
});

test('退出网络失败保留真实Session时恢复资料和头像，可继续保存且不自动重放退出', async ({ page, request }) => {
  const account = await createAccount(request);
  let attempts = 0;
  let failure: unknown;
  try {
    await test.step('建立真实本人头像', async () => {
      await login(page, account); await openProfile(page); await upload(page); await avatarVisible(page);
    });
    await page.route('**/api/auth/logout', async route => { attempts++; await route.abort('failed'); });
    await test.step('退出请求中断后确认Session并恢复头像', async () => {
      await page.getByRole('button', { name: /账号菜单/ }).click();
      await page.getByRole('menuitem', { name: /退出登录/ }).click();
      await expect(page.getByText('退出未完成，当前仍处于登录状态，请重试。', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: `账号菜单，${account.displayName}`, exact: true })).toBeVisible();
      expect((await user(page.request)).username).toBe(account.username);
      await avatarVisible(page);
    });
    await test.step('站内离页再返回资料，不以整页刷新重置认证状态', async () => {
      await page.getByRole('link', { name: '集会 Gather 首页', exact: true }).click();
      const mobileNavigation = page.getByRole('button', { name: '打开导航', exact: true });
      if (await mobileNavigation.isVisible()) await mobileNavigation.click();
      await page.getByRole('navigation', { name: '主导航', exact: true })
        .getByRole('link', { name: '个人中心', exact: true }).click();
      await expect(page.getByTestId('avatar-editor')).toBeVisible();
      await expect(page.getByLabel('昵称', { exact: true })).toHaveValue(account.displayName);
      await avatarVisible(page);
    });
    await test.step('恢复后仍可保存昵称和头像，退出POST不自动重放', async () => {
      await page.getByLabel('昵称', { exact: true }).fill(account.allowedDisplayNames[1]);
      await page.getByRole('button', { name: '保存昵称', exact: true }).click();
      await expect(page.getByTestId('profile-display-name')).toHaveText(account.allowedDisplayNames[1]);
      await upload(page, secondImage); await avatarVisible(page);
      expect(attempts).toBe(1);
      const current = await user(page.request); expect(current.username).toBe(account.username); expect(current.displayName).toBe(account.allowedDisplayNames[1]);
    });
  } catch (error) { failure = error; }
  finally {
    const errors: unknown[] = [];
    try { await page.unroute('**/api/auth/logout'); } catch (error) { errors.push(error); }
    try { await logoutApi(page.request); } catch (error) { errors.push(error); }
    if (failure && errors.length) throw new AggregateError([failure, ...errors], 'Logout recovery and cleanup both failed');
    if (failure) throw failure;
    if (errors.length) throw new AggregateError(errors, 'Logout recovery cleanup failed');
  }
});

test('头像与昵称真实并行保存，两个完整UserView迟到顺序均只更新各自字段', async ({ page, request }) => {
  const account = await createAccount(request);
  try {
    await login(page, account); await openProfile(page);
    for (const first of ['avatar', 'nickname'] as const) {
      const name = first === 'avatar' ? account.allowedDisplayNames[1] : account.displayName;
      const gate = await holdNext(page, first === 'avatar' ? avatarPath : '**/api/me/profile', first === 'avatar' ? 'POST' : 'PATCH');
      try {
        let savedSource: string | undefined;
        await page.getByLabel('昵称', { exact: true }).fill(name);
        if (first === 'avatar') {
          await select(page); await page.getByRole('button', { name: '上传头像', exact: true }).click();
        } else await page.getByRole('button', { name: '保存昵称', exact: true }).click();
        const earlier = await gate.arrived; expect(earlier.status()).toBe(200);
        const snapshot = await earlier.json();
        if (first === 'avatar') {
          expect(snapshot.displayName).toBe(account.displayName);
          await page.getByRole('button', { name: '保存昵称', exact: true }).click();
          await expect(page.getByTestId('profile-display-name')).toHaveText(name);
        } else {
          const previousAvatar = snapshot.avatarUrl;
          await upload(page, secondImage); savedSource = await avatarVisible(page);
          expect((await user(page.request)).avatarUrl).not.toBe(previousAvatar);
        }
        const committed = await user(page.request);
        gate.release(); await gate.done; await settle(page);
        await expect(page.getByTestId('profile-display-name')).toHaveText(name);
        await expect(page.getByRole('button', { name: `账号菜单，${name}`, exact: true })).toBeVisible();
        await expect(page.getByLabel('昵称', { exact: true })).toHaveValue(name);
        const source = await avatarVisible(page);
        if (savedSource) expect(source).toBe(savedSource);
        expect((await user(page.request)).avatarUrl).toBe(committed.avatarUrl);
      } finally { await gate.close(); }
    }
  } finally { await logoutApi(page.request); }
});

for (const destination of ['leave', 'same-account', 'different-account'] as const)
  for (const outcome of ['success', 'error'] as const)
    test(`真实头像POST已提交后迟到${outcome}，${destination}隔离且旧finally不破坏新上传`, async ({ page, request }) => {
      const account = await createAccount(request);
      const nextAccount = destination === 'different-account' ? await createAccount(request) : account;
      await login(page, account); await openProfile(page); await select(page);
      const old = await holdNext(page, avatarPath, 'POST', outcome);
      let next: Awaited<ReturnType<typeof holdNext>> | undefined;
      try {
        await page.getByRole('button', { name: '上传头像', exact: true }).click();
        const committed = await old.arrived; expect(committed.status()).toBe(200);
        const previous = await committed.json(); expect(previous.avatarUrl).toMatch(/v=[a-f0-9]{64}$/);
        await expect(page.getByRole('button', { name: '上传头像', exact: true })).toBeDisabled();
        if (destination === 'leave') {
          await page.getByRole('link', { name: '集会 Gather 首页', exact: true }).click();
          await expect(page).toHaveURL(/\/activities(?:\?|$)/);
        } else await relogin(page, nextAccount);
        await openProfile(page);
        await expect(page.getByTestId('avatar-editor').getByRole('status')).toHaveCount(0);
        await expect(page.getByRole('img', { name: '待上传头像', exact: true })).toHaveCount(0);
        next = await holdNext(page, avatarPath, 'POST');
        await select(page, secondImage); await page.getByRole('button', { name: '上传头像', exact: true }).click();
        const newer = await next.arrived; expect(newer.status()).toBe(200);
        const latest = await newer.json(); expect(latest.username).toBe(nextAccount.username);
        old.release(); await old.done; await settle(page);
        await expect(page.getByRole('button', { name: '上传头像', exact: true })).toBeDisabled();
        await expect(page.getByRole('img', { name: '待上传头像', exact: true })).toBeVisible();
        await expect(page.getByTestId('avatar-editor').getByRole('alert')).toHaveCount(0);
        await expect(page.getByTestId('avatar-editor').getByRole('status')).toHaveCount(0);
        await expect(page.getByRole('button', { name: `账号菜单，${nextAccount.displayName}`, exact: true })).toBeVisible();
        next.release(); await next.done;
        await expect(page.getByTestId('avatar-editor').getByRole('status')).toHaveText('头像已更新');
        await expect(page.getByRole('button', { name: '取消头像选择', exact: true })).toBeDisabled();
        await avatarVisible(page);
        const current = await user(page.request); expect(current.username).toBe(nextAccount.username); expect(current.avatarUrl).toBe(latest.avatarUrl);
        // The aborted delivery is an unknown browser result: its real POST already committed.
        if (destination === 'different-account') {
          await relogin(page, account); await openProfile(page); await avatarVisible(page);
          expect((await user(page.request)).avatarUrl).toBe(previous.avatarUrl);
        }
      } finally {
        try { await old.close(); } finally { try { await next?.close(); } finally { await logoutApi(page.request); } }
      }
    });

test('本人头像真实JPEG读取迟到，切换账号后不显示旧图片或覆盖新头像', async ({ page, request }) => {
  const first = await createAccount(request), second = await createAccount(request);
  await login(page, first); await openProfile(page);
  const gate = await holdNext(page, avatarPath, 'GET');
  try {
    await upload(page);
    const response = await gate.arrived; expect(response.status()).toBe(200); expect(response.headers()['content-type']).toContain('image/jpeg');
    await relogin(page, second); await openProfile(page);
    await expect(page.getByTestId('profile-avatar').locator('img')).toHaveCount(0);
    await upload(page, secondImage); const source = await avatarVisible(page), current = await user(page.request);
    gate.release(); await gate.done; await settle(page);
    await expect(page.getByTestId('profile-avatar').getByRole('img', { name: '我的头像', exact: true })).toHaveAttribute('src', source);
    await expect(page.getByRole('button', { name: `账号菜单，${second.displayName}`, exact: true })).toBeVisible();
    expect((await user(page.request)).avatarUrl).toBe(current.avatarUrl);
  } finally { try { await gate.close(); } finally { await logoutApi(page.request); } }
});

test('旧头像GET真实401在同账号重新登录后迟到，不退出新会话或隐藏新图片', async ({ page, request }) => {
  const account = await createAccount(request);
  await login(page, account); await openProfile(page);
  const fetchAllowed = deferred();
  const gate = await holdNext(page, avatarPath, 'GET', 'success', fetchAllowed.promise);
  try {
    await upload(page);
    // Logout invalidates the captured request's physical session before the real GET.
    await gate.requested;
    await logout(page); fetchAllowed.resolve();
    expect((await gate.arrived).status()).toBe(401);
    await page.getByRole('button', { name: '登录 / 体验', exact: true }).click(); await loginForm(page, account); await openProfile(page);
    const source = await avatarVisible(page);
    gate.release(); await gate.done; await settle(page);
    await expect(page.getByRole('button', { name: `账号菜单，${account.displayName}`, exact: true })).toBeVisible();
    await expect(page.getByTestId('profile-avatar').getByRole('img', { name: '我的头像', exact: true })).toHaveAttribute('src', source);
    expect((await user(page.request)).username).toBe(account.username);
  } finally { fetchAllowed.resolve(); try { await gate.close(); } finally { await logoutApi(page.request); } }
});
