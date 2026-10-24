import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { trackFixture, recordFixtureId } from '../scripts/e2e-cleanup.mjs';

// Provider/config substitutions below are contract fixtures, not real AMap validation.
// Activity reads/writes, authentication, authorization and persistence stay real.
test.use({ trace: 'off' });
type Point = { longitude: number; latitude: number };
type Activity = { id: number; title: string; description: string; location: string; locationPoint: Point | null };
type Kind = 'search' | 'reverse';
const savedPoint = { longitude: 121.4737012, latitude: 31.2304167 };
const searchPoint = { longitude: 121.1234568, latitude: 31.1234568 };
const clickPoint = { longitude: 120.7654322, latitude: 30.7654322 };
const createPath = '/admin/activities/new';
const editPath = (id: number) => `/admin/activities/${id}/edit`;
const copyPath = (id: number) => `${createPath}?copyFrom=${id}`;
const address = (page: Page) => page.getByLabel('活动地点', { exact: true });
const dialog = (page: Page) => page.getByRole('dialog');
const mapButton = (page: Page) => page.getByRole('button', { name: '地图选点', exact: true });
const confirm = (page: Page) => dialog(page).getByRole('button', { name: '确认使用此地点', exact: true });
const selectedAddress = (page: Page) => dialog(page).getByLabel('选中地点（可补充楼层、房间）', { exact: true });

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
}
async function logoutApi(request: APIRequestContext) {
  const me = await request.get('/api/auth/me'); if (me.status() === 401) return;
  expect(me.status()).toBe(200); expect((await write(request, '/api/auth/logout')).status()).toBe(200);
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
  await page.getByRole('menuitem', { name: /退出登录/ }).press('Enter');
  await expect(page.getByRole('button', { name: '登录 / 体验', exact: true })).toBeVisible();
}
async function finish(primary: unknown, cleanups: Array<() => Promise<unknown>>) {
  const errors: unknown[] = primary === undefined ? [] : [primary];
  for (const cleanup of cleanups) try { await cleanup(); } catch (error) { errors.push(error); }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Map verification and cleanup failed; original failures are preserved.');
}
test.afterEach(async ({ page, request }) => { await finish(undefined, [() => logoutApi(page.request), () => logoutApi(request)]); });

function intent(info: TestInfo, label: string) {
  return trackFixture(`地图 ${info.project.name} ${label} ${randomUUID().slice(0, 8)}`, '独立归属活动地图验证；地图提供商使用明确的契约替身。');
}
async function source(request: APIRequestContext, info: TestInfo, point: Point | null = savedPoint, location = '原文字地点') {
  const fixture = intent(info, '来源');
  const response = await write(request, '/api/admin/activities', 'POST', {
    title: fixture.title, description: fixture.description, location, locationPoint: point, category: 'TECHNOLOGY', capacity: 3,
    startsAt: new Date(Date.now() + 3 * 86400000).toISOString(), endsAt: new Date(Date.now() + 3 * 86400000 + 3600000).toISOString(),
    registrationDeadline: new Date(Date.now() + 2 * 86400000).toISOString(),
  });
  expect(response.status()).toBe(201); const activity = await response.json() as Activity;
  recordFixtureId(fixture.key, activity.id); return activity;
}
async function read(request: APIRequestContext, id: number) {
  const response = await request.get(`/api/activities/${id}`); expect(response.status()).toBe(200); return response.json() as Promise<Activity>;
}
async function newDraft(page: Page, info: TestInfo) {
  const fixture = intent(info, '发布');
  await page.getByLabel('活动标题', { exact: true }).fill(fixture.title);
  await page.getByLabel('活动介绍', { exact: true }).fill(fixture.description);
  const day = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  await page.getByLabel('开始时间（北京时间）', { exact: true }).fill(`${day}T20:00`);
  return fixture;
}
async function publish(page: Page, fixture: ReturnType<typeof intent>) {
  const response = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/admin/activities');
  await page.getByRole('button', { name: '发布活动', exact: true }).click();
  const created = await response; expect(created.status()).toBe(201);
  const activity = await created.json() as Activity; recordFixtureId(fixture.key, activity.id);
  await expect(page).toHaveURL(new RegExp(`/activities/${activity.id}$`)); return activity;
}
async function save(page: Page, id: number) {
  const response = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/admin/activities/${id}`);
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  const saved = await response; expect(saved.status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`/activities/${id}$`)); return saved.json() as Promise<Activity>;
}
async function settle(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function spa(page: Page, path: string) {
  await page.evaluate(path => {
    history.pushState({ ...history.state, idx: (history.state?.idx ?? 0) + 1 }, '', path);
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }, path);
  await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe(path); await settle(page);
}
async function fits(page: Page) { await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); }
async function capture(page: Page, info: TestInfo, name: string) {
  await fits(page); const path = info.outputPath(`${name}.png`); await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

// This intentionally implements only the adapter contract, including explicit held
// service callbacks. It does not render real tiles, contact AMap, or validate keys.
const providerFixture = String.raw`(() => {
  const state = window.__gatherMapFixture = window.__gatherMapFixture || { calls: [], maps: [], holdSearch: false, holdReverse: false };
  const searchResult = keyword => ({ poiList: { pois: [{ name: keyword, address: '契约替身地址', location: { lng: 121.123456789, lat: 31.123456789 } }] } });
  const reverseResult = () => ({ regeocode: { formattedAddress: '契约替身逆地址' } });
  class Map {
    constructor(container) {
      this.handlers = {}; this.destroyed = false; this.container = container; state.maps.push(this);
      this.button = document.createElement('button'); this.button.type = 'button'; this.button.textContent = '地图契约替身选点';
      this.button.onclick = () => this.handlers.click?.({ lnglat: { getLng: () => 120.765432198, getLat: () => 30.765432198 } });
      container.appendChild(this.button);
    }
    on(type, callback) { this.handlers[type] = callback; }
    off(type) { delete this.handlers[type]; }
    setCenter(point) { this.center = point; }
    destroy() { this.destroyed = true; this.button.remove(); this.handlers = {}; }
  }
  class Marker { constructor(options) { this.position = options.position; this.map = options.map; } setMap(map) { this.map = map; } setPosition(point) { this.position = point; } }
  class PlaceSearch { search(keyword, callback) {
    const call = { kind: 'search', keyword, callback, settled: false, result: searchResult(keyword) }; state.calls.push(call);
    if (!state.holdSearch) { call.settled = true; queueMicrotask(() => callback('complete', call.result)); }
  } }
  class Geocoder { getAddress(point, callback) {
    const call = { kind: 'reverse', point, callback, settled: false, result: reverseResult() }; state.calls.push(call);
    if (!state.holdReverse) { call.settled = true; queueMicrotask(() => callback('complete', call.result)); }
  } }
  window.AMap = { Map, Marker, PlaceSearch, Geocoder, plugin(names, ready) { queueMicrotask(ready); } };
})();`;

async function provider(page: Page, options: { failFirst?: boolean; holdScript?: boolean } = {}) {
  let attempts = 0, release!: () => void;
  const scriptGate = new Promise<void>(resolve => { release = resolve; });
  if (!options.holdScript) release();
  const configPattern = '**/api/maps/config', scriptPattern = 'https://webapi.amap.com/maps?**';
  const errors: unknown[] = [], jobs: Promise<unknown>[] = [];
  await page.route(configPattern, route => route.fulfill({ status: 200, contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify({ enabled: true, jsKey: 'dummy-contract-fixture-key', serviceHost: '/api/_AMapService' }) }));
  await page.route(scriptPattern, route => {
    attempts++;
    const job = (async () => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get('v')).toBe('2.0'); expect(url.searchParams.get('key')).toBe('dummy-contract-fixture-key');
      if (options.failFirst && attempts === 1) { await route.abort('failed'); return; }
      await scriptGate; await route.fulfill({ status: 200, contentType: 'application/javascript', body: providerFixture });
    })();
    jobs.push(job.catch(error => { errors.push(error); })); return job;
  });
  return { attempts: () => attempts, release,
    cleanup: async () => {
      release();
      await finish(undefined, [
        async () => { await Promise.all(jobs); if (errors.length) throw new AggregateError(errors, 'Provider fixture route failed.'); },
        async () => {
          if (page.isClosed()) return;
          await page.evaluate(() => {
            for (const call of (window as any).__gatherMapFixture?.calls ?? []) if (!call.settled) {
              call.settled = true; call.callback('error', {});
            }
          });
        },
        () => page.unroute(configPattern), () => page.unroute(scriptPattern),
      ]);
    },
  };
}
async function openMap(page: Page) {
  await mapButton(page).click(); await expect(dialog(page).getByRole('region', { name: '高德地图', exact: true })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: '地图契约替身选点', exact: true })).toBeVisible();
}
async function search(page: Page, keyword = '选中的会场') {
  await dialog(page).getByRole('searchbox', { name: '搜索地图地点', exact: true }).fill(keyword);
  await dialog(page).getByRole('button', { name: '搜索地点', exact: true }).click();
}
async function chooseSearch(page: Page, keyword = '选中的会场') {
  await search(page, keyword); await dialog(page).getByRole('button', { name: `契约替身地址 ${keyword}`, exact: true }).click();
  await expect(selectedAddress(page)).toHaveValue(`契约替身地址 ${keyword}`);
}
async function holdServices(page: Page, kind: Kind) {
  await page.evaluate(kind => { (window as any).__gatherMapFixture[kind === 'search' ? 'holdSearch' : 'holdReverse'] = true; }, kind);
}
async function callCount(page: Page, kind: Kind) {
  return page.evaluate(kind => (window as any).__gatherMapFixture.calls.filter((call: any) => call.kind === kind).length, kind);
}
async function releaseCall(page: Page, kind: Kind, index: number, failure = false, location?: string) {
  await page.evaluate(({ kind, index, failure, location }) => {
    const call = (window as any).__gatherMapFixture.calls.filter((call: any) => call.kind === kind)[index];
    if (!call || call.settled) throw new Error('Expected a pending provider contract callback.');
    call.settled = true;
    if (location && kind === 'reverse') call.result = { regeocode: { formattedAddress: location } };
    call.callback(failure ? 'error' : 'complete', failure ? {} : call.result);
  }, { kind, index, failure, location }); await settle(page);
}

test('真实未配置时不加载外部SDK，文字地点仍可发布并刷新，空点不猜坐标', async ({ page, request }, info) => {
  let primary: unknown, outbound = 0;
  const pattern = /^https:\/\/[^/]*amap\.com\//;
  await page.route(pattern, route => { outbound++; return route.abort('blockedbyclient'); });
  try {
    const response = await request.get('/api/maps/config'); expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toContain('no-store');
    expect(await response.json()).toEqual({ enabled: false, jsKey: null, serviceHost: '/api/_AMapService' });
    await login(page); await page.goto(createPath); const fixture = await newDraft(page, info); await address(page).fill('纯文字历史地点');
    await mapButton(page).click(); await expect(dialog(page).getByText('地图暂未配置', { exact: true })).toBeVisible();
    await dialog(page).getByRole('button', { name: '取消选点', exact: true }).click();
    const created = await publish(page, fixture); expect(created.locationPoint).toBeNull();
    await page.reload(); await expect(page.getByText('未设置地图位置', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '查看地图', exact: true })).toHaveCount(0);
    expect((await read(request, created.id)).locationPoint).toBeNull(); expect(outbound).toBe(0); await fits(page);
  } catch (error) { primary = error; }
  finally { await finish(primary, [() => page.unroute(pattern)]); }
});

test('契约替身搜索先保留候选，取消不改文字，确认才原子写入地址与七位坐标', async ({ page, request }, info) => {
  const fixtureSdk = await provider(page); let primary: unknown;
  try {
    await login(page); await page.goto(createPath); const fixture = await newDraft(page, info); await address(page).fill('尚未确认的原地点');
    expect(fixtureSdk.attempts()).toBe(0); await openMap(page); await chooseSearch(page);
    await expect(address(page)).toHaveValue('尚未确认的原地点'); await capture(page, info, 'map-contract-candidate');
    await dialog(page).getByRole('button', { name: '取消选点', exact: true }).click();
    await expect(address(page)).toHaveValue('尚未确认的原地点'); await expect(page.getByRole('button', { name: '清除位置', exact: true })).toHaveCount(0);
    await openMap(page); await chooseSearch(page); await selectedAddress(page).fill('确认后的详细地点 3楼'); await confirm(page).click();
    await expect(address(page)).toHaveValue('确认后的详细地点 3楼'); await expect(page.getByText(/已选地图位置：经度 121\.1234568/)).toBeVisible();
    const created = await publish(page, fixture);
    expect(created).toMatchObject({ location: '确认后的详细地点 3楼', locationPoint: searchPoint });
    expect(await read(request, created.id)).toMatchObject({ location: created.location, locationPoint: searchPoint });
    expect(fixtureSdk.attempts()).toBe(1);
  } catch (error) { primary = error; }
  finally { await finish(primary, [fixtureSdk.cleanup]); }
});

test('契约替身点击逆地址确认可编辑，手改地点清点，显式null持久化且取消后不能编辑', async ({ page, request }, info) => {
  const fixtureSdk = await provider(page); let primary: unknown;
  try {
    await loginApi(request); const activity = await source(request, info); await login(page); await page.goto(editPath(activity.id));
    await expect(address(page)).toHaveValue(activity.location); await openMap(page);
    await dialog(page).getByRole('button', { name: '地图契约替身选点', exact: true }).click();
    await expect(selectedAddress(page)).toHaveValue('契约替身逆地址'); await selectedAddress(page).fill('逆地址场地 2楼'); await confirm(page).click();
    expect(await save(page, activity.id)).toMatchObject({ location: '逆地址场地 2楼', locationPoint: clickPoint });
    await page.goto(editPath(activity.id)); await page.getByRole('button', { name: '清除位置', exact: true }).click();
    await expect(address(page)).toHaveValue('逆地址场地 2楼');
    expect((await save(page, activity.id)).locationPoint).toBeNull();
    await page.goto(editPath(activity.id)); await openMap(page); await chooseSearch(page); await confirm(page).click();
    await address(page).fill('手工更改的文字地点'); await expect(page.getByRole('button', { name: '清除位置', exact: true })).toHaveCount(0);
    expect(await save(page, activity.id)).toMatchObject({ location: '手工更改的文字地点', locationPoint: null });
    await page.reload(); await expect(page.getByText('未设置地图位置', { exact: true })).toBeVisible();
    expect((await read(request, activity.id)).locationPoint).toBeNull();
    expect((await write(request, `/api/admin/activities/${activity.id}/cancel`, 'POST', { reason: '地图独立活动取消权限验证' })).status()).toBe(200);
    await page.goto(editPath(activity.id)); await expect(mapButton(page)).toBeDisabled(); await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
  } catch (error) { primary = error; }
  finally { await finish(primary, [fixtureSdk.cleanup]); }
});

test('复制只预填白名单地点与位置，清空三个时间且新活动独立保存原点', async ({ page, request }, info) => {
  const fixtureSdk = await provider(page); let primary: unknown;
  try {
    await loginApi(request); const original = await source(request, info); await login(page); await page.goto(copyPath(original.id));
    await expect(address(page)).toHaveValue(original.location); await expect(page.getByRole('button', { name: '清除位置', exact: true })).toBeVisible();
    for (const label of ['开始时间（北京时间）', '结束时间（北京时间，可选）', '报名截止时间（北京时间，可选）'])
      await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
    await page.reload(); await expect(page.getByText(/已选地图位置：经度 121\.4737012/)).toBeVisible();
    const fixture = await newDraft(page, info); const created = await publish(page, fixture);
    expect(created.id).not.toBe(original.id); expect(created).toMatchObject({ location: original.location, locationPoint: savedPoint });
    expect(await read(request, original.id)).toEqual(original); expect(fixtureSdk.attempts()).toBe(0);
  } catch (error) { primary = error; }
  finally { await finish(primary, [fixtureSdk.cleanup]); }
});

test('匿名详情按需只读地图，外链固定高德与坐标参数，空位置不显示导航', async ({ page, request }, info) => {
  const fixtureSdk = await provider(page); let primary: unknown;
  try {
    await loginApi(request); const activity = await source(request, info), empty = await source(request, info, null, '无地图历史文字地点');
    await page.goto(`/activities/${activity.id}`); await expect(page.getByRole('heading', { name: activity.title, exact: true })).toBeVisible();
    expect(fixtureSdk.attempts()).toBe(0);
    const link = page.getByRole('link', { name: '在高德查看 / 导航', exact: true });
    const url = new URL((await link.getAttribute('href'))!);
    expect(url.origin).toBe('https://uri.amap.com'); expect(url.pathname).toBe('/marker'); expect(url.searchParams.get('position')).toBe('121.4737012,31.2304167');
    expect(url.searchParams.get('name')).toBe(activity.title); expect(url.searchParams.get('coordinate')).toBe('gaode'); expect(url.searchParams.get('callnative')).toBe('0');
    expect([...url.searchParams].length).toBe(4); await expect(link).toHaveAttribute('target', '_blank'); await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await page.getByRole('button', { name: '查看地图', exact: true }).click();
    await expect(dialog(page).getByRole('button', { name: '地图契约替身选点', exact: true })).toBeVisible();
    await expect(dialog(page).getByRole('searchbox')).toHaveCount(0); await expect(confirm(page)).toHaveCount(0); await capture(page, info, 'map-contract-readonly');
    await dialog(page).getByRole('button', { name: '关闭地图', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__gatherMapFixture.maps.every((map: any) => map.destroyed))).toBe(true);
    await page.goto(`/activities/${empty.id}`); await expect(page.getByText('未设置地图位置', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '在高德查看 / 导航', exact: true })).toHaveCount(0);
  } catch (error) { primary = error; }
  finally { await finish(primary, [fixtureSdk.cleanup]); }
});

test('SDK契约替身首次失败保持草稿，只有手动重试恢复，重开弹窗复用一次成功加载', async ({ page }, info) => {
  const fixtureSdk = await provider(page, { failFirst: true }); let primary: unknown;
  try {
    await login(page); await page.goto(createPath); await newDraft(page, info); await address(page).fill('加载失败仍保留的地点');
    await mapButton(page).click(); await expect(dialog(page).getByRole('button', { name: '重试地图加载', exact: true })).toBeVisible();
    expect(fixtureSdk.attempts()).toBe(1); await expect(address(page)).toHaveValue('加载失败仍保留的地点');
    await dialog(page).getByRole('button', { name: '重试地图加载', exact: true }).click();
    await expect(dialog(page).getByRole('button', { name: '地图契约替身选点', exact: true })).toBeVisible(); expect(fixtureSdk.attempts()).toBe(2);
    await dialog(page).getByRole('button', { name: '取消选点', exact: true }).click(); await openMap(page); expect(fixtureSdk.attempts()).toBe(2);
    expect(await page.evaluate(() => (window as any)._AMapSecurityConfig.serviceHost)).toBe(new URL('/api/_AMapService', page.url()).href);
    await expect(address(page)).toHaveValue('加载失败仍保留的地点');
  } catch (error) { primary = error; }
  finally { await finish(primary, [fixtureSdk.cleanup]); }
});

test('契约替身旧搜索与逆地址迟到成功或错误不覆盖新候选，关窗回调不回填草稿', async ({ page }, info) => {
  const fixtureSdk = await provider(page); let primary: unknown;
  try {
    await login(page); await page.goto(createPath); await newDraft(page, info); await address(page).fill('独立新草稿'); await openMap(page); await holdServices(page, 'search');
    await search(page, '旧搜索'); await expect.poll(() => callCount(page, 'search')).toBe(1);
    await search(page, '新搜索'); await expect.poll(() => callCount(page, 'search')).toBe(2);
    await releaseCall(page, 'search', 1); await releaseCall(page, 'search', 0, true);
    await dialog(page).getByRole('button', { name: '契约替身地址 新搜索', exact: true }).click(); await expect(selectedAddress(page)).toHaveValue('契约替身地址 新搜索');
    await expect(dialog(page).locator('.ant-alert-error')).toHaveCount(0); await holdServices(page, 'reverse');
    for (let index = 0; index < 2; index++) { await dialog(page).getByRole('button', { name: '地图契约替身选点', exact: true }).click(); await expect.poll(() => callCount(page, 'reverse')).toBe(index + 1); }
    await releaseCall(page, 'reverse', 1, false, '最新逆地址'); await releaseCall(page, 'reverse', 0, true); await expect(selectedAddress(page)).toHaveValue('最新逆地址');
    await dialog(page).getByRole('button', { name: '地图契约替身选点', exact: true }).click(); await expect.poll(() => callCount(page, 'reverse')).toBe(3);
    await dialog(page).getByRole('button', { name: '取消选点', exact: true }).click(); await openMap(page); await releaseCall(page, 'reverse', 2, false, '已经关闭的旧地址');
    await expect(address(page)).toHaveValue('独立新草稿'); await expect(selectedAddress(page)).toHaveCount(0); await expect(dialog(page).locator('.ant-alert-error')).toHaveCount(0);
  } catch (error) { primary = error; }
  finally { await finish(primary, [fixtureSdk.cleanup]); }
});

test('契约替身回调跨复制来源及同账号重登后失效，不覆盖新表单或退出新身份', async ({ page, request }, info) => {
  const fixtureSdk = await provider(page); let primary: unknown;
  try {
    await loginApi(request); const first = await source(request, info), second = await source(request, info, null, '第二来源的地点');
    await login(page); await page.goto(copyPath(first.id)); await openMap(page); await holdServices(page, 'search'); await search(page, '旧来源搜索');
    await expect.poll(() => callCount(page, 'search')).toBe(1); await spa(page, copyPath(second.id)); await expect(address(page)).toHaveValue(second.location);
    await releaseCall(page, 'search', 0); await expect(address(page)).toHaveValue(second.location); await expect(dialog(page)).toHaveCount(0);
    await openMap(page); await holdServices(page, 'reverse'); await dialog(page).getByRole('button', { name: '地图契约替身选点', exact: true }).click();
    await expect.poll(() => callCount(page, 'reverse')).toBe(1); await spa(page, '/activities'); await logout(page);
    await page.getByRole('button', { name: '登录 / 体验', exact: true }).click(); await loginForm(page); await spa(page, copyPath(second.id));
    await expect(address(page)).toHaveValue(second.location); await address(page).fill('同账号重登后的新草稿'); await releaseCall(page, 'reverse', 0, true);
    await expect(address(page)).toHaveValue('同账号重登后的新草稿'); await expect(page.locator('.ant-alert-error')).toHaveCount(0);
    const me = await page.request.get('/api/auth/me'); expect(me.status()).toBe(200); expect((await me.json()).username).toBe('admin');
    await expect(page.getByRole('button', { name: '发布活动', exact: true })).toBeEnabled();
  } catch (error) { primary = error; }
  finally { await finish(primary, [fixtureSdk.cleanup]); }
});

test('普通用户无发布编辑地图入口，后台拒绝坐标修改，仍能按需查看公开地图', async ({ page, request }, info) => {
  const fixtureSdk = await provider(page); let primary: unknown;
  try {
    await loginApi(request); const activity = await source(request, info); await login(page, 'demo');
    for (const path of [createPath, editPath(activity.id)]) {
      await page.goto(path); await expect(page.getByText('此页面仅对活动组织者开放', { exact: true })).toBeVisible();
      await expect(mapButton(page)).toHaveCount(0); expect(fixtureSdk.attempts()).toBe(0);
    }
    const rejected = await write(page.request, `/api/admin/activities/${activity.id}`, 'PATCH', {
      title: activity.title, description: activity.description, location: activity.location, locationPoint: clickPoint,
    }); expect(rejected.status()).toBe(403); expect(await read(request, activity.id)).toEqual(activity);
    await page.goto(`/activities/${activity.id}`); await page.getByRole('button', { name: '查看地图', exact: true }).click();
    await expect(dialog(page).getByRole('button', { name: '地图契约替身选点', exact: true })).toBeVisible(); await expect(confirm(page)).toHaveCount(0);
  } catch (error) { primary = error; }
  finally { await finish(primary, [fixtureSdk.cleanup]); }
});

test('SDK脚本迟到时关闭并换来源不创建旧地图，新弹窗复用受控加载', async ({ page, request }, info) => {
  const fixtureSdk = await provider(page, { holdScript: true }); let primary: unknown;
  try {
    await loginApi(request); const first = await source(request, info), second = await source(request, info, null, '脚本迟到后的新地点');
    await login(page); await page.goto(copyPath(first.id)); await mapButton(page).click(); await expect.poll(fixtureSdk.attempts).toBe(1);
    await dialog(page).getByRole('button', { name: '取消选点', exact: true }).click(); await spa(page, copyPath(second.id));
    await expect(address(page)).toHaveValue(second.location); fixtureSdk.release();
    await expect.poll(() => page.evaluate(() => Boolean((window as any).__gatherMapFixture))).toBe(true);
    expect(await page.evaluate(() => (window as any).__gatherMapFixture.maps.length)).toBe(0);
    await openMap(page); expect(fixtureSdk.attempts()).toBe(1); await expect(address(page)).toHaveValue(second.location);
    await expect(selectedAddress(page)).toHaveCount(0);
  } catch (error) { primary = error; }
  finally { await finish(primary, [fixtureSdk.cleanup]); }
});
