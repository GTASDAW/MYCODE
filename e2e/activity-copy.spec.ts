import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import mysql from 'mysql2/promise';
import { test, expect, type APIRequestContext, type Page, type TestInfo, type APIResponse } from '@playwright/test';
import { databaseConfig, verifyDatabase, trackFixture, recordFixtureId, recordFixtureEditIntent,
  trackAccount, recordAccountId, trackFavorite } from '../scripts/e2e-cleanup.mjs';

test.use({ trace: 'off', timezoneId: 'America/New_York' });
type Activity = { id: number; title: string; description: string; location: string; category: string; capacity: number;
  startsAt: string; endsAt: string | null; coverUrl: string | null; registeredCount: number; waitingCount: number };
type Source = Activity & { fixture: { key: string; title: string; description: string } };
const createPath = '/admin/activities/new';
const copyPath = (id: number) => `${createPath}?copyFrom=${id}`;
const title = (page: Page) => page.getByLabel('活动标题', { exact: true });
const start = (page: Page) => page.getByLabel('开始时间（北京时间）', { exact: true });
const end = (page: Page) => page.getByLabel('结束时间（北京时间，可选）', { exact: true });
const publish = (page: Page) => page.getByRole('button', { name: '发布活动', exact: true });
const utc = (value: string) => value.replace('T', ' ').replace('Z', '');

async function csrf(request: APIRequestContext) {
  const response = await request.get('/api/auth/csrf'); expect(response.status()).toBe(200); return response.json();
}
async function write(request: APIRequestContext, path: string, method = 'POST', data?: unknown) {
  const token = await csrf(request); return request.fetch(path, { method, headers: { [token.headerName]: token.token }, data });
}
async function loginApi(request: APIRequestContext, username = 'admin') {
  const token = await csrf(request);
  expect((await request.post('/api/auth/login', { headers: { [token.headerName]: token.token },
    form: { username, password: username === 'admin' ? 'Admin123!' : 'Demo123!' } })).status()).toBe(200);
  return (await request.get('/api/auth/me')).json();
}
async function logoutApi(request: APIRequestContext) {
  const current = await request.get('/api/auth/me'); if (current.status() === 401) return;
  expect(current.status()).toBe(200); expect((await write(request, '/api/auth/logout')).status()).toBe(200);
}
async function loginForm(page: Page, username = 'admin') {
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(username === 'admin' ? 'Admin123!' : 'Demo123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: /账号菜单/ })).toBeVisible();
}
async function login(page: Page, username = 'admin') { await page.goto('/login'); await loginForm(page, username); }
async function logout(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  await page.getByRole('menuitem', { name: /退出登录/ }).click();
  await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
}
async function finish(primary: unknown, operations: Array<() => Promise<unknown>>) {
  const errors: unknown[] = primary === undefined ? [] : [primary];
  for (const operation of operations) try { await operation(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Copy verification and cleanup failed; first error is preserved.');
}
async function database() {
  const config = databaseConfig();
  const db = await mysql.createConnection({ ...config, timezone: 'Z', dateStrings: true, jsonStrings: true });
  try { await verifyDatabase(db, config, JSON.parse(readFileSync(process.env.E2E_RUN_MANIFEST!, 'utf8')).target); }
  catch (error) { await db.end(); throw error; }
  return db;
}
async function source(request: APIRequestContext, info: TestInfo, state: 'future' | 'ongoing' | 'ended' | 'cancelled' = 'future', capacity = 3) {
  await loginApi(request);
  const fixture = trackFixture(`复制来源 ${info.project.name} ${state} ${randomUUID().slice(0, 8)}`, '复制活动独立归属来源。');
  const created = await write(request, '/api/admin/activities', 'POST', { title: fixture.title, description: fixture.description,
    location: '复制来源会场', category: 'TECHNOLOGY', capacity,
    startsAt: new Date(Date.now() + 48 * 3600000).toISOString(), endsAt: new Date(Date.now() + 49 * 3600000).toISOString() });
  expect(created.status()).toBe(201); const activity = await created.json() as Activity; recordFixtureId(fixture.key, activity.id);
  if (state === 'cancelled') expect((await write(request, `/api/admin/activities/${activity.id}/cancel`, 'POST', { reason: '复制已取消活动验证' })).status()).toBe(200);
  if (state === 'ongoing' || state === 'ended') {
    const db = await database();
    try {
      const [owned] = await db.execute<any[]>('SELECT id FROM activities WHERE id=? AND CAST(title AS BINARY)=CAST(? AS BINARY) AND CAST(description AS BINARY)=CAST(? AS BINARY)', [activity.id, fixture.title, fixture.description]);
      expect(owned).toHaveLength(1);
      await db.execute('UPDATE activities SET starts_at=?,ends_at=? WHERE id=?',
        [utc(new Date(Date.now() - 3 * 3600000).toISOString()), utc(new Date(Date.now() + (state === 'ongoing' ? 1 : -1) * 3600000).toISOString()), activity.id]);
    } finally { await db.end(); }
  }
  const response = await request.get(`/api/activities/${activity.id}`); expect(response.status()).toBe(200);
  return { ...await response.json(), fixture } as Source;
}
async function freshSource(request: APIRequestContext, value: Source) {
  // Ownership markers must remain the final description line for precise cleanup.
  const description = `数据库最新介绍\n${value.fixture.description}`;
  const edit = recordFixtureEditIntent(value.fixture.key, `${value.title} 最新`, description);
  const response = await write(request, `/api/admin/activities/${value.id}`, 'PATCH', {
    title: edit.title, description, location: '已更新的真实场地', category: 'CULTURE',
  });
  expect(response.status()).toBe(200); return { ...await response.json(), fixture: value.fixture } as Source;
}
async function form(page: Page, value: Activity) {
  await expect(title(page)).toHaveValue(value.title);
  await expect(page.getByLabel('活动介绍', { exact: true })).toHaveValue(value.description);
  await expect(page.getByLabel('活动地点', { exact: true })).toHaveValue(value.location);
  await expect(page.getByRole('spinbutton', { name: '报名名额', exact: true })).toHaveValue(String(value.capacity));
  await expect(page.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: '活动分类', exact: true }) }))
    .toContainText(value.category === 'CULTURE' ? '文化艺术' : '技术交流');
  await expect(start(page)).toHaveValue(''); await expect(end(page)).toHaveValue('');
  await expect(page.getByRole('img', { name: /活动封面|待上传/ })).toHaveCount(0);
  await expect(publish(page)).toBeEnabled();
}
async function ordinary(page: Page) {
  await expect(title(page)).toHaveValue(''); await expect(start(page)).toHaveValue(''); await expect(end(page)).toHaveValue('');
  await expect(page.getByRole('spinbutton', { name: '报名名额', exact: true })).toHaveValue('20');
}
async function choose(page: Page, value: string) {
  await page.getByRole('combobox', { name: '活动分类', exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: value }).click();
}
async function navigate(page: Page, path: string) {
  // Exercise a history change within the existing page and Provider instances.
  await page.evaluate(url => { history.pushState(null, '', url); dispatchEvent(new PopStateEvent('popstate')); }, path);
  await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe(path);
}
async function noOverflow(page: Page) { await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); }
async function picture(page: Page, info: TestInfo, name: string) {
  await noOverflow(page); const path = info.outputPath(`${name}.png`); await page.screenshot({ path, fullPage: true }); await info.attach(name, { path, contentType: 'image/png' });
}
function png() {
  const chunk = (name: string, data: Buffer) => { const type = Buffer.from(name), length = Buffer.alloc(4), sum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); sum.writeUInt32BE(crc32(Buffer.concat([type, data]))); return Buffer.concat([length, type, data, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(14, 0))), chunk('IEND', Buffer.alloc(0))]);
}
async function richEndedSource(request: APIRequestContext, info: TestInfo) {
  let value = await source(request, info, 'future', 1);
  const token = await csrf(request);
  expect((await request.post(`/api/admin/activities/${value.id}/cover`, { headers: { [token.headerName]: token.token },
    multipart: { file: { name: 'copy-source.png', mimeType: 'image/png', buffer: png() } } })).status()).toBe(200);
  const accounts = [];
  for (let index = 0; index < 3; index++) {
    const intent = trackAccount(); const response = await write(request, '/api/auth/register', 'POST', { username: intent.username, displayName: intent.displayName, password: 'Demo123!' });
    expect(response.status()).toBe(201); const account = await response.json(); recordAccountId(intent.key, account.id); accounts.push(account);
  }
  const actor = await (await request.get('/api/auth/me')).json();
  trackFavorite(accounts[0].id, value.id);
  const db = await database();
  try {
    await db.beginTransaction();
    const [owned] = await db.execute<any[]>('SELECT id FROM activities WHERE id=? AND CAST(title AS BINARY)=CAST(? AS BINARY) AND CAST(description AS BINARY)=CAST(? AS BINARY) FOR UPDATE', [value.id, value.title, value.description]); expect(owned).toHaveLength(1);
    for (const account of accounts) {
      const [owners] = await db.execute<any[]>("SELECT id FROM users WHERE id=? AND username=? AND display_name=? AND role='USER' FOR UPDATE", [account.id, account.username, account.displayName]); expect(owners).toHaveLength(1);
    }
    await db.execute('UPDATE activities SET starts_at=?,ends_at=?,registered_count=1 WHERE id=?', [utc(new Date(Date.now() - 3 * 3600000).toISOString()), utc(new Date(Date.now() - 3600000).toISOString()), value.id]);
    for (const [index, status] of ['ACTIVE', 'WAITING', 'CANCELLED'].entries()) await db.execute('INSERT INTO registrations(activity_id,user_id,status) VALUES(?,?,?)', [value.id, accounts[index].id, status]);
    await db.execute("INSERT INTO notifications(user_id,activity_id,type,activity_title,created_at) VALUES(?,?,'PROMOTED',?,UTC_TIMESTAMP(6))", [accounts[0].id, value.id, value.title]);
    await db.execute('INSERT INTO activity_favorites(user_id,activity_id,created_at) VALUES(?,?,UTC_TIMESTAMP(6))', [accounts[0].id, value.id]);
    await db.commit();
    const [[registration]] = await db.execute<any[]>("SELECT id FROM registrations WHERE activity_id=? AND user_id=? AND status='ACTIVE'", [value.id, accounts[0].id]);
    expect((await write(request, `/api/admin/activities/${value.id}/registrations/${registration.id}/check-in`)).status()).toBe(200);
  } catch (error) { await db.rollback(); throw error; } finally { await db.end(); }
  value = { ...await (await request.get(`/api/activities/${value.id}`)).json(), fixture: value.fixture };
  expect(value.coverUrl).toBeTruthy(); expect(value.registeredCount).toBe(1); expect(value.waitingCount).toBe(1);
  return { value, users: [actor.id, ...accounts.map(account => account.id)] };
}
async function sourceDigest(value: Source, users: number[]) {
  const db = await database();
  try {
    const [owned] = await db.execute<any[]>('SELECT id FROM activities WHERE id=? AND CAST(title AS BINARY)=CAST(? AS BINARY) AND CAST(description AS BINARY)=CAST(? AS BINARY)', [value.id, value.title, value.description]); expect(owned).toHaveLength(1);
    const queries: Array<[string, string, number[]]> = [
      ['activities', 'SELECT * FROM activities WHERE id=? ORDER BY id', [value.id]],
      ...['registrations', 'notifications', 'activity_audit_logs', 'activity_favorites'].map(table => [table, `SELECT * FROM ${table} WHERE activity_id=? ORDER BY id`, [value.id]] as [string, string, number[]]),
      ['users', `SELECT * FROM users WHERE id IN (${users.map(() => '?').join(',')}) ORDER BY id`, users],
      ['flyway_schema_history', 'SELECT * FROM flyway_schema_history ORDER BY installed_rank', []],
    ];
    const digests: Record<string, string> = {};
    for (const [table, sql, params] of queries) {
      const [rows] = await db.execute<any[]>(sql, params);
      const typed = rows.map(row => Object.entries(row).map(([key, value]) => [key, value === null ? ['null'] : Buffer.isBuffer(value) ? ['bytes', value.toString('hex')] : [typeof value, String(value)]]));
      digests[table] = createHash('sha256').update(JSON.stringify(typed)).digest('hex');
    }
    return digests;
  } finally { await db.end(); }
}
async function draft(page: Page, info: TestInfo) {
  const fixture = trackFixture(`复制新建 ${info.project.name} ${randomUUID().slice(0, 8)}`, '复制只生成独立新活动，不继承人员、状态或历史。');
  await title(page).fill(fixture.title); await page.getByLabel('活动介绍', { exact: true }).fill(fixture.description);
  await page.getByLabel('活动地点', { exact: true }).fill('复制后修改场地'); await choose(page, '运动户外');
  await page.getByRole('spinbutton', { name: '报名名额', exact: true }).fill('7');
  const day = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  await start(page).fill(`${day}T20:00`); await end(page).fill(`${day}T22:00`);
  return { fixture, startsAt: `${day}T12:00:00Z`, endsAt: `${day}T14:00:00Z` };
}
async function assertCreated(request: APIRequestContext, id: number, value: Awaited<ReturnType<typeof draft>>, original: Source) {
  expect(id).not.toBe(original.id);
  const response = await request.get(`/api/activities/${id}`); expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ id, title: value.fixture.title, description: value.fixture.description, location: '复制后修改场地', category: 'SPORTS', capacity: 7,
    startsAt: value.startsAt, endsAt: value.endsAt, registeredCount: 0, waitingCount: 0, registrationStatus: null, coverUrl: null, cancelled: false });
  const db = await database();
  try {
    const [[row]] = await db.execute<any[]>('SELECT cover_image,cover_hash,cancelled_at,cancelled_by,cancellation_reason,registered_count FROM activities WHERE id=?', [id]);
    expect(row).toEqual({ cover_image: null, cover_hash: null, cancelled_at: null, cancelled_by: null, cancellation_reason: null, registered_count: 0 });
    for (const table of ['registrations', 'notifications', 'activity_favorites']) {
      const [[count]] = await db.execute<any[]>(`SELECT COUNT(*) AS total FROM ${table} WHERE activity_id=?`, [id]); expect(Number(count.total)).toBe(0);
    }
    const [audit] = await db.execute<any[]>('SELECT action,changes_json FROM activity_audit_logs WHERE activity_id=? ORDER BY id', [id]);
    expect(audit).toHaveLength(1); expect(audit[0].action).toBe('CREATE');
    const changes = typeof audit[0].changes_json === 'string' ? JSON.parse(audit[0].changes_json) : audit[0].changes_json;
    expect(changes.map((change: { field: string }) => change.field)).toEqual(['title', 'description', 'location', 'startsAt', 'endsAt', 'capacity', 'category']);
    expect(changes.every((change: { before: unknown }) => change.before === null)).toBe(true);
  } finally { await db.end(); }
}

test('管理列表与详情复制四种状态，刷新直达及fresh GET只预填五字段', async ({ page, request }, info) => {
  let primary: unknown;
  try {
    await login(page);
    for (const state of ['future', 'ongoing', 'ended', 'cancelled'] as const) {
      let value = await source(request, info, state);
      await page.goto(`/admin/activities?keyword=${encodeURIComponent(value.title)}`);
      const row = page.locator(`[data-activity-id="${value.id}"]`); await expect(row).toBeVisible();
      const oldTitle = value.title;
      if (state === 'future') { value = await freshSource(request, value); await expect(row).toContainText(oldTitle); await expect(row).not.toContainText(value.title); }
      const read = page.waitForResponse(response => new URL(response.url()).pathname === `/api/activities/${value.id}` && response.request().method() === 'GET');
      await row.getByRole('link', { name: '复制活动', exact: true }).click(); expect((await read).status()).toBe(200);
      await expect(page).toHaveURL(new RegExp(`copyFrom=${value.id}$`)); await form(page, value);
      await page.reload(); await form(page, value);
      await page.goto(`/activities/${value.id}`); await expect(page.getByRole('heading', { name: value.title, exact: true })).toBeVisible();
      await page.getByRole('link', { name: '复制活动', exact: true }).click(); await form(page, value); await noOverflow(page);
    }
    await picture(page, info, 'copy-all-source-states');
  } catch (error) { primary = error; }
  finally { await finish(primary, [() => logoutApi(page.request), () => logoutApi(request)]); }
});

test('复制含封面报名候补取消签到通知收藏的来源只新建正常CREATE，七表源摘要不变且提交防重', async ({ page, request }, info) => {
  let primary: unknown, pending: Held | undefined;
  try {
    const rich = await richEndedSource(request, info), before = await sourceDigest(rich.value, rich.users);
    await login(page); await page.goto(copyPath(rich.value.id)); await form(page, rich.value);
    await publish(page).click(); await expect(page.getByText('请选择活动开始时间', { exact: true })).toBeVisible();
    const value = await draft(page, info);
    pending = await hold(page, '/api/admin/activities', 'POST', 201, { inspect: async response => {
      const activity = await response.json(); recordFixtureId(value.fixture.key, activity.id); await assertCreated(request, activity.id, value, rich.value);
    } });
    await publish(page).click(); await pending.ready; await expect(publish(page)).toHaveAttribute('aria-busy', 'true');
    await publish(page).click({ force: true }); expect(pending.count()).toBe(1);
    pending.release(); await pending.delivered(); await expect(page.getByRole('heading', { name: value.fixture.title, exact: true })).toBeVisible();
    expect(await sourceDigest(rich.value, rich.users)).toEqual(before);
    await picture(page, info, 'copy-created-independent');
  } catch (error) { primary = error; }
  finally { await finish(primary, [...(pending ? [pending.cleanup] : []), () => logoutApi(page.request), () => logoutApi(request)]); }
});

test('普通发布不读来源，非法与不存在来源不显示可提交草稿，网络失败可手动恢复且权限在外层', async ({ page, request }, info) => {
  let primary: unknown, reads = 0, fail = true;
  try {
    const value = await source(request, info); await login(page);
    page.on('request', request => { if (/^\/api\/activities\/\d+$/.test(new URL(request.url()).pathname)) reads++; });
    await page.goto(createPath); await ordinary(page); expect(reads).toBe(0);
    for (const query of ['0', '-1', '1.5', 'bad', `${value.id}&copyFrom=${value.id}`]) {
      await page.goto(`${createPath}?copyFrom=${query}`);
      await expect(page.getByText('复制来源参数无效，请使用唯一的正整数活动编号。', { exact: true })).toBeVisible();
      await expect(title(page)).toHaveCount(0); expect(reads).toBe(0);
    }
    await page.goto(copyPath(9007199254740991)); await expect(page.getByRole('button', { name: '重新加载', exact: true })).toBeVisible(); await expect(title(page)).toHaveCount(0);
    await page.getByRole('link', { name: '普通发布', exact: true }).click(); await ordinary(page);
    await page.route(`**/api/activities/${value.id}`, route => fail ? route.abort('failed') : route.continue());
    await page.goto(copyPath(value.id)); await expect(page.getByText('暂时无法连接服务，请检查网络后重试。', { exact: true })).toBeVisible(); await expect(title(page)).toHaveCount(0);
    fail = false; await page.getByRole('button', { name: '重新加载', exact: true }).click(); await form(page, value);
    await logout(page); reads = 0;
    await page.goto(`/activities/${value.id}`); await expect(page.getByRole('heading', { name: value.title, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '复制活动', exact: true })).toHaveCount(0); reads = 0;
    await page.goto(copyPath(value.id)); await expect(page).toHaveURL(/\/login$/); expect(reads).toBe(0);
    await loginForm(page, 'demo'); reads = 0; await page.goto(copyPath(value.id));
    await expect(page.getByText('此页面仅对活动组织者开放', { exact: true })).toBeVisible(); expect(reads).toBe(0);
    await page.goto(`/activities/${value.id}`); await expect(page.getByRole('link', { name: '复制活动', exact: true })).toHaveCount(0);
    await picture(page, info, 'copy-permission-boundary');
  } catch (error) { primary = error; }
  finally { await finish(primary, [() => page.unrouteAll({ behavior: 'wait' }), () => logoutApi(page.request), () => logoutApi(request)]); }
});

type Held = { ready: Promise<void>; release(): void; delivered(): Promise<void>; cleanup(): Promise<void>; count(): number };
async function hold(page: Page, path: string, method: string, status: number,
  options: { failure?: boolean; expiredCookie?: string; authError?: boolean; invalidEnd?: boolean; inspect?: (response: APIResponse) => Promise<void> } = {}): Promise<Held> {
  let release!: () => void, ready!: () => void, reject!: (error: unknown) => void, armed = true, released = false, count = 0;
  const gate = new Promise<void>(resolve => { release = () => { released = true; resolve(); }; });
  const started = new Promise<void>((resolve, failed) => { ready = resolve; reject = failed; });
  const jobs: Promise<{ error?: unknown }>[] = [], outcomes: Promise<{ failure?: string; status?: number }>[] = [];
  const pattern = `**${path}`;
  await page.route(pattern, route => {
    if (route.request().method() !== method) return route.continue();
    count++;
    // Strict Mode can replace an initial read; every read must remain held until release.
    // Mutations still hold only the first request, so the count exposes double submission.
    if (released || method !== 'GET' && !armed) return route.continue();
    armed = false;
    const target = route.request();
    outcomes.push(new Promise(resolve => {
      const clear = () => { page.off('requestfinished', finished); page.off('requestfailed', failed); };
      const finished = async (request: typeof target) => { if (request !== target) return; clear(); resolve({ status: (await request.response())?.status() }); };
      const failed = (request: typeof target) => { if (request !== target) return; clear(); resolve({ failure: request.failure()?.errorText }); };
      page.on('requestfinished', finished); page.on('requestfailed', failed);
    }));
    const job = (async () => {
      try {
        const headers = options.expiredCookie ? { ...target.headers(), cookie: options.expiredCookie } : undefined;
        // Public activity reads are anonymous when a cookie expires. This one explicit fault injection
        // obtains a genuine auth/me 401; it does not claim the public endpoint normally returns 401.
        const url = options.authError ? new URL('/api/auth/me', target.url()).href : undefined;
        const data = options.invalidEnd ? { ...target.postDataJSON(), endsAt: target.postDataJSON().startsAt } : undefined;
        let response: APIResponse;
        try { response = await route.fetch({ ...(headers ? { headers } : {}), ...(url ? { url } : {}), ...(data ? { postData: JSON.stringify(data) } : {}) }); }
        catch (error) {
          if (method === 'GET' && /ERR_ABORTED|cancel/i.test(target.failure()?.errorText ?? '')) return;
          throw error;
        }
        expect(response.status()).toBe(status); if (options.inspect) await options.inspect(response);
        ready(); await gate;
        try { if (options.failure) await route.abort('failed'); else await route.fulfill({ response }); }
        catch (error) { if (!target.failure()) throw error; }
      } catch (error) { reject(error); throw error; }
    })();
    jobs.push(job.then(() => ({}), error => ({ error }))); return job;
  });
  const delivered = async () => {
    const settled = await Promise.all(jobs); const errors = settled.flatMap(result => result.error === undefined ? [] : [result.error]);
    if (errors.length) throw new AggregateError(errors, 'A held genuine copy response failed.');
    for (const outcome of await Promise.all(outcomes)) {
      if (outcome.failure) expect(outcome.failure).toMatch(/ERR_ABORTED|ERR_FAILED|cancel/i);
      else { expect(options.failure).not.toBe(true); expect(outcome.status).toBe(status); }
    }
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  };
  return { ready: started, release, delivered, count: () => count,
    cleanup: async () => { release(); await finish(undefined, [delivered, () => page.unroute(pattern)]); } };
}
async function expiredCookie(request: APIRequestContext) {
  await loginApi(request); const cookie = (await request.storageState()).cookies.find(cookie => cookie.name === 'JSESSIONID'); expect(cookie).toBeTruthy();
  const header = `JSESSIONID=${cookie!.value}`; await logoutApi(request);
  expect((await request.get('/api/auth/me', { headers: { Cookie: header } })).status()).toBe(401); return header;
}

for (const destination of ['source', 'ordinary', 'same-account'] as const) for (const outcome of ['success', 'failure', '401'] as const) {
  test(`来源读取真实迟到${outcome}不污染${destination}的新状态与pending`, async ({ page, request }, info) => {
    let primary: unknown, pending: Held | undefined, nextPending: Held | undefined;
    try {
      const first = await source(request, info), second = await source(request, info);
      const expired = outcome === '401' ? await expiredCookie(request) : undefined;
      await login(page);
      pending = await hold(page, `/api/activities/${first.id}`, 'GET', outcome === '401' ? 401 : 200,
        { failure: outcome === 'failure', expiredCookie: expired, authError: outcome === '401' });
      await page.goto(copyPath(first.id)); await pending.ready; await expect(title(page)).toHaveCount(0);
      if (destination === 'source') {
        nextPending = await hold(page, `/api/activities/${second.id}`, 'GET', 200);
        await navigate(page, copyPath(second.id)); await nextPending.ready; await expect(title(page)).toHaveCount(0);
        pending.release(); await pending.delivered(); await expect(title(page)).toHaveCount(0);
        nextPending.release(); await nextPending.delivered(); await form(page, second);
      }
      else if (destination === 'ordinary') { await page.getByRole('link', { name: '普通发布', exact: true }).click(); await ordinary(page); }
      else {
        await logout(page); await page.getByRole('button', { name: '登录 / 体验', exact: true }).click(); await loginForm(page);
        await navigate(page, copyPath(second.id)); await form(page, second);
      }
      const draftTitle = `新的草稿 ${randomUUID().slice(0, 8)}`; await title(page).fill(draftTitle);
      pending.release(); await pending.delivered(); await expect(title(page)).toHaveValue(draftTitle); await expect(publish(page)).toBeEnabled();
      await expect(page.locator('.ant-alert-error')).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe(createPath);
      expect(new URL(page.url()).searchParams.get('copyFrom')).toBe(destination === 'ordinary' ? null : String(second.id));
      const me = await page.request.get('/api/auth/me'); expect(me.status()).toBe(200); expect((await me.json()).username).toBe('admin');
    } catch (error) { primary = error; }
    finally { await finish(primary, [...(pending ? [pending.cleanup] : []), ...(nextPending ? [nextPending.cleanup] : []), () => logoutApi(page.request), () => logoutApi(request)]); }
  });
}

for (const destination of ['source', 'same-account', 'other-account'] as const) for (const outcome of ['success', 'error'] as const) {
  test(`复制提交真实迟到${outcome}不导航或覆盖${destination}，成功记录可精确清理`, async ({ page, request }, info) => {
    let primary: unknown, pending: Held | undefined;
    try {
      const first = await source(request, info), second = await source(request, info);
      await login(page); await page.goto(copyPath(first.id)); await form(page, first);
      const value = await draft(page, info);
      pending = await hold(page, '/api/admin/activities', 'POST', outcome === 'success' ? 201 : 400,
        { invalidEnd: outcome === 'error', inspect: async response => {
          if (response.status() === 201) { const created = await response.json(); recordFixtureId(value.fixture.key, created.id); }
          else expect((await response.json()).code).toBe('VALIDATION_ERROR');
        } });
      await publish(page).click(); await pending.ready;
      if (destination === 'source') { await navigate(page, copyPath(second.id)); await form(page, second); }
      else {
        await logout(page); await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
        await loginForm(page, destination === 'same-account' ? 'admin' : 'demo');
        if (destination === 'same-account') { await navigate(page, copyPath(second.id)); await form(page, second); }
        else { await navigate(page, '/profile'); await expect(page.getByRole('heading', { name: '个人中心', exact: true })).toBeVisible(); }
      }
      const current = page.url();
      if (destination !== 'other-account') await title(page).fill('新页面继续编辑的草稿');
      pending.release(); await pending.delivered(); expect(page.url()).toBe(current);
      await expect(page.getByText('活动已发布', { exact: true })).toHaveCount(0); await expect(page.locator('.ant-alert-error')).toHaveCount(0);
      if (destination !== 'other-account') { await expect(title(page)).toHaveValue('新页面继续编辑的草稿'); await expect(publish(page)).toBeEnabled(); }
      const me = await page.request.get('/api/auth/me'); expect(me.status()).toBe(200);
      expect((await me.json()).username).toBe(destination === 'other-account' ? 'demo' : 'admin');
      const db = await database();
      try { const [rows] = await db.execute<any[]>('SELECT id FROM activities WHERE CAST(title AS BINARY)=CAST(? AS BINARY) AND CAST(description AS BINARY)=CAST(? AS BINARY)', [value.fixture.title, value.fixture.description]); expect(rows).toHaveLength(outcome === 'success' ? 1 : 0); }
      finally { await db.end(); }
    } catch (error) { primary = error; }
    finally { await finish(primary, [...(pending ? [pending.cleanup] : []), () => logoutApi(page.request), () => logoutApi(request)]); }
  });
}

test('旧复制提交的finally不能清除新来源正在提交的busy，两个真实新建均先登记ID', async ({ page, request }, info) => {
  let primary: unknown, old: Held | undefined, current: Held | undefined;
  try {
    const first = await source(request, info), second = await source(request, info);
    await login(page); await page.goto(copyPath(first.id)); await form(page, first);
    const firstDraft = await draft(page, info);
    old = await hold(page, '/api/admin/activities', 'POST', 201, { inspect: async response => {
      recordFixtureId(firstDraft.fixture.key, (await response.json()).id);
    } });
    await publish(page).click(); await old.ready;
    await navigate(page, copyPath(second.id)); await form(page, second);
    const nextDraft = await draft(page, info);
    current = await hold(page, '/api/admin/activities', 'POST', 201, { inspect: async response => {
      recordFixtureId(nextDraft.fixture.key, (await response.json()).id);
    } });
    await publish(page).click(); await current.ready; await expect(publish(page)).toHaveAttribute('aria-busy', 'true');
    old.release(); await old.delivered();
    await expect(page).toHaveURL(new RegExp(`copyFrom=${second.id}$`));
    await expect(title(page)).toHaveValue(nextDraft.fixture.title); await expect(publish(page)).toHaveAttribute('aria-busy', 'true');
    current.release(); await current.delivered();
    await expect(page.getByRole('heading', { name: nextDraft.fixture.title, exact: true })).toBeVisible();
    expect(current.count()).toBe(1);
  } catch (error) { primary = error; }
  finally { await finish(primary, [...(old ? [old.cleanup] : []), ...(current ? [current.cleanup] : []), () => logoutApi(page.request), () => logoutApi(request)]); }
});

test('普通发布真实201迟到时通过SPA概览导航离开，旧提交不得跳回新活动详情', async ({ page, request }, info) => {
  let primary: unknown, pending: Held | undefined, createdId: number | undefined;
  try {
    await login(page); await page.goto(createPath); await ordinary(page);
    const value = await draft(page, info);
    pending = await hold(page, '/api/admin/activities', 'POST', 201, { inspect: async response => {
      const created = await response.json(); createdId = created.id;
      recordFixtureId(value.fixture.key, created.id);
      expect(created).toMatchObject({ title: value.fixture.title, description: value.fixture.description,
        registeredCount: 0, waitingCount: 0, coverUrl: null });
    } });
    await publish(page).click(); await pending.ready; expect(Number.isSafeInteger(createdId)).toBe(true);
    let documentRequests = 0;
    page.on('request', request => { if (request.resourceType() === 'document') documentRequests++; });
    const menu = page.getByRole('button', { name: '打开导航', exact: true });
    if (await menu.isVisible()) await menu.click();
    const overview = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/overview' && response.status() === 200);
    await page.getByRole('link', { name: '概览', exact: true }).click(); await overview;
    await expect.poll(() => new URL(page.url()).pathname).toBe('/admin/dashboard');
    await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await expect.poll(() => new URL(page.url()).searchParams.get('to')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const canonicalUrl = page.url();
    expect(documentRequests).toBe(0);
    pending.release(); await pending.delivered();
    await expect(page).toHaveURL(canonicalUrl);
    await expect(page.getByRole('heading', { name: '概览', exact: true })).toBeVisible();
    await expect(page.getByText('活动已发布', { exact: true })).toHaveCount(0);
    expect(documentRequests).toBe(0);
    const persisted = await request.get(`/api/activities/${createdId}`); expect(persisted.status()).toBe(200);
    expect(await persisted.json()).toMatchObject({ id: createdId, title: value.fixture.title, description: value.fixture.description });
    await noOverflow(page);
  } catch (error) { primary = error; }
  finally { await finish(primary, [...(pending ? [pending.cleanup] : []), () => logoutApi(page.request)]); }
});
