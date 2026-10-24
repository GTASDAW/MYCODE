import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { amapMarkerUrl, copyLocationPoint, enabledMapsConfig, manualActivityLocation,
  MapOperationGate, selectedActivityLocation, validLocationPoint } from '../src/activityMap.ts';
import { createActivityMap, createAmapSdkLoader } from '../src/amapAdapter.ts';
import { activityCopyDraft, activityCreateRequest } from '../src/activityCopy.ts';
import { AuthRequestGuard } from '../src/authRequestGuard.ts';
import { auditFieldLabels, auditChangeText } from '../src/auditLogPresentation.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const config = { enabled: true, jsKey: 'fake-key-for-contract-test', serviceHost: '/api/_AMapService' };
const point = { longitude: 121.473701, latitude: 31.230416 };

test('points require finite paired numbers in range and copying excludes unrelated fields', () => {
  for (const value of [point, { longitude: -180, latitude: -90 }, { longitude: 180, latitude: 90 }])
    assert.equal(validLocationPoint(value), true);
  for (const value of [undefined, null, '', [], { longitude: 1 }, { latitude: 1 }, { longitude: '1', latitude: 1 },
    { longitude: NaN, latitude: 1 }, { longitude: Infinity, latitude: 1 }, { longitude: 180.000001, latitude: 1 },
    { longitude: 1, latitude: -90.000001 }]) assert.equal(validLocationPoint(value), false);
  const raw = { ...point, userId: 99, url: 'javascript:alert(1)' };
  assert.deepEqual(copyLocationPoint(raw), point);
  assert.notEqual(copyLocationPoint(raw), raw);
  assert.deepEqual(copyLocationPoint({ longitude: 121.123456789, latitude: 31.123456789 }), { longitude: 121.1234568, latitude: 31.1234568 });
});

test('coordinate rounding matches decimal HALF_UP for signed halves, exponents, boundaries and negative zero', () => {
  for (const [value, expected] of [
    [1.00000005, 1.0000001], [-1.00000005, -1.0000001], [1.000000049, 1], [-1.000000049, -1],
    [5e-8, 1e-7], [-5e-8, -1e-7], [4.999999999e-8, 0], [-4.999999999e-8, 0],
    [1.5e-7, 2e-7], [-1.5e-7, -2e-7], [5e-324, 0], [-5e-324, 0],
    [89.99999995, 90], [-89.99999995, -90], [0, 0], [-0, 0],
  ]) {
    const result = copyLocationPoint({ longitude: value, latitude: value });
    assert.deepEqual(result, { longitude: expected, latitude: expected }, String(value));
    assert.equal(Object.is(result.longitude, -0), false); assert.equal(Object.is(result.latitude, -0), false);
  }
  for (const [longitude, expected] of [[179.99999995, 180], [-179.99999995, -180], [180, 180], [-180, -180]])
    assert.deepEqual(copyLocationPoint({ longitude, latitude: 0 }), { longitude: expected, latitude: 0 });
  for (const value of [{ longitude: 180.000000001, latitude: 0 }, { longitude: 0, latitude: 90.000000001 },
    { longitude: 1e21, latitude: 0 }, { longitude: 0, latitude: -1e21 }]) assert.equal(copyLocationPoint(value), null);
});

test('manual address edits clear a prior point; selecting commits a validated text/point pair atomically', () => {
  assert.deepEqual(manualActivityLocation(' 新地址 '), { location: ' 新地址 ', locationPoint: null });
  assert.deepEqual(selectedActivityLocation(' 上海场馆 3楼 ', point), { location: '上海场馆 3楼', locationPoint: point });
  for (const [address, coordinates] of [[' ', point], ['x'.repeat(201), point], ['地址', null]])
    assert.throws(() => selectedActivityLocation(address, coordinates));
});

test('external marker links keep a fixed HTTPS origin, route and parameter contract with encoded title only', () => {
  const title = '中文 &position=0,0#? <script>"\n';
  const result = amapMarkerUrl(point, title), url = new URL(result);
  assert.equal(url.origin, 'https://uri.amap.com'); assert.equal(url.pathname, '/marker');
  assert.equal(url.searchParams.get('position'), '121.473701,31.230416');
  assert.equal(url.searchParams.get('name'), title); assert.equal(url.searchParams.get('coordinate'), 'gaode');
  assert.equal(url.searchParams.get('callnative'), '0'); assert.equal(url.hash, '');
  assert.equal([...url.searchParams].length, 4);
  assert.equal(new URL(amapMarkerUrl({ longitude: 121.123456789, latitude: 31.123456789 }, title)).searchParams.get('position'), '121.1234568,31.1234568');
  assert.equal(amapMarkerUrl({ longitude: 'https://evil.example', latitude: 0 }, title), null);
});

test('map configuration never accepts a remote proxy, disabled service or malformed key', () => {
  assert.equal(enabledMapsConfig(config), true);
  for (const invalid of [{ ...config, enabled: false }, { ...config, jsKey: null }, { ...config, jsKey: '' },
    { ...config, jsKey: 'key&jscode=secret' }, { ...config, serviceHost: 'https://evil.example/_AMapService' },
    { ...config, serviceHost: '/api/_AMapService/' }]) assert.equal(enabledMapsConfig(invalid), false);
});

test('copy/create preserve only the optional point and editable fields while clearing all original times', () => {
  const source = { id: 42, title: '活动', description: '介绍', location: '地址', locationPoint: { ...point, secret: 'discard' },
    category: 'SPORTS', capacity: 10, startsAt: '2020-01-01T00:00:00Z', endsAt: '2020-01-01T02:00:00Z',
    registrationDeadline: '2019-01-01T00:00:00Z', coverUrl: '/old', checkedInAt: 'old', cancelled: true };
  const draft = activityCopyDraft(source);
  assert.deepEqual(draft.locationPoint, point); assert.notEqual(draft.locationPoint, source.locationPoint);
  assert.equal(draft.startsAt, undefined); assert.equal(draft.endsAt, undefined); assert.equal(draft.registrationDeadline, undefined);
  assert.equal(Object.hasOwn(draft, 'coverUrl'), false); assert.equal(Object.hasOwn(draft, 'checkedInAt'), false);
  const request = activityCreateRequest({ ...draft, ...source, startsAt: '2035-01-02T10:30', endsAt: '', registrationDeadline: '' });
  assert.deepEqual(request.locationPoint, point); assert.equal(Object.hasOwn(request.locationPoint, 'secret'), false);
  assert.equal(Object.hasOwn(request, 'id'), false); assert.equal(Object.hasOwn(request, 'cancelled'), false);
  assert.equal(activityCopyDraft({ ...source, locationPoint: null }).locationPoint, null);
  assert.equal(auditFieldLabels.locationLongitude, '地图经度（GCJ-02）');
  assert.equal(auditFieldLabels.locationLatitude, '地图纬度（GCJ-02）');
  assert.equal(auditChangeText('locationLongitude', '121.473701'), '121.473701');
  assert.equal(auditChangeText('locationLatitude', null), '未设置');
});

test('SDK subscribers deduplicate one load, abort independently and do not reload after success', async () => {
  const starts = [], sdk = { fixture: 'contract replacement; not the real AMap service' };
  const loader = createAmapSdkLoader((configuration, ready, failed) => {
    starts.push({ configuration, ready, failed }); return () => {};
  });
  const first = new AbortController(), second = new AbortController();
  const a = loader.subscribe(config, first.signal), b = loader.subscribe(config, second.signal);
  assert.equal(starts.length, 1); first.abort();
  await assert.rejects(a, { name: 'AbortError' }); starts[0].ready(sdk);
  assert.equal(await b, sdk); assert.equal(await loader.subscribe(config, new AbortController().signal), sdk);
  assert.equal(starts.length, 1);
});

test('SDK failure waits for manual retry, cleans the failed script and ignores late callbacks from that round', async () => {
  const starts = [], loader = createAmapSdkLoader((configuration, ready, failed) => {
    const item = { ready, failed, cleaned: 0 }; starts.push(item); return () => item.cleaned++;
  });
  const first = loader.subscribe(config, new AbortController().signal);
  starts[0].failed(); await assert.rejects(first, /手动重试/);
  await assert.rejects(loader.subscribe(config, new AbortController().signal), /手动重试/);
  assert.equal(starts.length, 1);
  const retry = loader.subscribe(config, new AbortController().signal, true);
  assert.equal(starts.length, 2); assert.equal(starts[0].cleaned, 1);
  starts[0].ready({ old: true }); starts[0].failed();
  const sdk = { new: true }; starts[1].ready(sdk); assert.equal(await retry, sdk);
});

test('already aborted or unconfigured SDK subscriptions never insert a script; abandoned subscribers consume late failures', async () => {
  let started = 0, fail;
  const loader = createAmapSdkLoader((configuration, ready, failed) => { started++; fail = failed; return () => {}; });
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(loader.subscribe(config, aborted.signal), { name: 'AbortError' });
  await assert.rejects(loader.subscribe({ ...config, enabled: false }, new AbortController().signal), /未配置/);
  assert.equal(started, 0);
  const abandoned = new AbortController(), pending = loader.subscribe(config, abandoned.signal); abandoned.abort();
  await assert.rejects(pending, { name: 'AbortError' }); fail();
  await Promise.resolve(); assert.equal(started, 1);
});

test('search/reverse success, error and finally tickets expire on new operations, route changes, close and same-user login', () => {
  for (const action of ['search', 'pick', 'route', 'close', 'same-user-login']) {
    const auth = new AuthRequestGuard(), generation = auth.captureAuthentication(); let route = 'activity:42';
    const gate = new MapOperationGate(() => route === 'activity:42' && auth.isCurrentAuthentication(generation));
    const old = gate.begin(); assert.equal(gate.isCurrent(old), true);
    if (action === 'search' || action === 'pick') gate.begin();
    if (action === 'route') route = 'activity:43';
    if (action === 'close') gate.dispose();
    if (action === 'same-user-login') auth.beginAuthentication();
    assert.equal(gate.isCurrent(old), false, action);
  }
});

test('provider adapter exposes selected/rounded points, results and reverse addresses and destroys its handlers once', async () => {
  const calls = [], callbacks = {}, events = {};
  class Map {
    constructor(container, options) { calls.push(['map', options]); }
    on(type, callback) { events[type] = callback; }
    off(type, callback) { assert.equal(events[type], callback); delete events[type]; calls.push(['off']); }
    setCenter(position) { calls.push(['center', position]); }
    destroy() { calls.push(['destroy']); }
  }
  class Marker { setMap(value) { calls.push(['marker-map', value]); } setPosition(value) { calls.push(['marker-position', value]); } }
  class PlaceSearch { search(keyword, callback) { callbacks.search = callback; } }
  class Geocoder { getAddress(position, callback) { callbacks.reverse = callback; } }
  const selected = [], map = createActivityMap({ Map, Marker, PlaceSearch, Geocoder }, {}, point, value => selected.push(value));
  events.click({ lnglat: { getLng: () => 121.12345678, getLat: () => 31.12345678 } });
  assert.deepEqual(selected, [{ longitude: 121.1234568, latitude: 31.1234568 }]);
  const searching = map.search('场馆'); callbacks.search('complete', { poiList: { pois: [{ name: '场馆', address: '地址', location: { lng: 121, lat: 31 } }] } });
  assert.deepEqual(await searching, [{ location: '地址 场馆', locationPoint: { longitude: 121, latitude: 31 } }]);
  const reversing = map.reverse(point); callbacks.reverse('complete', { regeocode: { formattedAddress: '上海场馆' } });
  assert.deepEqual(await reversing, { location: '上海场馆', locationPoint: point });
  const late = map.search('旧地点'), neverReturns = map.reverse(point);
  map.destroy(); map.destroy(); callbacks.search('complete', { poiList: { pois: [] } });
  await assert.rejects(late, { name: 'AbortError' }); await assert.rejects(neverReturns, { name: 'AbortError' });
  assert.equal(calls.filter(value => value[0] === 'destroy').length, 1);
  assert.equal(calls.filter(value => value[0] === 'off').length, 1); assert.equal(events.click, undefined);
});

test('asynchronous malformed provider search/reverse callbacks reject immediately without uncaught or late errors', async () => {
  const callbacks = {};
  class Map { setCenter() {} destroy() {} }
  class Marker { setMap() {} setPosition() {} }
  class PlaceSearch { search(keyword, callback) { callbacks.search = callback; } }
  class Geocoder { getAddress(position, callback) { callbacks.reverse = callback; } }
  const map = createActivityMap({ Map, Marker, PlaceSearch, Geocoder }, {}, null);
  const throwing = () => { throw new Error('raw provider exception must not escape'); };
  const malformed = {
    search: [['error', undefined], ['complete', undefined], ['complete', null], ['complete', {}],
      ['complete', { poiList: { pois: 'invalid' } }], ['complete', { poiList: { pois: [null] } }],
      ['complete', { poiList: { pois: [42] } }], ['complete', { poiList: { pois: [{ name: '场地' }] } }],
      ['complete', { poiList: { pois: [{ name: '场地', location: { getLng: throwing, getLat: () => 31 } }] } }],
      ['complete', { poiList: { pois: [{ get name() { return throwing(); }, location: { lng: 121, lat: 31 } }] } }]],
    reverse: [['error', undefined], ['complete', undefined], ['complete', null], ['complete', {}],
      ['complete', { regeocode: null }], ['complete', { regeocode: { formattedAddress: 42 } }],
      ['complete', { regeocode: { get formattedAddress() { return throwing(); } } }]],
  };
  try {
    for (const kind of ['search', 'reverse']) for (const [status, result] of malformed[kind]) {
      let settled = false;
      const pending = kind === 'search' ? map.search('场地') : map.reverse(point);
      const outcome = pending.then(() => ({ success: true }), error => ({ error }));
      void outcome.then(() => { settled = true; });
      const callback = callbacks[kind]; queueMicrotask(() => callback(status, result));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, true, `${kind} must reject immediately instead of waiting for the timeout`);
      const response = await outcome;
      assert.ok(response.error instanceof Error); assert.match(response.error.message, kind === 'search' ? /地点搜索失败/ : /无法获取所选位置地址/);
      assert.doesNotMatch(response.error.message, /raw provider|TypeError|超时/);
      // A second malformed response after settlement must remain contained as well.
      queueMicrotask(() => callback('complete', undefined)); await new Promise(resolve => setImmediate(resolve));
    }
    const empty = map.search('无结果'); queueMicrotask(() => callbacks.search('no_data', undefined));
    assert.deepEqual(await empty, []);
    const abandoned = map.reverse(point), late = callbacks.reverse; map.destroy();
    await assert.rejects(abandoned, { name: 'AbortError' });
    queueMicrotask(() => late('error', undefined)); await new Promise(resolve => setImmediate(resolve));
  } finally { map.destroy(); }
});

test('maps config is a cancellable no-store public read and update explicitly whitelists the optional point', async () => {
  const { api } = await import('../src/api.ts?map-contract-test');
  const calls = [], controller = new AbortController();
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.endsWith('/csrf') ? { token: 'fake-csrf', headerName: 'X-CSRF-TOKEN' } :
      url.endsWith('/maps/config') ? config : { id: 42 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  assert.deepEqual(await api.mapsConfig(controller.signal), config);
  assert.equal(calls[0].url, '/api/maps/config'); assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.signal, controller.signal);
  const details = { title: '标题', description: '介绍', location: '地址', locationPoint: point, role: 'ADMIN', capacity: 999 };
  await api.updateActivity(42, details, controller.signal);
  const write = calls.find(call => call.options.method === 'PATCH');
  assert.deepEqual(JSON.parse(write.options.body), { title: '标题', description: '介绍', location: '地址', locationPoint: point });
  await api.updateActivity(42, { ...details, locationPoint: null }, controller.signal);
  assert.equal(JSON.parse(calls.at(-1).options.body).locationPoint, null);
});
