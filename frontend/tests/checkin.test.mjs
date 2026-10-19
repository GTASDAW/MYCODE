import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { canCheckInRegistration, checkInLabel } from '../src/registrationCheckIn.ts';
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
