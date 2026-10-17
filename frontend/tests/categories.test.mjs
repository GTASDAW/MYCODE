import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityCategoryFilterOptions, activityCategoryLabel, activityCategoryLabels, activityCategoryOptions,
  isActivityCategory, parseActivityCategoryFilter } from '../src/activityCategory.ts';
import { activityDetailsPath, activityListPath, defaultActivityQuery, parseActivityQuery, safeActivityListPath,
  serializeActivityQuery } from '../src/activityDiscovery.ts';
import { adminActivityListPath, defaultAdminActivityQuery, parseAdminActivityQuery,
  serializeAdminActivityQuery } from '../src/adminActivityQuery.ts';
import { safeActivityDetailReturn } from '../src/activityDetailNavigation.ts';
import { safeReturnPath } from '../src/pages/authNavigation.ts';
import { auditChangeText, auditFieldLabels } from '../src/auditLogPresentation.ts';
import { AuthRequestGuard, readAccountResource } from '../src/authRequestGuard.ts';

const categories = { UNCATEGORIZED: '未分类', TECHNOLOGY: '技术交流', SPORTS: '运动户外', CULTURE: '文化艺术', OTHER: '其他' };

test('activity categories expose exactly the fixed five case-sensitive codes with a distinct all-category search option', () => {
  assert.deepEqual(activityCategoryLabels, categories);
  assert.deepEqual(activityCategoryOptions, Object.entries(categories).map(([value, label]) => ({ value, label })));
  assert.deepEqual(activityCategoryFilterOptions, [{ value: 'ALL', label: '全部分类' }, ...activityCategoryOptions]);
  for (const [code, label] of Object.entries(categories)) {
    assert.equal(isActivityCategory(code), true);
    assert.equal(activityCategoryLabel(code), label);
    assert.equal(parseActivityCategoryFilter(code), code);
  }
  for (const value of ['', 'technology', 'TECHNOLOGY ', '未分类', '__proto__', 'toString', null, undefined, {}, 'ALL']) {
    assert.equal(isActivityCategory(value), false);
    assert.equal(parseActivityCategoryFilter(value), 'ALL');
  }
});

test('public category URLs combine literal keywords, statuses and stable pagination without changing the keyword contents', () => {
  for (const category of Object.keys(categories)) for (const status of ['ALL', 'OPEN', 'FULL', 'STARTED', 'CANCELLED', 'UPCOMING']) {
    const query = { keyword: ' 上海 %_! +&? ', status, category, page: 3, pageSize: 24 };
    assert.deepEqual(parseActivityQuery(serializeActivityQuery(query)), { query, notice: null });
  }
  assert.equal(serializeActivityQuery({ ...defaultActivityQuery, category: 'TECHNOLOGY', page: 2 }), '?category=TECHNOLOGY&page=2');
  const query = parseActivityQuery('?keyword=%20%25_%20&status=FULL&category=technology&page=2&pageSize=24&userId=99').query;
  assert.deepEqual(query, { keyword: ' %_ ', status: 'FULL', category: 'ALL', page: 2, pageSize: 24 });
  assert.equal(serializeActivityQuery(query), '?keyword=+%25_+&status=FULL&page=2&pageSize=24');
  const overlong = parseActivityQuery(`?keyword=${'a'.repeat(201)}&category=SPORTS&status=OPEN&page=2`);
  assert.deepEqual(overlong.query, { ...defaultActivityQuery, category: 'SPORTS', status: 'OPEN', page: 2 });
  assert.match(overlong.notice, /200/);
});

test('public details and login returns preserve a canonical category filter without accepting an admin or external list destination', () => {
  const source = '/activities?keyword=%25_&status=OPEN&category=CULTURE&page=2&pageSize=24';
  assert.equal(safeActivityListPath(source), source);
  assert.equal(safeActivityDetailReturn(source), source);
  const details = activityDetailsPath(42, source);
  assert.equal(new URLSearchParams(details.split('?')[1]).get('from'), source);
  assert.equal(safeReturnPath(details), details);
  assert.equal(safeActivityListPath('/activities?category=SPORTS&unknown=ignored&page=0002'), '/activities?category=SPORTS&page=2');
  for (const path of ['/admin/activities?category=SPORTS', '//evil.example/activities?category=SPORTS', '/activities/42?category=SPORTS'])
    assert.equal(safeActivityListPath(path), '/activities');
});

test('admin management owns URL defaults and preserves committed AND conditions while trimming only its keyword', () => {
  assert.deepEqual(parseAdminActivityQuery(''), { query: defaultAdminActivityQuery, notice: null });
  assert.equal(serializeAdminActivityQuery(defaultAdminActivityQuery), '');
  const query = parseAdminActivityQuery('?keyword=++%25_++&status=UPCOMING&category=TECHNOLOGY&page=0002&pageSize=020&actorId=77').query;
  assert.deepEqual(query, { keyword: '%_', status: 'UPCOMING', category: 'TECHNOLOGY', page: 2, pageSize: 20 });
  assert.equal(adminActivityListPath(query), '/admin/activities?keyword=%25_&status=UPCOMING&category=TECHNOLOGY&page=2&pageSize=20');
  assert.equal(activityListPath({ ...defaultActivityQuery, category: 'UNCATEGORIZED' }), '/activities?category=UNCATEGORIZED');
  for (const category of ['ALL', ...Object.keys(categories)]) {
    const expected = { ...defaultAdminActivityQuery, category, pageSize: 7 };
    assert.deepEqual(parseAdminActivityQuery(serializeAdminActivityQuery(expected)).query, expected);
  }
});

test('admin malformed category and paging recover safely without losing other valid criteria or custom sizes', () => {
  assert.deepEqual(parseAdminActivityQuery('?category=ADMIN&status=FULL&page=-2&pageSize=101').query,
    { ...defaultAdminActivityQuery, status: 'FULL' });
  assert.deepEqual(parseAdminActivityQuery('?category=SPORTS&page=2147483647&pageSize=100').query,
    { ...defaultAdminActivityQuery, category: 'SPORTS', page: 2147483647, pageSize: 100 });
  const result = parseAdminActivityQuery(`?keyword=${'a'.repeat(201)}&category=OTHER&status=CANCELLED&page=2`);
  assert.deepEqual(result.query, { ...defaultAdminActivityQuery, category: 'OTHER', status: 'CANCELLED', page: 2 });
  assert.match(result.notice, /200/);
  assert.equal(parseAdminActivityQuery('?pageSize=1e2').query.pageSize, 10);
  assert.equal(parseActivityQuery('?pageSize=1e2').query.pageSize, 12);
});

test('category audit changes show Chinese before/after values and leave historical records without a category unchanged', () => {
  assert.equal(auditFieldLabels.category, '活动分类');
  for (const [code, label] of Object.entries(categories)) assert.equal(auditChangeText('category', code), label);
  assert.equal(auditChangeText('category', null), '未设置');
  assert.equal(auditChangeText('category', 'future-unknown-code'), 'future-unknown-code');
  const oldChanges = [{ field: 'title', before: '旧标题', after: '新标题' }];
  assert.deepEqual(oldChanges.map(change => ({ ...change, before: auditChangeText(change.field, change.before), after: auditChangeText(change.field, change.after) })), oldChanges);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('a changed public category or authentication generation rejects old successful rows and old 401 errors, including anonymous and same-ID login', async () => {
  for (const change of ['category', 'anonymous-login', 'same-account-login', 'different-account-login']) for (const failed of [false, true]) {
    const auth = new AuthRequestGuard();
    const generation = auth.captureAuthentication();
    let scope = 'TECHNOLOGY:1:0';
    const startedScope = scope;
    const response = deferred();
    let expired = 0;
    let correction = 0;
    const current = () => scope === startedScope && auth.isCurrentAuthentication(generation);
    const pending = readAccountResource(() => response.promise, new AbortController().signal, current,
      () => expired++).then(page => { if (current() && page.total === 0) correction++; });
    if (change === 'category') scope = 'CULTURE:1:0';
    else auth.beginAuthentication();
    if (failed) response.reject(Object.assign(new Error('old public 401'), { status: 401 }));
    else response.resolve({ total: 0, items: [] });
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(expired, 0);
    assert.equal(correction, 0);
  }
});
