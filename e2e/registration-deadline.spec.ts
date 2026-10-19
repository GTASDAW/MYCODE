import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { databaseConfig, verifyDatabase, trackFixture, recordFixtureId, trackAccount, recordAccountId } from '../scripts/e2e-cleanup.mjs';

test.use({ timezoneId: 'America/New_York', trace: 'off' });
const deadline = (page: Page) => page.getByLabel('报名截止时间（北京时间，可选）', { exact: true });
const publish = (page: Page) => page.getByRole('button', { name: '发布活动', exact: true });
const utc = (date: string) => date.replace('T', ' ').replace('Z', '');
async function write(request: APIRequestContext, path: string, data?: unknown, method = 'POST') {
  const response = await request.get('/api/auth/csrf'); expect(response.status()).toBe(200);
  const token = await response.json();
  return request.fetch(path, { method, headers: { [token.headerName]: token.token }, data });
}
async function loginApi(request: APIRequestContext, username = 'admin') {
  const token = await (await request.get('/api/auth/csrf')).json();
  expect((await request.post('/api/auth/login', { headers: { [token.headerName]: token.token },
    form: { username, password: username === 'admin' ? 'Admin123!' : 'Demo123!' } })).status()).toBe(200);
}
async function login(page: Page, username = 'admin') {
  await page.goto('/login');
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(username === 'admin' ? 'Admin123!' : 'Demo123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: /账号菜单/ })).toBeVisible();
}
async function database() {
  const config = databaseConfig(), db = await mysql.createConnection({ ...config, timezone: 'Z', dateStrings: true });
  try { await verifyDatabase(db, config, JSON.parse(readFileSync(process.env.E2E_RUN_MANIFEST!, 'utf8')).target); }
  catch (error) { await db.end(); throw error; }
  return db;
}
async function create(request: APIRequestContext, info: TestInfo, hours: number | null = 24, capacity = 2) {
  await loginApi(request);
  const fixture = trackFixture(`报名截止 ${info.project.name} ${randomUUID().slice(0, 8)}`, '报名截止专项仅操作本轮独立活动。');
  const body = { title: fixture.title, description: fixture.description, location: '报名截止验证会场', category: 'SPORTS', capacity,
    startsAt: new Date(Date.now() + 48 * 3600000).toISOString(), endsAt: new Date(Date.now() + 50 * 3600000).toISOString(),
    ...(hours === null ? {} : { registrationDeadline: new Date(Date.now() + Math.max(hours, 1) * 3600000).toISOString() }) };
  const response = await write(request, '/api/admin/activities', body); expect(response.status()).toBe(201);
  const activity = await response.json(); recordFixtureId(fixture.key, activity.id);
  if (hours !== null && hours < 0) await changeDeadline(activity, new Date(Date.now() + hours * 3600000).toISOString());
  return { ...await (await request.get(`/api/activities/${activity.id}`)).json(), fixture };
}
async function changeDeadline(activity: { id: number; title: string; description: string }, value: string) {
  const db = await database();
  try {
    await db.beginTransaction();
    const [owned] = await db.execute<any[]>('SELECT id FROM activities WHERE id=? AND CAST(title AS BINARY)=CAST(? AS BINARY) AND CAST(description AS BINARY)=CAST(? AS BINARY) FOR UPDATE',
      [activity.id, activity.title, activity.description]); expect(owned).toHaveLength(1);
    expect((await db.execute<mysql.ResultSetHeader>('UPDATE activities SET registration_deadline=? WHERE id=?', [utc(value), activity.id]))[0].affectedRows).toBe(1);
    await db.commit();
  } catch (error) { await db.rollback(); throw error; } finally { await db.end(); }
}
async function detail(page: Page, activity: { id: number; title: string }) {
  await page.goto(`/activities/${activity.id}`);
  await expect(page.getByRole('heading', { name: activity.title, exact: true })).toBeVisible();
}
async function picture(page: Page, info: TestInfo, name: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const path = info.outputPath(`${name}.png`); await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('截止表单校验北京时间UTC、直达刷新、固定编辑与复制清空', async ({ page }, info) => {
  await login(page); await page.goto('/admin/activities/new');
  const fixture = trackFixture(`截止表单 ${info.project.name} ${randomUUID().slice(0, 8)}`, '报名截止北京时间表单。');
  await page.getByLabel('活动标题', { exact: true }).fill(fixture.title);
  await page.getByLabel('活动介绍', { exact: true }).fill(fixture.description);
  await page.getByLabel('活动地点', { exact: true }).fill('北京时间截止场地');
  const day = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
  await page.getByLabel('开始时间（北京时间）', { exact: true }).fill(`${day}T20:00`);
  let creates = 0; page.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/admin/activities') creates++; });
  await deadline(page).fill('2000-01-01T10:00'); await publish(page).click();
  await expect(page.getByText('报名截止时间必须晚于当前时间', { exact: true })).toBeVisible();
  for (const time of ['20:00', '20:01']) {
    await deadline(page).fill(`${day}T${time}`); await publish(page).click();
    await expect(page.getByText('报名截止时间必须早于开始时间', { exact: true })).toBeVisible();
  }
  expect(creates).toBe(0);
  await deadline(page).fill(`${day}T18:30`);
  const saved = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/admin/activities');
  await publish(page).click(); const response = await saved; expect(response.status()).toBe(201);
  const activity = await response.json(); recordFixtureId(fixture.key, activity.id);
  expect(activity).toMatchObject({ startsAt: `${day}T12:00:00Z`, registrationDeadline: `${day}T10:30:00Z`, endsAt: null, registrationClosed: false });
  await expect(page.getByRole('heading', { name: fixture.title, exact: true })).toBeVisible();
  await expect(page.locator('.detail-content')).toContainText('18:30');
  await page.reload(); await expect(page.locator('.detail-content')).toContainText('18:30');
  await page.goto(`/admin/activities/${activity.id}/edit`);
  await expect(page.getByLabel('报名截止时间（北京时间）', { exact: true })).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('报名截止时间（北京时间）', { exact: true })).toHaveValue(/18:30/);
  await page.goto(`/admin/activities/new?copyFrom=${activity.id}`);
  await expect(page.getByLabel('活动标题', { exact: true })).toHaveValue(fixture.title);
  await expect(deadline(page)).toHaveValue('');
  await expect(page.getByLabel('开始时间（北京时间）', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('结束时间（北京时间，可选）', { exact: true })).toHaveValue('');
  await picture(page, info, 'deadline-copy-cleared');
});

test('截止状态独立展示、已有筛选真实查询、错误恢复和旧请求兼容', async ({ page, request }, info) => {
  const closed = await create(request, info, -1), legacy = await create(request, info, null);
  expect(closed).toMatchObject({ closed: false, registrationClosed: true });
  expect(legacy).toMatchObject({ registrationDeadline: null, registrationClosed: false });
  await page.goto(`/activities?keyword=${encodeURIComponent(closed.title)}`);
  const card = page.locator(`[data-activity-id="${closed.id}"]`);
  await expect(card.getByText('未开始', { exact: true })).toBeVisible();
  await expect(card.getByText('报名已截止', { exact: true })).toBeVisible();
  for (const status of ['OPEN', 'FULL', 'UPCOMING']) {
    const publicPage = await (await request.get(`/api/activities/search?keyword=${encodeURIComponent(closed.title)}&status=${status}`)).json();
    const adminPage = await (await request.get(`/api/admin/activities?keyword=${encodeURIComponent(closed.title)}&status=${status}`)).json();
    expect(publicPage.total).toBe(status === 'UPCOMING' ? 1 : 0); expect(adminPage.total).toBe(status === 'UPCOMING' ? 1 : 0);
    expect(publicPage.summary).toMatchObject({ upcomingActivities: 0, availableSeats: 0 });
  }
  await detail(page, closed);
  await expect(page.locator('.registration-panel').getByRole('button', { name: '报名已截止', exact: true })).toBeDisabled();
  await login(page); await page.goto(`/admin/activities?keyword=${encodeURIComponent(closed.title)}`);
  await expect(page.locator(`[data-activity-id="${closed.id}"]`).getByText('报名已截止', { exact: true })).toBeVisible();
  await detail(page, closed);
  await expect(page.getByRole('link', { name: '编辑活动', exact: true })).toBeVisible();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '下载日历', exact: true }).click();
  const text = readFileSync((await (await download).path())!, 'utf8').replace(/\r\n /g, '');
  expect(text).toContain(`DTSTART:${closed.startsAt.slice(0, 19).replace(/[-:]/g, '')}Z`);
  expect(text).toContain(`DTEND:${closed.endsAt.slice(0, 19).replace(/[-:]/g, '')}Z`);
  expect(text).not.toMatch(/REGISTRATION|DEADLINE/);
  let fail = true; await page.route(`**/api/activities/${legacy.id}`, r => fail ? r.abort('failed') : r.continue());
  await page.goto(`/activities/${legacy.id}`);
  await expect(page.getByRole('button', { name: '重新加载', exact: true })).toBeVisible();
  fail = false; await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.locator('.detail-content')).toContainText('活动开始时');
  await expect(page.getByRole('button', { name: '立即报名', exact: true })).toBeEnabled();
  await page.unrouteAll({ behavior: 'wait' }); await picture(page, info, 'deadline-legacy-default');
});

test('截止后拒绝报名重报和候补，但允许取消并FIFO递补且没有多余通知', async ({ page, request }, info) => {
  const activity = await create(request, info, 24, 1);
  const accounts: Array<{ id: number; username: string }> = [];
  for (let index = 0; index < 3; index++) {
    const intent = trackAccount(); const result = await write(request, '/api/auth/register', { username: intent.username, displayName: intent.displayName, password: 'Demo123!' });
    expect(result.status()).toBe(201); const account = await result.json(); recordAccountId(intent.key, account.id); accounts.push(account);
    await loginApi(request, account.username);
    const joined = await write(request, `/api/activities/${activity.id}/registration`);
    expect(joined.status()).toBe(200); expect((await joined.json()).registrationStatus).toBe(index === 0 ? 'ACTIVE' : 'WAITING');
  }
  await changeDeadline(activity, new Date(Date.now() - 60000).toISOString());
  await loginApi(request, accounts[0].username);
  const rejected = await write(request, `/api/activities/${activity.id}/registration`);
  expect(rejected.status()).toBe(409); expect((await rejected.json()).code).toBe('REGISTRATION_CLOSED');
  await login(page, accounts[0].username); await detail(page, activity);
  await expect(page.getByRole('button', { name: '取消报名', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '取消报名', exact: true }).click();
  const cancelled = page.waitForResponse(r => r.request().method() === 'DELETE' && new URL(r.url()).pathname === `/api/activities/${activity.id}/registration`);
  await page.getByRole('button', { name: '确认取消', exact: true }).click(); expect((await cancelled).status()).toBe(200);
  await expect(page.locator('.registration-panel').getByRole('button', { name: '报名已截止', exact: true })).toBeDisabled();
  const rejoin = await write(request, `/api/activities/${activity.id}/registration`); expect(rejoin.status()).toBe(409);
  await loginApi(request, accounts[2].username);
  expect((await write(request, `/api/activities/${activity.id}/registration`, undefined, 'DELETE')).status()).toBe(200);
  await loginApi(request, 'demo');
  const newcomer = await write(request, `/api/activities/${activity.id}/registration`); expect(newcomer.status()).toBe(409);
  expect((await newcomer.json()).code).toBe('REGISTRATION_CLOSED');
  const db = await database();
  try {
    const [rows] = await db.execute<any[]>('SELECT user_id,status FROM registrations WHERE activity_id=? ORDER BY id', [activity.id]);
    expect(rows.map(row => [row.user_id, row.status])).toEqual([[accounts[0].id, 'CANCELLED'], [accounts[1].id, 'ACTIVE'], [accounts[2].id, 'CANCELLED']]);
    const [[counts]] = await db.execute<any[]>('SELECT registered_count,(SELECT COUNT(*) FROM registrations WHERE activity_id=? AND status=\'ACTIVE\') AS active FROM activities WHERE id=?', [activity.id, activity.id]);
    expect(counts).toMatchObject({ registered_count: 1, active: 1 });
    const [notifications] = await db.execute<any[]>('SELECT user_id,type FROM notifications WHERE activity_id=? ORDER BY id', [activity.id]);
    expect(notifications).toEqual([{ user_id: accounts[1].id, type: 'PROMOTED' }]);
  } finally { await db.end(); }
  await picture(page, info, 'deadline-cancel-still-allowed');
});

test('截止前后自动更新报名状态不轮询，迟到的客户端不能绕过服务端截止', async ({ page, request }, info) => {
  const activity = await create(request, info, 24);
  await page.clock.install({ time: Date.parse(activity.registrationDeadline) - 3600000 });
  await page.goto(`/activities?keyword=${encodeURIComponent(activity.title)}`);
  const card = page.locator(`[data-activity-id="${activity.id}"]`);
  await expect(card.getByText('未开始', { exact: true })).toBeVisible();
  await expect(card.getByText('报名已截止', { exact: true })).toHaveCount(0);
  await page.clock.setSystemTime(Date.parse(activity.registrationDeadline) - 1000);
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  let reads = 0; page.on('request', r => { if (r.method() === 'GET' && new URL(r.url()).pathname.startsWith('/api/activities')) reads++; });
  await page.clock.fastForward(1000);
  await expect(card.getByText('报名已截止', { exact: true })).toBeVisible(); expect(reads).toBe(0);
  await detail(page, activity);
  await expect(page.locator('.registration-panel').getByRole('button', { name: '报名已截止', exact: true })).toBeDisabled();
  await page.clock.setSystemTime(Date.parse(activity.registrationDeadline) - 3600000);
  await login(page, 'demo'); await detail(page, activity);
  await expect(page.getByRole('button', { name: '立即报名', exact: true })).toBeEnabled();
  await changeDeadline(activity, new Date(Date.now() - 60000).toISOString());
  const denied = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/activities/${activity.id}/registration`);
  await page.getByRole('button', { name: '立即报名', exact: true }).click(); expect((await denied).status()).toBe(409);
  await expect(page.locator('.action-error')).toContainText('报名已截止');
  await expect(page.locator('.registration-panel').getByRole('button', { name: '报名已截止', exact: true })).toBeDisabled();
  expect((await page.request.get('/api/auth/me')).status()).toBe(200);
  const actual = await (await request.get(`/api/activities/${activity.id}`)).json(); expect(actual.registeredCount).toBe(0);
  await picture(page, info, 'deadline-stale-client-rejected');
});
