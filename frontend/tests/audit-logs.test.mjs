import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityAuditLogPath, auditLogListPath, defaultAuditLogQuery, parseAuditActivityId,
  parseAuditLogQuery, serializeAuditLogQuery } from '../src/auditLogQuery.ts';
import { auditActionLabels, auditChangeText, auditFieldLabels, formatAuditDateTime } from '../src/auditLogPresentation.ts';
import { AuthRequestGuard, readAccountResource } from '../src/authRequestGuard.ts';

test('audit URLs preserve all actions, supported pagination and safe activity IDs while canonicalizing defaults', () => {
  assert.deepEqual(parseAuditLogQuery(''), defaultAuditLogQuery);
  assert.equal(serializeAuditLogQuery(defaultAuditLogQuery), '');
  for (const action of ['ALL', 'CREATE', 'EDIT', 'CANCEL', 'CHECK_IN', 'CHECK_IN_REVOKE']) {
    const query = { action, page: 3, pageSize: 20, activityId: 42 };
    assert.deepEqual(parseAuditLogQuery(serializeAuditLogQuery(query)), query);
  }
  const query = parseAuditLogQuery('?page=0002&pageSize=010&action=EDIT&activityId=00042&userId=99&actorId=888');
  assert.deepEqual(query, { action: 'EDIT', page: 2, pageSize: 10, activityId: 42 });
  assert.equal(auditLogListPath(query), '/admin/audit-logs?action=EDIT&page=2&activityId=42');
  assert.equal(activityAuditLogPath(42), '/admin/audit-logs?activityId=42');
  assert.equal(serializeAuditLogQuery(parseAuditLogQuery('?action=ALL&page=1&pageSize=10&unknown=yes')), '');
});

test('invalid audit URL values never become API criteria, including unsafe IDs, exponent notation and controls', () => {
  for (const id of ['0', '-1', '1.5', '1e3', '+1', '9007199254740992', 'Infinity', 'NaN', '1x', ' 1 ', '\u00001', '１'])
    assert.equal(parseAuditLogQuery(`?activityId=${encodeURIComponent(id)}`).activityId, null, id);
  for (const page of ['0', '-1', '1.5', '1e3', '2147483648'])
    assert.equal(parseAuditLogQuery(`?page=${page}`).page, 1, page);
  for (const size of ['0', '-1', '101', '1e2', '10.5'])
    assert.equal(parseAuditLogQuery(`?pageSize=${size}`).pageSize, 10, size);
  assert.equal(parseAuditLogQuery('?action=create').action, 'ALL');
  assert.deepEqual(parseAuditLogQuery('?activityId=9007199254740991&page=2147483647&pageSize=100'),
    { action: 'ALL', activityId: Number.MAX_SAFE_INTEGER, page: 2147483647, pageSize: 100 });
});

test('activity filter drafts normalize surrounding spaces without accepting non-integer identities', () => {
  assert.equal(parseAuditActivityId(' 00042 '), 42);
  assert.equal(parseAuditActivityId('9007199254740991'), Number.MAX_SAFE_INTEGER);
  for (const value of ['', '   ', '-3', '+3', '3.0', '3e2', '9007199254740992', '\n1\u0000'])
    assert.equal(parseAuditActivityId(value), null, JSON.stringify(value));
});

test('audit timestamps display Beijing time and preserve all microseconds instead of Date millisecond truncation', () => {
  assert.match(formatAuditDateTime('2030-01-01T16:00:01.123456Z'), /1月2日.*00:00:01\.123456$/);
  assert.match(formatAuditDateTime('2030-01-01T08:02:03.000001Z'), /16:02:03\.000001$/);
  assert.match(formatAuditDateTime('2030-01-01T08:02:03Z'), /16:02:03\.000000$/);
  assert.equal(auditChangeText('checkedInAt', '2030-01-01T08:02:03.123456Z'), formatAuditDateTime('2030-01-01T08:02:03.123456Z'));
  assert.equal(formatAuditDateTime('not-a-time'), '时间不可用');
});

test('audit changes retain literal long multiline text and distinguish an absent value from an empty string', () => {
  const text = '<img src=x onerror=alert(1)>\n' + '介绍'.repeat(1200) + '\n末尾';
  assert.equal(auditChangeText('description', text), text);
  assert.equal(auditChangeText('title', ''), '');
  assert.equal(auditChangeText('title', null), '未设置');
  assert.deepEqual(Object.keys(auditActionLabels), ['CREATE', 'EDIT', 'CANCEL', 'CHECK_IN', 'CHECK_IN_REVOKE']);
  assert.deepEqual(Object.keys(auditFieldLabels), ['title', 'description', 'location', 'locationLongitude', 'locationLatitude', 'category', 'coverHash', 'startsAt', 'endsAt', 'registrationDeadline', 'capacity', 'cancelledAt', 'cancellationReason', 'checkedInAt', 'checkInMethod', 'checkedInBy', 'checkInReason']);
  assert.equal(auditChangeText('endsAt', '2030-01-01T08:02:03.123456Z'), formatAuditDateTime('2030-01-01T08:02:03.123456Z'));
  assert.equal(auditChangeText('registrationDeadline', '2030-01-01T08:02:03.123456Z'), formatAuditDateTime('2030-01-01T08:02:03.123456Z'));
  assert.equal(auditChangeText('coverHash', null), '未设置');
  assert.equal(auditChangeText('coverHash', 'a'.repeat(64)), 'a'.repeat(64));
  assert.equal(auditChangeText('checkInMethod', 'SELF_LOCATION'), '本人定位');
  assert.equal(auditChangeText('checkInMethod', 'ADMIN'), '管理员确认');
  assert.equal(auditChangeText('checkInMethod', null), '未设置');
  assert.equal(auditChangeText('checkInReason', '<b>现场核对</b>'), '<b>现场核对</b>');
  assert.equal(auditActionLabels.CHECK_IN_REVOKE, '撤销签到');
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('a previous audit filter or drawer result cannot publish success or expire a current account before cleanup runs', async () => {
  for (const result of [{ items: [{ id: 1 }], total: 51 }, { id: 1, changes: [] }, Object.assign(new Error('old 401'), { status: 401 })]) {
    const guard = new AuthRequestGuard();
    const account = guard.beginAccountRequest(1);
    let currentScope = 'ALL:page1:drawer1';
    const startedScope = currentScope;
    const response = deferred();
    let expired = 0;
    const pending = readAccountResource(() => response.promise, new AbortController().signal,
      () => currentScope === startedScope && guard.isSameAccount(account, 1), () => expired++);
    currentScope = 'EDIT:page1:drawer2';
    if (result instanceof Error) response.reject(result);
    else response.resolve(result);
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(expired, 0);
  }
});

test('audit detail success and errors expire after same-user re-login, another account, close or page leave', async () => {
  for (const obsoleteBy of ['same-user-login', 'another-account', 'drawer-close', 'page-leave']) {
    for (const failed of [false, true]) {
      const guard = new AuthRequestGuard();
      const account = guard.beginAccountRequest(1);
      const controller = new AbortController();
      const response = deferred();
      let currentUserId = 1;
      let expired = 0;
      const pending = readAccountResource(() => response.promise, controller.signal,
        () => guard.isSameAccount(account, currentUserId), () => expired++);
      if (obsoleteBy === 'same-user-login' || obsoleteBy === 'another-account') guard.beginAuthentication();
      if (obsoleteBy === 'another-account') currentUserId = 2;
      if (obsoleteBy === 'drawer-close' || obsoleteBy === 'page-leave') controller.abort();
      if (failed) response.reject(Object.assign(new Error('old 401'), { status: 401 }));
      else response.resolve({ id: 7, changes: [{ field: 'description', after: 'old text' }] });
      await assert.rejects(pending, error => error.name === 'AbortError');
      assert.equal(expired, 0);
    }
  }
});
