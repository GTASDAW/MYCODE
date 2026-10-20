import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import {
  databaseConfig,
  verifyDatabase,
  trackAccount,
  recordAccountId,
  trackFixture,
  recordFixtureId,
  trackFavorite,
} from '../scripts/e2e-cleanup.mjs';

// Waiting positions are personal/session data. Keep screenshots only and never retain Session/CSRF bodies.
test.use({ trace: 'off' });

type Status = 'ACTIVE' | 'WAITING' | 'CANCELLED';
interface Account {
  key: string;
  id: number;
  username: string;
  displayName: string;
  allowedDisplayNames: string[];
}
interface Activity {
  id: number;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string | null;
  registrationDeadline: string | null;
  capacity: number;
  registeredCount: number;
  waitingCount: number;
  waitingPosition: number | null;
  registrationStatus: Status | null;
  closed: boolean;
  cancelled: boolean;
  registrationClosed: boolean;
}
interface RegistrationRow { id: number; userId: number; status: Status; updatedAt: string }
const password = 'Demo123!';
const networkError = '暂时无法连接服务，请检查网络后重试。';

function manifest() {
  const path = process.env.E2E_RUN_MANIFEST;
  if (!path || dirname(resolve(path)) !== resolve('.runtime/e2e'))
    throw new Error('Verified fixture manifest is required.');
  return JSON.parse(readFileSync(path, 'utf8')) as { target: { host: string; port: number; database: string; serverUuid: string } };
}

async function database() {
  const config = databaseConfig();
  const connection = await mysql.createConnection({ ...config, timezone: 'Z', dateStrings: true });
  try { await verifyDatabase(connection, config, manifest().target); }
  catch (error) { await connection.end(); throw error; }
  return connection;
}

async function csrf(request: APIRequestContext) {
  const response = await request.get('/api/auth/csrf');
  expect(response.status()).toBe(200);
  return response.json() as Promise<{ token: string; headerName: string }>;
}

async function write(request: APIRequestContext, path: string, method: 'POST' | 'DELETE' = 'POST', data?: unknown) {
  const token = await csrf(request);
  return request.fetch(path, { method, data, headers: { [token.headerName]: token.token } });
}

async function loginApi(request: APIRequestContext, account?: Account) {
  const token = await csrf(request);
  const response = await request.post('/api/auth/login', {
    form: { username: account?.username ?? 'admin', password: account ? password : 'Admin123!' },
    headers: { [token.headerName]: token.token },
  });
  expect(response.status()).toBe(200);
}

async function logoutApi(request: APIRequestContext) {
  const me = await request.get('/api/auth/me');
  if (me.status() === 401) return;
  expect(me.status()).toBe(200);
  expect((await write(request, '/api/auth/logout')).status()).toBe(200);
}

async function loginForm(page: Page, account: Account) {
  await page.getByLabel('账号', { exact: true }).fill(account.username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: `账号菜单，${account.displayName}`, exact: true })).toBeVisible();
}

async function login(page: Page, account: Account) {
  await page.goto('/login');
  await loginForm(page, account);
}

async function logout(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  const item = page.getByRole('menuitem', { name: /退出登录/ });
  await expect(item).toBeVisible();
  const completed = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/auth/logout' && response.status() === 200);
  // Enter avoids the fixed-header dropdown relocation race covered by the existing E2E suites.
  await item.press('Enter');
  await completed;
  await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
}

async function registerAccount(request: APIRequestContext, prefix: string): Promise<Account> {
  // The full ownership UUID occupies 36 of the nickname's 40 allowed characters.
  const intent = trackAccount([prefix.slice(0, 4)]);
  const response = await write(request, '/api/auth/register', 'POST', {
    username: intent.username,
    displayName: intent.displayName,
    password,
  });
  expect(response.status()).toBe(201);
  const user = await response.json() as { id: number };
  recordAccountId(intent.key, user.id);
  return { ...intent, id: user.id };
}

async function createActivity(request: APIRequestContext, info: TestInfo, options: {
  capacity?: number;
  registrationDeadline?: string | null;
} = {}) {
  await loginApi(request);
  const fixture = trackFixture(
    `候补顺位 ${info.project.name} ${randomUUID().slice(0, 8)}`,
    '候补顺位专项独立活动。',
  );
  const startsAt = new Date(Date.now() + 48 * 3600000).toISOString();
  const endsAt = new Date(Date.now() + 50 * 3600000).toISOString();
  const body = {
    title: fixture.title,
    description: fixture.description,
    location: '候补顺位独立场地',
    startsAt,
    endsAt,
    registrationDeadline: options.registrationDeadline === undefined
      ? new Date(Date.now() + 24 * 3600000).toISOString()
      : options.registrationDeadline,
    capacity: options.capacity ?? 1,
    category: 'OTHER',
  };
  const response = await write(request, '/api/admin/activities', 'POST', body);
  expect(response.status()).toBe(201);
  const activity = await response.json() as Activity;
  recordFixtureId(fixture.key, activity.id);
  const bound = await request.get(`/api/activities/${activity.id}`);
  expect(bound.status()).toBe(200);
  expect(await bound.json()).toMatchObject({ id: activity.id, title: fixture.title, description: fixture.description });
  return { ...activity, fixture };
}

async function join(request: APIRequestContext, account: Account, activityId: number): Promise<Activity> {
  await loginApi(request, account);
  const response = await write(request, `/api/activities/${activityId}/registration`);
  expect(response.status()).toBe(200);
  return response.json();
}

async function cancel(request: APIRequestContext, account: Account, activityId: number): Promise<Activity> {
  await loginApi(request, account);
  const response = await write(request, `/api/activities/${activityId}/registration`, 'DELETE');
  expect(response.status()).toBe(200);
  return response.json();
}

async function detail(request: APIRequestContext, activityId: number, account?: Account): Promise<Activity> {
  if (account) await loginApi(request, account);
  else await logoutApi(request);
  const response = await request.get(`/api/activities/${activityId}`);
  expect(response.status()).toBe(200);
  return response.json();
}

async function updateWaitingTime(activity: { id: number; title: string; description: string }, accounts: Account[], timestamp: Date) {
  const connection = await database();
  try {
    await connection.beginTransaction();
    const [owned] = await connection.execute<any[]>(
      'SELECT id FROM activities WHERE id=? AND CAST(title AS BINARY)=CAST(? AS BINARY) AND CAST(description AS BINARY)=CAST(? AS BINARY) FOR UPDATE',
      [activity.id, activity.title, activity.description],
    );
    expect(owned).toHaveLength(1);
    const [users] = await connection.execute<any[]>(
      `SELECT id FROM users WHERE id IN (${accounts.map(() => '?').join(',')}) AND role='USER' FOR UPDATE`,
      accounts.map(account => account.id),
    );
    expect(users.map(row => row.id).sort((a, b) => a - b)).toEqual(accounts.map(account => account.id).sort((a, b) => a - b));
    const value = timestamp.toISOString().replace('T', ' ').replace('Z', '');
    const [changed] = await connection.execute<mysql.ResultSetHeader>(
      `UPDATE registrations SET updated_at=? WHERE activity_id=? AND user_id IN (${accounts.map(() => '?').join(',')}) AND status='WAITING'`,
      [value, activity.id, ...accounts.map(account => account.id)],
    );
    expect(changed.affectedRows).toBe(accounts.length);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { await connection.end(); }
}

async function setDeadline(activity: { id: number; title: string; description: string }, value: Date) {
  const connection = await database();
  try {
    await connection.beginTransaction();
    const [owned] = await connection.execute<any[]>(
      'SELECT id FROM activities WHERE id=? AND CAST(title AS BINARY)=CAST(? AS BINARY) AND CAST(description AS BINARY)=CAST(? AS BINARY) FOR UPDATE',
      [activity.id, activity.title, activity.description],
    );
    expect(owned).toHaveLength(1);
    const [changed] = await connection.execute<mysql.ResultSetHeader>(
      'UPDATE activities SET registration_deadline=? WHERE id=?',
      [value.toISOString().replace('T', ' ').replace('Z', ''), activity.id],
    );
    expect(changed.affectedRows).toBe(1);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { await connection.end(); }
}

async function registrationRows(activity: { id: number; title: string; description: string }, accounts: Account[]) {
  const connection = await database();
  try {
    const [owned] = await connection.execute<any[]>(
      'SELECT id FROM activities WHERE id=? AND CAST(title AS BINARY)=CAST(? AS BINARY) AND CAST(description AS BINARY)=CAST(? AS BINARY)',
      [activity.id, activity.title, activity.description],
    );
    expect(owned).toHaveLength(1);
    const [rows] = await connection.execute<any[]>(
      `SELECT id,user_id AS userId,status,updated_at AS updatedAt FROM registrations WHERE activity_id=? AND user_id IN (${accounts.map(() => '?').join(',')}) ORDER BY id`,
      [activity.id, ...accounts.map(account => account.id)],
    );
    return rows as RegistrationRow[];
  } finally { await connection.end(); }
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function picture(page: Page, info: TestInfo, name: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

test.afterEach(async ({ page, request }) => {
  const results = await Promise.allSettled([logoutApi(page.request), logoutApi(request)]);
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'Waiting-position sessions could not all log out.');
});

test('候补顺位只来自本人，updated_at 相同按 registration id 排序且不跨活动', async ({ request, playwright }, info) => {
  const activity = await createActivity(request, info, { capacity: 1 });
  const other = await createActivity(request, info, { capacity: 1 });
  const seat = await registerAccount(request, '顺位座位-');
  const first = await registerAccount(request, '顺位一-');
  const second = await registerAccount(request, '顺位二-');
  const third = await registerAccount(request, '顺位三-');
  expect((await join(request, seat, activity.id)).registrationStatus).toBe('ACTIVE');
  for (const account of [first, second, third]) expect((await join(request, account, activity.id)).registrationStatus).toBe('WAITING');
  await updateWaitingTime(activity, [first, second, third], new Date(Date.now() - 60000));
  const rows = await registrationRows(activity, [first, second, third]);
  expect(new Set(rows.map(row => row.updatedAt)).size).toBe(1);
  const ordered = [...rows].sort((a, b) => a.id - b.id).map(row => row.userId);
  expect(ordered).toEqual([first.id, second.id, third.id]);
  for (const [index, account] of [first, second, third].entries()) {
    const view = await detail(request, activity.id, account);
    expect(view).toMatchObject({ registrationStatus: 'WAITING', waitingPosition: index + 1, waitingCount: 3 });
    const forged = await request.get(`/api/activities/${activity.id}?userId=${second.id}`);
    expect(forged.status()).toBe(200);
    expect(await forged.json()).toMatchObject({ registrationStatus: 'WAITING', waitingPosition: index + 1 });
  }
  const guest = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  try {
    const anonymous = await guest.get(`/api/activities/${activity.id}?userId=${first.id}`);
    expect(anonymous.status()).toBe(200);
    expect(await anonymous.json()).toMatchObject({ registrationStatus: null, waitingPosition: null, waitingCount: 3 });
  } finally { await guest.dispose(); }
  const unrelated = await detail(request, other.id, first);
  expect(unrelated).toMatchObject({ registrationStatus: null, waitingPosition: null, waitingCount: 0 });
  await loginApi(request, third);
  const oldActivities = await (await request.get('/api/activities')).json();
  expect(oldActivities.find((value: Activity) => value.id === activity.id)).toMatchObject({ waitingPosition: 3 });
  const search = await (await request.get(`/api/activities/search?${new URLSearchParams({ keyword: activity.title })}`)).json();
  expect(search.items).toHaveLength(1);
  expect(search.items[0]).toMatchObject({ id: activity.id, waitingPosition: 3 });
  const oldMine = await (await request.get('/api/me/registrations')).json();
  expect(oldMine.find((value: { activity: Activity }) => value.activity.id === activity.id).activity.waitingPosition).toBe(3);
  const mine = await (await request.get('/api/me/registrations/search')).json();
  expect(mine.items.find((value: { activity: Activity }) => value.activity.id === activity.id).activity.waitingPosition).toBe(3);
  trackFavorite(third.id, activity.id);
  expect((await write(request, `/api/me/favorites/${activity.id}`)).status()).toBe(200);
  const favorites = await (await request.get('/api/me/favorites')).json();
  expect(favorites.items.find((value: { activity: Activity }) => value.activity.id === activity.id).activity.waitingPosition).toBe(3);
  await loginApi(request);
  const adminJoined = await write(request, `/api/activities/${activity.id}/registration`);
  expect(adminJoined.status()).toBe(200);
  expect(await adminJoined.json()).toMatchObject({ registrationStatus: 'WAITING', waitingPosition: 4 });
  const adminActivities = await (await request.get(`/api/admin/activities?${new URLSearchParams({ keyword: activity.title })}`)).json();
  expect(adminActivities.items[0]).toMatchObject({ id: activity.id, waitingPosition: 4 });
  const adminRoster = await (await request.get(`/api/admin/activities/${activity.id}/registrations`)).json();
  expect(adminRoster.activity).toMatchObject({ id: activity.id, waitingPosition: 4 });
  const cancelled = await cancel(request, second, activity.id);
  expect(cancelled).toMatchObject({ registrationStatus: 'CANCELLED', waitingPosition: null });
});

test('详情手动刷新读取真实递补，取消后重报排到候补队尾且 POST 只有一次', async ({ page, request }, info) => {
  const activity = await createActivity(request, info, { capacity: 1 });
  const seat = await registerAccount(request, '刷新座位-');
  const first = await registerAccount(request, '刷新一-');
  const second = await registerAccount(request, '刷新二-');
  const third = await registerAccount(request, '刷新三-');
  await join(request, seat, activity.id);
  await join(request, first, activity.id);
  await join(request, second, activity.id);
  await join(request, third, activity.id);
  await login(page, first);
  await page.goto(`/activities/${activity.id}`);
  await expect(page.getByTestId('waiting-position')).toContainText('候补第 1 位，前面还有 0 人');
  let refreshReads = 0;
  page.on('request', browserRequest => {
    if (browserRequest.method() === 'GET' && new URL(browserRequest.url()).pathname === `/api/activities/${activity.id}`) refreshReads++;
  });
  await cancel(request, seat, activity.id);
  const refreshed = page.waitForResponse(response => response.request().method() === 'GET'
    && new URL(response.url()).pathname === `/api/activities/${activity.id}` && response.status() === 200);
  await page.getByRole('button', { name: '刷新活动信息', exact: true }).click();
  expect((await refreshed).status()).toBe(200);
  await expect(page.getByTestId('waiting-position')).toHaveCount(0);
  await expect(page.getByText('你的名额已确认', { exact: true })).toBeVisible();
  await settle(page);
  const readsAfterRefresh = refreshReads;
  await page.waitForTimeout(250);
  expect(refreshReads).toBe(readsAfterRefresh);
  const cancelled = page.waitForResponse(response => response.request().method() === 'DELETE'
    && new URL(response.url()).pathname === `/api/activities/${activity.id}/registration` && response.status() === 200);
  await page.getByRole('button', { name: '取消报名', exact: true }).click();
  await page.getByRole('button', { name: '确认取消', exact: true }).click();
  await cancelled;
  await expect(page.getByRole('button', { name: '加入候补', exact: true })).toBeVisible();
  let writes = 0;
  let releasePost!: () => void;
  let postArrived!: () => void;
  let rejectPost!: (error: unknown) => void;
  const postJobs: Promise<unknown>[] = [];
  const postGate = new Promise<void>(resolveGate => { releasePost = resolveGate; });
  const postFetched = new Promise<void>((resolveFetched, rejectFetched) => { postArrived = resolveFetched; rejectPost = rejectFetched; });
  await page.route(url => url.pathname === `/api/activities/${activity.id}/registration`, route => {
    if (route.request().method() !== 'POST') return route.continue();
    writes++;
    const job = (async () => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      postArrived();
      await postGate;
      await route.fulfill({ response });
    })();
    postJobs.push(job.catch(error => { rejectPost(error); return error; }));
    return job;
  });
  try {
    const button = page.getByRole('button', { name: /加入候补/ });
    await button.click();
    await postFetched;
    await expect(button).toHaveClass(/ant-btn-loading/);
    await expect(page.getByRole('button', { name: '刷新活动信息', exact: true })).toBeDisabled();
    await button.click({ force: true });
    releasePost();
    expect((await Promise.all(postJobs)).filter(error => error !== undefined)).toEqual([]);
    expect(writes).toBe(1);
    await expect(page.getByTestId('waiting-position')).toContainText('候补第 2 位，前面还有 1 人');
    await expect(page.getByRole('button', { name: '刷新活动信息', exact: true })).toBeEnabled();
    await picture(page, info, 'waiting-position-detail');
  } finally {
    releasePost();
    const errors = (await Promise.all(postJobs)).filter(error => error !== undefined);
    await page.unrouteAll({ behavior: 'wait' });
    expect(errors).toEqual([]);
  }
  const joined = await detail(request, activity.id, first);
  expect(joined).toMatchObject({ registrationStatus: 'WAITING', waitingPosition: 2, waitingCount: 2 });
});

test('我的报名 WAITING 筛选、分页、直达刷新和详情返回保留本人候补顺位', async ({ page, request }, info) => {
  const waitingActivity = await createActivity(request, info, { capacity: 1 });
  const waitingActivityTwo = await createActivity(request, info, { capacity: 1 });
  const activeActivity = await createActivity(request, info, { capacity: 1 });
  const seat = await registerAccount(request, '我的报名座位-');
  const seatTwo = await registerAccount(request, '我的报名座位二-');
  const account = await registerAccount(request, '我的报名本人-');
  await join(request, seat, waitingActivity.id);
  await join(request, account, waitingActivity.id);
  await join(request, seatTwo, waitingActivityTwo.id);
  await join(request, account, waitingActivityTwo.id);
  await join(request, account, activeActivity.id);
  await login(page, account);
  const query = `/my-registrations?status=WAITING&pageSize=1`;
  const firstRead = page.waitForEvent('requestfinished', { predicate: browserRequest => browserRequest.method() === 'GET'
    && new URL(browserRequest.url()).pathname === '/api/me/registrations/search'
    && new URL(browserRequest.url()).searchParams.get('status') === 'WAITING' });
  await page.goto(query);
  const response = await (await firstRead).response();
  expect(response?.status()).toBe(200);
  const payload = await response!.json();
  expect(payload).toMatchObject({ total: 2, page: 1, pageSize: 1, summary: { waitingRegistrations: 2 } });
  expect(payload.items[0].status).toBe('WAITING');
  expect(payload.items[0].activity.waitingPosition).toBe(1);
  await expect(page.getByTestId(`myregistration-waiting-position-${payload.items[0].id}`)).toContainText('候补第 1 位，前面还有 0 人');
  await expect(page.getByRole('button', { name: '刷新报名', exact: true })).toBeVisible();
  const page2Query = '/my-registrations?status=WAITING&page=2&pageSize=1';
  const page2Read = page.waitForEvent('requestfinished', { predicate: browserRequest => browserRequest.method() === 'GET'
    && new URL(browserRequest.url()).pathname === '/api/me/registrations/search'
    && new URL(browserRequest.url()).searchParams.get('status') === 'WAITING'
    && new URL(browserRequest.url()).searchParams.get('page') === '2' });
  await page.locator('[aria-label="报名分页"] .ant-pagination-item[title="2"]').click();
  const page2Response = await (await page2Read).response();
  expect(page2Response?.status()).toBe(200);
  const page2Payload = await page2Response!.json();
  expect(page2Payload).toMatchObject({ total: 2, page: 2, pageSize: 1 });
  await page.reload();
  await expect(page).toHaveURL(page2Query);
  const row = page.getByTestId(`myregistration-${page2Payload.items[0].id}`);
  await expect(row).toContainText('候补第 1 位，前面还有 0 人');
  await picture(page, info, 'waiting-position-my-registrations');
  await row.getByRole('link', { name: '查看活动', exact: true }).click();
  await expect(page.getByRole('heading', { name: page2Payload.items[0].activity.title, exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('from')).toBe(page2Query);
  await expect(page.getByRole('link', { name: '返回我的报名', exact: true })).toHaveAttribute('href', page2Query);
  await page.reload();
  await expect(page.getByRole('link', { name: '返回我的报名', exact: true })).toBeVisible();
});

test('报名截止后候补顺位仍可读取并允许既有候补取消递补，重报仍被服务端拒绝', async ({ page, request }, info) => {
  const activity = await createActivity(request, info, { capacity: 1 });
  const seat = await registerAccount(request, '截止座位-');
  const first = await registerAccount(request, '截止一-');
  const second = await registerAccount(request, '截止二-');
  const newcomer = await registerAccount(request, '截止新用户-');
  await join(request, seat, activity.id);
  await join(request, first, activity.id);
  await join(request, second, activity.id);
  await setDeadline(activity, new Date(Date.now() - 60000));
  const waiting = await detail(request, activity.id, second);
  expect(waiting).toMatchObject({ registrationStatus: 'WAITING', waitingPosition: 2, registrationClosed: true });
  await login(page, second);
  await page.goto(`/activities/${activity.id}`);
  await expect(page.getByTestId('waiting-position')).toContainText('候补第 2 位，前面还有 1 人');
  await expect(page.getByText('报名已截止，已有候补仍可在活动开始前递补', { exact: true })).toBeVisible();
  await loginApi(request, newcomer);
  const duplicate = await write(request, `/api/activities/${activity.id}/registration`);
  expect(duplicate.status()).toBe(409);
  expect((await duplicate.json()).code).toBe('REGISTRATION_CLOSED');
  await cancel(request, seat, activity.id);
  const promoted = await detail(request, activity.id, first);
  expect(promoted).toMatchObject({ registrationStatus: 'ACTIVE', waitingPosition: null });
  const secondStillWaiting = await detail(request, activity.id, second);
  expect(secondStillWaiting).toMatchObject({ registrationStatus: 'WAITING', waitingPosition: 1 });
  expect((await cancel(request, second, activity.id)).registrationStatus).toBe('CANCELLED');
});

test('浏览器时间只改变开始提示，候补历史保留顺位且详情无轮询', async ({ page, request }, info) => {
  const activity = await createActivity(request, info, { capacity: 1 });
  const seat = await registerAccount(request, '开始座位-');
  const waiting = await registerAccount(request, '开始候补-');
  await join(request, seat, activity.id);
  await join(request, waiting, activity.id);
  await login(page, waiting);
  await page.clock.install({ time: Date.parse(activity.startsAt) - 3600000 });
  let reads = 0;
  page.on('request', browserRequest => {
    if (browserRequest.method() === 'GET' && new URL(browserRequest.url()).pathname === `/api/activities/${activity.id}`) reads++;
  });
  await page.goto(`/activities/${activity.id}`);
  await expect(page.getByTestId('waiting-position')).toContainText('候补第 1 位，前面还有 0 人');
  await expect(page.getByText('报名已截止，已有候补仍可在活动开始前递补', { exact: true })).toBeVisible();
  await page.clock.setSystemTime(Date.parse(activity.startsAt) - 1000);
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await settle(page);
  const beforeStart = reads;
  await page.clock.fastForward(1000);
  await expect(page.getByText('活动已开始，候补递补已停止', { exact: true })).toBeVisible();
  expect(reads).toBe(beforeStart);
  await settle(page);
  const beforeIdle = reads;
  await page.waitForTimeout(250);
  expect(reads).toBe(beforeIdle);
  const apiView = await detail(request, activity.id, waiting);
  expect(apiView).toMatchObject({ registrationStatus: 'WAITING', waitingPosition: 1 });
});

test('详情读取失败可手动恢复，迟到的旧 401 不覆盖新登录身份或候补文案', async ({ page, request }, info) => {
  const activity = await createActivity(request, info, { capacity: 1 });
  const seat = await registerAccount(request, '迟到座位-');
  const first = await registerAccount(request, '迟到一-');
  const second = await registerAccount(request, '迟到二-');
  await join(request, seat, activity.id);
  await join(request, first, activity.id);
  await join(request, second, activity.id);
  await login(page, first);
  let failed = true;
  let reads = 0;
  await page.route(url => url.pathname === `/api/activities/${activity.id}`, route => {
    reads++;
    if (failed) return route.abort('failed');
    return route.continue();
  });
  await page.goto(`/activities/${activity.id}`);
  await expect(page.getByText(networkError, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新加载', exact: true })).toBeVisible();
  failed = false;
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.getByTestId('waiting-position')).toContainText('候补第 1 位，前面还有 0 人');
  const afterRecovery = reads;
  await page.waitForTimeout(250);
  expect(reads).toBe(afterRecovery);
  await page.unrouteAll({ behavior: 'wait' });

  // Public details normally fall back to anonymous 200. Explicitly inject a genuine expired
  // auth/me 401 to exercise stale-error isolation without claiming the public endpoint returns it.
  await loginApi(request, first);
  const cookie = (await request.storageState()).cookies.find(value => value.name === 'JSESSIONID');
  expect(cookie).toBeTruthy();
  const expiredCookie = `JSESSIONID=${cookie!.value}`;
  await logoutApi(request);
  expect((await request.get('/api/auth/me', { headers: { Cookie: expiredCookie } })).status()).toBe(401);
  let release!: () => void;
  let fetched!: () => void;
  let rejected!: (error: unknown) => void;
  let armed = true;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  const arrived = new Promise<void>((resolveArrived, rejectArrived) => { fetched = resolveArrived; rejected = rejectArrived; });
  const jobs: Promise<unknown>[] = [];
  let held = 0;
  const matcher = (url: URL) => url.pathname === `/api/activities/${activity.id}`;
  await page.route(matcher, route => {
    if (!armed) return route.continue();
    held++;
    const job = (async () => {
      const response = await route.fetch({ url: new URL('/api/auth/me', route.request().url()).href,
        headers: { ...route.request().headers(), cookie: expiredCookie } });
      expect(response.status()).toBe(401);
      expect((await response.json()).code).toBe('UNAUTHENTICATED');
      fetched();
      await gate;
      try { await route.fulfill({ response }); }
      catch (error) { if (!route.request().failure()) throw error; }
    })();
    jobs.push(job.catch(error => { rejected(error); return error; }));
    return job;
  });
  try {
    await page.getByRole('button', { name: '刷新活动信息', exact: true }).click();
    await arrived;
    armed = false;
    await logout(page);
    await login(page, second);
    await page.goto(`/activities/${activity.id}`);
    await expect(page.getByTestId('waiting-position')).toContainText('候补第 2 位，前面还有 1 人');
    release();
    const errors = (await Promise.all(jobs)).filter(error => error !== undefined);
    expect(errors).toEqual([]);
    await settle(page);
    await expect(page.getByRole('button', { name: `账号菜单，${second.displayName}`, exact: true })).toBeVisible();
    expect((await page.request.get('/api/auth/me')).status()).toBe(200);
    expect(held).toBeGreaterThanOrEqual(1);
    await expect(page.getByText('候补第 1 位，前面还有 0 人', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('waiting-position')).toContainText('候补第 2 位，前面还有 1 人');
  } finally {
    armed = false;
    release();
    const errors = (await Promise.all(jobs)).filter(error => error !== undefined);
    await page.unroute(matcher);
    expect(errors).toEqual([]);
  }
});
