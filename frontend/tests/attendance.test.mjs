import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attendanceDashboardPath, attendanceRangeError, defaultAttendanceQuery, isAttendanceDate,
  parseAttendanceQuery, serializeAttendanceQuery } from '../src/attendanceQuery.ts';
import { attendanceRateText } from '../src/attendancePresentation.ts';
import { formatPreciseDateTime } from '../src/date.ts';
import { AuthRequestGuard, readAccountResource } from '../src/authRequestGuard.ts';

test('attendance defaults use the Beijing calendar day and an inclusive thirty-day range at its UTC boundary', () => {
  assert.deepEqual(defaultAttendanceQuery(Date.parse('2026-10-15T15:59:59.999Z')),
    { from: '2026-09-16', to: '2026-10-15', page: 1, pageSize: 10 });
  assert.deepEqual(defaultAttendanceQuery(Date.parse('2026-10-15T16:00:00Z')),
    { from: '2026-09-17', to: '2026-10-16', page: 1, pageSize: 10 });
  assert.equal(defaultAttendanceQuery(Date.parse('2026-12-31T16:00:00Z')).from, '2026-12-03');
});

test('attendance dates accept real leap days and the inclusive year bounds without JavaScript date rollover', () => {
  for (const date of ['2000-01-01', '2000-02-29', '2024-02-29', '2100-12-31']) assert.equal(isAttendanceDate(date), true, date);
  for (const date of ['1999-12-31', '2101-01-01', '2100-02-29', '2023-02-29', '2024-02-30', '2026-04-31',
    '2026-13-01', '2026-00-10', '2026-01-00', '2026-1-1', ' 2026-01-01', '2026-01-01T00:00:00Z', ''])
    assert.equal(isAttendanceDate(date), false, date);
});

test('date range validation counts both endpoints and rejects reversed, missing and more than 366-day intervals', () => {
  assert.equal(attendanceRangeError('2024-01-01', '2024-12-31'), null);
  assert.equal(attendanceRangeError('2023-01-01', '2024-01-01'), null);
  assert.equal(attendanceRangeError('2026-10-15', '2026-10-15'), null);
  assert.equal(attendanceRangeError('2024-01-01', '2025-01-01'), '日期范围最多包含 366 天，请缩小范围。');
  assert.equal(attendanceRangeError('2026-10-16', '2026-10-15'), '开始日期不能晚于结束日期。');
  assert.match(attendanceRangeError('', '2026-10-15'), /有效开始和结束日期/);
});

const defaults = { from: '2026-09-16', to: '2026-10-15', page: 1, pageSize: 10 };

test('attendance URLs freeze explicit dates and retain pagination while discarding client identity and unrelated criteria', () => {
  const query = parseAttendanceQuery('?from=2024-01-01&to=2024-12-31&page=0002&pageSize=020&userId=999&status=CANCELLED', defaults);
  assert.deepEqual(query, { from: '2024-01-01', to: '2024-12-31', page: 2, pageSize: 20 });
  assert.equal(attendanceDashboardPath(query), '/admin/dashboard?from=2024-01-01&to=2024-12-31&page=2&pageSize=20');
  assert.equal(serializeAttendanceQuery(defaults), '?from=2026-09-16&to=2026-10-15');
  assert.deepEqual(parseAttendanceQuery(serializeAttendanceQuery(defaults), { ...defaults, from: '2026-09-17', to: '2026-10-16' }), defaults);
  assert.deepEqual(parseAttendanceQuery('', defaults), defaults);
});

test('missing, empty or invalid URL dates recover both dates together and never reach the API as partial ranges', () => {
  for (const search of ['?from=2026-10-01', '?to=2026-10-15', '?from=&to=2026-10-15', '?from=2026-10-01&to=',
    '?from=2026-02-30&to=2026-03-01', '?from=2026-10-16&to=2026-10-15', '?from=2024-01-01&to=2025-01-01',
    '?from=1999-12-31&to=2000-01-01', '?from=2026-1-01&to=2026-01-02'])
    assert.deepEqual(parseAttendanceQuery(search, defaults), defaults, search);
});

test('attendance pagination is bounded, preserves valid custom sizes and canonicalizes integer spelling', () => {
  for (const page of ['0', '-1', '1e2', '1.5', '2147483648', 'Infinity'])
    assert.equal(parseAttendanceQuery(`?page=${page}`, defaults).page, 1, page);
  for (const size of ['0', '-1', '101', '1e2', '1.5', '20oops'])
    assert.equal(parseAttendanceQuery(`?pageSize=${size}`, defaults).pageSize, 10, size);
  assert.deepEqual(parseAttendanceQuery('?page=2147483647&pageSize=100', defaults), { ...defaults, page: 2147483647, pageSize: 100 });
  assert.equal(parseAttendanceQuery('?pageSize=7', defaults).pageSize, 7);
});

test('attendance percentages preserve the server scale and distinguish zero progress, no denominator and unknown data', () => {
  assert.equal(attendanceRateText(66.67), '66.67%');
  assert.equal(attendanceRateText(0), '0.00%');
  assert.equal(attendanceRateText(100), '100.00%');
  assert.equal(attendanceRateText(null), '不适用（无有效报名）');
  for (const value of [undefined, NaN, Infinity, -1, 100.01]) assert.equal(attendanceRateText(value), '—');
  assert.match(formatPreciseDateTime('2026-10-15T16:00:00.123456Z'), /10月16日.*00:00:00\.123456$/);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('late attendance pages and errors cannot publish after a newer date range, page size or same-query refresh', async () => {
  for (const nextScope of ['2026-01-01:2026-01-31:1:10:0', '2026-09-16:2026-10-15:1:20:0', '2026-09-16:2026-10-15:1:10:1']) {
    for (const failed of [false, true]) {
      const auth = new AuthRequestGuard();
      const ticket = auth.beginAccountRequest(1);
      let currentScope = '2026-09-16:2026-10-15:1:10:0';
      const capturedScope = currentScope;
      const response = deferred();
      let expired = 0;
      const pending = readAccountResource(() => response.promise, new AbortController().signal,
        () => currentScope === capturedScope && auth.isSameAccount(ticket, 1), () => expired++);
      currentScope = nextScope;
      if (failed) response.reject(Object.assign(new Error('old attendance 401'), { status: 401 }));
      else response.resolve({ total: 11, summary: { activeRegistrations: 100, checkInRate: 25 } });
      await assert.rejects(pending, error => error.name === 'AbortError');
      assert.equal(expired, 0);
    }
  }
});

test('all dashboard resources reject old successes and 401 errors after account switch or same-user re-login', async () => {
  for (const resource of ['overview', 'upcoming', 'attendance']) for (const nextUserId of [1, 2]) {
    for (const failed of [false, true]) {
      const auth = new AuthRequestGuard();
      const ticket = auth.beginAccountRequest(1);
      let currentUserId = 1;
      const response = deferred();
      let expired = 0;
      const pending = readAccountResource(() => response.promise, new AbortController().signal,
        () => auth.isSameAccount(ticket, currentUserId), () => expired++);
      auth.beginAuthentication();
      currentUserId = nextUserId;
      if (failed) response.reject(Object.assign(new Error(`old ${resource} 401`), { status: 401 }));
      else response.resolve({ id: 99, totalActivities: 3 });
      await assert.rejects(pending, error => error.name === 'AbortError');
      assert.equal(expired, 0);
    }
  }
});

test('leaving attendance for a roster cancels both old success and error without publishing to the returned panel', async () => {
  for (const failed of [false, true]) {
    const controller = new AbortController();
    const response = deferred();
    const pending = readAccountResource(() => response.promise, controller.signal, () => true, () => assert.fail('aborted panel expired authentication'));
    controller.abort();
    if (failed) response.reject(new Error('late attendance error'));
    else response.resolve({ asOf: '2026-10-15T08:00:00Z' });
    await assert.rejects(pending, error => error.name === 'AbortError');
  }
});
