import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { trackFixture, recordFixtureId } from '../scripts/e2e-cleanup.mjs';

// Authentication and writes use real sessions; no request bodies or cookies in traces.
test.use({ trace: 'off' });
const categories = { UNCATEGORIZED: '未分类', TECHNOLOGY: '技术交流', SPORTS: '运动户外', CULTURE: '文化艺术', OTHER: '其他' };
type Category = keyof typeof categories;
type Kind = 'public' | 'admin';
interface Activity { id: number; title: string; description: string; location: string; category: Category;
  capacity: number; registeredCount: number; waitingCount: number; startsAt: string; registrationStatus: string | null }
interface Result { items: Activity[]; total: number; page: number; pageSize: number;
  summary?: { upcomingActivities: number; availableSeats: number } }
interface Query { keyword?: string; status?: string; category?: Category | 'ALL'; page?: number; pageSize?: number }
const endpoint = (kind: Kind) => kind === 'public' ? '/api/activities/search' : '/api/admin/activities';
const pathname = (kind: Kind) => kind === 'public' ? '/activities' : '/admin/activities';
const defaultSize = (kind: Kind) => kind === 'public' ? 12 : 10;
function normalized(kind: Kind, query: Query) {
  return { keyword: query.keyword ?? '', status: query.status ?? 'ALL', category: query.category ?? 'ALL',
    page: query.page ?? 1, pageSize: query.pageSize ?? defaultSize(kind) };
}
function parameters(kind: Kind, query: Query, canonical = false) {
  const current = normalized(kind, query);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(current)) {
    const omit = key === 'keyword' ? value === '' : key === 'status' || key === 'category' ? value === 'ALL'
      : key === 'page' ? value === 1 : value === defaultSize(kind);
    if (!canonical || !omit) params.set(key, String(value));
  }
  return params;
}
function url(kind: Kind, query: Query) {
  const search = parameters(kind, query, true).toString();
  return `${pathname(kind)}${search ? `?${search}` : ''}`;
}
function matches(raw: string, kind: Kind, query: Query) {
  const actual = new URL(raw);
  return actual.pathname === endpoint(kind) && [...parameters(kind, query)].every(([key, value]) => actual.searchParams.get(key) === value);
}
async function completed(page: Page, kind: Kind, query: Query) {
  const request = await page.waitForEvent('requestfinished', { predicate: request => request.method() === 'GET' && matches(request.url(), kind, query) });
  const response = await request.response();
  expect(response?.status()).toBe(200);
  return response!.json() as Promise<Result>;
}
async function open(page: Page, kind: Kind, query: Query) {
  const loaded = completed(page, kind, query);
  await page.goto(url(kind, query));
  const result = await loaded;
  await assertView(page, kind, result);
  return result;
}
async function assertUrl(page: Page, kind: Kind, query: Query) {
  await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe(url(kind, query));
}
async function assertView(page: Page, kind: Kind, result: Result) {
  await expect(page.locator('[data-activity-id]')).toHaveCount(result.items.length);
  await expect.poll(() => page.locator('[data-activity-id]').evaluateAll(rows => rows.map(row => Number(row.getAttribute('data-activity-id')))))
    .toEqual(result.items.map(row => row.id));
  for (const item of result.items) {
    const row = page.locator(`[data-activity-id="${item.id}"]`);
    if (kind === 'public') await expect(row.getByTestId(`activity-category-${item.id}`)).toHaveText(categories[item.category]);
    else await expect(row).toContainText(categories[item.category]);
  }
  if (kind === 'public') {
    await expect(page.locator('.section-heading').getByText(`共 ${result.total} 场活动`, { exact: true })).toBeVisible();
    for (const [key, value] of Object.entries(result.summary!))
      await expect.poll(async () => (await page.getByTestId(`discovery-${key}`).locator('.ant-statistic-content-value').innerText()).replace(/[\s,]/g, ''))
        .toBe(String(value));
  } else await expect(page.getByText(`共 ${result.total} 场活动`, { exact: true })).toBeVisible();
}
async function choose(page: Page, label: string, text: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ has: page.getByText(text, { exact: true }) }).click();
  await expect(page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')).toHaveCount(0);
}
async function write(request: APIRequestContext, path: string, method: 'POST' | 'PATCH' | 'DELETE' = 'POST', data?: unknown) {
  const csrf = await request.get('/api/auth/csrf');
  expect(csrf.status()).toBe(200);
  const token = await csrf.json();
  return request.fetch(path, { method, headers: { [token.headerName]: token.token }, data });
}
async function loginApi(request: APIRequestContext, username = 'admin') {
  const csrf = await (await request.get('/api/auth/csrf')).json();
  const response = await request.post('/api/auth/login', { headers: { [csrf.headerName]: csrf.token },
    form: { username, password: username === 'admin' ? 'Admin123!' : 'Demo123!' } });
  expect(response.status()).toBe(200);
  return response.json();
}
async function logoutApi(request: APIRequestContext) {
  const me = await request.get('/api/auth/me');
  if (me.status() === 401) return;
  expect(me.status()).toBe(200);
  expect((await write(request, '/api/auth/logout')).status()).toBe(200);
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
async function navigate(page: Page, name: string) {
  const menu = page.getByRole('button', { name: '打开导航', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('link', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
function prefix(info: TestInfo, purpose: string) { return `分类 ${info.project.name} ${purpose} ${randomUUID().slice(0, 8)}`; }
async function create(request: APIRequestContext, title: string, category?: Category | null, capacity = 2) {
  const fixture = trackFixture(title, '活动分类真实浏览器回归，只清理本轮完整归属的数据。');
  const response = await write(request, '/api/admin/activities', 'POST', { title: fixture.title, description: fixture.description,
    location: '分类回归场地', capacity, startsAt: new Date(Date.now() + 48 * 3600000).toISOString(), category });
  expect(response.status()).toBe(201);
  const activity = await response.json() as Activity;
  recordFixtureId(fixture.key, activity.id);
  expect(activity.category).toBe(category ?? 'UNCATEGORIZED');
  return activity;
}
function editBody(activity: Activity, category?: unknown) {
  return { title: activity.title, description: activity.description, location: activity.location, category };
}
async function edit(request: APIRequestContext, activity: Activity, category?: unknown) {
  return write(request, `/api/admin/activities/${activity.id}`, 'PATCH', editBody(activity, category));
}
async function capture(page: Page, info: TestInfo, name: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  const dialog = page.getByRole('dialog', { name: '操作记录详情', exact: true });
  const isDialog = await dialog.isVisible();
  if (isDialog) await expect.poll(() => dialog.evaluate(element => {
    const wrapper = element.closest('.ant-drawer-content-wrapper') ?? element;
    const rect = wrapper.getBoundingClientRect();
    return !wrapper.getAnimations({ subtree: true }).some(animation => animation.playState === 'running')
      && rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1;
  })).toBeTruthy();
  else await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: !isDialog });
  await info.attach(name, { path, contentType: 'image/png' });
}
async function finish(primary: unknown, operations: Array<() => Promise<unknown>>) {
  const failures: unknown[] = primary === undefined ? [] : [primary];
  for (const operation of operations) try { await operation(); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Classification verification and cleanup failed; the first error is preserved.');
}

test('真实页面发布分类、卡片详情及仅分类编辑生成中文前后值审计', async ({ page, request }, info) => {
  let primary: unknown;
  try {
    const fixture = trackFixture(prefix(info, '发布编辑'), '通过真实表单发布并只改变分类，保留标题介绍归属。');
    await login(page);
    await page.goto('/admin/activities/new');
    await page.getByLabel('活动标题', { exact: true }).fill(fixture.title);
    await page.getByLabel('活动介绍', { exact: true }).fill(fixture.description);
    await page.getByLabel('活动地点', { exact: true }).fill('分类表单场地');
    await page.getByLabel('开始时间（北京时间）', { exact: true }).fill(new Date(Date.now() + 56 * 3600000).toISOString().slice(0, 16));
    await page.getByRole('spinbutton', { name: '报名名额' }).fill('3');
    await choose(page, '活动分类', categories.TECHNOLOGY);
    const creating = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/activities' && response.request().method() === 'POST');
    await page.getByRole('main').getByRole('button', { name: '发布活动', exact: true }).click();
    const created = await creating;
    expect(created.status()).toBe(201);
    const original = await created.json() as Activity;
    recordFixtureId(fixture.key, original.id);
    expect(original.category).toBe('TECHNOLOGY');
    await expect(page.getByTestId(`activity-category-${original.id}`)).toHaveText(categories.TECHNOLOGY);
    await open(page, 'public', { keyword: fixture.title, category: 'TECHNOLOGY' });
    await page.getByRole('link', { name: `查看${fixture.title}的详情`, exact: true }).click();
    await expect(page.getByTestId(`activity-category-${original.id}`)).toHaveText(categories.TECHNOLOGY);
    await page.getByRole('link', { name: '编辑活动', exact: true }).click();
    await expect(page.getByLabel('活动标题', { exact: true })).toHaveValue(original.title);
    await choose(page, '活动分类', categories.CULTURE);
    const saving = page.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/activities/${original.id}` && response.request().method() === 'PATCH');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    const saved = await saving;
    expect(saved.status()).toBe(200);
    const updated = await saved.json() as Activity;
    expect(updated).toEqual({ ...original, category: 'CULTURE' });
    await expect(page.getByTestId(`activity-category-${original.id}`)).toHaveText(categories.CULTURE);
    const audit = await (await page.request.get(`/api/admin/audit-logs?activityId=${original.id}`)).json();
    expect(audit.items.map((row: { action: string }) => row.action)).toEqual(['EDIT', 'CREATE']);
    const detail = await (await page.request.get(`/api/admin/audit-logs/${audit.items[0].id}`)).json();
    expect(detail.changes).toEqual([{ field: 'category', before: 'TECHNOLOGY', after: 'CULTURE' }]);
    const initial = await (await page.request.get(`/api/admin/audit-logs/${audit.items[1].id}`)).json();
    expect(initial.changes.find((change: { field: string }) => change.field === 'category')).toEqual({ field: 'category', before: null, after: 'TECHNOLOGY' });
    await page.goto(`/admin/audit-logs?activityId=${original.id}&action=EDIT`);
    await page.getByRole('button', { name: `查看操作记录 ${audit.items[0].id} 详情`, exact: true }).click();
    await expect(page.getByTestId('audit-before-category')).toHaveText(categories.TECHNOLOGY);
    await expect(page.getByTestId('audit-after-category')).toHaveText(categories.CULTURE);
    await capture(page, info, 'category-only-edit-audit');
  } catch (error) { primary = error; }
  finally { await finish(primary, [() => logoutApi(page.request), () => logoutApi(request)]); }
});

test('公开分类与状态关键词共同筛选，全量统计、分页历史刷新及详情登录返回保留分类', async ({ page, request }, info) => {
  let primary: unknown;
  try {
    await loginApi(request);
    const keyword = prefix(info, '公开分页');
    const fixtures: Activity[] = [];
    for (let index = 0; index < 13; index++) fixtures.push(await create(request, `${keyword} ${index}`, 'TECHNOLOGY'));
    const sports = await create(request, `${keyword} 体育`, 'SPORTS');
    const full = await create(request, `${keyword} 满员`, 'TECHNOLOGY', 1);
    expect((await write(request, `/api/activities/${full.id}/registration`)).status()).toBe(200);
    const query: Query = { keyword, status: 'OPEN', category: 'TECHNOLOGY' };
    const first = await open(page, 'public', query);
    expect(first).toMatchObject({ total: 13, summary: { upcomingActivities: 13, availableSeats: 26 } });
    expect(first.items).toHaveLength(12);
    const lastQuery = { ...query, page: 2 };
    const lastRead = completed(page, 'public', lastQuery);
    await page.locator('.ant-pagination-item[title="2"]').click();
    const last = await lastRead;
    expect(last.items).toHaveLength(1);
    expect(new Set([...first.items, ...last.items].map(row => row.id))).toEqual(new Set(fixtures.map(row => row.id)));
    expect(last.summary).toEqual(first.summary);
    await assertView(page, 'public', last); await assertUrl(page, 'public', lastQuery);
    const refreshing = completed(page, 'public', lastQuery); await page.reload(); await assertView(page, 'public', await refreshing);
    const backward = completed(page, 'public', query); await page.goBack(); await assertView(page, 'public', await backward);
    const forward = completed(page, 'public', lastQuery); await page.goForward(); await assertView(page, 'public', await forward);
    await page.getByRole('link', { name: `查看${last.items[0].title}的详情`, exact: true }).click();
    expect(new URL(page.url()).searchParams.get('from')).toBe(url('public', lastQuery));
    await page.getByRole('button', { name: '登录后报名', exact: true }).click();
    await loginForm(page, 'demo');
    await expect(page.getByTestId(`activity-category-${last.items[0].id}`)).toHaveText(categories.TECHNOLOGY);
    const returned = completed(page, 'public', lastQuery);
    await page.getByRole('link', { name: '返回活动列表', exact: true }).click();
    await assertView(page, 'public', await returned); await assertUrl(page, 'public', lastQuery);
    const resizedQuery = { ...query, pageSize: 24 };
    const resized = completed(page, 'public', resizedQuery); await choose(page, '每页数量', '24 条/页');
    expect((await resized).items).toHaveLength(13); await assertUrl(page, 'public', resizedQuery);
    const sportsQuery = { ...resizedQuery, category: 'SPORTS' as const };
    const next = completed(page, 'public', sportsQuery); await choose(page, '活动分类', categories.SPORTS);
    const matching = await next;
    expect(matching.items.map(row => row.id)).toEqual([sports.id]);
    expect(matching.summary).toEqual({ upcomingActivities: 1, availableSeats: 2 });
    await assertView(page, 'public', matching); await assertUrl(page, 'public', sportsQuery);
    await capture(page, info, 'category-public-filter');
    const reset = completed(page, 'public', { pageSize: 24 }); await page.getByRole('button', { name: /^重\s*置$/ }).click();
    await assertView(page, 'public', await reset); await assertUrl(page, 'public', { pageSize: 24 });
  } catch (error) { primary = error; }
  finally { await finish(primary, [() => logoutApi(page.request), () => logoutApi(request)]); }
});

test('管理分类URL支持复合筛选、分页刷新历史与同条件刷新，分类移出末页后replace修正', async ({ page, request }, info) => {
  let primary: unknown;
  try {
    await loginApi(request);
    const keyword = prefix(info, '管理分页');
    const fixtures: Activity[] = [];
    for (let index = 0; index < 11; index++) fixtures.push(await create(request, `${keyword} ${index}`, 'TECHNOLOGY'));
    await create(request, `${keyword} 体育`, 'SPORTS');
    const full = await create(request, `${keyword} 满员`, 'TECHNOLOGY', 1);
    expect((await write(request, `/api/activities/${full.id}/registration`)).status()).toBe(200);
    await login(page);
    const query: Query = { keyword, status: 'OPEN', category: 'TECHNOLOGY' };
    const first = await open(page, 'admin', query);
    expect(first.total).toBe(11); expect(first.items).toHaveLength(10);
    const lastQuery = { ...query, page: 2 };
    const lastRead = completed(page, 'admin', lastQuery); await page.locator('.ant-pagination-item[title="2"]').click();
    const last = await lastRead; await assertView(page, 'admin', last); await assertUrl(page, 'admin', lastQuery);
    expect(last.items).toHaveLength(1);
    const refreshed = completed(page, 'admin', lastQuery); await page.reload(); await assertView(page, 'admin', await refreshed);
    const backward = completed(page, 'admin', query); await page.goBack(); await assertView(page, 'admin', await backward);
    const forward = completed(page, 'admin', lastQuery); await page.goForward(); await assertView(page, 'admin', await forward);
    const resizedQuery = { ...query, pageSize: 20 };
    const resized = completed(page, 'admin', resizedQuery); await choose(page, '每页管理活动数量', '20 条/页');
    expect((await resized).items).toHaveLength(11); await assertUrl(page, 'admin', resizedQuery);
    const again = completed(page, 'admin', resizedQuery); await page.getByRole('button', { name: '查询', exact: true }).click();
    await assertView(page, 'admin', await again); // Same conditions perform a real new HTTP read.
    await open(page, 'admin', lastQuery);
    const target = fixtures.find(item => item.id === last.items[0].id)!;
    expect((await edit(request, target, 'SPORTS')).status()).toBe(200);
    let outsideRequests = 0;
    const countOutside = (request: { url(): string }) => { if (matches(request.url(), 'admin', lastQuery)) outsideRequests++; };
    page.on('request', countOutside);
    const historyLength = await page.evaluate(() => window.history.length);
    const outside = completed(page, 'admin', lastQuery), corrected = completed(page, 'admin', query);
    await page.getByRole('button', { name: '刷新活动', exact: true }).click();
    expect(await outside).toMatchObject({ total: 10, page: 2, items: [] });
    const current = await corrected;
    expect(current).toMatchObject({ total: 10, page: 1 });
    await assertView(page, 'admin', current); await assertUrl(page, 'admin', query);
    expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
    expect(outsideRequests).toBe(1);
    const sportsQuery = { ...query, category: 'SPORTS' as const };
    const categoryRead = completed(page, 'admin', sportsQuery); await choose(page, '活动分类', categories.SPORTS);
    expect((await categoryRead).total).toBe(2); await assertUrl(page, 'admin', sportsQuery);
    const history = completed(page, 'admin', query); await page.goBack(); await assertView(page, 'admin', await history);
    await assertUrl(page, 'admin', query); expect(outsideRequests).toBe(1);
    page.off('request', countOutside);
    await capture(page, info, 'category-admin-filter');
  } catch (error) { primary = error; }
  finally { await finish(primary, [() => logoutApi(page.request), () => logoutApi(request)]); }
});

test('旧客户端默认和null分类保持兼容，五类贯穿数组个人嵌套与写响应，非法写入和查询由后端400拒绝', async ({ page, request }, info) => {
  let primary: unknown;
  try {
    await loginApi(request);
    const keyword = prefix(info, '兼容');
    const typed: Activity[] = [];
    for (const category of Object.keys(categories) as Category[]) typed.push(await create(request, `${keyword} ${category}`, category));
    const legacy = await create(request, `${keyword} 旧客户端`);
    await create(request, `${keyword} null客户端`, null);
    expect((await edit(request, legacy, 'TECHNOLOGY')).status()).toBe(200);
    expect((await (await edit(request, legacy)).json()).category).toBe('TECHNOLOGY');
    expect((await (await edit(request, legacy, null)).json()).category).toBe('TECHNOLOGY');
    const before = await (await request.get(`/api/admin/audit-logs?activityId=${legacy.id}`)).json();
    expect(before.total).toBe(2);
    for (const invalid of ['', 'ALL', 'technology', 'UNKNOWN']) {
      const patch = await edit(request, legacy, invalid);
      expect(patch.status()).toBe(400);
      const intent = trackFixture(`${keyword} 非法${invalid || '空'}`, '非法发布若发生意外提交也保留精确清理意图。');
      const post = await write(request, '/api/admin/activities', 'POST', { title: intent.title, description: intent.description,
        location: legacy.location, startsAt: legacy.startsAt, capacity: 1, category: invalid });
      expect(post.status()).toBe(400);
      for (const kind of ['public', 'admin'] as const)
        expect((await request.get(`${endpoint(kind)}?category=${encodeURIComponent(invalid)}`)).status()).toBe(400);
    }
    expect(await (await request.get(`/api/admin/audit-logs?activityId=${legacy.id}`)).json()).toEqual(before);
    const all = await (await request.get('/api/activities')).json() as Activity[];
    for (const activity of typed) expect(all.find(row => row.id === activity.id)?.category).toBe(activity.category);
    await loginApi(page.request, 'demo');
    for (const activity of typed) {
      const joined = await write(page.request, `/api/activities/${activity.id}/registration`);
      expect(joined.status()).toBe(200); expect((await joined.json()).category).toBe(activity.category);
      const oldMine = await (await page.request.get('/api/me/registrations')).json();
      const newMine = await (await page.request.get('/api/me/registrations/search?status=ACTIVE')).json();
      expect(oldMine.find((row: { activity: Activity }) => row.activity.id === activity.id).activity.category).toBe(activity.category);
      expect(newMine.items.find((row: { activity: Activity }) => row.activity.id === activity.id).activity.category).toBe(activity.category);
      expect((await (await write(page.request, `/api/activities/${activity.id}/registration`, 'DELETE')).json()).category).toBe(activity.category);
    }
  } catch (error) { primary = error; }
  finally { await finish(primary, [() => logoutApi(page.request), () => logoutApi(request)]); }
});

test('分类无效URL规范为ALL，真实网络失败按条件重试，匿名及普通用户不发管理分类查询', async ({ page, request }, info) => {
  let primary: unknown, failPublic = true, failAdmin = true;
  try {
    await loginApi(request);
    const fixture = await create(request, prefix(info, '错误权限'), 'SPORTS');
    const query: Query = { keyword: fixture.title, category: 'SPORTS' };
    await page.route('**/api/activities/search?**', route => failPublic ? route.abort('failed') : route.continue());
    await page.goto(url('public', query));
    await expect(page.getByText('暂时无法连接服务，请检查网络后重试。', { exact: true })).toBeVisible();
    await expect(page.getByTestId('discovery-availableSeats').locator('.ant-statistic-content-value')).toHaveText('—');
    await assertUrl(page, 'public', query);
    failPublic = false;
    const retried = completed(page, 'public', query); await page.getByRole('button', { name: '重新加载', exact: true }).click();
    expect((await retried).items.map(row => row.id)).toEqual([fixture.id]);
    await page.goto(`/activities?keyword=${encodeURIComponent(fixture.title)}&category=NOT_VALID&page=1&pageSize=12`);
    await assertUrl(page, 'public', { keyword: fixture.title });
    await expect(page.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: '活动分类', exact: true }) })).toContainText('全部分类');
    await login(page);
    await page.route('**/api/admin/activities?**', route => failAdmin ? route.abort('failed') : route.continue());
    await page.goto(url('admin', query));
    await expect(page.getByText('暂时无法连接服务，请检查网络后重试。', { exact: true })).toBeVisible();
    await assertUrl(page, 'admin', query);
    failAdmin = false;
    const adminRetry = completed(page, 'admin', query); await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await assertView(page, 'admin', await adminRetry);
    await page.goto('/admin/activities?category=ALL&status=ALL&page=1&pageSize=10&keyword=');
    await assertUrl(page, 'admin', {});
    await page.goto(`/admin/activities?keyword=${encodeURIComponent(fixture.title)}&category=technology`);
    await assertUrl(page, 'admin', { keyword: fixture.title });
    await logout(page);
    let reads = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === endpoint('admin')) reads++; });
    await page.goto(url('admin', query)); await expect(page).toHaveURL(/\/login$/); expect(reads).toBe(0);
    await loginForm(page, 'demo');
    await page.goto(url('admin', query));
    await expect(page.getByText('此页面仅对活动组织者开放', { exact: true })).toBeVisible(); expect(reads).toBe(0);
    expect((await page.request.get(`${endpoint('admin')}?category=SPORTS`)).status()).toBe(403);
    await capture(page, info, 'category-forbidden');
  } catch (error) { primary = error; }
  finally { await finish(primary, [() => page.unrouteAll({ behavior: 'wait' }), () => logoutApi(page.request), () => logoutApi(request)]); }
});

type Held = { ready: Promise<void>; release(): void; delivered(): Promise<void>; cleanup(): Promise<void> };
async function hold(page: Page, kind: Kind, query: Query, lateStatus: 200 | 401, expiredCookie?: string, fail = false,
  verifySuccess?: (result: Result) => void): Promise<Held> {
  let release!: () => void, ready!: () => void, rejectReady!: (error: unknown) => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  const jobs: Promise<{ error?: unknown }>[] = [];
  const networkOutcomes: Promise<{ failure?: string; status?: number }>[] = [];
  const pattern = `**${endpoint(kind)}?**`;
  let armed = true;
  await page.route(pattern, route => {
    if (!armed || !matches(route.request().url(), kind, query)) return route.continue();
    armed = false;
    const target = route.request();
    networkOutcomes.push(new Promise(resolve => {
      const clear = () => { page.off('requestfinished', finished); page.off('requestfailed', failed); };
      const finished = async (request: typeof target) => {
        if (request !== target) return;
        clear(); resolve({ status: (await request.response())?.status() });
      };
      const failed = (request: typeof target) => {
        if (request !== target) return;
        clear(); resolve({ failure: request.failure()?.errorText ?? 'Unknown request failure' });
      };
      page.on('requestfinished', finished); page.on('requestfailed', failed);
    }));
    const job = (async () => {
      try {
        let response;
        try { response = await route.fetch(expiredCookie ? { headers: { ...route.request().headers(), cookie: expiredCookie } } : undefined); }
        catch { throw new Error('The held category query could not read the genuine server response.'); }
        expect(response.status()).toBe(lateStatus);
        if (lateStatus === 401) expect((await response.json()).code).toBe('UNAUTHENTICATED');
        else if (verifySuccess) verifySuccess(await response.json());
        ready(); await gate;
        try { if (fail) await route.abort('failed'); else await route.fulfill({ response }); }
        catch (error) { if (!route.request().failure()) throw error; }
      } catch (error) { rejectReady(error); throw error; }
    })();
    jobs.push(job.then(() => ({}), error => ({ error })));
    return job;
  });
  async function delivered() {
    const outcomes = await Promise.all(jobs);
    const errors = outcomes.flatMap(outcome => outcome.error === undefined ? [] : [outcome.error]);
    if (errors.length) throw new AggregateError(errors, 'A genuine delayed category response failed.');
    for (const outcome of await Promise.all(networkOutcomes)) {
      if (outcome.failure) expect(outcome.failure).toMatch(/ERR_ABORTED|ERR_FAILED|cancel/i);
      else { expect(fail).toBe(false); expect(outcome.status).toBe(lateStatus); }
    }
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  return { ready: started, release, delivered, cleanup: async () => { release(); await finish(undefined, [delivered, () => page.unroute(pattern)]); } };
}

test('分类真实旧成功迟到不能覆盖新分类结果及全量统计', async ({ page, request }, info) => {
  let primary: unknown, pending: Held | undefined;
  try {
    await loginApi(request);
    const keyword = prefix(info, '切换迟到');
    await create(request, `${keyword} 技术`, 'TECHNOLOGY', 1);
    const sports = await create(request, `${keyword} 体育`, 'SPORTS', 3);
    const oldQuery: Query = { keyword, category: 'TECHNOLOGY' }, nextQuery: Query = { keyword, category: 'SPORTS' };
    await open(page, 'public', oldQuery);
    pending = await hold(page, 'public', oldQuery, 200);
    await page.getByRole('button', { name: '查询', exact: true }).click(); await pending.ready;
    const next = completed(page, 'public', nextQuery); await choose(page, '活动分类', categories.SPORTS);
    const current = await next;
    expect(current.items.map(row => row.id)).toEqual([sports.id]); expect(current.summary).toEqual({ upcomingActivities: 1, availableSeats: 3 });
    await assertView(page, 'public', current);
    pending.release(); await pending.delivered(); await assertView(page, 'public', current); await assertUrl(page, 'public', nextQuery);
  } catch (error) { primary = error; }
  finally { await finish(primary, [...(pending ? [pending.cleanup] : []), () => logoutApi(page.request), () => logoutApi(request)]); }
});

for (const sameAccount of [false, true]) for (const lateStatus of [200, 401] as const) {
  test(`管理分类真实迟到${lateStatus}不污染${sameAccount ? '同管理员重新登录' : '切换普通用户'}后的认证代次`, async ({ page, request }, info) => {
    let primary: unknown, pending: Held | undefined;
    try {
      await loginApi(request);
      const keyword = prefix(info, `管理代次${lateStatus}`);
      await create(request, `${keyword} 旧技术`, 'TECHNOLOGY');
      const sports = await create(request, `${keyword} 新体育`, 'SPORTS');
      await login(page);
      const initial = await (await page.request.get('/api/auth/me')).json();
      const oldQuery: Query = { keyword, category: 'TECHNOLOGY' };
      await open(page, 'admin', oldQuery);
      let expired: string | undefined;
      if (lateStatus === 401) {
        const state = await request.storageState();
        const session = state.cookies.find(cookie => cookie.name === 'JSESSIONID');
        expect(!!session?.value).toBeTruthy();
        expired = `JSESSIONID=${session!.value}`; // In memory only; never attach it to evidence.
        await logoutApi(request);
        expect((await request.get('/api/auth/me', { headers: { Cookie: expired } })).status()).toBe(401);
      }
      pending = await hold(page, 'admin', oldQuery, lateStatus, expired);
      await page.getByRole('button', { name: '刷新活动', exact: true }).click(); await pending.ready;
      await logout(page); await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
      await loginForm(page, sameAccount ? 'admin' : 'demo');
      if (sameAccount) {
        await navigate(page, '活动管理');
        await page.getByRole('textbox', { name: '搜索活动', exact: true }).fill(keyword);
        const searched = completed(page, 'admin', { keyword });
        await page.getByRole('button', { name: '查询', exact: true }).click();
        await assertView(page, 'admin', await searched);
        await assertUrl(page, 'admin', { keyword });
        const currentQuery: Query = { keyword, category: 'SPORTS' };
        const loaded = completed(page, 'admin', currentQuery); await choose(page, '活动分类', categories.SPORTS);
        const current = await loaded; expect(current.items.map(row => row.id)).toEqual([sports.id]);
        pending.release(); await pending.delivered(); await assertView(page, 'admin', current); await assertUrl(page, 'admin', currentQuery);
      } else {
        await page.getByRole('button', { name: /账号菜单/ }).click();
        await page.getByRole('menuitem', { name: '个人中心', exact: true }).click();
        await expect(page.getByRole('heading', { name: '个人中心', exact: true })).toBeVisible();
        pending.release(); await pending.delivered(); await expect(page).toHaveURL(/\/profile$/);
        await expect(page.locator('[data-activity-id]')).toHaveCount(0);
      }
      const me = await page.request.get('/api/auth/me'); expect(me.status()).toBe(200);
      const identity = await me.json(); expect(identity.username).toBe(sameAccount ? 'admin' : 'demo');
      if (sameAccount) expect(identity.id).toBe(initial.id); else expect(identity.id).not.toBe(initial.id);
      await expect(page.getByText('请先登录', { exact: true })).toHaveCount(0);
    } catch (error) { primary = error; }
    finally { await finish(primary, [...(pending ? [pending.cleanup] : []), () => logoutApi(page.request), () => logoutApi(request)]); }
  });
}

for (const failure of [false, true]) {
  test(`公开分类${failure ? '旧网络错误' : '含旧本人ACTIVE的成功'}迟到不污染同账号重新登录后的新报名状态`, async ({ page, request, playwright }, info) => {
    let primary: unknown, pending: Held | undefined;
    const participant = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
    try {
      await loginApi(request);
      const activity = await create(request, prefix(info, '公开相同代次'), 'SPORTS');
      await loginApi(participant, 'demo');
      expect((await write(participant, `/api/activities/${activity.id}/registration`)).status()).toBe(200);
      await login(page, 'demo');
      const initial = await (await page.request.get('/api/auth/me')).json();
      const query: Query = { keyword: activity.title, category: 'SPORTS' };
      const old = await open(page, 'public', query);
      expect(old.items[0].registrationStatus).toBe('ACTIVE');
      await expect(page.locator(`[data-activity-id="${activity.id}"]`).getByText('已报名', { exact: true })).toBeVisible();
      pending = await hold(page, 'public', query, 200, undefined, failure, result => {
        expect(result.items[0]).toMatchObject({ id: activity.id, category: 'SPORTS', registrationStatus: 'ACTIVE' });
      });
      await page.getByRole('button', { name: '查询', exact: true }).click(); await pending.ready;
      await logout(page);
      expect((await write(participant, `/api/activities/${activity.id}/registration`, 'DELETE')).status()).toBe(200);
      await page.getByRole('button', { name: '登录 / 体验', exact: true }).click();
      await loginForm(page, 'demo');
      await page.getByRole('textbox', { name: '搜索活动', exact: true }).fill(activity.title);
      const keywordRead = completed(page, 'public', { keyword: activity.title });
      await page.getByRole('button', { name: '查询', exact: true }).click();
      await assertView(page, 'public', await keywordRead);
      const fresh = completed(page, 'public', query); await choose(page, '活动分类', categories.SPORTS);
      const current = await fresh;
      expect(current.items[0].registrationStatus).toBe('CANCELLED');
      await assertView(page, 'public', current);
      pending.release(); await pending.delivered();
      await assertView(page, 'public', current); await assertUrl(page, 'public', query);
      const row = page.locator(`[data-activity-id="${activity.id}"]`);
      await expect(row.getByText('已报名', { exact: true })).toHaveCount(0);
      await expect(row.getByText('报名中', { exact: true })).toBeVisible();
      await expect(page.getByText('暂时无法连接服务，请检查网络后重试。', { exact: true })).toHaveCount(0);
      const me = await page.request.get('/api/auth/me'); expect(me.status()).toBe(200);
      expect(await me.json()).toMatchObject({ id: initial.id, username: 'demo', role: 'USER' });
      const truth = await page.request.get(`${endpoint('public')}?${parameters('public', query)}`);
      expect((await truth.json()).items[0].registrationStatus).toBe('CANCELLED');
      await capture(page, info, `category-public-same-account-late-${failure ? 'network' : 'active'}`);
    } catch (error) { primary = error; }
    finally { await finish(primary, [...(pending ? [pending.cleanup] : []), () => logoutApi(page.request),
      () => logoutApi(participant), () => participant.dispose(), () => logoutApi(request)]); }
  });
}
