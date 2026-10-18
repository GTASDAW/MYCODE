import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { trackFixture, recordFixtureId, trackAccount, recordAccountId, databaseConfig, verifyDatabase } from '../scripts/e2e-cleanup.mjs';

// The form must interpret its wall clock input as Beijing time even in another browser timezone.
test.use({ timezoneId: 'America/New_York', trace: 'off' });

async function write(request: APIRequestContext, path: string, data?: unknown) {
  const csrf = await (await request.get('/api/auth/csrf')).json();
  return request.post(path, { headers: { [csrf.headerName]: csrf.token }, data });
}
async function admin(request: APIRequestContext) {
  const csrf = await (await request.get('/api/auth/csrf')).json();
  expect((await request.post('/api/auth/login', { headers: { [csrf.headerName]: csrf.token },
    form: { username: 'admin', password: 'Admin123!' } })).status()).toBe(200);
  return (await request.get('/api/auth/me')).json();
}
async function login(page: Page, username = 'admin', password = 'Admin123!') {
  await page.goto('/login');
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: /账号菜单/ })).toBeVisible();
}
const utc = (value: string) => value.replace('T', ' ').replace('Z', '');
async function seeded(request: APIRequestContext, info: TestInfo, startHours: number, endHours: number | null,
                      options: { cancelled?: boolean; user?: { id: number; username: string; displayName: string } } = {}) {
  const actor = await admin(request), config = databaseConfig();
  const db = await mysql.createConnection(config);
  const fixture = trackFixture(`结束时间 ${info.project.name} ${randomUUID().slice(0, 8)}`, '本轮独立活动用于状态、日历及结束后签到回归，不修改既有活动。');
  const start = new Date(Date.now() + startHours * 3600000).toISOString();
  const end = endHours === null ? null : new Date(Date.now() + endHours * 3600000).toISOString();
  try {
    const manifest = JSON.parse(readFileSync(process.env.E2E_RUN_MANIFEST!, 'utf8'));
    await verifyDatabase(db, config, manifest.target);
    await db.beginTransaction();
    const [actors] = await db.execute<any[]>("SELECT id FROM users WHERE id=? AND username='admin' AND role='ADMIN' FOR UPDATE", [actor.id]);
    expect(actors).toHaveLength(1);
    if (options.user) {
      const [users] = await db.execute<any[]>("SELECT id FROM users WHERE id=? AND CAST(username AS BINARY)=CAST(? AS BINARY) AND CAST(display_name AS BINARY)=CAST(? AS BINARY) AND role='USER' FOR UPDATE",
        [options.user.id, options.user.username, options.user.displayName]);
      expect(users).toHaveLength(1);
    }
    const [insert] = await db.execute<mysql.ResultSetHeader>(
      'INSERT INTO activities(title,description,location,starts_at,ends_at,capacity,registered_count,created_by,cancelled_at,cancelled_by,cancellation_reason) VALUES(?,?,?,?,?,2,?,?,?,?,?)',
      [fixture.title, fixture.description, '结束时间独立场地', utc(start), end ? utc(end) : null,
        options.user ? 1 : 0, actor.id, options.cancelled ? utc(new Date(Date.now() - 4 * 3600000).toISOString()) : null,
        options.cancelled ? actor.id : null, options.cancelled ? '结束时间取消优先验证' : null]);
    if (options.user) await db.execute("INSERT INTO registrations(activity_id,user_id,status) VALUES(?,?,'ACTIVE')", [insert.insertId, options.user.id]);
    await db.commit();
    recordFixtureId(fixture.key, insert.insertId);
    const response = await request.get(`/api/activities/${insert.insertId}`);
    expect(response.status()).toBe(200);
    const activity = await response.json();
    expect(Date.parse(activity.startsAt)).toBe(Date.parse(start));
    if (end === null) expect(activity.endsAt).toBeNull();
    else expect(Date.parse(activity.endsAt)).toBe(Date.parse(end));
    return activity;
  } catch (error) { await db.rollback(); throw error; } finally { await db.end(); }
}
async function detail(page: Page, activity: { id: number; title: string }) {
  await page.goto(`/activities/${activity.id}`);
  await expect(page.getByRole('heading', { name: activity.title, exact: true })).toBeVisible();
}
async function fits(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function shot(page: Page, info: TestInfo, name: string) {
  await fits(page);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('创建校验结束边界、浏览器异地时区仍按北京时间提交UTC，编辑只读且刷新保留', async ({ page }, info) => {
  await login(page);
  const fixture = trackFixture(`时间表单 ${info.project.name} ${randomUUID().slice(0, 8)}`, '北京时间结束时间表单验证。');
  await page.goto('/admin/activities/new');
  await page.getByLabel('活动标题', { exact: true }).fill(fixture.title);
  await page.getByLabel('活动介绍', { exact: true }).fill(fixture.description);
  await page.getByLabel('活动地点', { exact: true }).fill('跨时区场地');
  const day = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
  const start = `${day}T20:00`, end = `${day}T22:30`;
  await page.getByLabel('开始时间（北京时间）', { exact: true }).fill(start);
  await page.getByLabel('结束时间（北京时间，可选）', { exact: true }).fill(start);
  await page.getByRole('button', { name: '发布活动', exact: true }).click();
  await expect(page.getByText('结束时间必须晚于开始时间', { exact: true })).toBeVisible();
  await page.getByLabel('结束时间（北京时间，可选）', { exact: true }).fill(`${day}T19:59`);
  await page.getByRole('button', { name: '发布活动', exact: true }).click();
  await expect(page.getByText('结束时间必须晚于开始时间', { exact: true })).toBeVisible();
  await page.getByLabel('结束时间（北京时间，可选）', { exact: true }).fill(end);
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/admin/activities');
  await page.getByRole('button', { name: '发布活动', exact: true }).click();
  const response = await saved; expect(response.status()).toBe(201);
  const activity = await response.json(); recordFixtureId(fixture.key, activity.id);
  expect(activity).toMatchObject({ startsAt: `${day}T12:00:00Z`, endsAt: `${day}T14:30:00Z` });
  await expect(page.getByRole('heading', { name: fixture.title, exact: true })).toBeVisible();
  await expect(page.locator('.detail-content')).toContainText('22:30');
  await page.reload(); await expect(page.locator('.detail-content')).toContainText('22:30');
  await shot(page, info, 'created-end-time');
  await page.goto(`/admin/activities/${activity.id}/edit`);
  await expect(page.getByRole('heading', { name: '编辑活动', exact: true })).toBeVisible();
  const fixedEnd = page.getByLabel('结束时间（北京时间）', { exact: true });
  await expect(fixedEnd).toHaveAttribute('readonly', '');
  await expect(fixedEnd).toHaveValue(/22:30/);
  await fits(page);
});

test('创建不填结束时间兼容旧请求，详情与日历保持未提供', async ({ page, request }, info) => {
  await admin(request);
  const fixture = trackFixture(`无结束 ${info.project.name} ${randomUUID().slice(0, 8)}`, '旧创建请求不传 endsAt。');
  const response = await write(request, '/api/admin/activities', { title: fixture.title, description: fixture.description,
    location: '旧接口兼容', startsAt: new Date(Date.now() + 86400000).toISOString(), capacity: 2 });
  expect(response.status()).toBe(201); const activity = await response.json(); recordFixtureId(fixture.key, activity.id);
  expect(activity.endsAt).toBeNull();
  await detail(page, activity);
  await expect(page.getByText('未提供', { exact: true })).toBeVisible();
  const saved = page.waitForEvent('download'); await page.getByRole('button', { name: '下载日历', exact: true }).click();
  const bytes = readFileSync((await (await saved).path())!); expect(bytes.toString('utf8')).not.toMatch(/DTEND:|DURATION:/);
  await fits(page);
});

test('列表详情显示进行中、结束与历史未知，取消优先；日历包含精确UTC结束', async ({ page, request }, info) => {
  const cases = [
    [await seeded(request, info, -2, 1), '进行中'],
    [await seeded(request, info, -3, -1), '已结束'],
    [await seeded(request, info, -3, null), '已开始'],
    [await seeded(request, info, -3, -1, { cancelled: true }), '活动已取消'],
  ] as const;
  for (const [activity, label] of cases) {
    await page.goto(`/activities?keyword=${encodeURIComponent(activity.title)}`);
    const card = page.locator(`[data-activity-id="${activity.id}"]`);
    await expect(card.locator('.ant-tag').filter({ hasText: new RegExp(`^${label}$`) })).toBeVisible();
    if (activity.endsAt === null) await expect(card).toContainText('未提供');
    await fits(page); await detail(page, activity);
    await expect(page.locator('.detail-content .ant-tag').filter({ hasText: new RegExp(`^${label}$`) })).toBeVisible();
    if (activity.endsAt === null) await expect(page.getByText('未提供', { exact: true })).toBeVisible();
    if (activity.cancelled) { await expect(page.getByRole('button', { name: '下载日历', exact: true })).toBeDisabled(); continue; }
    const saved = page.waitForEvent('download'); await page.getByRole('button', { name: '下载日历', exact: true }).click();
    const text = readFileSync((await (await saved).path())!, 'utf8').replace(/\r\n /g, '');
    if (activity.endsAt) expect(text).toContain(`DTEND:${activity.endsAt.slice(0, 19).replace(/[-:]/g, '')}Z\r\n`);
    else expect(text).not.toContain('DTEND:');
    await shot(page, info, `state-${label}`);
  }
});

test('停留在列表和详情跨越精确开始结束边界时自动更新，无需网络刷新', async ({ page, request }, info) => {
  const activity = await seeded(request, info, 24, 25);
  const start = Date.parse(activity.startsAt), end = Date.parse(activity.endsAt);
  await page.clock.install({ time: start - 1000 });
  await page.goto(`/activities?keyword=${encodeURIComponent(activity.title)}`);
  const card = page.locator(`[data-activity-id="${activity.id}"]`);
  await expect(card.getByText('未开始', { exact: true })).toBeVisible();
  await page.clock.fastForward(1000);
  await expect(card.getByText('进行中', { exact: true })).toBeVisible();
  await page.clock.fastForward(end - start);
  await expect(card.getByText('已结束', { exact: true })).toBeVisible();
  await page.clock.setSystemTime(start - 1000);
  await detail(page, activity);
  await expect(page.locator('.detail-content').getByText('未开始', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '登录后报名', exact: true })).toBeVisible();
  await page.clock.fastForward(1000);
  await expect(page.locator('.detail-content').getByText('进行中', { exact: true })).toBeVisible();
  await expect(page.locator('.registration-panel').getByRole('button', { name: '进行中', exact: true })).toBeDisabled();
  await page.clock.fastForward(end - start);
  await expect(page.locator('.detail-content').getByText('已结束', { exact: true })).toBeVisible();
  await fits(page);
});

test('活动结束后管理员仍可补录签到，普通用户无管理权限', async ({ page, request }, info) => {
  await admin(request);
  const intent = trackAccount();
  const registered = await write(request, '/api/auth/register', { username: intent.username, password: 'Demo123!', displayName: intent.displayName });
  expect(registered.status()).toBe(201); const user = await registered.json(); recordAccountId(intent.key, user.id);
  const activity = await seeded(request, info, -3, -1, { user });
  await login(page);
  await page.goto(`/admin/activities/${activity.id}/registrations`);
  const roster = await (await page.request.get(`/api/admin/activities/${activity.id}/registrations`)).json();
  expect(roster.items).toHaveLength(1); const registration = roster.items[0];
  const button = page.getByRole('button', { name: `确认报名 ${registration.id} 签到`, exact: true });
  await expect(button).toBeEnabled(); await button.click();
  const modal = page.getByRole('dialog', { name: '确认签到', exact: true });
  const checked = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/registrations/${registration.id}/check-in`));
  await modal.getByRole('button', { name: '确认签到', exact: true }).click();
  expect((await checked).status()).toBe(200); await expect(modal).toHaveCount(0);
  const after = await (await page.request.get(`/api/admin/activities/${activity.id}/registrations`)).json();
  expect(after.items[0].checkedInAt).not.toBeNull(); expect(after.activity.endsAt).toBe(activity.endsAt);
  await shot(page, info, 'ended-check-in');
  await page.getByRole('button', { name: /账号菜单/ }).click();
  await page.getByRole('menuitem', { name: /退出登录/ }).click();
  await login(page, user.username, 'Demo123!');
  await page.goto('/admin/activities/new');
  await expect(page.getByLabel('结束时间（北京时间，可选）', { exact: true })).toHaveCount(0);
  expect((await page.request.get(`/api/admin/activities/${activity.id}/registrations`)).status()).toBe(403);
});
