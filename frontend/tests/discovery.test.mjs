import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activityDetailsPath,
  activityListPath,
  defaultActivityQuery,
  parseActivityQuery,
  safeActivityListPath,
  serializeActivityQuery,
} from '../src/activityDiscovery.ts';
import { parseAdminActivityQuery, serializeAdminActivityQuery, adminActivityListPath } from '../src/adminActivityQuery.ts';
import { activityStartDateRangeError, isActivityStartDate } from '../src/activityStartDate.ts';
import { safeActivityDetailReturn } from '../src/activityDetailNavigation.ts';
import { safeReturnPath } from '../src/pages/authNavigation.ts';
import { AuthRequestGuard, readAccountResource } from '../src/authRequestGuard.ts';

test('discovery URLs restore literal keywords, status and pagination without trimming or treating SQL wildcard characters specially', () => {
  const query = { keyword: ' 上海 %_! +&? ', status: 'OPEN', category: 'ALL', page: 3, pageSize: 24 };
  const search = serializeActivityQuery(query);
  assert.deepEqual(parseActivityQuery(search), { query, notice: null });
  assert.equal(activityListPath(query), `/activities${search}`);
  assert.equal(serializeActivityQuery(defaultActivityQuery), '');
  assert.deepEqual(parseActivityQuery(''), { query: defaultActivityQuery, notice: null });
});

test('invalid URL status and integer fields use bounded safe defaults', () => {
  for (const search of [
    '?status=ADMIN&page=0&pageSize=101',
    '?status=open&page=-2&pageSize=0',
    '?page=1.5&pageSize=12oops',
    '?page=2147483648&pageSize=999999999999999999999',
  ]) assert.deepEqual(parseActivityQuery(search).query, defaultActivityQuery);
  assert.deepEqual(parseActivityQuery('?page=2147483647&pageSize=100&status=UPCOMING').query,
    { ...defaultActivityQuery, page: 2147483647, pageSize: 100, status: 'UPCOMING' });
  assert.equal(serializeActivityQuery(parseActivityQuery('?page=0002&pageSize=01&unknown=value').query), '?page=2&pageSize=1');
});

test('long URL keywords are cleared with an explicit notice while other valid conditions survive', () => {
  const result = parseActivityQuery(`?${new URLSearchParams({ keyword: 'a'.repeat(201), status: 'FULL', page: '2' })}`);
  assert.deepEqual(result.query, { ...defaultActivityQuery, status: 'FULL', page: 2 });
  assert.ok(result.notice.includes('200'));
  assert.equal(parseActivityQuery(serializeActivityQuery(result.query)).notice, null);
  assert.equal(parseActivityQuery(`?${new URLSearchParams({ keyword: '😀'.repeat(100) })}`).query.keyword.length, 200);
  assert.equal(parseActivityQuery(`?${new URLSearchParams({ keyword: '😀'.repeat(101) })}`).query.keyword, '');
});

test('all lifecycle status filters retain their exact wire values including the legacy started union', () => {
  for (const status of ['ALL', 'OPEN', 'FULL', 'STARTED', 'ONGOING', 'ENDED', 'CANCELLED', 'UPCOMING'])
    assert.equal(parseActivityQuery(`?status=${status}`).query.status, status);
  for (const status of ['ongoing', 'ended', 'ONGOING ', 'ENDED ', 'ONGOING_ENDED'])
    assert.equal(parseActivityQuery(`?${new URLSearchParams({ status })}`).query.status, 'ALL');
});

test('detail return destinations accept only the internal activities list and normalize its known query parameters', () => {
  const source = '/activities?keyword=%25_&status=FULL&page=2&pageSize=24';
  assert.equal(safeActivityListPath(source), source);
  assert.equal(safeActivityListPath('/activities?unknown=1&from=https%3A%2F%2Fexample.com&page=0002'), '/activities?page=2');
  for (const unsafe of [
    null, {}, 'https://example.com/activities', '//example.com/activities',
    '/admin/activities', '/activities/1', '/activities/../admin', '/activities%2f..%2fadmin',
    '/activities#hash', '/activities?status=ALL#hash', '/activities?keyword=\\bad',
    '/activities\n', '/activities?keyword=\u0000bad',
  ]) assert.equal(safeActivityListPath(unsafe), '/activities');
});

test('detail hrefs preserve the list query after refresh while unrelated entry points remain compatible', () => {
  for (const status of ['OPEN', 'STARTED', 'ONGOING', 'ENDED']) {
    const source = `/activities?keyword=%E4%B8%8A%E6%B5%B7&status=${status}&category=SPORTS&page=2&pageSize=24`;
    const details = activityDetailsPath(42, source);
    assert.equal(details.split('?')[0], '/activities/42');
    assert.equal(new URLSearchParams(details.slice(details.indexOf('?'))).get('from'), source);
  }
  assert.equal(activityDetailsPath(42), '/activities/42');
  assert.equal(new URLSearchParams(activityDetailsPath(42, '//example.com').split('?')[1]).get('from'), '/activities');
});

test('start-date filters accept strict real calendar dates, optional endpoints and long inclusive ranges', () => {
  for (const date of ['2000-01-01', '2000-02-29', '2024-02-29', '2100-12-31'])
    assert.equal(isActivityStartDate(date), true, date);
  for (const date of ['1999-12-31', '2101-01-01', '2100-02-29', '2023-02-29', '2026-02-30',
    '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-1-01', '2026-01-1',
    ' 2026-01-01', '2026-01-01 ', '2026-01-01T00:00:00Z', '']) {
    assert.equal(isActivityStartDate(date), false, date);
    if (date !== '') {
      assert.match(activityStartDateRangeError(date, ''), /有效开始日期/, date);
      assert.match(activityStartDateRangeError('', date), /有效开始日期/, date);
    }
  }
  for (const [from, to] of [['', ''], ['2000-01-01', ''], ['', '2100-12-31'],
    ['2026-10-23', '2026-10-23'], ['2000-01-01', '2100-12-31']])
    assert.equal(activityStartDateRangeError(from, to), null);
  assert.match(activityStartDateRangeError('2026-10-24', '2026-10-23'), /不能晚于/);
});

test('public and admin URLs canonically combine one or both start dates with existing criteria and preserve legacy shapes', () => {
  for (const [parse, serialize, path, pageSize] of [
    [parseActivityQuery, serializeActivityQuery, activityListPath, 12],
    [parseAdminActivityQuery, serializeAdminActivityQuery, adminActivityListPath, 10],
  ]) {
    const legacy = { keyword: '中文 %_! +&?', status: 'OPEN', category: 'TECHNOLOGY', page: 2, pageSize: 7 };
    assert.deepEqual(parse(serialize(legacy)), { query: legacy, notice: null });
    assert.equal('startDateFrom' in parse('').query, false);
    assert.equal('startDateTo' in parse('').query, false);
    for (const dates of [{ startDateFrom: '2000-01-01' }, { startDateTo: '2100-12-31' },
      { startDateFrom: '2000-01-01', startDateTo: '2100-12-31' }]) {
      const query = { ...legacy, ...dates };
      const expected = `?keyword=%E4%B8%AD%E6%96%87+%25_%21+%2B%26%3F&status=OPEN&category=TECHNOLOGY&${new URLSearchParams(dates)}&page=2&pageSize=7`;
      assert.equal(serialize(query), expected);
      assert.deepEqual(parse(expected), { query, notice: null });
      assert.equal(safeReturnPath(path(query)), path(query));
      const paged = { ...query, page: 3, pageSize };
      assert.deepEqual(parse(serialize(paged)).query, paged);
    }
  }
});

test('invalid URL endpoints clear independently, reversed valid ranges clear together, and notices survive other invalid criteria', () => {
  for (const parse of [parseActivityQuery, parseAdminActivityQuery]) {
    for (const invalid of ['', '1999-12-31', '2101-01-01', '2026-02-30', '2026-1-01', '2026-01-01 ', '2026-01-01T00:00:00Z']) {
      for (const side of ['startDateFrom', 'startDateTo']) {
        const other = side === 'startDateFrom' ? 'startDateTo' : 'startDateFrom';
        const params = { keyword: '中文 %_', status: 'FULL', category: 'SPORTS', [side]: invalid,
          [other]: '2026-10-23', page: '2', pageSize: '7', userId: '999' };
        const result = parse(`?${new URLSearchParams(params)}`);
        assert.deepEqual(result.query, { keyword: '中文 %_', status: 'FULL', category: 'SPORTS',
          [other]: '2026-10-23', page: 2, pageSize: 7 });
        assert.match(result.notice, /无效开始日期/);
      }
    }
    const result = parse(`?${new URLSearchParams({ keyword: 'a'.repeat(201), status: 'CANCELLED', category: 'OTHER',
      startDateFrom: '2026-10-24', startDateTo: '2026-10-23', page: '2', pageSize: '7' })}`);
    assert.deepEqual(result.query, { keyword: '', status: 'CANCELLED', category: 'OTHER', page: 2, pageSize: 7 });
    assert.match(result.notice, /200/);
    assert.match(result.notice, /已清空两端日期/);
  }
});

test('public details and login return chains keep canonical start dates while rejecting unrelated destinations', () => {
  const source = '/activities?keyword=%25_&status=OPEN&category=SPORTS&startDateFrom=2024-02-29&startDateTo=2026-10-23&page=2&pageSize=24';
  assert.equal(safeActivityListPath(source), source);
  assert.equal(safeActivityDetailReturn(source), source);
  const details = activityDetailsPath(42, source);
  assert.equal(new URLSearchParams(details.slice(details.indexOf('?'))).get('from'), source);
  assert.equal(safeReturnPath(details), details);
  assert.equal(safeActivityListPath('/activities?startDateTo=2026-10-23&startDateFrom=bad&category=SPORTS&page=0002'),
    '/activities?category=SPORTS&startDateTo=2026-10-23&page=2');
  for (const unsafe of ['//evil.example/activities?startDateFrom=2026-10-23',
    'https://evil.example/activities?startDateFrom=2026-10-23', '/activities?startDateFrom=2026-10-23#bad'])
    assert.equal(safeActivityListPath(unsafe), '/activities');
});

test('changed date criteria and authentication invalidate old successes, errors and queued page corrections', async () => {
  for (const change of ['startDateFrom', 'startDateTo', 'both', 'same-account-login']) {
    for (const errorStatus of [null, 401, 500]) {
      const auth = new AuthRequestGuard();
      const generation = auth.captureAuthentication();
      let query = { ...defaultActivityQuery, startDateFrom: '2026-10-01', startDateTo: '2026-10-23', page: 3 };
      const capturedScope = serializeActivityQuery(query);
      let resolve, reject;
      const response = new Promise((done, fail) => { resolve = done; reject = fail; });
      let expired = 0, published = 0, corrected = 0;
      const current = () => serializeActivityQuery(query) === capturedScope && auth.isCurrentAuthentication(generation);
      const pending = readAccountResource(() => response, new AbortController().signal, current, () => expired++)
        .then(page => { published++; if (current() && page.total === 0) corrected++; });
      if (change === 'same-account-login') auth.beginAuthentication();
      else query = { ...query, ...(change !== 'startDateTo' ? { startDateFrom: '2026-10-02' } : {}),
        ...(change !== 'startDateFrom' ? { startDateTo: '2026-10-24' } : {}) };
      if (errorStatus !== null) reject(Object.assign(new Error('late date search error'), { status: errorStatus }));
      else resolve({ total: 0, items: [] });
      await assert.rejects(pending, error => error.name === 'AbortError');
      assert.equal(expired, 0);
      assert.equal(published, 0);
      assert.equal(corrected, 0);
    }
  }
});
