import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { databaseConfig, verifyDatabase, trackFixture, recordFixtureId } from '../scripts/e2e-cleanup.mjs';

test.use({ trace: 'off', timezoneId: 'America/New_York' });
type Surface = 'public' | 'admin';
type Query = { keyword: string; status: string; category: string; page: number; pageSize: number };
type Fixture = { id: number; title: string; description: string; startsAt: string; endsAt: string | null };
const endpoint = (surface: Surface) => surface === 'public' ? '/api/activities/search' : '/api/admin/activities';
const path = (surface: Surface, query: Query) => `${surface === 'public' ? '/activities' : '/admin/activities'}?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`;
const utc = (value: string) => value.replace('T', ' ').replace('Z', '');

function resultAfter(page: Page, surface: Surface, query: Query) {
  return page.waitForEvent('requestfinished', { predicate: request => {
    const url = new URL(request.url());
    return request.method() === 'GET' && url.pathname === endpoint(surface)
      && [...new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))]
        .every(([key, value]) => (url.searchParams.get(key) ?? (key === 'category' ? 'ALL' : '')) === value);
  } }).then(async request => {
    const response = (await request.response())!; expect(response.status()).toBe(200);
    return response.json();
  });
}
async function open(page: Page, surface: Surface, query: Query) {
  const loaded = resultAfter(page, surface, query); await page.goto(path(surface, query)); return loaded;
}
async function choose(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ has: page.getByText(value, { exact: true }) }).click();
  await expect(page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')).toHaveCount(0);
}
async function login(page: Page, username = 'admin') {
  await page.goto('/login'); await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(username === 'admin' ? 'Admin123!' : 'Demo123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: /账号菜单/ })).toBeVisible();
}
async function fixtures(request: APIRequestContext, info: TestInfo) {
  const csrf = await (await request.get('/api/auth/csrf')).json();
  expect((await request.post('/api/auth/login', { headers: { [csrf.headerName]: csrf.token },
    form: { username: 'admin', password: 'Admin123!' } })).status()).toBe(200);
  const actor = await (await request.get('/api/auth/me')).json(); expect(actor.role).toBe('ADMIN');
  const keyword = `时间筛选%_ ${info.project.name} ${randomUUID().slice(0, 8)}`;
  const now = Date.now(), ongoing: Fixture[] = [], ended: Fixture[] = [];
  const cases = [
    ...Array.from({ length: 3 }, (_, index) => ({ kind: 'ongoing', label: `进行 ${index}`, start: -1, end: 1, category: 'TECHNOLOGY', cancelled: false })),
    ...Array.from({ length: 3 }, (_, index) => ({ kind: 'ended', label: `结束 ${index}`, start: -3, end: -2, category: 'TECHNOLOGY', cancelled: false })),
    { kind: 'legacy', label: '未知结束', start: -2, end: null, category: 'TECHNOLOGY', cancelled: false },
    { kind: 'future', label: '未来', start: 1, end: 2, category: 'TECHNOLOGY', cancelled: false },
    { kind: 'cancelled', label: '取消进行', start: -1, end: 1, category: 'TECHNOLOGY', cancelled: true },
    { kind: 'cancelled', label: '取消结束', start: -3, end: -2, category: 'TECHNOLOGY', cancelled: true },
    { kind: 'other', label: '其他分类', start: -1, end: 1, category: 'OTHER', cancelled: false },
    { kind: 'trap', label: '字面匹配陷阱', start: -1, end: 1, category: 'TECHNOLOGY', cancelled: false },
  ];
  const declared = cases.map(item => ({ ...item, intent: trackFixture(`${item.kind === 'trap' ? keyword.replace('%_', 'ZZ') : keyword} ${item.label}`,
    '独立归属的活动状态筛选样本，验证时间、历史空值、取消及分页，不修改已有活动。') }));
  const config = databaseConfig(), db = await mysql.createConnection(config);
  let legacy!: Fixture;
  try {
    await verifyDatabase(db, config, JSON.parse(readFileSync(process.env.E2E_RUN_MANIFEST!, 'utf8')).target);
    await db.beginTransaction();
    const [actors] = await db.execute<any[]>("SELECT id FROM users WHERE id=? AND username='admin' AND role='ADMIN' FOR UPDATE", [actor.id]); expect(actors).toHaveLength(1);
    const inserted: { key: string; activity: Fixture; kind: string }[] = [];
    for (const item of declared) {
      const startsAt = new Date(now + item.start * 3600000).toISOString();
      const endsAt = item.end === null ? null : new Date(now + item.end * 3600000).toISOString();
      const [row] = await db.execute<mysql.ResultSetHeader>(
        'INSERT INTO activities(title,description,location,starts_at,ends_at,capacity,registered_count,created_by,category,cancelled_at,cancelled_by,cancellation_reason) VALUES(?,?,?,?,?,2,0,?,?,?,?,?)',
        [item.intent.title, item.intent.description, '状态筛选独立场地', utc(startsAt), endsAt ? utc(endsAt) : null, actor.id, item.category,
          item.cancelled ? utc(new Date(now - 4 * 3600000).toISOString()) : null, item.cancelled ? actor.id : null, item.cancelled ? '筛选取消优先验证' : null]);
      inserted.push({ key: item.intent.key, activity: { id: row.insertId, title: item.intent.title, description: item.intent.description, startsAt, endsAt }, kind: item.kind });
    }
    await db.commit();
    for (const item of inserted) {
      recordFixtureId(item.key, item.activity.id);
      if (item.kind === 'ongoing') ongoing.push(item.activity);
      if (item.kind === 'ended') ended.push(item.activity);
      if (item.kind === 'legacy') legacy = item.activity;
    }
  } catch (error) { await db.rollback(); throw error; } finally { await db.end(); }
  return { keyword, ongoing, ended, legacy };
}
async function assertList(page: Page, surface: Surface, result: any, ids: number[], total: number) {
  expect(result.total).toBe(total); expect(result.items.map((item: any) => item.id)).toEqual(ids);
  await expect.poll(async () => (await page.locator('[data-activity-id]').evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-activity-id')))))).toEqual(ids);
  if (surface === 'public') {
    expect(result.summary).toEqual({ upcomingActivities: 0, availableSeats: 0 });
    await expect(page.getByTestId('discovery-upcomingActivities')).toContainText('0');
    await expect(page.getByTestId('discovery-availableSeats')).toContainText('0');
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function expireOwnedFixture(activity: Fixture) {
  const config = databaseConfig(), db = await mysql.createConnection(config);
  try {
    await verifyDatabase(db, config, JSON.parse(readFileSync(process.env.E2E_RUN_MANIFEST!, 'utf8')).target);
    await db.beginTransaction();
    const [rows] = await db.execute<any[]>('SELECT id FROM activities WHERE id=? AND CAST(title AS BINARY)=CAST(? AS BINARY) AND CAST(description AS BINARY)=CAST(? AS BINARY) FOR UPDATE',
      [activity.id, activity.title, activity.description]); expect(rows).toHaveLength(1);
    // Only this declared fixture changes: model a completed boundary between two query snapshots.
    expect((await db.execute<mysql.ResultSetHeader>('UPDATE activities SET ends_at=? WHERE id=?',
      [utc(new Date(Date.now() - 60000).toISOString()), activity.id]))[0].affectedRows).toBe(1);
    await db.commit();
  } catch (error) { await db.rollback(); throw error; } finally { await db.end(); }
}

for (const surface of ['public', 'admin'] as const) {
  test(`${surface} 新筛选保留分类分页与历史导航、兼容旧已开始，空结果和网络失败可恢复`, async ({ page, request }, info) => {
    const data = await fixtures(request, info);
    if (surface === 'admin') await login(page);
    let query: Query = { keyword: data.keyword, category: 'TECHNOLOGY', status: 'ONGOING', page: 2, pageSize: 2 };
    await assertList(page, surface, await open(page, surface, query), [data.ongoing[2].id], 3);
    const initialUrl = page.url();
    const refreshed = resultAfter(page, surface, query); await page.reload(); await assertList(page, surface, await refreshed, [data.ongoing[2].id], 3);
    await page.getByRole('link', { name: surface === 'public' ? `查看${data.ongoing[2].title}的详情` : data.ongoing[2].title, exact: true }).click();
    await expect(page.getByRole('heading', { name: data.ongoing[2].title, exact: true })).toBeVisible();
    if (surface === 'public') {
      await page.getByRole('button', { name: '登录后收藏', exact: true }).click();
      await page.getByLabel('账号', { exact: true }).fill('demo'); await page.getByLabel('密码', { exact: true }).fill('Demo123!');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.getByRole('heading', { name: data.ongoing[2].title, exact: true })).toBeVisible();
      const returned = resultAfter(page, surface, query); await page.getByRole('link', { name: '返回活动列表', exact: true }).click();
      await assertList(page, surface, await returned, [data.ongoing[2].id], 3);
    } else {
      const returned = resultAfter(page, surface, query); await page.goBack(); await assertList(page, surface, await returned, [data.ongoing[2].id], 3);
    }
    expect(page.url()).toBe(initialUrl);
    query = { ...query, status: 'ENDED', page: 1 };
    let loaded = resultAfter(page, surface, query); await choose(page, '活动状态', '已结束');
    await assertList(page, surface, await loaded, data.ended.slice(0, 2).map(item => item.id), 3);
    expect(new URL(page.url()).searchParams.get('page')).toBeNull();
    await page.screenshot({ path: info.outputPath(`${surface}-ended-filters.png`), fullPage: true });
    loaded = resultAfter(page, surface, { ...query, status: 'ONGOING', page: 2 }); await page.goBack();
    await assertList(page, surface, await loaded, [data.ongoing[2].id], 3);
    loaded = resultAfter(page, surface, query); await page.goForward(); await assertList(page, surface, await loaded, data.ended.slice(0, 2).map(item => item.id), 3);
    query = { ...query, status: 'STARTED', pageSize: 100 };
    const allStarted = [...data.ended.map(item => item.id), data.legacy.id, ...data.ongoing.map(item => item.id)];
    await assertList(page, surface, await open(page, surface, query), allStarted, 7);
    query = { ...query, status: 'ENDED', category: 'OTHER', pageSize: 2 };
    const empty = await open(page, surface, query); expect(empty.total).toBe(0); expect(empty.items).toEqual([]);
    await expect(page.getByText('暂无符合条件的活动', { exact: true })).toBeVisible();
    query = { ...query, category: 'TECHNOLOGY' };
    await page.route(`**${endpoint(surface)}?**`, route => route.abort('failed'));
    await page.goto(path(surface, query)); await expect(page.getByRole('button', { name: '重新加载', exact: true })).toBeVisible();
    await page.unroute(`**${endpoint(surface)}?**`);
    loaded = resultAfter(page, surface, query); await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await assertList(page, surface, await loaded, data.ended.slice(0, 2).map(item => item.id), 3);
    loaded = resultAfter(page, surface, { ...query, status: 'ALL' });
    await page.goto(path(surface, { ...query, status: 'ended' })); expect((await loaded).total).toBe(10);
    await expect.poll(() => new URL(page.url()).searchParams.get('status')).toBeNull();
    if (surface === 'public') expect((await page.request.get(`/api/admin/activities?status=ONGOING`)).status()).toBe(403);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });

  test(`${surface} 时间标签跨边界不轮询，手动刷新重读集合并修正越界分页`, async ({ page, request }, info) => {
    const data = await fixtures(request, info); if (surface === 'admin') await login(page);
    const query: Query = { keyword: data.keyword, category: 'TECHNOLOGY', status: 'ONGOING', page: 2, pageSize: 2 };
    let requests = 0; page.on('request', request => { if (new URL(request.url()).pathname === endpoint(surface)) requests++; });
    await page.clock.install({ time: Date.now() });
    await assertList(page, surface, await open(page, surface, query), [data.ongoing[2].id], 3);
    const before = requests; await page.clock.fastForward(2 * 3600000);
    await expect(page.locator(`[data-activity-id="${data.ongoing[2].id}"]`).getByText('已结束', { exact: true })).toBeVisible();
    expect(requests).toBe(before);
    await page.clock.setSystemTime(Date.now()); await expireOwnedFixture(data.ongoing[2]);
    const corrected = resultAfter(page, surface, { ...query, page: 1 }); await page.reload();
    await assertList(page, surface, await corrected, data.ongoing.slice(0, 2).map(item => item.id), 2);
    await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBeNull();
    await expireOwnedFixture(data.ongoing[1]);
    const current = { ...query, page: 1 }; const refreshed = resultAfter(page, surface, current);
    await page.getByRole('button', { name: '查询', exact: true }).click();
    await assertList(page, surface, await refreshed, [data.ongoing[0].id], 1);
    expect(new URL(page.url()).searchParams.get('status')).toBe('ONGOING');
    expect(requests).toBeGreaterThan(before);
  });
}
