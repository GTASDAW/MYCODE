import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { test, expect, type APIRequestContext, type Browser, type Page, type Request, type TestInfo } from '@playwright/test';
import { databaseConfig, verifyDatabase, trackFixture, recordFixtureId, trackAccount, recordAccountId } from '../scripts/e2e-cleanup.mjs';

// Clipboard contents and account credentials must never enter a retained trace.
test.use({ trace: 'off' });

interface Activity { id: number; title: string; description: string; startsAt: string; endsAt: string | null; cancelled: boolean }
interface Account { id: number; username: string; displayName: string }
type ClipboardMode = 'pending' | 'success' | 'rejection' | 'unsupported';
type Outcome = 'success' | 'failure';
const password = 'Demo123!';
const shareButton = (page: Page) => page.getByRole('button', { name: '复制活动链接', exact: true });
const shareDialog = (page: Page) => page.getByRole('dialog', { name: '复制活动链接', exact: true });
const success = (page: Page) => page.getByText('活动链接已复制', { exact: true });
const publicUrl = (page: Page, activity: Pick<Activity, 'id'>) => `${new URL(page.url()).origin}/activities/${activity.id}`;

async function write(request: APIRequestContext, path: string, data?: unknown) {
  const response = await request.get('/api/auth/csrf'); expect(response.status()).toBe(200);
  const csrf = await response.json();
  return request.post(path, { data, headers: { [csrf.headerName]: csrf.token } });
}
async function admin(request: APIRequestContext) {
  const csrf = await (await request.get('/api/auth/csrf')).json();
  expect((await request.post('/api/auth/login', { headers: { [csrf.headerName]: csrf.token },
    form: { username: 'admin', password: 'Admin123!' } })).status()).toBe(200);
  const current = await request.get('/api/auth/me'); expect(current.status()).toBe(200);
  const actor = await current.json(); expect(actor).toMatchObject({ username: 'admin', role: 'ADMIN' }); return actor;
}
async function account(request: APIRequestContext): Promise<Account> {
  const intent = trackAccount();
  const response = await write(request, '/api/auth/register', { username: intent.username, displayName: intent.displayName, password });
  expect(response.status()).toBe(201); const user = await response.json(); recordAccountId(intent.key, user.id); return user;
}
async function create(request: APIRequestContext, info: TestInfo): Promise<Activity> {
  const intent = trackFixture(`公开分享 ${info.project.name} ${randomUUID().slice(0, 8)}`, '本轮独立的活动公开链接分享验证。');
  const response = await write(request, '/api/admin/activities', { title: intent.title, description: intent.description,
    location: '分享验证独立场地', startsAt: new Date(Date.now() + 48 * 3600000).toISOString(), capacity: 2, category: 'TECHNOLOGY' });
  expect(response.status()).toBe(201); const activity = await response.json(); recordFixtureId(intent.key, activity.id); return activity;
}
async function historical(request: APIRequestContext, info: TestInfo): Promise<Activity[]> {
  const manifestPath = process.env.E2E_RUN_MANIFEST;
  if (!manifestPath || dirname(resolve(manifestPath)) !== resolve('.runtime/e2e')) throw new Error('A verified local fixture manifest is required.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.baseUrl !== new URL(info.project.use.baseURL!).origin) throw new Error('Fixture origin differs from the verified run.');
  const current = await request.get('/api/auth/me'); expect(current.status()).toBe(200);
  const actor = await current.json(); expect(actor).toMatchObject({ username: 'admin', role: 'ADMIN' });
  const declared = ['进行中', '已结束'].map(label => trackFixture(`公开分享 ${label} ${info.project.name} ${randomUUID().slice(0, 8)}`,
    '仅插入已核归属的历史活动，不改既有活动时间。'));
  const config = databaseConfig(), connection = await mysql.createConnection(config);
  const ids: number[] = [];
  try {
    await verifyDatabase(connection, config, manifest.target);
    await connection.beginTransaction();
    const [actors] = await connection.execute<any[]>("SELECT id FROM users WHERE id=? AND username='admin' AND role='ADMIN' FOR UPDATE", [actor.id]);
    expect(actors).toEqual([{ id: actor.id }]);
    for (const [index, intent] of declared.entries()) {
      const bound = JSON.parse(readFileSync(manifestPath, 'utf8')).fixtures.find((item: { key: string }) => item.key === intent.key);
      expect(bound).toMatchObject({ id: null, title: intent.title, description: intent.description });
      const [inserted] = await connection.execute<mysql.ResultSetHeader>(
        "INSERT INTO activities(title,description,location,starts_at,ends_at,capacity,registered_count,created_by,category) "
        + "VALUES(?,?,?,UTC_TIMESTAMP(6)-INTERVAL 3 HOUR,UTC_TIMESTAMP(6)+INTERVAL ? HOUR,2,0,?,'TECHNOLOGY')",
        [intent.title, intent.description, '分享历史独立场地', index === 0 ? 1 : -2, actor.id]);
      ids.push(inserted.insertId);
      const [rows] = await connection.execute<any[]>('SELECT id,title,description,created_by AS actorId,category FROM activities WHERE id=?', [inserted.insertId]);
      expect(rows).toEqual([{ id: inserted.insertId, title: intent.title, description: intent.description, actorId: actor.id, category: 'TECHNOLOGY' }]);
    }
    await connection.commit();
    ids.forEach((id, index) => recordFixtureId(declared[index].key, id));
  } catch (error) { await connection.rollback(); throw error; } finally { await connection.end(); }
  const activities: Activity[] = [];
  for (const [index, id] of ids.entries()) {
    const response = await request.get(`/api/activities/${id}`); expect(response.status()).toBe(200);
    const activity = await response.json(); expect(activity).toMatchObject({ id, title: declared[index].title, description: declared[index].description, cancelled: false });
    expect(Date.parse(activity.startsAt)).toBeLessThan(Date.now());
    expect(Date.parse(activity.endsAt) < Date.now()).toBe(index === 1); activities.push(activity);
  }
  return activities;
}
async function loginForm(page: Page, user: Account | 'admin') {
  await page.getByLabel('账号', { exact: true }).fill(user === 'admin' ? user : user.username);
  await page.getByLabel('密码', { exact: true }).fill(user === 'admin' ? 'Admin123!' : password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: /账号菜单/ })).toBeVisible();
}
async function loginInApp(page: Page, user: Account | 'admin') {
  await page.getByRole('button', { name: '登录 / 体验', exact: true }).click(); await loginForm(page, user);
}
async function logout(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  const completed = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/auth/logout' && response.status() === 200);
  await page.getByRole('menuitem', { name: /退出登录/ }).press('Enter'); await completed;
  await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
}
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function spa(page: Page, path: string) {
  // Preserve pending Clipboard promises and AuthProvider in the same browser document.
  await page.evaluate(path => {
    history.pushState({ ...history.state, idx: (history.state?.idx ?? 0) + 1 }, '', path);
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }, path);
  await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search + new URL(page.url()).hash).toBe(path);
  await settle(page);
}
async function detail(page: Page, activity: Activity, suffix = '', inApp = false) {
  const path = `/activities/${activity.id}${suffix}`;
  if (inApp) await spa(page, path); else await page.goto(path);
  await expect(page.getByRole('heading', { name: activity.title, exact: true })).toBeVisible();
  await expect(shareButton(page)).toBeEnabled();
}
async function fits(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function capture(page: Page, info: TestInfo, name: string) {
  await fits(page); const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true }); await info.attach(name, { path, contentType: 'image/png' });
}
async function fallback(page: Page, activity: Activity) {
  const dialog = shareDialog(page); await expect(dialog).toBeVisible();
  const input = dialog.getByRole('textbox', { name: '活动公开链接', exact: true });
  await expect(input).toHaveValue(publicUrl(page, activity)); await expect(input).toHaveAttribute('readonly', '');
  await input.focus();
  await expect.poll(() => input.evaluate((element: HTMLInputElement) => element.selectionEnd! - element.selectionStart!)).toBe(publicUrl(page, activity).length);
  await input.press('ControlOrMeta+A');
  await expect.poll(() => input.evaluate((element: HTMLInputElement) => element.selectionStart === 0 && element.selectionEnd === element.value.length)).toBe(true);
  await fits(page);
}
async function closeFallback(page: Page) {
  await shareDialog(page).getByRole('button', { name: '关闭分享链接', exact: true }).click();
  await expect(shareDialog(page)).toHaveCount(0); await expect(shareButton(page)).toBeEnabled();
}
async function clipboard(page: Page, mode: ClipboardMode = 'pending') {
  // Only this API is stubbed. Activities, identity, authorization and network responses stay real.
  await page.evaluate(mode => {
    const state = { mode, calls: [] as { url: string; settled: boolean; resolve(): void; reject(error: unknown): void }[] };
    const api = { writeText(url: string) {
      return new Promise<void>((resolve, reject) => {
        const call = { url, settled: false, resolve, reject }; state.calls.push(call);
        if (state.mode === 'success') { call.settled = true; resolve(); }
        if (state.mode === 'rejection') { call.settled = true; reject(new DOMException('Clipboard denied by test', 'NotAllowedError')); }
      });
    } };
    (window as any).__gatherShareClipboard = { state, api };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'unsupported' ? undefined : api });
  }, mode);
}
async function mode(page: Page, value: ClipboardMode) {
  await page.evaluate(value => {
    const probe = (window as any).__gatherShareClipboard; probe.state.mode = value;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: value === 'unsupported' ? undefined : probe.api });
  }, value);
}
async function calls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__gatherShareClipboard.state.calls.map((call: { url: string }) => call.url));
}
async function release(page: Page, index: number, outcome: Outcome) {
  await page.evaluate(({ index, outcome }) => {
    const call = (window as any).__gatherShareClipboard.state.calls[index];
    if (!call || call.settled) throw new Error('Clipboard operation was not pending.');
    call.settled = true;
    if (outcome === 'success') call.resolve(); else call.reject(new DOMException('Clipboard denied by test', 'NotAllowedError'));
  }, { index, outcome });
  await settle(page);
}
async function releaseAll(page: Page) {
  if (page.isClosed()) return;
  await page.evaluate(() => {
    for (const call of (window as any).__gatherShareClipboard?.state.calls ?? []) {
      if (!call.settled) { call.settled = true; call.resolve(); }
    }
  });
}
async function noHttp(page: Page, action: () => Promise<void>) {
  await page.waitForLoadState('networkidle');
  const observed: string[] = [];
  const listener = (request: Request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) observed.push(`${request.method()} ${new URL(request.url()).pathname}`);
  };
  page.on('request', listener);
  try { await action(); await settle(page); expect(observed).toEqual([]); } finally { page.off('request', listener); }
}
async function isolated(browser: Browser, info: TestInfo) {
  const use = info.project.use;
  const context = await browser.newContext({ baseURL: use.baseURL, viewport: use.viewport, userAgent: use.userAgent,
    isMobile: use.isMobile, hasTouch: use.hasTouch, deviceScaleFactor: use.deviceScaleFactor });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(use.baseURL!).origin });
  return context;
}

test('隔离上下文真实剪贴板支持匿名USER和ADMIN，只复制公开地址且点击不发HTTP', async ({ browser, request }, info) => {
  await admin(request); const activity = await create(request, info), user = await account(request);
  const context = await isolated(browser, info);
  try {
    const page = await context.newPage();
    const suffix = `?${new URLSearchParams({ from: '/my-favorites?page=2&pageSize=20', source: 'private-source' })}#private-fragment`;
    await detail(page, activity, suffix);
    for (const identity of ['anonymous', user, 'admin'] as const) {
      if (identity !== 'anonymous') { await loginInApp(page, identity); await detail(page, activity, suffix, true); }
      await expect(shareButton(page)).toHaveText('复制活动链接');
      await noHttp(page, async () => {
        await shareButton(page).click(); await expect(success(page)).toBeVisible();
        // Read only immediately after writing this known public fixture URL; no prior clipboard read.
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(publicUrl(page, activity));
      });
      await expect(shareDialog(page)).toHaveCount(0); await fits(page);
      if (identity !== 'anonymous') {
        const me = await page.request.get('/api/auth/me'); expect(me.status()).toBe(200);
        expect(await me.json()).toMatchObject({ role: identity === 'admin' ? 'ADMIN' : 'USER' });
      }
      await expect(success(page)).toHaveCount(0);
      if (identity === user) await logout(page);
    }
    await capture(page, info, 'activity-share-real-clipboard');
  } finally { await context.close(); }
});

test('独立已开始已结束和已取消活动都保留可用分享入口', async ({ page, request }, info) => {
  await admin(request); const [ongoing, ended] = await historical(request, info), cancelled = await create(request, info);
  expect((await write(request, `/api/admin/activities/${cancelled.id}/cancel`, { reason: '分享取消活动验证' })).status()).toBe(200);
  for (const [index, activity] of [ongoing, ended, cancelled].entries()) {
    await detail(page, activity); await clipboard(page, 'success');
    await expect(page.locator('.activity-status')).toContainText(['进行中', '已结束', '活动已取消'][index]);
    await noHttp(page, async () => { await shareButton(page).click(); await expect(success(page)).toBeVisible(); });
    expect(await calls(page)).toEqual([publicUrl(page, activity)]); await expect(shareButton(page)).toBeEnabled();
  }
  await capture(page, info, 'activity-share-cancelled');
});

test('不支持和拒绝剪贴板均提供只读可全选链接，关闭后仅手动重试', async ({ page, request }, info) => {
  await admin(request); const activity = await create(request, info); await detail(page, activity, '?from=%2Fmy-registrations%3Fpage%3D2#local');
  await clipboard(page, 'unsupported');
  await noHttp(page, async () => { await shareButton(page).click(); await fallback(page, activity); });
  expect(await calls(page)).toEqual([]); await capture(page, info, 'activity-share-manual-copy');
  await closeFallback(page); await settle(page); expect(await calls(page)).toEqual([]);
  await mode(page, 'rejection');
  await noHttp(page, async () => { await shareButton(page).click(); await fallback(page, activity); });
  expect(await calls(page)).toEqual([publicUrl(page, activity)]);
  await closeFallback(page); await settle(page); expect(await calls(page)).toHaveLength(1);
  await shareButton(page).click(); await fallback(page, activity); expect(await calls(page)).toHaveLength(2);
  await closeFallback(page); await mode(page, 'success');
  await shareButton(page).click(); await expect(success(page)).toBeVisible();
  expect(await calls(page)).toHaveLength(3); await expect(shareDialog(page)).toHaveCount(0);
});

test('写入在点击调用栈同步开始，pending禁用并防重且finally后可手动再复制', async ({ page, request }, info) => {
  await admin(request); const activity = await create(request, info); await detail(page, activity); await clipboard(page);
  try {
    await noHttp(page, async () => {
      const synchronous = await shareButton(page).evaluate((element: HTMLButtonElement) => {
        element.click(); return (window as any).__gatherShareClipboard.state.calls.length;
      });
      expect(synchronous).toBe(1); await expect(shareButton(page)).toBeDisabled();
      await shareButton(page).click({ force: true }); await shareButton(page).dispatchEvent('click');
      expect(await calls(page)).toEqual([publicUrl(page, activity)]);
      await release(page, 0, 'success'); await expect(success(page)).toBeVisible(); await expect(shareButton(page)).toBeEnabled();
    });
    await mode(page, 'rejection'); await shareButton(page).click(); await fallback(page, activity); expect(await calls(page)).toHaveLength(2);
  } finally { await releaseAll(page); }
});

async function staleAgainstCurrent(page: Page, from: Activity, destination: Activity, path: string, outcome: Outcome, phase: 'busy' | 'fallback') {
  const first = (await calls(page)).length;
  await shareButton(page).click(); await expect(shareButton(page)).toBeDisabled();
  await spa(page, path); await expect(page.getByRole('heading', { name: destination.title, exact: true })).toBeVisible();
  await expect(shareButton(page)).toBeEnabled(); await shareButton(page).click();
  expect((await calls(page)).slice(first)).toEqual([publicUrl(page, from), publicUrl(page, destination)]);
  if (phase === 'fallback') { await release(page, first + 1, 'failure'); await fallback(page, destination); }
  await release(page, first, outcome);
  await expect(success(page)).toHaveCount(0);
  if (phase === 'busy') {
    await expect(shareButton(page)).toBeDisabled(); await expect(shareDialog(page)).toHaveCount(0);
    await release(page, first + 1, 'failure');
  }
  await fallback(page, destination); await expect(shareDialog(page)).toHaveCount(1); await closeFallback(page);
}

test('同SPA切换活动后旧成功失败和finally不能改变当前busy或手动复制框', async ({ page, request }, info) => {
  await admin(request); const first = await create(request, info), second = await create(request, info);
  await detail(page, first); await clipboard(page);
  try {
    let current = first;
    for (const outcome of ['success', 'failure'] as const) for (const phase of ['busy', 'fallback'] as const) {
      const next = current.id === first.id ? second : first;
      await staleAgainstCurrent(page, current, next, `/activities/${next.id}`, outcome, phase); current = next;
    }
  } finally { await releaseAll(page); }
});

test('同活动search和hash变化均隔离旧回调，原finally不清除新操作或fallback', async ({ page, request }, info) => {
  await admin(request); const activity = await create(request, info); await detail(page, activity); await clipboard(page);
  try {
    let sequence = 0;
    for (const condition of ['search', 'hash'] as const) for (const outcome of ['success', 'failure'] as const)
      for (const phase of ['busy', 'fallback'] as const) {
        const path = condition === 'search' ? `/activities/${activity.id}?share-scope=${++sequence}`
          : `/activities/${activity.id}${new URL(page.url()).search}#share-${++sequence}`;
        await staleAgainstCurrent(page, activity, activity, path, outcome, phase);
      }
  } finally { await releaseAll(page); }
});

test('切换账号和同账号重登隔离旧成功失败，保留新身份的busy与fallback', async ({ page, request }, info) => {
  await admin(request); const activity = await create(request, info), owner = await account(request), other = await account(request);
  await page.goto('/login'); await loginForm(page, owner); await detail(page, activity, '', true); await clipboard(page);
  try {
    let current = owner;
    for (const destination of ['same', 'different'] as const) for (const outcome of ['success', 'failure'] as const) {
      const old = (await calls(page)).length; await shareButton(page).click(); await expect(shareButton(page)).toBeDisabled();
      await logout(page); const next = destination === 'same' ? current : current.id === owner.id ? other : owner;
      await loginInApp(page, next); await detail(page, activity, '', true); current = next;
      await shareButton(page).click(); await expect(shareButton(page)).toBeDisabled();
      if (outcome === 'failure') { await release(page, old + 1, 'failure'); await fallback(page, activity); }
      await release(page, old, outcome); await expect(success(page)).toHaveCount(0);
      const me = await page.request.get('/api/auth/me'); expect(me.status()).toBe(200); expect(await me.json()).toMatchObject({ id: current.id });
      if (outcome === 'success') { await expect(shareButton(page)).toBeDisabled(); await expect(shareDialog(page)).toHaveCount(0); await release(page, old + 1, 'failure'); }
      await fallback(page, activity); await closeFallback(page);
      await expect(page.getByRole('button', { name: `账号菜单，${current.displayName}`, exact: true })).toBeVisible();
    }
  } finally { await releaseAll(page); }
});

for (const fault of ['confirmation-unavailable', 'response-lost'] as const) test(
  `退出网络失败后旧复制结果不反馈，仍能以当前代次重新复制（${fault === 'confirmation-unavailable' ? 'Session确认失败需重登' : '真实退出已提交并确认匿名'}）`, async ({ page, request }, info) => {
  await admin(request); const activity = await create(request, info), owner = await account(request);
  await page.goto('/login'); await loginForm(page, owner); await detail(page, activity, '', true); await clipboard(page);
  const unknownNotice = page.getByText('退出结果未确认，请重新登录确认。', { exact: true });
  const logoutPattern = '**/api/auth/logout', sessionPattern = '**/api/auth/me';
  let recovering = false, posts = 0, confirmations = 0, committed = 0, anonymous = 0, primary: unknown;
  const jobs: Array<Promise<{ error?: unknown }>> = [];
  await page.route(logoutPattern, route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++; recovering = true;
    const job = (async () => {
      if (fault === 'response-lost') {
        // The real server commits logout; only its browser-facing response is lost.
        const response = await route.fetch(); expect(response.status()).toBe(200); committed++;
      }
      await route.abort('failed');
    })();
    jobs.push(job.then(() => ({}), error => ({ error }))); return job;
  });
  await page.route(sessionPattern, route => {
    if (!recovering || route.request().method() !== 'GET') return route.continue();
    confirmations++;
    const job = (async () => {
      if (fault === 'confirmation-unavailable') { await route.abort('failed'); return; }
      const response = await route.fetch(); expect(response.status()).toBe(401); anonymous++;
      await route.fulfill({ response });
    })();
    jobs.push(job.then(() => ({}), error => ({ error }))); return job;
  });
  try {
    let round = 0;
    for (const outcome of ['success', 'failure'] as const) for (const phase of ['busy', 'fallback'] as const) {
      await expect(unknownNotice).toHaveCount(0); await page.waitForLoadState('networkidle');
      const old = (await calls(page)).length; await shareButton(page).click(); await expect(shareButton(page)).toBeDisabled();
      await page.getByRole('button', { name: /账号菜单/ }).click();
      await page.getByRole('menuitem', { name: /退出登录/ }).press('Enter');
      if (fault === 'confirmation-unavailable') await expect(unknownNotice).toBeVisible();
      else {
        await expect(page.getByRole('heading', { name: '发现活动', exact: true })).toBeVisible();
        await expect(unknownNotice).toHaveCount(0);
      }
      await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: `账号菜单，${owner.displayName}`, exact: true })).toHaveCount(0);
      await expect(shareDialog(page)).toHaveCount(0); await expect(success(page)).toHaveCount(0);
      recovering = false; round++; await settle(page);
      expect(posts).toBe(round); expect(confirmations).toBe(round);
      expect(committed).toBe(fault === 'response-lost' ? round : 0); expect(anonymous).toBe(fault === 'response-lost' ? round : 0);
      const confirmedSession = await page.request.get('/api/auth/me');
      expect(confirmedSession.status()).toBe(fault === 'response-lost' ? 401 : 200);
      if (fault === 'confirmation-unavailable') expect(await confirmedSession.json()).toMatchObject({ id: owner.id });
      // Explicitly log in again in the same document; no automatic logout replay.
      await loginInApp(page, owner); await detail(page, activity, '', true);
      await expect(page.getByRole('button', { name: `账号菜单，${owner.displayName}`, exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: activity.title, exact: true })).toBeVisible();
      await expect(shareButton(page)).toBeEnabled(); await expect(shareDialog(page)).toHaveCount(0);
      await shareButton(page).click(); await expect(shareButton(page)).toBeDisabled();
      expect((await calls(page)).slice(old)).toEqual([publicUrl(page, activity), publicUrl(page, activity)]);
      if (phase === 'fallback') { await release(page, old + 1, 'failure'); await fallback(page, activity); }
      await release(page, old, outcome); await expect(success(page)).toHaveCount(0);
      if (phase === 'busy') {
        await expect(shareButton(page)).toBeDisabled(); await expect(shareDialog(page)).toHaveCount(0);
        await release(page, old + 1, 'failure');
      }
      await fallback(page, activity); await expect(shareDialog(page)).toHaveCount(1); await closeFallback(page);
      expect(posts).toBe(round); expect(confirmations).toBe(round);
    }
    const me = await page.request.get('/api/auth/me'); expect(me.status()).toBe(200); expect(await me.json()).toMatchObject({ id: owner.id, role: 'USER' });
  } catch (error) { primary = error; }
  finally {
    recovering = false;
    const errors: unknown[] = primary === undefined ? [] : [primary];
    for (const cleanup of [async () => {
      const results = await Promise.all(jobs); for (const result of results) if (result.error !== undefined) errors.push(result.error);
    }, () => page.unroute(logoutPattern), () => page.unroute(sessionPattern), () => releaseAll(page)])
      try { await cleanup(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Logout fault verification and cleanup failed; original failures are preserved.');
  }
});

test('真实断网加载失败和真实404不展示分享入口，恢复后可再次分享', async ({ page, request, context }, info) => {
  await admin(request); const activity = await create(request, info); await detail(page, activity);
  try {
    await context.setOffline(true); await page.getByRole('button', { name: '刷新活动信息', exact: true }).click();
    await expect(page.getByText('暂时无法连接服务，请检查网络后重试。', { exact: true })).toBeVisible();
    await expect(shareButton(page)).toHaveCount(0); await expect(shareDialog(page)).toHaveCount(0);
  } finally { await context.setOffline(false); }
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.getByRole('heading', { name: activity.title, exact: true })).toBeVisible(); await expect(shareButton(page)).toBeEnabled();
  const absent = 2147483647; expect((await request.get(`/api/activities/${absent}`)).status()).toBe(404);
  await spa(page, `/activities/${absent}`); await expect(page.getByRole('button', { name: '重新加载', exact: true })).toBeVisible();
  await expect(shareButton(page)).toHaveCount(0); await expect(shareDialog(page)).toHaveCount(0);
  await detail(page, activity, '', true); await clipboard(page, 'success'); await shareButton(page).click(); await expect(success(page)).toBeVisible();
});

test('离开详情清除手动框且迟到成功失败不显示反馈，返回后操作正常', async ({ page, request }, info) => {
  await admin(request); const activity = await create(request, info); await detail(page, activity); await clipboard(page, 'rejection');
  await shareButton(page).click(); await fallback(page, activity);
  await spa(page, '/activities'); await expect(page.getByRole('heading', { name: '发现活动', exact: true })).toBeVisible();
  await expect(shareDialog(page)).toHaveCount(0); await detail(page, activity, '', true); await mode(page, 'pending');
  try {
    for (const outcome of ['success', 'failure'] as const) {
      const old = (await calls(page)).length; await shareButton(page).click(); await expect(shareButton(page)).toBeDisabled();
      await spa(page, '/activities'); await expect(page.getByRole('heading', { name: '发现活动', exact: true })).toBeVisible();
      await release(page, old, outcome); await expect(success(page)).toHaveCount(0); await expect(shareDialog(page)).toHaveCount(0);
      await expect(shareButton(page)).toHaveCount(0); await detail(page, activity, '', true);
    }
    await mode(page, 'success'); await shareButton(page).click(); await expect(success(page)).toBeVisible(); await expect(shareButton(page)).toBeEnabled();
  } finally { await releaseAll(page); }
});
