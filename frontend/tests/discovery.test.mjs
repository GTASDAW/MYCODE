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

test('discovery URLs restore literal keywords, status and pagination without trimming or treating SQL wildcard characters specially', () => {
  const query = { keyword: ' 上海 %_! +&? ', status: 'OPEN', page: 3, pageSize: 24 };
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

test('all lifecycle status filters retain their exact wire values', () => {
  for (const status of ['ALL', 'OPEN', 'FULL', 'STARTED', 'CANCELLED', 'UPCOMING'])
    assert.equal(parseActivityQuery(`?status=${status}`).query.status, status);
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
  const source = '/activities?keyword=%E4%B8%8A%E6%B5%B7&status=OPEN&page=2&pageSize=24';
  const details = activityDetailsPath(42, source);
  assert.equal(details.split('?')[0], '/activities/42');
  assert.equal(new URLSearchParams(details.slice(details.indexOf('?'))).get('from'), source);
  assert.equal(activityDetailsPath(42), '/activities/42');
  assert.equal(new URLSearchParams(activityDetailsPath(42, '//example.com').split('?')[1]).get('from'), '/activities');
});
