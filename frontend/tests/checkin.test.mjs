import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { canCheckInRegistration, canCorrectCheckInRegistration, checkInLabel, checkInMethodLabel,
  locationCheckInUnavailableReason, checkInCorrectionReasonError } from '../src/registrationCheckIn.ts';
import { requestNativeLocation } from '../src/nativeLocation.ts';
import { downloadCsv } from '../src/fileDownload.ts';
import { AuthRequestGuard } from '../src/authRequestGuard.ts';

const originalDocument = globalThis.document;
const originalCreateUrl = URL.createObjectURL;
const originalRevokeUrl = URL.revokeObjectURL;
afterEach(() => {
  globalThis.document = originalDocument;
  URL.createObjectURL = originalCreateUrl;
  URL.revokeObjectURL = originalRevokeUrl;
});

test('only an unsigned active participant of a started and uncancelled activity can check in', () => {
  const active = { status: 'ACTIVE', checkedInAt: null };
  assert.equal(canCheckInRegistration({ closed: false, cancelled: false }, active), false);
  assert.equal(canCheckInRegistration({ closed: true, cancelled: false }, active), true);
  assert.equal(canCheckInRegistration({ closed: true, cancelled: true }, active), false);
  assert.equal(canCheckInRegistration({ closed: true, cancelled: false }, { ...active, checkedInAt: '2030-01-01T00:00:00Z' }), false);
  for (const status of ['WAITING', 'CANCELLED'])
    assert.equal(canCheckInRegistration({ closed: true, cancelled: false }, { status, checkedInAt: null }), false);
  assert.equal(checkInLabel(active), '未签到');
  assert.equal(checkInLabel({ ...active, checkedInAt: '2030-01-01T00:00:00Z' }), '已签到');
  for (const status of ['WAITING', 'CANCELLED']) assert.equal(checkInLabel({ status, checkedInAt: null }), '不适用');
});

test('a stale pre-start snapshot opens check-in on time and an ended activity still supports make-up attendance', () => {
  const start = Date.parse('2030-01-01T00:00:00Z');
  const activity = { closed: false, cancelled: false, startsAt: '2030-01-01T00:00:00Z', endsAt: '2030-01-01T01:00:00Z' };
  const registration = { status: 'ACTIVE', checkedInAt: null };
  assert.equal(canCheckInRegistration(activity, registration, start - 1), false);
  assert.equal(canCheckInRegistration(activity, registration, start), true);
  assert.equal(canCheckInRegistration(activity, registration, start + 86400_000), true);
  assert.equal(canCheckInRegistration({ ...activity, cancelled: true }, registration, start + 86400_000), false);
  assert.equal(canCheckInRegistration({ ...activity, registrationDeadline: '2029-12-31T23:00:00Z', registrationClosed: true }, registration, start - 1), false);
  assert.equal(canCheckInRegistration({ ...activity, registrationDeadline: '2029-12-31T23:00:00Z', registrationClosed: true }, registration, start), true);
});

function browserDownload() {
  const events = [];
  const link = { style: {}, click() { events.push(['click', this.download]); }, remove() { events.push(['remove']); } };
  globalThis.document = { createElement: () => link, body: { appendChild: () => events.push(['append']) } };
  URL.createObjectURL = () => { events.push(['create']); return 'blob:test'; };
  URL.revokeObjectURL = url => events.push(['revoke', url]);
  return { events, link };
}

test('CSV downloads preserve the filename and always remove the temporary link and object URL', () => {
  const { events, link } = browserDownload();
  downloadCsv(new Blob(['\ufeff姓名\r\n中文\r\n']), 'activity-25-registrations.csv', () => true);
  assert.equal(link.href, 'blob:test');
  assert.deepEqual(events, [['create'], ['append'], ['click', 'activity-25-registrations.csv'], ['remove'], ['revoke', 'blob:test']]);
});

test('obsolete account or page results cannot initiate a download and release resources when superseded', () => {
  const { events } = browserDownload();
  downloadCsv(new Blob(['CSV']), 'activity-25-registrations.csv', () => false);
  assert.deepEqual(events, []);
  let checks = 0;
  downloadCsv(new Blob(['CSV']), 'activity-25-registrations.csv', () => ++checks === 1);
  assert.deepEqual(events, [['create'], ['append'], ['remove'], ['revoke', 'blob:test']]);
});

test('a CSV response from the same account before re-login cannot download under the new authentication', async () => {
  const { events } = browserDownload();
  const auth = new AuthRequestGuard();
  auth.beginAuthentication();
  const ticket = auth.beginAccountRequest(1);
  let complete;
  const response = new Promise(resolve => { complete = resolve; });
  const pending = response.then(blob => downloadCsv(blob, 'activity-25-registrations.csv', () => auth.isSameAccount(ticket, 1)));
  auth.beginAuthentication();
  complete(new Blob(['CSV']));
  await pending;
  assert.deepEqual(events, []);
  const freshTicket = auth.beginAccountRequest(1);
  downloadCsv(new Blob(['CSV']), 'activity-25-registrations.csv', () => auth.isSameAccount(freshTicket, 1));
  assert.ok(events.some(event => event[0] === 'click'));
});

test('a browser download failure still releases its temporary link and object URL', () => {
  const { events, link } = browserDownload();
  link.click = () => { throw new Error('browser rejected download'); };
  assert.throws(() => downloadCsv(new Blob(['CSV']), 'activity-25-registrations.csv', () => true), /browser rejected/);
  assert.deepEqual(events, [['create'], ['append'], ['remove'], ['revoke', 'blob:test']]);
});

test('self location check-in is limited to active unsigned records with a point and an exact ongoing window', () => {
  const start = Date.parse('2030-01-01T00:00:00Z');
  const registration = { status: 'ACTIVE', checkedInAt: null, activity: {
    startsAt: '2030-01-01T00:00:00Z', endsAt: '2030-01-01T01:00:00Z',
    locationPoint: { longitude: 116.4, latitude: 39.9 }, cancelled: false,
  } };
  const reason = (record = registration, enabled = true, now = start) => locationCheckInUnavailableReason(record, enabled, now);
  assert.equal(reason(), null);
  assert.equal(reason(registration, true, start + 3599_999), null);
  assert.match(reason(registration, true, start - 1), /开始后/);
  assert.match(reason(registration, true, start + 3600_000), /已结束/);
  assert.match(reason(registration, false), /暂不可用/);
  for (const activity of [{ ...registration.activity, locationPoint: null }, { ...registration.activity, endsAt: null }])
    assert.match(reason({ ...registration, activity }), /管理员/);
  for (const status of ['WAITING', 'CANCELLED']) assert.ok(reason({ ...registration, status }));
  assert.ok(reason({ ...registration, checkedInAt: '2030-01-01T00:00:00Z' }));
  assert.ok(reason({ ...registration, activity: { ...registration.activity, cancelled: true } }));
  const fractional = { ...registration, activity: { ...registration.activity,
    startsAt: '2030-01-01T00:00:00.000001Z', endsAt: '2030-01-01T01:00:00.000001Z' } };
  assert.ok(reason(fractional, true, start));
  assert.equal(reason(fractional, true, start + 3600_000), null);
});

test('administrator corrections support signed records after the end but preserve active and cancellation restrictions', () => {
  const activity = { cancelled: false, closed: false, startsAt: '2030-01-01T00:00:00Z', endsAt: '2030-01-01T01:00:00Z' };
  const record = { status: 'ACTIVE', checkedInAt: '2030-01-01T00:00:01Z' };
  const start = Date.parse(activity.startsAt);
  assert.equal(canCorrectCheckInRegistration(activity, record, start - 1), false);
  assert.equal(canCorrectCheckInRegistration(activity, record, start + 86400_000), true);
  assert.equal(canCorrectCheckInRegistration({ ...activity, cancelled: true }, record, start), false);
  for (const status of ['WAITING', 'CANCELLED'])
    assert.equal(canCorrectCheckInRegistration(activity, { ...record, status }, start), false);
  assert.equal(checkInMethodLabel('SELF_LOCATION'), '本人定位');
  assert.equal(checkInMethodLabel('ADMIN'), '管理员确认');
  assert.equal(checkInMethodLabel(null), '—');
});

test('correction reasons are mandatory single line text with a 500 character maximum', () => {
  assert.equal(checkInCorrectionReasonError('  管理员核对现场记录  '), null);
  assert.equal(checkInCorrectionReasonError('补'.repeat(500)), null);
  for (const text of ['', '   ', 'a'.repeat(501), '😀'.repeat(251), '补签\n原因', '原因\r', '原因\t', '原因\u0085', '原因\u2028', '\0原因'])
    assert.ok(checkInCorrectionReasonError(text), JSON.stringify(text));
});

function nativeRequest(overrides = {}) {
  let success, failure, options, calls = 0;
  const controller = new AbortController();
  const geolocation = { getCurrentPosition(ok, fail, configured) { calls++; success = ok; failure = fail; options = configured; } };
  const promise = requestNativeLocation({ signal: controller.signal, isCurrent: () => true,
    secureContext: true, geolocation, ...overrides });
  return { promise, controller, success: value => success(value), failure: value => failure(value),
    options: () => options, calls: () => calls };
}
const nativePosition = (accuracy = 20) => ({ coords: { longitude: 116.397, latitude: 39.908, accuracy } });

test('native positioning requests a single uncached accurate fix and returns WGS84 without client conversion', async () => {
  const request = nativeRequest();
  assert.equal(request.calls(), 1);
  assert.deepEqual(request.options(), { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
  request.success(nativePosition(100));
  assert.deepEqual(await request.promise, { longitude: 116.397, latitude: 39.908, accuracyMeters: 100 });
});

test('insecure contexts, unsupported browsers and obsolete requests do not ask for location', async () => {
  const insecure = nativeRequest({ secureContext: false });
  await assert.rejects(insecure.promise, /安全连接/);
  assert.equal(insecure.calls(), 0);
  const obsolete = nativeRequest({ isCurrent: () => false });
  await assert.rejects(obsolete.promise, error => error.name === 'AbortError');
  assert.equal(obsolete.calls(), 0);
  const controller = new AbortController();
  controller.abort();
  const cancelled = nativeRequest({ signal: controller.signal });
  await assert.rejects(cancelled.promise, error => error.name === 'AbortError');
  assert.equal(cancelled.calls(), 0);
  await assert.rejects(requestNativeLocation({ signal: new AbortController().signal, isCurrent: () => true,
    secureContext: true, geolocation: {} }), /无法获取位置/);
});

test('native permission, timeout and position failures have manual recovery messages', async () => {
  for (const [code, message] of [[1, /定位权限未开启/], [2, /无法获取位置/], [3, /定位超时/]]) {
    const request = nativeRequest();
    request.failure({ code, message: 'raw browser detail must not be displayed' });
    await assert.rejects(request.promise, error => message.test(error.message) && /手动重试/.test(error.message) &&
      !error.message.includes('raw browser'));
  }
});

test('native silence after a dismissed permission prompt has its own ten-second deadline and can be retried', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const request = nativeRequest();
  let state = 'pending';
  const result = request.promise.then(() => { state = 'resolved'; }, () => { state = 'rejected'; });
  context.mock.timers.tick(9999); await Promise.resolve();
  assert.equal(state, 'pending'); assert.equal(request.calls(), 1);
  context.mock.timers.tick(1); await Promise.resolve();
  assert.equal(state, 'rejected');
  await assert.rejects(request.promise, /定位超时/); await result;
  request.success(nativePosition()); request.failure({ code: 1 });
  assert.equal(state, 'rejected'); assert.equal(request.calls(), 1);
  const fresh = nativeRequest();
  fresh.success(nativePosition());
  assert.deepEqual(await fresh.promise, { longitude: 116.397, latitude: 39.908, accuracyMeters: 20 });
  context.mock.timers.tick(20000); await Promise.resolve();
  assert.equal(fresh.calls(), 1);
});

test('invalid precision and coordinates never become a check-in submission', async () => {
  for (const accuracy of [0, -1, 100.0001, NaN, Infinity]) {
    const request = nativeRequest();
    request.success(nativePosition(accuracy));
    await assert.rejects(request.promise, /定位精度不足/);
  }
  for (const coords of [{ longitude: 181, latitude: 0 }, { longitude: 0, latitude: -91 }, { longitude: NaN, latitude: 0 }]) {
    const request = nativeRequest();
    request.success({ coords: { ...coords, accuracy: 1 } });
    await assert.rejects(request.promise, /有效位置/);
  }
});

test('aborted or superseded native callbacks cannot start a write including after same-account reauthentication', async () => {
  for (const change of ['abort', 'page', 'same-account-login']) {
    const auth = new AuthRequestGuard(), ticket = auth.beginAccountRequest(1);
    let page = 'old', writes = 0;
    const request = nativeRequest({ isCurrent: () => page === 'old' && auth.isSameAccount(ticket, 1) });
    const submit = request.promise.then(() => writes++);
    if (change === 'abort') request.controller.abort();
    if (change === 'page') page = 'new';
    if (change === 'same-account-login') auth.beginAuthentication();
    request.success(nativePosition());
    request.failure({ code: 1 });
    await assert.rejects(submit, error => error.name === 'AbortError');
    assert.equal(writes, 0);
  }
});
