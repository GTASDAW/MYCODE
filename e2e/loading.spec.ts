import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { afterContract } from '../scripts/frontend-loading-core.mjs';

interface Chunk { file: string; imports: string[]; dynamicImports: string[]; facadeModule: string | null;
  isEntry: boolean; isDynamicEntry: boolean; modules: string[] }
interface ManifestEntry { file: string; isEntry?: boolean; css?: string[]; imports?: string[]; dynamicImports?: string[] }
interface Build { chunks: Chunk[]; modules: { id: string; imports: string[] }[]; manifest: Record<string, ManifestEntry> }
const buildPath = resolve(process.env.LOADING_BUILD_PATH ?? '.runtime/frontend-loading/after/build.json');
const distPath = resolve(process.env.LOADING_DIST_PATH ?? '.runtime/frontend-loading/after/dist');
const build = JSON.parse(readFileSync(buildPath, 'utf8')) as Build;
if (!build.manifest) build.manifest = JSON.parse(readFileSync(resolve(distPath, '.vite/manifest.json'), 'utf8'));
const contract = afterContract(build) as { lazyEntries: { module: string; file: string }[];
  publicRequired: string[]; adminDeferredSrc: string[]; tableImplementationModules: string[] };
const lazyModules = ['ActivityDetailPage', 'CreateActivityPage', 'EditActivityPage', 'LoginPage', 'RegisterPage',
  'ProfilePage', 'NotificationsPage', 'MyRegistrationsPage', 'MyFavoritesPage', 'AdminDashboardPage', 'AdminActivitiesPage',
  'AdminRegistrationsPage', 'AdminMonitoringPage', 'AdminAuditLogsPage'];
const pageModule = (name: string) => `src/pages/${name}.tsx`;
const chunks = new Map(build.chunks.map(chunk => [chunk.file, chunk]));
const lazyEntry = (name: string) => {
  const entry = contract.lazyEntries.find(entry => entry.module === pageModule(name));
  const chunk = build.chunks.find(chunk => chunk.file === entry?.file);
  if (!chunk) throw new Error(`A real independent lazy entry is required for ${name}.`);
  return chunk;
};
const closure = (file: string) => {
  const files = new Set<string>();
  const visit = (current: string) => {
    if (files.has(current)) return;
    files.add(current);
    chunks.get(current)?.imports.filter(imported => chunks.has(imported)).forEach(visit);
  };
  visit(file); return files;
};
const entryFiles = Object.values(build.manifest).filter(entry => entry.isEntry).map(entry => entry.file);
const eagerFiles = new Set(entryFiles.flatMap(file => [...closure(file)]));
const eagerModules = new Set([...eagerFiles].flatMap(file => chunks.get(file)?.modules ?? []));
const lazyFiles = lazyModules.map(name => lazyEntry(name).file);
const audit = lazyEntry('AdminAuditLogsPage');
const monitor = lazyEntry('AdminMonitoringPage');
const auditCss = [...new Set(Object.values(build.manifest).filter(entry => closure(audit.file).has(entry.file))
  .flatMap(entry => entry.css ?? []))].find(file => !Object.values(build.manifest)
  .filter(entry => eagerFiles.has(entry.file)).some(entry => entry.css?.includes(file)));
if (!auditCss) throw new Error('The production audit page must have a real deferred stylesheet for failure verification.');
const assetPath = (file: string) => `/${file}`;
const requestedAsset = (url: string) => new URL(url).pathname.slice(1);
const userMenu = (page: Page) => page.getByRole('button', { name: /账号菜单/ });

test.beforeAll(async ({ request }) => {
  const base = new URL(process.env.LOADING_BASE_URL ?? 'http://127.0.0.1:5185');
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(base.hostname);
  const html = await request.get('/');
  expect(html.status()).toBe(200);
  const text = await html.text();
  expect(text).not.toContain('/@vite/client');
  expect(text).toContain('/assets/');
  for (const entry of entryFiles) expect(text).toContain(assetPath(entry));
  expect(lazyFiles).toHaveLength(14);
  expect(new Set(lazyFiles).size).toBe(14);
});

async function token(request: APIRequestContext) {
  const response = await request.get('/api/auth/csrf');
  expect(response.status()).toBe(200);
  return response.json();
}

async function logout(request: APIRequestContext) {
  const current = await request.get('/api/auth/me');
  if (current.status() === 401) return;
  expect(current.status()).toBe(200);
  const csrf = await token(request);
  expect((await request.post('/api/auth/logout', { headers: { [csrf.headerName]: csrf.token } })).status()).toBe(200);
}

async function finish(primaryError: unknown, cleanup: Array<() => Promise<unknown>>) {
  const errors: unknown[] = primaryError === undefined ? [] : [primaryError];
  for (const operation of cleanup) try { await operation(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Production loading verification and cleanup failed; first error is the original failure.');
}

async function login(page: Page, username = 'admin') {
  await page.goto('/login');
  await loginForm(page, username);
}

async function loginForm(page: Page, username = 'admin') {
  await page.getByLabel('账号', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(username === 'admin' ? 'Admin123!' : 'Demo123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(userMenu(page)).toBeVisible();
}

async function navigate(page: Page, name: string) {
  const mobile = page.getByRole('button', { name: '打开导航', exact: true });
  if (await mobile.isVisible()) await mobile.click();
  await page.getByRole('link', { name, exact: true }).click();
}

async function capture(page: Page, info: TestInfo, name: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('生产HTML与带hash资源缓存头正确，缺失JS和CSS真实404且不返回SPA', async ({ request }) => {
  for (const path of ['/', '/index.html', '/admin/audit-logs?action=EDIT&pageSize=20']) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/html');
    expect(response.headers()['cache-control']).toBe('no-cache');
  }
  for (const file of [entryFiles[0], audit.file, auditCss!]) {
    const response = await request.get(assetPath(file));
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(response.headers()['content-type']).not.toContain('text/html');
  }
  for (const file of ['loading-missing-12345678.js', 'loading-missing-12345678.css', 'not-a-content-hash.js']) {
    const response = await request.get(`/assets/${file}`);
    expect(response.status()).toBe(404);
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(response.headers()['content-type']).not.toContain('text/html');
    expect(await response.text()).not.toContain('id="root"');
  }
  const icon = await request.get('/favicon.svg');
  expect(icon.status()).toBe(200);
  expect(icon.headers()['cache-control']).toBeUndefined();
  const internalGraph = await request.get('/.vite/loading-graph.json');
  expect(internalGraph.status()).toBe(404);
  expect(internalGraph.headers()['cache-control']).toBe('no-store');
});

test('冷首页只读取入口静态依赖，不下载14个其他页面或管理员独占模块', async ({ page }) => {
  const loaded: string[] = [];
  page.on('request', request => { if (request.resourceType() === 'script') loaded.push(requestedAsset(request.url())); });
  await page.goto('/activities');
  await expect(page.getByRole('heading', { name: '发现活动', exact: true })).toBeVisible();
  await expect(page.locator('.activity-card').first()).toBeVisible();
  expect(loaded.filter(file => lazyFiles.includes(file))).toEqual([]);
  expect(loaded.filter(file => file.endsWith('.js')).every(file => eagerFiles.has(file))).toBeTruthy();
  expect([...eagerModules].filter(module => lazyModules.map(pageModule).includes(module))).toEqual([]);
  const browserModules = loaded.flatMap(file => chunks.get(file)?.modules ?? []);
  expect(contract.publicRequired).toContain('src/Layout.tsx');
  expect(contract.adminDeferredSrc.length).toBeGreaterThan(0);
  expect(contract.tableImplementationModules.length).toBeGreaterThan(0);
  expect(browserModules.filter(module => contract.adminDeferredSrc.includes(module))).toEqual([]);
  expect(browserModules.filter(module => contract.tableImplementationModules.includes(module))).toEqual([]);
});

test('管理员首次进入读取对应chunk，离开后复访复用模块，Session保持真实身份', async ({ page }) => {
  let reads = 0;
  page.on('request', request => { if (requestedAsset(request.url()) === monitor.file) reads++; });
  let primaryError: unknown;
  try {
    await login(page);
    expect(reads).toBe(0);
    await navigate(page, '运行指标');
    await expect(page.getByRole('heading', { name: '运行指标', exact: true })).toBeVisible();
    expect(reads).toBe(1);
    await navigate(page, '发现活动');
    await expect(page.locator('.activity-card').first()).toBeVisible();
    await navigate(page, '运行指标');
    await expect(page.getByRole('heading', { name: '运行指标', exact: true })).toBeVisible();
    expect(reads).toBe(1);
    const me = await page.request.get('/api/auth/me');
    expect(me.status()).toBe(200);
    expect((await me.json()).username).toBe('admin');
  } catch (error) { primaryError = error; }
  finally { await finish(primaryError, [() => logout(page.request)]); }
});

test('未登录及普通用户访问管理路径不下载管理员页面chunk也不读取管理接口', async ({ page }) => {
  const adminFiles = lazyModules.filter(name => /^(Admin|Create|Edit)/.test(name)).map(name => lazyEntry(name).file);
  const assets: string[] = [];
  const apiReads: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (adminFiles.includes(path.slice(1))) assets.push(path);
    if (path.startsWith('/api/admin/')) apiReads.push(path);
  });
  let primaryError: unknown;
  try {
    await page.goto('/admin/audit-logs');
    await expect(page).toHaveURL(/\/login$/);
    expect(assets).toEqual([]); expect(apiReads).toEqual([]);
    await loginForm(page, 'demo');
    await expect(page.getByText('此页面仅对活动组织者开放', { exact: true })).toBeVisible();
    for (const path of ['/admin/dashboard', '/admin/monitoring', '/admin/activities', '/admin/activities/new',
      '/admin/activities/1/edit', '/admin/activities/1/registrations']) {
      await page.goto(path);
      await expect(page.getByText('此页面仅对活动组织者开放', { exact: true })).toBeVisible();
    }
    expect(assets).toEqual([]); expect(apiReads).toEqual([]);
  } catch (error) { primaryError = error; }
  finally { await finish(primaryError, [() => logout(page.request)]); }
});

test('慢chunk仅显示局部加载，外壳账号可用且离开后旧页面不会迟到挂载', async ({ page }, info) => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let fetched!: () => void;
  let rejected!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { fetched = resolve; rejected = reject; });
  const jobs: Promise<void>[] = [];
  let managementReads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/admin/monitoring') managementReads++; });
  let primaryError: unknown;
  try {
    await login(page);
    await page.route(`**/${monitor.file}`, route => {
      const job = (async () => {
        try {
          const response = await route.fetch(); expect(response.status()).toBe(200);
          fetched(); await hold; await route.fulfill({ response });
        } catch (error) { rejected(error); throw error; }
      })(); jobs.push(job); return job;
    });
    await navigate(page, '运行指标');
    await ready;
    await expect(page.getByTestId('page-loading')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: '正在打开页面…' })).toBeVisible();
    await expect(userMenu(page)).toBeVisible();
    await userMenu(page).click();
    await expect(page.getByRole('menuitem', { name: '个人中心', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await capture(page, info, 'production-slow-page-shell');
    await navigate(page, '发现活动');
    await expect(page.locator('.activity-card').first()).toBeVisible();
    release(); await Promise.all(jobs);
    await expect(page).toHaveURL(/\/activities$/);
    await expect(page.getByTestId('page-loading')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '运行指标', exact: true })).toHaveCount(0);
    expect(managementReads).toBe(0);
    expect((await (await page.request.get('/api/auth/me')).json()).username).toBe('admin');
  } catch (error) { primaryError = error; }
  finally {
    release(); await finish(primaryError, [() => Promise.all(jobs), () => page.unroute(`**/${monitor.file}`), () => logout(page.request)]);
  }
});

for (const [extension, failure] of [['js', 'network'], ['js', '404'], ['css', 'network'], ['css', '404']] as const) {
  test(`真实生产${extension.toUpperCase()}资源${failure === 'network' ? '网络失败' : '404'}显示局部错误，恢复后手动刷新保留URL与Session`, async ({ page }, info) => {
    const file = extension === 'js' ? audit.file : auditCss!;
    const target = '/admin/audit-logs?action=EDIT&pageSize=20#main-content';
    let documents = 0;
    let assetAttempts = 0;
    let fail = true;
    let primaryError: unknown;
    page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++; });
    try {
      await login(page);
      await page.route(`**/${file}`, async route => {
        assetAttempts++;
        if (!fail) return route.continue();
        if (failure === 'network') return route.abort('failed');
        const response = await route.fetch({ url: new URL(`/assets/loading-missing-12345678.${extension}`, info.project.use.baseURL).href });
        expect(response.status()).toBe(404);
        expect(response.headers()['cache-control']).toBe('no-store');
        await route.fulfill({ response });
      });
      const initialDocuments = documents;
      await page.goto(target);
      await expect(page.getByTestId('page-load-error')).toContainText('页面暂时无法打开');
      await expect(page.getByRole('button', { name: '重新加载当前页面', exact: true })).toBeVisible();
      await expect(userMenu(page)).toBeVisible();
      const expectedUrl = new URL(target, info.project.use.baseURL).href;
      await expect(page).toHaveURL(expectedUrl);
      expect(documents).toBe(initialDocuments + 1);
      expect(assetAttempts).toBe(1);
      expect((await (await page.request.get('/api/auth/me')).json()).username).toBe('admin');
      await userMenu(page).click();
      await expect(page.getByRole('menuitem', { name: '个人中心', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await capture(page, info, `production-${extension}-${failure}-error`);
      expect(documents).toBe(initialDocuments + 1); expect(assetAttempts).toBe(1);
      fail = false;
      await page.getByRole('button', { name: '重新加载当前页面', exact: true }).click();
      await expect(page.getByRole('heading', { name: '管理员操作记录', exact: true })).toBeVisible();
      await expect(page.getByTestId('page-load-error')).toHaveCount(0);
      await expect(page).toHaveURL(expectedUrl);
      expect(documents).toBe(initialDocuments + 2);
      expect(assetAttempts).toBe(2);
      expect((await (await page.request.get('/api/auth/me')).json()).username).toBe('admin');
    } catch (error) { primaryError = error; }
    finally { await finish(primaryError, [() => page.unroute(`**/${file}`), () => logout(page.request)]); }
  });
}

test('缺失页面模块仍可返回即时活动列表，生产深链和登录返回保留已提交条件', async ({ page, request }) => {
  let primaryError: unknown;
  try {
    await login(page);
    await page.route(`**/${monitor.file}`, route => route.abort('failed'));
    await navigate(page, '运行指标');
    await expect(page.getByTestId('page-load-error')).toBeVisible();
    await page.getByRole('link', { name: '返回活动列表', exact: true }).click();
    await expect(page).toHaveURL(/\/activities$/);
    await expect(page.locator('.activity-card').first()).toBeVisible();
    await page.unroute(`**/${monitor.file}`);
    await logout(page.request);
    const path = '/my-registrations?status=CANCELLED&pageSize=20';
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
    await loginForm(page, 'demo');
    await expect(page.getByRole('heading', { name: '我的报名', exact: true })).toBeVisible();
    await expect(page).toHaveURL(new URL(path, infoBase(page)).href);
    await page.reload();
    await expect(page.getByRole('heading', { name: '我的报名', exact: true })).toBeVisible();
    await expect(page).toHaveURL(new URL(path, infoBase(page)).href);
    const activities = await (await request.get('/api/activities')).json();
    expect(activities.length).toBeGreaterThan(0);
    await page.goto(`/activities/${activities[0].id}`);
    await expect(page.getByRole('heading', { name: activities[0].title, exact: true })).toBeVisible();
  } catch (error) { primaryError = error; }
  finally { await finish(primaryError, [() => page.unroute(`**/${monitor.file}`), () => logout(page.request)]); }
});

function infoBase(page: Page) { return new URL(page.url()).origin; }
