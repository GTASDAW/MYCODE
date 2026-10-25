import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { databaseConfig, verifyDatabase, trackAccount, recordAccountId, trackFixture, recordFixtureId,
  recordFixtureEditIntent } from '../scripts/e2e-cleanup.mjs';

// Never retain credentials, Cookie headers, CSRF tokens or request bodies in traces.
test.use({ trace: 'off' });
const listApi = '/api/admin/audit-logs';
const listPage = '/admin/audit-logs';
const networkError = '暂时无法连接服务，请检查网络后重试。';
const labels = { CREATE: '发布活动', EDIT: '编辑活动', CANCEL: '取消活动', CHECK_IN: '签到' };
interface Account { key: string; id: number; username: string; displayName: string; allowedDisplayNames: string[] }
interface Audit { id: number; action: keyof typeof labels; activityId: number; activityTitle: string;
  actorUserId: number; actorUsername: string; actorDisplayName: string; registrationId: number | null;
  targetUsername: string | null; targetDisplayName: string | null; occurredAt: string }
interface AuditPage { items: Audit[]; total: number; page: number; pageSize: number }

async function write(request: APIRequestContext, path: string, method: 'POST' | 'PATCH' = 'POST', data?: unknown) {
  const csrf = await request.get('/api/auth/csrf');
  expect(csrf.status()).toBe(200);
  const token = await csrf.json();
  return request.fetch(path, { method, headers: { [token.headerName]: token.token }, data });
}

async function loginApi(request: APIRequestContext, account?: Account) {
  const csrf = await (await request.get('/api/auth/csrf')).json();
  const response = await request.post('/api/auth/login', { headers: { [csrf.headerName]: csrf.token },
    form: { username: account?.username ?? 'admin', password: account ? 'Demo123!' : 'Admin123!' } });
  expect(response.status()).toBe(200);
  return response.json();
}

async function logoutApi(request: APIRequestContext) {
  const current = await request.get('/api/auth/me');
  if (current.status() === 401) return;
  expect(current.status()).toBe(200);
  expect((await write(request, '/api/auth/logout')).status()).toBe(200);
}

async function register(request: APIRequestContext): Promise<Account> {
  const account = trackAccount(['旧-', '新-']);
  const response = await write(request, '/api/auth/register', 'POST', {
    username: account.username, displayName: account.displayName, password: 'Demo123!',
  });
  expect(response.status()).toBe(201);
  const user = await response.json();
  recordAccountId(account.key, user.id);
  return { ...account, id: user.id };
}

async function loginForm(page: Page, account?: Account) {
  await page.getByLabel('账号', { exact: true }).fill(account?.username ?? 'admin');
  await page.getByLabel('密码', { exact: true }).fill(account ? 'Demo123!' : 'Admin123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: /账号菜单/ })).toBeVisible();
}

async function login(page: Page, account?: Account) {
  await page.goto('/login');
  await loginForm(page, account);
}

async function logout(page: Page) {
  await page.getByRole('button', { name: /账号菜单/ }).click();
  await page.getByRole('menuitem', { name: /退出登录/ }).click();
  await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
}

async function list(request: APIRequestContext, activityId?: number, action = 'ALL', page = 1, pageSize = 10) {
  const query = new URLSearchParams({ action, page: String(page), pageSize: String(pageSize) });
  if (activityId !== undefined) query.set('activityId', String(activityId));
  const response = await request.get(`${listApi}?${query}`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<AuditPage>;
}

async function assertList(page: Page, result: AuditPage) {
  await expect(page.locator('[data-audit-id]')).toHaveCount(result.items.length);
  await expect.poll(() => page.locator('[data-audit-id]').evaluateAll(rows => rows.map(row => Number(row.getAttribute('data-audit-id')))))
    .toEqual(result.items.map(row => row.id));
  await expect(page.getByTestId('audit-total')).toHaveText(`当前筛选共 ${result.total} 条记录`);
}

async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ has: page.getByText(option, { exact: true }) }).click();
  await expect(page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')).toHaveCount(0);
}

async function capture(page: Page, info: TestInfo, name: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  const dialog = page.getByRole('dialog', { name: '操作记录详情', exact: true });
  const hasDialog = await dialog.isVisible();
  if (hasDialog) {
    await expect.poll(() => dialog.evaluate(element => {
      const wrapper = element.closest('.ant-drawer-content-wrapper') ?? element;
      const rect = wrapper.getBoundingClientRect();
      const running = wrapper.getAnimations({ subtree: true }).some(animation => animation.playState === 'running');
      return !running && rect.x >= -1 && rect.y >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1
        && rect.width > 0 && rect.height > 0;
    })).toBeTruthy();
    await expect.poll(() => dialog.evaluate(element => {
      const body = element.querySelector('.ant-drawer-body') ?? element;
      return body.scrollWidth <= body.clientWidth + 1;
    })).toBeTruthy();
  }
  const path = info.outputPath(`${name}.png`);
  // A fixed drawer belongs to the visible viewport; full-page screenshots can
  // stitch it onto a scrolled background and create a misleading position.
  await page.screenshot({ path, fullPage: !hasDialog });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function create(request: APIRequestContext, info: TestInfo, rich = false) {
  const fixture = trackFixture(`审计 <b>活动</b> ${info.project.name} ${randomUUID().slice(0, 8)}`,
    rich ? `原介绍 <script>window.__gatherAuditInjection=true</script>\n${'第一行中文、引号“原文”和长介绍。\n'.repeat(60)}` : '管理员操作记录精确归属活动。');
  const response = await write(request, '/api/admin/activities', 'POST', { title: fixture.title, description: fixture.description,
    location: '操作记录原场地', startsAt: new Date(Date.now() + 48 * 3600000).toISOString(), capacity: 2 });
  expect(response.status()).toBe(201);
  const activity = await response.json();
  recordFixtureId(fixture.key, activity.id);
  return { ...fixture, ...activity };
}

async function started(request: APIRequestContext, account: Account, info: TestInfo) {
  const fixture = trackFixture(`审计签到 ${info.project.name} ${randomUUID().slice(0, 8)}`, '归属明确的独立已开始活动，不改变既有活动时间。');
  const manifest = JSON.parse(readFileSync(process.env.E2E_RUN_MANIFEST!, 'utf8'));
  const config = databaseConfig();
  const db = await mysql.createConnection(config);
  try {
    await verifyDatabase(db, config, manifest.target);
    const me = await (await request.get('/api/auth/me')).json();
    expect(me.role).toBe('ADMIN');
    await db.beginTransaction();
    const [users] = await db.execute<any[]>('SELECT id, username, display_name AS displayName, role FROM users WHERE id=? FOR UPDATE', [account.id]);
    expect(users).toEqual([{ id: account.id, username: account.username, displayName: account.displayName, role: 'USER' }]);
    const [activity] = await db.execute<mysql.ResultSetHeader>(
      'INSERT INTO activities(title,description,location,starts_at,capacity,registered_count,created_by) VALUES (?,?,?,UTC_TIMESTAMP(6) - INTERVAL 1 HOUR,1,1,?)',
      [fixture.title, fixture.description, '独立签到审计场地', me.id]);
    const [registration] = await db.execute<mysql.ResultSetHeader>(
      "INSERT INTO registrations(activity_id,user_id,status,created_at,updated_at) VALUES (?,?,'ACTIVE',UTC_TIMESTAMP(6) - INTERVAL 2 HOUR,UTC_TIMESTAMP(6) - INTERVAL 2 HOUR)",
      [activity.insertId, account.id]);
    await db.commit();
    recordFixtureId(fixture.key, activity.insertId);
    const bound = await request.get(`/api/activities/${activity.insertId}`);
    expect(bound.status()).toBe(200);
    expect(await bound.json()).toMatchObject({ id: activity.insertId, title: fixture.title, description: fixture.description });
    return { ...fixture, id: activity.insertId, registrationId: registration.insertId };
  } catch (error) { await db.rollback(); throw error; }
  finally { await db.end(); }
}

async function detail(page: Page, id: number) {
  await page.getByRole('button', { name: `查看操作记录 ${id} 详情`, exact: true }).click();
  await expect(page.getByTestId('audit-log-detail')).toBeVisible();
  return page.getByTestId('audit-log-detail');
}

async function closeDetail(page: Page, id: number) {
  const trigger = page.getByRole('button', { name: `查看操作记录 ${id} 详情`, exact: true });
  const dialog = page.getByRole('dialog', { name: '操作记录详情', exact: true });
  const drawer = await dialog.evaluateHandle(element => element.closest('.ant-drawer'));
  try {
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('.ant-drawer-mask:visible')).toHaveCount(0);
    // rc-drawer calls afterOpenChange(false) and restores its captured focus
    // before destroyOnHidden unmounts this root. The captured element can differ
    // from the detail trigger, so observe completed destruction, not its identity.
    await expect.poll(() => drawer.evaluate(element => !!element && !element.isConnected)).toBeTruthy();
  } finally { await drawer.dispose(); }
  await expect(trigger).toBeVisible();
  await expect(page.getByTestId('audit-log-detail')).toHaveCount(0);
}

async function finishTest(primaryError: unknown, cleanup: Array<() => Promise<unknown>>) {
  const errors: unknown[] = primaryError === undefined ? [] : [primaryError];
  for (const operation of cleanup) {
    try { await operation(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'The audit test and its cleanup failed; the first error is the original test failure.');
}

async function assertDetailId(page: Page, id: number) {
  await expect(page.getByTestId('audit-log-detail').locator('.ant-descriptions-item-content').first()).toHaveText(String(id));
}

async function revokedSessionCookie(request: APIRequestContext) {
  // This independent fixture Session belongs to this test. Revoking it must not
  // change the browser's valid Session or its in-memory authentication generation.
  const state = await request.storageState();
  const session = state.cookies.find(cookie => cookie.name === 'JSESSIONID');
  expect(!!session?.value).toBeTruthy();
  const cookie = `JSESSIONID=${session!.value}`;
  await logoutApi(request);
  expect((await request.get('/api/auth/me', { headers: { Cookie: cookie } })).status()).toBe(401);
  return cookie; // Kept only in memory; never persisted, attached, or logged.
}

async function holdDetail(page: Page, id: number, status: 200 | 401, revokedCookie?: string) {
  const pattern = `**${listApi}/${id}`;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let fetched!: () => void;
  let rejectFetched!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { fetched = resolve; rejectFetched = reject; });
  const jobs: Promise<void>[] = [];
  await page.route(pattern, route => {
    const job = (async () => {
      try {
        let response;
        try {
          response = await route.fetch(revokedCookie ? {
            headers: { ...route.request().headers(), cookie: revokedCookie },
          } : undefined);
        } catch { throw new Error('The held audit detail could not be read from the real server.'); }
        expect(response.status()).toBe(status);
        if (status === 200) expect((await response.json()).id).toBe(id);
        else expect((await response.json()).code).toBe('UNAUTHENTICATED');
        fetched();
        await held;
        try { await route.fulfill({ response }); } catch { /* Closed details already cancelled the old genuine response. */ }
      } catch (error) { rejectFetched(error); throw error; }
    })();
    jobs.push(job);
    return job;
  });
  return { ready, release, delivered: () => Promise.all(jobs), cleanup: async () => {
    release(); await finishTest(undefined, [() => Promise.all(jobs), () => page.unroute(pattern)]);
  } };
}

async function twoLogs(request: APIRequestContext, info: TestInfo) {
  await loginApi(request);
  const activity = await create(request, info);
  recordFixtureEditIntent(activity.key, `${activity.title} 已编辑`, activity.description);
  expect((await write(request, `/api/admin/activities/${activity.id}`, 'PATCH', {
    title: `${activity.title} 已编辑`, description: activity.description, location: '详情范围验证的新场地',
  })).status()).toBe(200);
  const result = await list(request, activity.id);
  expect(result.items.map(row => row.action)).toEqual(['EDIT', 'CREATE']);
  return { activity, result, older: result.items[1], newer: result.items[0] };
}

async function openAuditFromNavigation(page: Page) {
  const mobileMenu = page.getByRole('button', { name: '打开导航', exact: true });
  if (await mobileMenu.isVisible()) await mobileMenu.click();
  await page.getByRole('link', { name: '操作记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '管理员操作记录', exact: true })).toBeVisible();
}

test('四类管理员操作的真实快照、长文本前后值和只读详情在桌面手机可用', async ({ page, request, playwright }, info) => {
  test.setTimeout(120000);
  const admin = await loginApi(request);
  const original = await create(request, info, true);
  const afterTitle = `${original.title} 已编辑`;
  const afterDescription = `新介绍 <img src=x onerror=window.__gatherAuditInjection=true>\n${'修改后的中文长描述。\n'.repeat(60)}${original.description}`;
  recordFixtureEditIntent(original.key, afterTitle, afterDescription);
  const changes = { title: afterTitle, description: afterDescription, location: '操作记录新场地' };
  expect((await write(request, `/api/admin/activities/${original.id}`, 'PATCH', changes)).status()).toBe(200);
  expect((await write(request, `/api/admin/activities/${original.id}`, 'PATCH', changes)).status()).toBe(200); // No-op is not a new event.
  const reason = '临时验证取消，保留 <b>原始文本</b>。';
  const cancellation = await write(request, `/api/admin/activities/${original.id}/cancel`, 'POST', { reason });
  expect(cancellation.status()).toBe(200);
  expect((await write(request, `/api/admin/activities/${original.id}/cancel`, 'POST', { reason: '不覆盖首次原因' })).status()).toBe(200);
  const account = await register(request);
  const attendance = await started(request, account, info);
  const checkedIn = await write(request, `/api/admin/activities/${attendance.id}/registrations/${attendance.registrationId}/check-in`);
  expect(checkedIn.status()).toBe(200);
  const signed = await checkedIn.json();
  expect(signed).toMatchObject({ checkInMethod: 'ADMIN', checkInVersion: 1, checkedInBy: admin.id });
  expect((await write(request, `/api/admin/activities/${attendance.id}/registrations/${attendance.registrationId}/check-in`)).status()).toBe(200);
  const participant = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  let primaryError: unknown;
  try {
    await loginApi(participant, account);
    expect((await write(participant, '/api/me/profile', 'PATCH', { displayName: account.allowedDisplayNames[1] })).status()).toBe(200);
    const futureLogs = await list(request, original.id);
    expect(futureLogs.total).toBe(3);
    expect(futureLogs.items.map(row => row.action)).toEqual(['CANCEL', 'EDIT', 'CREATE']);
    expect(futureLogs.items.map(row => row.activityTitle)).toEqual([afterTitle, afterTitle, original.title]);
    expect(futureLogs.items.every(row => row.actorUserId === admin.id && row.actorUsername === admin.username
      && row.actorDisplayName === admin.displayName && !Object.hasOwn(row, 'changes'))).toBeTruthy();
    const attendanceLogs = await list(request, attendance.id);
    expect(attendanceLogs.total).toBe(1);
    expect(attendanceLogs.items[0]).toMatchObject({ action: 'CHECK_IN', targetUsername: account.username,
      targetDisplayName: account.displayName, registrationId: attendance.registrationId });
    await login(page);
    await page.goto('/admin/activities');
    await page.getByRole('textbox', { name: '搜索活动', exact: true }).fill(afterTitle);
    await page.getByRole('button', { name: '查询', exact: true }).click();
    const row = page.locator(`[data-activity-id="${original.id}"]`);
    await expect(row).toBeVisible();
    await row.getByRole('link', { name: '操作记录', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/audit-logs\\?activityId=${original.id}$`));
    await assertList(page, futureLogs);
    await capture(page, info, 'audit-four-actions-list');
    for (const action of ['CREATE', 'EDIT', 'CANCEL'] as const) {
      await choose(page, '操作类型', labels[action]);
      const expected = await list(request, original.id, action);
      await assertList(page, expected);
      const content = await detail(page, expected.items[0].id);
      await expect(content).toContainText(expected.items[0].activityTitle);
      await expect(content).toContainText(admin.displayName);
      const instant = expected.items[0].occurredAt;
      const local = new Date(Date.parse(instant) + 8 * 3600000).toISOString();
      const fraction = (instant.match(/\.(\d+)Z$/)?.[1] ?? '').padEnd(6, '0');
      await expect(content).toContainText(`${local.slice(11, 19)}.${fraction}`);
      if (action === 'CREATE') {
        await expect(page.getByTestId('audit-before-title')).toHaveText('未设置');
        expect(await page.getByTestId('audit-after-title').textContent()).toBe(original.title);
      } else if (action === 'EDIT') {
        expect(await page.getByTestId('audit-before-description').textContent()).toBe(original.description);
        expect(await page.getByTestId('audit-after-description').textContent()).toBe(afterDescription);
        expect(await page.getByTestId('audit-before-title').textContent()).toBe(original.title);
        expect(await page.getByTestId('audit-after-title').textContent()).toBe(afterTitle);
        await expect(content.locator('script, img')).toHaveCount(0);
        expect(await page.evaluate(() => Object.prototype.hasOwnProperty.call(window, '__gatherAuditInjection'))).toBeFalsy();
        await capture(page, info, 'audit-long-plaintext-detail');
      } else expect(await page.getByTestId('audit-after-cancellationReason').textContent()).toBe(reason);
      await closeDetail(page, expected.items[0].id);
    }
    await choose(page, '操作类型', labels.CHECK_IN);
    await page.getByLabel('筛选活动 ID', { exact: true }).fill(String(attendance.id));
    await page.getByRole('button', { name: '查询记录', exact: true }).click();
    await assertList(page, attendanceLogs);
    const content = await detail(page, attendanceLogs.items[0].id);
    await expect(content).toContainText(account.displayName);
    await expect(content).not.toContainText(account.allowedDisplayNames[1]);
    await expect(content).toContainText(account.username);
    await expect(page.getByTestId('audit-before-checkedInAt')).toHaveText('未设置');
    await expect(page.getByTestId('audit-before-checkedInBy')).toHaveText('未设置');
    await expect(page.getByTestId('audit-after-checkedInBy')).toHaveText(String(admin.id));
    await expect(page.getByTestId('audit-before-checkInMethod')).toHaveText('未设置');
    await expect(page.getByTestId('audit-after-checkInMethod')).toHaveText('管理员确认');
    const actualDetail = await (await request.get(`${listApi}/${attendanceLogs.items[0].id}`)).json();
    expect(actualDetail.changes).toEqual([
      { field: 'checkedInAt', before: null, after: signed.checkedInAt },
      { field: 'checkedInBy', before: null, after: String(admin.id) },
      { field: 'checkInMethod', before: null, after: 'ADMIN' },
    ]);
    await capture(page, info, 'audit-checkin-snapshot');
  } catch (error) { primaryError = error; }
  finally {
    await finishTest(primaryError, [() => logoutApi(participant), () => participant.dispose(),
      () => logoutApi(page.request), () => logoutApi(request)]);
  }
});

test('操作记录筛选分页和浏览器历史保留URL，刷新、数量变化、越界及空结果正确', async ({ page, request }, info) => {
  await loginApi(request);
  const activity = await create(request, info);
  for (let index = 1; index <= 11; index++) expect((await write(request, `/api/admin/activities/${activity.id}`, 'PATCH', {
    title: activity.title, description: activity.description, location: `分页独立场地 ${index}`,
  })).status()).toBe(200);
  await login(page);
  await page.goto(`${listPage}?activityId=${activity.id}`);
  await assertList(page, await list(request, activity.id));
  await page.locator('.ant-pagination-item[title="2"]').click();
  await expect(page).toHaveURL(new RegExp(`\\?page=2&activityId=${activity.id}$`));
  await assertList(page, await list(request, activity.id, 'ALL', 2));
  await choose(page, '操作类型', '编辑活动');
  await expect(page).toHaveURL(new RegExp(`\\?action=EDIT&activityId=${activity.id}$`));
  await assertList(page, await list(request, activity.id, 'EDIT'));
  await page.locator('.ant-pagination-item[title="2"]').click();
  const pageTwoUrl = `${listPage}?action=EDIT&page=2&activityId=${activity.id}`;
  await expect(page).toHaveURL(new RegExp(`${pageTwoUrl.replaceAll('?', '\\?')}$`));
  const second = await list(request, activity.id, 'EDIT', 2);
  await assertList(page, second);
  await detail(page, second.items[0].id);
  await closeDetail(page, second.items[0].id);
  await page.getByRole('button', { name: '刷新操作记录', exact: true }).click();
  await expect(page.getByTestId('audit-log-detail')).toHaveCount(0);
  await assertList(page, second);
  await page.reload();
  await assertList(page, second);
  await detail(page, second.items[0].id);
  // Browser history is a real scope change even while the drawer masks page controls.
  await page.goBack();
  await expect(page.getByTestId('audit-log-detail')).toHaveCount(0);
  await assertList(page, await list(request, activity.id, 'EDIT'));
  await page.goForward();
  await assertList(page, second);
  await choose(page, '每页操作记录数量', '20 条/页');
  await expect(page).toHaveURL(new RegExp(`\\?action=EDIT&pageSize=20&activityId=${activity.id}$`));
  await assertList(page, await list(request, activity.id, 'EDIT', 1, 20));
  await page.goto(`${listPage}?action=EDIT&page=999&pageSize=20&activityId=${activity.id}`);
  await expect(page).toHaveURL(new RegExp(`\\?action=EDIT&pageSize=20&activityId=${activity.id}$`));
  await assertList(page, await list(request, activity.id, 'EDIT', 1, 20));
  await page.getByLabel('筛选活动 ID', { exact: true }).fill('9007199254740992');
  await page.getByRole('button', { name: '查询记录', exact: true }).click();
  await expect(page.getByText('活动 ID 必须为正整数，且不超过 9007199254740991。', { exact: true })).toBeVisible();
  await page.getByLabel('筛选活动 ID', { exact: true }).fill('9007199254740991');
  await page.getByRole('button', { name: '查询记录', exact: true }).click();
  await assertList(page, { items: [], total: 0, page: 1, pageSize: 20 });
  await expect(page.getByText('暂无符合条件的操作记录', { exact: true })).toBeVisible();
  await capture(page, info, 'audit-empty-filter');
  await logoutApi(page.request); await logoutApi(request);
});

test('操作记录的未登录与普通用户权限、列表失败和详情失败可真实重试', async ({ page, request }, info) => {
  await loginApi(request);
  const activity = await create(request, info);
  const account = await register(request);
  let managementReads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith(listApi)) managementReads++; });
  await page.goto(listPage);
  await expect(page).toHaveURL(/\/login$/);
  expect(managementReads).toBe(0);
  expect((await page.request.get(listApi)).status()).toBe(401);
  await loginForm(page, account);
  await page.goto(listPage);
  await expect(page.getByText('此页面仅对活动组织者开放', { exact: true })).toBeVisible();
  expect(managementReads).toBe(0);
  expect((await page.request.get(listApi)).status()).toBe(403);
  const row = (await list(request, activity.id)).items[0];
  expect((await page.request.get(`${listApi}/${row.id}`)).status()).toBe(403);
  await logout(page);
  await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
  await loginForm(page);
  await page.route('**/api/admin/audit-logs?**', route => route.abort('failed'));
  await page.goto(`${listPage}?activityId=${activity.id}`);
  await expect(page.getByText(networkError, { exact: true })).toBeVisible();
  await expect(page.getByTestId('audit-total')).toHaveCount(0);
  await page.unroute('**/api/admin/audit-logs?**');
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await assertList(page, await list(request, activity.id));
  await page.route(`**${listApi}/${row.id}`, route => route.abort('failed'));
  await page.getByRole('button', { name: `查看操作记录 ${row.id} 详情`, exact: true }).click();
  await expect(page.getByRole('dialog', { name: '操作记录详情', exact: true }).getByText(networkError, { exact: true })).toBeVisible();
  await page.unroute(`**${listApi}/${row.id}`);
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.getByTestId('audit-log-detail')).toContainText(activity.title);
  await capture(page, info, 'audit-real-retry');
  await logoutApi(page.request); await logoutApi(request);
});

for (const lateStatus of [200, 401]) {
  test(`操作记录真实迟到 ${lateStatus} 不覆盖同SPA中重新登录的普通用户会话`, async ({ page, request }, info) => {
    await loginApi(request);
    const activity = await create(request, info);
    const account = await register(request);
    await login(page);
    await page.goto(`${listPage}?activityId=${activity.id}`);
    await assertList(page, await list(request, activity.id));
    if (lateStatus === 401) await logoutApi(page.request); // Provider still has the old identity until the held real response is delivered.
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let fetched!: () => void;
    let rejectFetched!: (reason: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { fetched = resolve; rejectFetched = reject; });
    const jobs: Promise<void>[] = [];
    await page.route('**/api/admin/audit-logs?**', route => {
      const job = (async () => {
        try {
          const response = await route.fetch();
          expect(response.status()).toBe(lateStatus);
          fetched();
          await hold;
          try { await route.fulfill({ response }); } catch { /* A completed page cleanup may already have aborted the old response. */ }
        } catch (error) { rejectFetched(error); throw error; }
      })();
      jobs.push(job);
      return job;
    });
    let primaryError: unknown;
    try {
      await page.getByRole('button', { name: '刷新操作记录', exact: true }).click();
      await ready;
      await logout(page);
      await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
      await loginForm(page, account);
      await page.getByRole('button', { name: /账号菜单/ }).click();
      await page.getByRole('menuitem', { name: '个人中心', exact: true }).click();
      await expect(page.getByRole('heading', { name: '个人中心', exact: true })).toBeVisible();
      release();
      await Promise.all(jobs);
      await expect(page).toHaveURL(/\/profile$/);
      await expect(page.getByRole('button', { name: `账号菜单，${account.displayName}`, exact: true })).toBeVisible();
      await expect(page.locator('[data-audit-id]')).toHaveCount(0);
      await expect(page.getByText(activity.title, { exact: true })).toHaveCount(0);
      const me = await page.request.get('/api/auth/me');
      expect(me.status()).toBe(200);
      expect(await me.json()).toMatchObject({ id: account.id, username: account.username, role: 'USER' });
      await capture(page, info, `audit-late-${lateStatus}-new-session`);
    } catch (error) { primaryError = error; }
    finally {
      release();
      await finishTest(primaryError, [() => Promise.all(jobs), () => page.unroute('**/api/admin/audit-logs?**'),
        () => logoutApi(page.request), () => logoutApi(request)]);
    }
  });
}

test('旧详情真实迟到401不退出同一管理员会话，也不覆盖另一条详情', async ({ page, request }, info) => {
  const { activity, result, older, newer } = await twoLogs(request, info);
  await login(page);
  await page.goto(`${listPage}?activityId=${activity.id}`);
  await assertList(page, result);
  const before = await (await page.request.get('/api/auth/me')).json();
  const expiredCookie = await revokedSessionCookie(request);
  const held = await holdDetail(page, older.id, 401, expiredCookie);
  let primaryError: unknown;
  try {
    await page.getByRole('button', { name: `查看操作记录 ${older.id} 详情`, exact: true }).click();
    await held.ready;
    expect((await page.request.get('/api/auth/me')).status()).toBe(200);
    await closeDetail(page, older.id);
    await detail(page, newer.id);
    await assertDetailId(page, newer.id);
    held.release();
    await held.delivered();
    await assertDetailId(page, newer.id);
    await expect(page.getByRole('dialog', { name: '操作记录详情', exact: true })).toBeVisible();
    await expect(page.getByText('请先登录', { exact: true })).toHaveCount(0);
    const current = await page.request.get('/api/auth/me');
    expect(current.status()).toBe(200);
    expect(await current.json()).toMatchObject({ id: before.id, username: 'admin', role: 'ADMIN' });
    await capture(page, info, 'audit-old-detail-401-current-scope');
  } catch (error) { primaryError = error; }
  finally { await finishTest(primaryError, [held.cleanup, () => logoutApi(page.request), () => logoutApi(request)]); }
});

for (const lateStatus of [200, 401] as const) {
  test(`旧详情真实迟到${lateStatus}不污染同SPA中相同管理员重新登录后的新详情`, async ({ page, request }, info) => {
    const { activity, result, older, newer } = await twoLogs(request, info);
    await login(page);
    await page.goto(`${listPage}?activityId=${activity.id}`);
    await assertList(page, result);
    const initialUser = await (await page.request.get('/api/auth/me')).json();
    const expiredCookie = lateStatus === 401 ? await revokedSessionCookie(request) : undefined;
    const held = await holdDetail(page, older.id, lateStatus, expiredCookie);
    let primaryError: unknown;
    try {
      await page.getByRole('button', { name: `查看操作记录 ${older.id} 详情`, exact: true }).click();
      await held.ready;
      await closeDetail(page, older.id);
      await logout(page);
      await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
      await loginForm(page); // Same administrator ID, new real Session and authentication generation.
      await openAuditFromNavigation(page);
      await page.getByLabel('筛选活动 ID', { exact: true }).fill(String(activity.id));
      await page.getByRole('button', { name: '查询记录', exact: true }).click();
      await assertList(page, result);
      await detail(page, newer.id);
      await assertDetailId(page, newer.id);
      held.release();
      await held.delivered();
      await assertDetailId(page, newer.id);
      await expect(page).toHaveURL(new RegExp(`/admin/audit-logs\\?activityId=${activity.id}$`));
      const current = await page.request.get('/api/auth/me');
      expect(current.status()).toBe(200);
      expect(await current.json()).toMatchObject({ id: initialUser.id, username: 'admin', role: 'ADMIN' });
      await expect(page.getByRole('button', { name: /账号菜单/ })).toBeVisible();
      await capture(page, info, `audit-detail-late-${lateStatus}-same-admin-new-session`);
    } catch (error) { primaryError = error; }
    finally { await finishTest(primaryError, [held.cleanup, () => logoutApi(page.request), () => logoutApi(request)]); }
  });
}
