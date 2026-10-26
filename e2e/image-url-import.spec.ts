import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import mysql from 'mysql2/promise';
import { test, expect, type APIRequestContext, type Locator, type Page, type Request, type Route, type TestInfo } from '@playwright/test';
import { databaseConfig, verifyDatabase, trackAccount, recordAccountId, trackFixture, recordFixtureId } from '../scripts/e2e-cleanup.mjs';

// Only the external HTTPS response is a declared browser fixture. Uploads,
// authentication, authorization and persisted JPEG reads use the real application.
// No real third party, user URL, Session header or image body enters a trace.
test.use({ trace: 'off' });

interface Account { key: string; id: number; username: string; displayName: string; allowedDisplayNames: string[] }
interface Activity { id: number; title: string; description: string; coverUrl: string | null }
interface FetchProbe { mode: string; credentials: string; cache: string; redirect: string; referrerPolicy: string; method: string }
declare global { interface Window { __gatherImageImportProbe: FetchProbe[] } }
type Kind = 'avatar' | 'cover';
interface Editor { kind: Kind; scope: Locator; input: Locator; link: Locator; importing: Locator; upload: Locator; preview: Locator; cancel: Locator; endpoint: string }
const password = 'Demo123!';
const imageHost = 'images.example.test';
const importedNotice = '图片已导入，请点击上传保存。';

function png(red: number, width = 320, height = 180) {
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    rows[offset] = red; rows[offset + 1] = 60 + Math.floor(y / height * 150); rows[offset + 2] = 200;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const firstImage = png(30), secondImage = png(170, 240, 160);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function csrf(request: APIRequestContext) {
  const response = await request.get('/api/auth/csrf'); expect(response.status()).toBe(200);
  const token = await response.json(); return { [token.headerName]: token.token };
}
async function loginApi(request: APIRequestContext, account?: Account) {
  expect((await request.post('/api/auth/login', { headers: await csrf(request), form: {
    username: account?.username ?? 'admin', password: account ? password : 'Admin123!',
  } })).status()).toBe(200);
}
async function logoutApi(request: APIRequestContext) {
  const current = await request.get('/api/auth/me'); if (current.status() === 401) return;
  expect(current.status()).toBe(200);
  expect((await request.post('/api/auth/logout', { headers: await csrf(request) })).status()).toBe(200);
}
async function verifyTarget() {
  const manifestPath = process.env.E2E_RUN_MANIFEST;
  if (!manifestPath || dirname(resolve(manifestPath)) !== resolve('.runtime/e2e')) throw new Error('A verified local fixture manifest is required.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const config = databaseConfig(), connection = await mysql.createConnection(config);
  try { await verifyDatabase(connection, config, manifest.target); } finally { await connection.end(); }
  return { manifestPath, config, target: manifest.target };
}
async function createAccount(request: APIRequestContext): Promise<Account> {
  const { manifestPath } = await verifyTarget();
  const intent = trackAccount(['导入-', '草稿-']);
  const response = await request.post('/api/auth/register', { headers: await csrf(request),
    data: { username: intent.username, displayName: intent.displayName, password } });
  expect(response.status()).toBe(201); const account = await response.json(); recordAccountId(intent.key, account.id);
  expect(account).toMatchObject({ username: intent.username, displayName: intent.displayName, role: 'USER', avatarUrl: null });
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  expect(manifest.accounts.some((row: Account) => row.key === intent.key && row.id === account.id && row.username === intent.username && row.displayName === intent.displayName)).toBe(true);
  return { ...intent, id: account.id };
}
async function createActivity(request: APIRequestContext, info: TestInfo, started = false): Promise<Activity> {
  const { config, target } = await verifyTarget(); await loginApi(request);
  const intent = trackFixture(`链接导入 ${info.project.name} ${randomUUID().slice(0, 8)}`, '仅本轮活动封面导入测试；外站响应为明确浏览器替身，不调用真实图片来源。');
  if (!started) {
    const response = await request.post('/api/admin/activities', { headers: await csrf(request), data: {
      title: intent.title, description: intent.description, location: '图片导入独立测试场地',
      startsAt: new Date(Date.now() + 48 * 3600000).toISOString(), capacity: 3, category: 'TECHNOLOGY',
    } });
    expect(response.status()).toBe(201); const activity = await response.json(); recordFixtureId(intent.key, activity.id); return activity;
  }
  // An already-started boundary uses its own declared row, never a sample date edit.
  const connection = await mysql.createConnection(config);
  try {
    await verifyDatabase(connection, config, target);
    const me = await request.get('/api/auth/me'); expect(me.status()).toBe(200); const admin = await me.json(); expect(admin.role).toBe('ADMIN');
    await connection.beginTransaction();
    const [actors] = await connection.execute<any[]>("SELECT id FROM users WHERE id=? AND username='admin' AND role='ADMIN' FOR UPDATE", [admin.id]);
    expect(actors).toHaveLength(1);
    const [created] = await connection.execute<mysql.ResultSetHeader>(
      'INSERT INTO activities(title,description,location,starts_at,capacity,registered_count,created_by) VALUES(?,?,?,UTC_TIMESTAMP(6)-INTERVAL 1 HOUR,3,0,?)',
      [intent.title, intent.description, '已开始封面边界独立场地', admin.id]);
    await connection.commit(); recordFixtureId(intent.key, created.insertId);
    const response = await request.get(`/api/activities/${created.insertId}`); expect(response.status()).toBe(200);
    const activity = await response.json(); expect(activity).toMatchObject({ id: created.insertId, title: intent.title, description: intent.description, registeredCount: 0 }); return activity;
  } catch (error) { await connection.rollback(); throw error; } finally { await connection.end(); }
}
async function login(page: Page, account?: Account) {
  await page.goto('/login'); await loginForm(page, account);
}
async function loginForm(page: Page, account?: Account) {
  await page.getByLabel('账号', { exact: true }).fill(account?.username ?? 'admin');
  await page.getByLabel('密码', { exact: true }).fill(account ? password : 'Admin123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: /账号菜单/ })).toBeVisible();
}
async function logout(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  await page.getByRole('menuitem', { name: /退出登录/ }).press('Enter');
  await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
}
async function openProfile(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  await page.getByRole('menuitem', { name: '个人中心', exact: true }).press('Enter');
  await expect(page.getByTestId('avatar-editor')).toBeVisible(); return editor(page, 'avatar');
}
function editor(page: Page, kind: Kind, activity?: Activity): Editor {
  const avatar = kind === 'avatar', scope = avatar ? page.getByTestId('avatar-editor') : page.locator('.cover-editor');
  return { kind, scope, input: scope.getByLabel(avatar ? '选择头像' : '选择活动封面', { exact: true }),
    link: scope.getByLabel(avatar ? '头像图片链接' : '封面图片链接', { exact: true }),
    importing: scope.getByRole('button', { name: avatar ? '从链接导入头像' : '从链接导入封面', exact: true }),
    upload: scope.getByRole('button', { name: avatar ? '上传头像' : '上传封面', exact: true }),
    preview: scope.getByRole('img', { name: avatar ? '待上传头像' : '待上传活动封面', exact: true }),
    cancel: scope.getByRole('button', { name: avatar ? '取消头像选择' : '取消封面选择', exact: true }),
    endpoint: avatar ? '/api/me/avatar' : `/api/admin/activities/${activity!.id}/cover` };
}
async function openCover(page: Page, activity: Activity) {
  await page.goto(`/admin/activities/${activity.id}/edit`);
  await expect(page.getByRole('heading', { name: '编辑活动', exact: true })).toBeVisible();
  const result = editor(page, 'cover', activity); await expect(result.link).toBeVisible(); return result;
}
async function selectLocal(edit: Editor, buffer = firstImage) {
  await edit.input.setInputFiles({ name: `${edit.kind}.png`, mimeType: 'image/png', buffer });
  await expect(edit.preview).toBeVisible(); await expect(edit.upload).toBeEnabled(); return edit.preview.getAttribute('src');
}
async function savedUrl(request: APIRequestContext, kind: Kind, activity?: Activity): Promise<string | null> {
  const response = await request.get(kind === 'avatar' ? '/api/auth/me' : `/api/activities/${activity!.id}`); expect(response.status()).toBe(200);
  const value = await response.json(); return kind === 'avatar' ? value.avatarUrl : value.coverUrl;
}
async function save(page: Page, edit: Editor, importedUrl?: string) {
  const completed = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === edit.endpoint);
  await edit.upload.click(); const response = await completed; expect(response.status()).toBe(200);
  const request = response.request(); expect(await request.headerValue('content-type')).toMatch(/^multipart\/form-data; boundary=/);
  if (importedUrl) expect(request.postDataBuffer()?.includes(Buffer.from(importedUrl)) ?? false).toBe(false);
  await expect(edit.scope.getByRole('status')).toContainText(edit.kind === 'avatar' ? '头像已更新' : '封面已保存');
  await expect(edit.preview).toHaveCount(0); return response.json();
}
async function assertJpeg(request: APIRequestContext, url: string, kind: Kind) {
  const response = await request.get(url); expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('image/jpeg'); expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect(response.headers()['cache-control']).toContain(kind === 'avatar' ? 'no-store' : 'no-cache');
  expect((await response.body()).subarray(0, 3)).toEqual(Buffer.from([255, 216, 255]));
}
async function installFetchProbe(page: Page) {
  await page.addInitScript(({ host }) => {
    const nativeFetch = window.fetch.bind(window); window.__gatherImageImportProbe = [];
    window.fetch = (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).hostname === host) window.__gatherImageImportProbe.push({ mode: request.mode,
        credentials: request.credentials, cache: request.cache, redirect: request.redirect, referrerPolicy: request.referrerPolicy, method: request.method });
      return nativeFetch(input, init);
    };
  }, { host: imageHost });
}
async function assertFetchOptions(page: Page) {
  const probes = await page.evaluate(() => window.__gatherImageImportProbe);
  expect(probes.length).toBeGreaterThan(0);
  expect(probes.every(value => value.mode === 'cors' && value.credentials === 'omit' && value.cache === 'no-store'
    && value.redirect === 'error' && value.referrerPolicy === 'no-referrer' && value.method === 'GET')).toBe(true);
}
function observeWrites(page: Page) {
  const writes: { method: string; pathname: string }[] = [];
  const handler = (request: Request) => { const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) writes.push({ method: request.method(), pathname }); };
  page.on('request', handler); return { writes, close: () => page.off('request', handler) };
}
interface ImageResponse { body?: Buffer; type?: string; status?: number; failure?: boolean; held?: boolean; declaredLength?: string }
async function externalImage(page: Page, options: ImageResponse = {}) {
  const url = `https://${imageHost}/${randomUUID()}.png`, gate = deferred(), ready = deferred();
  const jobs: Promise<{ error?: unknown }>[] = []; let requests = 0;
  if (!options.held) gate.resolve();
  const handler = (route: Route) => {
    const target = route.request(); requests++;
    const job = (async () => {
      expect(target.method()).toBe('GET');
      expect(await target.headerValue('cookie')).toBeNull(); expect(await target.headerValue('referer')).toBeNull();
      expect(await target.headerValue('authorization')).toBeNull();
      ready.resolve(); await gate.promise;
      try {
        // This is an explicitly simulated CORS/transport rejection, not a live external server.
        if (options.failure) await route.abort('accessdenied');
        else await route.fulfill({ status: options.status ?? 200, body: options.body ?? firstImage, headers: {
          'Content-Type': options.type ?? 'image/png', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
          ...(options.declaredLength === undefined ? {} : { 'Content-Length': options.declaredLength }),
        } });
      } catch (error) { if (!target.failure() && !/already handled|cancel|abort|closed/i.test(String(error))) throw error; }
    })();
    jobs.push(job.then(() => ({}), error => ({ error }))); return job;
  };
  await page.route(url, handler);
  const done = async () => { const errors = (await Promise.all(jobs)).flatMap(value => value.error === undefined ? [] : [value.error]);
    if (errors.length) throw new AggregateError(errors, 'A declared external-image route failed.'); await settle(page); };
  return { url, ready: ready.promise, release: () => gate.resolve(), count: () => requests, done,
    close: async () => { gate.resolve(); try { await done(); } finally { await page.unroute(url, handler); } } };
}
async function importImage(edit: Editor, image: Awaited<ReturnType<typeof externalImage>>) {
  await edit.link.fill(image.url); await edit.importing.click(); await image.ready;
}
test.beforeEach(async ({ page }) => {
  // A broken validator or unexpected extra fetch must still never reach DNS,
  // a real third party or the explicitly rejected loopback URL in this suite.
  await page.route(/^(?:https?:\/\/images\.example\.test\/|https:\/\/127\.0\.0\.1\/private\.png)/,
    route => route.abort('blockedbyclient'));
});
test.afterEach(async ({ page, request }) => {
  const results = await Promise.allSettled([logoutApi(page.request), logoutApi(request)]);
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'Owned image-import sessions could not all log out.');
});

test('头像和封面手动导入仅预览，确认后原站multipart持久化JPEG且保留文字草稿', async ({ page, request }, info) => {
  await installFetchProbe(page);
  const account = await createAccount(request), activity = await createActivity(request, info);
  for (const kind of ['avatar', 'cover'] as const) {
    await login(page, kind === 'avatar' ? account : undefined);
    const edit = kind === 'avatar' ? await openProfile(page) : await openCover(page, activity);
    await expect(edit.importing).toBeDisabled(); await expect(edit.upload).toBeDisabled();
    await expect(edit.scope).toContainText('再点击上传保存'); await expect(edit.scope).toContainText('尚未选择待上传图片');
    const draft = kind === 'avatar' ? page.getByLabel('昵称', { exact: true }) : page.getByLabel('活动标题', { exact: true });
    const draftText = kind === 'avatar' ? account.allowedDisplayNames[1] : '尚未保存的封面标题草稿'; await draft.fill(draftText);
    const image = await externalImage(page), observed = observeWrites(page);
    try {
      await edit.link.fill(image.url); await settle(page); expect(image.count()).toBe(0); expect(observed.writes).toEqual([]);
      expect(await savedUrl(page.request, kind, activity)).toBeNull();
      await edit.importing.click(); await image.ready; await image.done();
      await expect(edit.preview).toBeVisible(); await expect(edit.preview).toHaveAttribute('src', /^blob:/);
      await expect(edit.scope.getByRole('status')).toContainText(importedNotice);
      expect(await edit.input.inputValue()).toBe(''); expect(observed.writes).toEqual([]);
      expect(await savedUrl(page.request, kind, activity)).toBeNull(); await assertFetchOptions(page);
      await save(page, edit, image.url); expect(observed.writes).toEqual([{ method: 'POST', pathname: edit.endpoint }]);
      await expect(draft).toHaveValue(draftText); await expect(edit.link).toHaveValue('');
      const url = await savedUrl(page.request, kind, activity); expect(url).toMatch(kind === 'avatar' ? /^\/api\/me\/avatar\?v=[a-f0-9]{64}$/ : /^\/api\/activities\/\d+\/cover\?v=[a-f0-9]{64}$/);
      await assertJpeg(page.request, url!, kind);
      if (kind === 'avatar') {
        const me = await (await page.request.get('/api/auth/me')).json(); expect(me.displayName).toBe(account.displayName);
        await expect.poll(() => page.getByTestId('profile-avatar').locator('img').evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight])).toEqual([256, 256]);
      } else expect((await (await request.get(`/api/activities/${activity.id}`)).json()).title).toBe(activity.title);
      await page.reload(); await expect(edit.link).toBeVisible(); expect(await savedUrl(page.request, kind, activity)).toBe(url);
    } finally { observed.close(); await image.close(); }
    await logout(page);
  }
});

test('非法链接及403非图坏图超大和CORS替身失败保留原图与待选，本地上传继续可用', async ({ page, request }, info) => {
  await installFetchProbe(page);
  const account = await createAccount(request), activity = await createActivity(request, info);
  for (const kind of ['avatar', 'cover'] as const) {
    await login(page, kind === 'avatar' ? account : undefined);
    const edit = kind === 'avatar' ? await openProfile(page) : await openCover(page, activity);
    await selectLocal(edit); await save(page, edit); const original = await savedUrl(page.request, kind, activity);
    const selected = await selectLocal(edit, secondImage), observed = observeWrites(page);
    try {
      for (const url of ['http://images.example.test/insecure.png', 'https://127.0.0.1/private.png']) {
        let invalidReads = 0; const countInvalid = (request: Request) => { if (request.url() === url) invalidReads++; };
        page.on('request', countInvalid);
        const before = await page.evaluate(() => window.__gatherImageImportProbe.length);
        try {
          await edit.link.fill(url); await edit.importing.click(); await expect(edit.scope.getByRole('alert')).toBeVisible();
          expect(await page.evaluate(() => window.__gatherImageImportProbe.length)).toBe(before); expect(invalidReads).toBe(0);
        } finally { page.off('request', countInvalid); }
      }
      const oversized = Buffer.concat([firstImage, Buffer.alloc(2 * 1024 * 1024 + 1 - firstImage.length)]);
      const cases: ImageResponse[] = [{ status: 403 }, { status: 401 }, { type: 'application/json', body: Buffer.from('{}') },
        { body: Buffer.from('not a PNG') }, { body: oversized, declaredLength: '1' }, { failure: true }];
      for (const options of cases) {
        const image = await externalImage(page, options);
        try {
          await importImage(edit, image); await image.done(); await expect(edit.scope.getByRole('alert')).toBeVisible();
          await expect(edit.preview).toHaveAttribute('src', selected!); await expect(edit.upload).toBeEnabled();
          expect(await savedUrl(page.request, kind, activity)).toBe(original); expect(observed.writes).toEqual([]);
          expect((await page.request.get('/api/auth/me')).status()).toBe(200);
        } finally { await image.close(); }
      }
      await selectLocal(edit, secondImage); await save(page, edit);
      expect(await savedUrl(page.request, kind, activity)).not.toBe(original);
    } finally { observed.close(); }
    await logout(page);
  }
});

test('URL与本地选择切换隔离迟到成功失败，旧finally不解除新导入busy或替换新预览', async ({ page, request }, info) => {
  const account = await createAccount(request), activity = await createActivity(request, info);
  for (const kind of ['avatar', 'cover'] as const) {
    await login(page, kind === 'avatar' ? account : undefined);
    const edit = kind === 'avatar' ? await openProfile(page) : await openCover(page, activity);
    for (const failure of [false, true]) {
      const old = await externalImage(page, { held: true, failure }), current = await externalImage(page, { held: true, body: secondImage });
      try {
        await importImage(edit, old); await expect(edit.upload).toBeDisabled(); await expect(edit.input).toBeEnabled();
        const local = await selectLocal(edit); await expect(edit.importing).not.toHaveClass(/ant-btn-loading/);
        await importImage(edit, current); await expect(edit.importing).toHaveClass(/ant-btn-loading/);
        old.release(); await old.done();
        await expect(edit.importing).toHaveClass(/ant-btn-loading/); await expect(edit.upload).toBeDisabled();
        await expect(edit.preview).toHaveAttribute('src', local!); await expect(edit.scope.getByRole('alert')).toHaveCount(0);
        current.release(); await current.done(); await expect(edit.importing).not.toHaveClass(/ant-btn-loading/);
        await expect(edit.upload).toBeEnabled(); await expect(edit.preview).not.toHaveAttribute('src', local!);
        expect(await edit.input.inputValue()).toBe(''); expect(old.count()).toBe(1); expect(current.count()).toBe(1);
        await edit.cancel.click(); await expect(edit.preview).toHaveCount(0); await expect(edit.link).toHaveValue(''); await expect(edit.upload).toBeDisabled();
      } finally { await Promise.all([old.close(), current.close()]); }
    }
    expect(await savedUrl(page.request, kind, activity)).toBeNull(); await logout(page);
  }
});

async function navigateCoverWithinSpa(page: Page, activity: Activity) {
  const mobile = page.getByRole('button', { name: '打开导航', exact: true }); if (await mobile.isVisible()) await mobile.click();
  await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('link', { name: '活动管理', exact: true }).click();
  await page.getByLabel('搜索活动', { exact: true }).fill(activity.title); await page.getByRole('button', { name: '查询', exact: true }).click();
  const row = page.locator(`[data-activity-id="${activity.id}"]`); await expect(row).toBeVisible();
  await row.getByRole('link', { name: '编辑活动', exact: true }).click();
  const edit = editor(page, 'cover', activity); await expect(edit.link).toBeVisible(); return edit;
}
test('离页换账号及切换封面活动后迟到响应不进入新scope，不修改任何原有图片', async ({ page, request }, info) => {
  const first = await createAccount(request), second = await createAccount(request);
  await login(page, first); let edit = await openProfile(page);
  const leaving = await externalImage(page, { held: true });
  try {
    await importImage(edit, leaving);
    await page.getByRole('link', { name: '集会 Gather 首页', exact: true }).click(); await expect(page).toHaveURL(/\/activities(?:\?|$)/);
    edit = await openProfile(page); const local = await selectLocal(edit, secondImage); leaving.release(); await leaving.done();
    await expect(edit.preview).toHaveAttribute('src', local!); await expect(edit.scope.getByRole('alert')).toHaveCount(0);
    await edit.cancel.click();
  } finally { await leaving.close(); }
  const changing = await externalImage(page, { held: true, failure: true });
  try {
    await importImage(edit, changing); await logout(page);
    if (!await page.getByLabel('账号', { exact: true }).isVisible()) await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
    await loginForm(page, second); edit = await openProfile(page); const local = await selectLocal(edit, secondImage);
    changing.release(); await changing.done(); await expect(edit.preview).toHaveAttribute('src', local!);
    await expect(edit.scope.getByRole('alert')).toHaveCount(0); await expect(edit.upload).toBeEnabled();
    expect(await savedUrl(page.request, 'avatar')).toBeNull(); await save(page, edit);
    expect((await (await page.request.get('/api/auth/me')).json()).username).toBe(second.username);
    await loginApi(request, first); expect(await savedUrl(request, 'avatar')).toBeNull();
  } finally { await changing.close(); }
  await logout(page);
  const a = await createActivity(request, info), b = await createActivity(request, info);
  await login(page); edit = await openCover(page, a);
  const moved = await externalImage(page, { held: true });
  try {
    await importImage(edit, moved); edit = await navigateCoverWithinSpa(page, b); const local = await selectLocal(edit, secondImage);
    moved.release(); await moved.done(); await expect(edit.preview).toHaveAttribute('src', local!); await expect(edit.scope.getByRole('alert')).toHaveCount(0);
    await save(page, edit); expect(await savedUrl(request, 'cover', a)).toBeNull(); expect(await savedUrl(request, 'cover', b)).not.toBeNull();
  } finally { await moved.close(); }
});

test('仅本人头像及未开始未取消活动ADMIN可保存，禁用入口说明与后端权限保持', async ({ page, request }, info) => {
  const owner = await createAccount(request), other = await createAccount(request);
  const cancelled = await createActivity(request, info), started = await createActivity(request, info, true);
  expect((await request.post(`/api/admin/activities/${cancelled.id}/cancel`, { headers: await csrf(request), data: { reason: '图片链接导入权限边界' } })).status()).toBe(200);
  await login(page, owner); const avatar = await openProfile(page); await selectLocal(avatar); await save(page, avatar);
  const url = await savedUrl(page.request, 'avatar'); expect(url).not.toBeNull(); await assertJpeg(page.request, url!, 'avatar');
  await loginApi(request, other); expect((await request.get(url!)).status()).toBe(404); await logoutApi(request);
  expect((await request.get(url!)).status()).toBe(401);
  await page.goto(`/admin/activities/${cancelled.id}/edit`); await expect(page.getByText('此页面仅对活动组织者开放', { exact: true })).toBeVisible();
  await expect(page.getByLabel('封面图片链接', { exact: true })).toHaveCount(0);
  expect((await page.request.post(`/api/admin/activities/${cancelled.id}/cover`, { headers: await csrf(page.request), multipart: {
    file: { name: 'cover.png', mimeType: 'image/png', buffer: firstImage },
  } })).status()).toBe(403);
  await logout(page); await login(page); await loginApi(request);
  for (const activity of [cancelled, started]) {
    const cover = await openCover(page, activity); await expect(cover.importing).toBeDisabled(); await expect(cover.link).toBeDisabled();
    await expect(cover.input).toBeDisabled(); await expect(cover.upload).toBeDisabled();
    await expect(cover.scope).toContainText('活动已开始或已取消，不能修改封面');
    expect((await request.post(cover.endpoint, { headers: await csrf(request), multipart: { file: { name: 'cover.png', mimeType: 'image/png', buffer: firstImage } } })).status()).toBe(409);
    expect(await savedUrl(request, 'cover', activity)).toBeNull();
  }
});
