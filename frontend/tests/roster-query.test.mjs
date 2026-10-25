import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultRosterQuery, parseRosterQuery, rosterActivityDetailsPath, rosterListPath, serializeRosterQuery } from '../src/rosterQuery.ts';
import { safeActivityDetailReturn } from '../src/activityDetailNavigation.ts';
import { safeActivityListPath } from '../src/activityDiscovery.ts';
import { safeReturnPath } from '../src/pages/authNavigation.ts';
import { AuthRequestGuard, readAccountResource } from '../src/authRequestGuard.ts';

test('roster URLs combine literal trimmed keywords and all filters with stable pagination and no client identity', () => {
  assert.deepEqual(parseRosterQuery(''), { query: defaultRosterQuery, notice: null });
  assert.equal(serializeRosterQuery(defaultRosterQuery), '');
  for (const status of ['ALL', 'ACTIVE', 'WAITING', 'CANCELLED']) for (const checkInStatus of ['ALL', 'CHECKED_IN', 'NOT_CHECKED_IN']) for (const checkInMethod of ['ALL', 'SELF_LOCATION', 'ADMIN']) {
    const query = { keyword: '中文 %_! +&?', status, checkInStatus, checkInMethod, page: 3, pageSize: 7 };
    const search = serializeRosterQuery(query);
    assert.deepEqual(parseRosterQuery(search), { query, notice: null });
    assert.equal(rosterListPath(42, query), `/admin/activities/42/registrations${search}`);
  }
  const parsed = parseRosterQuery('?keyword=++%25_+%2B%26++&status=ACTIVE&checkInStatus=NOT_CHECKED_IN&page=0002&pageSize=020&userId=99&actorId=77');
  assert.deepEqual(parsed, { query: { keyword: '%_ +&', status: 'ACTIVE', checkInStatus: 'NOT_CHECKED_IN', checkInMethod: 'ALL', page: 2, pageSize: 20 }, notice: null });
  assert.equal(serializeRosterQuery(parsed.query), '?keyword=%25_+%2B%26&status=ACTIVE&checkInStatus=NOT_CHECKED_IN&page=2&pageSize=20');
});

test('roster method URLs retain canonical order and older callers do not emit an undefined method', () => {
  const legacy = { keyword: '中文', status: 'ACTIVE', checkInStatus: 'CHECKED_IN', page: 2, pageSize: 20 };
  const search = '?keyword=%E4%B8%AD%E6%96%87&status=ACTIVE&checkInStatus=CHECKED_IN&page=2&pageSize=20';
  assert.equal(serializeRosterQuery(legacy), search);
  assert.equal(serializeRosterQuery({ ...legacy, checkInMethod: undefined }), search);
  assert.equal(serializeRosterQuery({ ...legacy, checkInMethod: 'ALL' }), search);
  assert.deepEqual(parseRosterQuery(search).query, { ...legacy, checkInMethod: 'ALL' });
  const filtered = serializeRosterQuery({ ...legacy, checkInMethod: 'SELF_LOCATION' });
  assert.equal(filtered, '?keyword=%E4%B8%AD%E6%96%87&status=ACTIVE&checkInStatus=CHECKED_IN&checkInMethod=SELF_LOCATION&page=2&pageSize=20');
  assert.deepEqual([...new URLSearchParams(filtered).keys()], ['keyword', 'status', 'checkInStatus', 'checkInMethod', 'page', 'pageSize']);
});

test('invalid roster integers and enumerations use defaults while valid custom values survive', () => {
  for (const page of ['0', '-1', '1.5', '1e2', '2147483648', 'NaN', 'Infinity'])
    assert.equal(parseRosterQuery(`?page=${page}`).query.page, 1);
  for (const pageSize of ['0', '-1', '101', '1.5', '1e2', '20oops'])
    assert.equal(parseRosterQuery(`?pageSize=${pageSize}`).query.pageSize, 10);
  for (const status of ['active', 'CHECKED_IN', 'ADMIN', 'ACTIVE '])
    assert.equal(parseRosterQuery(`?${new URLSearchParams({ status })}`).query.status, 'ALL');
  for (const checkInStatus of ['checked_in', 'ACTIVE', 'ADMIN', 'NOT_CHECKED_IN '])
    assert.equal(parseRosterQuery(`?${new URLSearchParams({ checkInStatus })}`).query.checkInStatus, 'ALL');
  assert.deepEqual(parseRosterQuery('?keyword=++&status=ALL&checkInStatus=ALL&page=1&pageSize=10').query, defaultRosterQuery);
  assert.deepEqual(parseRosterQuery('?page=2147483647&pageSize=100&status=WAITING&checkInStatus=CHECKED_IN').query,
    { ...defaultRosterQuery, page: 2147483647, pageSize: 100, status: 'WAITING', checkInStatus: 'CHECKED_IN' });
});

test('invalid roster methods normalize to ALL while retaining all other valid submitted conditions', () => {
  const expected = { keyword: '中文 %_', status: 'ACTIVE', checkInStatus: 'CHECKED_IN', checkInMethod: 'ALL', page: 3, pageSize: 7 };
  for (const checkInMethod of ['', 'admin', 'SELF_LOCATION ', 'CHECKED_IN', 'UNKNOWN', 'null']) {
    const parsed = parseRosterQuery(`?${new URLSearchParams({ keyword: ' 中文 %_ ', status: 'ACTIVE',
      checkInStatus: 'CHECKED_IN', checkInMethod, page: '3', pageSize: '7' })}`);
    assert.deepEqual(parsed, { query: expected, notice: null });
    assert.equal(new URLSearchParams(serializeRosterQuery(parsed.query)).has('checkInMethod'), false);
  }
});

test('overlong roster URL keywords clear explicitly without losing filters, pagination, or supported Unicode', () => {
  const parsed = parseRosterQuery(`?${new URLSearchParams({ keyword: 'a'.repeat(201), status: 'WAITING', checkInStatus: 'NOT_CHECKED_IN', checkInMethod: 'ADMIN', page: '2', pageSize: '7' })}`);
  assert.deepEqual(parsed.query, { keyword: '', status: 'WAITING', checkInStatus: 'NOT_CHECKED_IN', checkInMethod: 'ADMIN', page: 2, pageSize: 7 });
  assert.match(parsed.notice, /超过 200/);
  assert.equal(parseRosterQuery(serializeRosterQuery(parsed.query)).notice, null);
  assert.equal(parseRosterQuery(`?${new URLSearchParams({ keyword: '😀'.repeat(100) })}`).query.keyword, '😀'.repeat(100));
  assert.equal(parseRosterQuery(`?${new URLSearchParams({ keyword: '😀'.repeat(101) })}`).query.keyword, '');
});

test('only an explicitly authorized matching activity may return from detail to its canonical roster', () => {
  const query = { keyword: '中文 %_! +&?', status: 'ACTIVE', checkInStatus: 'NOT_CHECKED_IN', checkInMethod: 'SELF_LOCATION', page: 2, pageSize: 7 };
  const path = rosterListPath(42, query);
  assert.equal(safeActivityDetailReturn(path, 42), path);
  assert.equal(safeActivityDetailReturn('/admin/activities/42/registrations?keyword=++%25_++&page=0002&userId=99', 42),
    '/admin/activities/42/registrations?keyword=%25_&page=2');
  assert.equal(safeActivityDetailReturn(path), '/activities');
  assert.equal(safeActivityDetailReturn(path, 43), '/activities');
  assert.equal(safeActivityListPath(path), '/activities');
  const detail = rosterActivityDetailsPath(42, query);
  assert.equal(detail.split('?')[0], '/activities/42');
  assert.equal(new URLSearchParams(detail.split('?')[1]).get('from'), path);
  assert.equal(safeReturnPath(detail), detail);
  assert.equal(safeReturnPath(path), path);
  assert.equal(safeActivityDetailReturn('/admin/activities/42/registrations?checkInMethod=ADMIN&checkInStatus=CHECKED_IN&page=2', 42),
    '/admin/activities/42/registrations?checkInStatus=CHECKED_IN&checkInMethod=ADMIN&page=2');
  assert.equal(safeActivityDetailReturn('/admin/activities/42/registrations?checkInMethod=unknown&status=ACTIVE&page=2', 42),
    '/admin/activities/42/registrations?status=ACTIVE&page=2');
  for (const activityId of [0, -1, 42.5, Number.MAX_SAFE_INTEGER + 1, NaN])
    assert.equal(safeActivityDetailReturn(path, activityId), '/activities');
  for (const unsafe of ['https://example.com/admin/activities/42/registrations', '//example.com/admin/activities/42/registrations',
    '/admin/activities/0042/registrations', '/admin/activities/42/registrations/export', '/admin/activities/42/registrations/',
    '/admin/activities/43/registrations', '/admin/activities/42/../42/registrations', '/admin/activities/42%2fregistrations',
    '/admin/activities/42/registrations#x', '/admin/activities/42/registrations?keyword=x#x', '/admin/activities/42/registrations?keyword=\\bad'])
    assert.equal(safeActivityDetailReturn(unsafe, 42), '/activities', unsafe);
  assert.equal(safeActivityDetailReturn('/my-registrations?status=ACTIVE&page=2', 42), '/my-registrations?status=ACTIVE&page=2');
});

test('obsolete roster results and 401s cannot publish or queue correction after a keyword change, refresh or reauthentication', async () => {
  for (const change of ['keyword', 'check-in-filter', 'check-in-method', 'page-size', 'refresh', 'same-account-login', 'different-account-login']) for (const failed of [false, true]) {
    const auth = new AuthRequestGuard(), ticket = auth.beginAccountRequest(1);
    let userId = 1, revision = 0, query = { ...defaultRosterQuery, keyword: '旧关键词', page: 5 };
    const scope = () => `42:${serializeRosterQuery(query)}:${revision}`;
    const started = scope();
    let finish, fail, published = 0, expired = 0;
    const response = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const pending = readAccountResource(() => response, new AbortController().signal,
      () => scope() === started && auth.isSameAccount(ticket, userId), () => expired++).then(() => published++);
    if (change === 'keyword') query = { ...query, keyword: '新关键词' };
    if (change === 'check-in-filter') query = { ...query, checkInStatus: 'NOT_CHECKED_IN' };
    if (change === 'check-in-method') query = { ...query, checkInMethod: 'SELF_LOCATION' };
    if (change === 'page-size') query = { ...query, pageSize: 20 };
    if (change === 'refresh') revision++;
    if (change.includes('login')) { auth.beginAuthentication(); if (change === 'different-account-login') userId = 2; }
    if (failed) fail(Object.assign(new Error('obsolete roster'), { status: 401 })); else finish({ items: [], total: 0 });
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(published, 0);
    assert.equal(expired, 0);
  }
});
