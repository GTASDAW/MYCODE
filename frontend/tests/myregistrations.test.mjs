import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultMyRegistrationQuery,
  myRegistrationListPath,
  parseMyRegistrationQuery,
  serializeMyRegistrationQuery,
} from '../src/myRegistrationQuery.ts';
import { myRegistrationDetailsPath, safeActivityDetailReturn } from '../src/activityDetailNavigation.ts';
import { safeActivityListPath, activityDetailsPath } from '../src/activityDiscovery.ts';
import { AuthRequestGuard, readAccountResource } from '../src/authRequestGuard.ts';

test('personal registration URLs preserve all status filters and pagination while normalizing defaults and unknown identity fields', () => {
  assert.deepEqual(parseMyRegistrationQuery(''), defaultMyRegistrationQuery);
  assert.equal(serializeMyRegistrationQuery(defaultMyRegistrationQuery), '');
  for (const status of ['ALL', 'ACTIVE', 'WAITING', 'CANCELLED']) {
    const query = { status, page: 3, pageSize: 20 };
    assert.deepEqual(parseMyRegistrationQuery(serializeMyRegistrationQuery(query)), query);
  }
  const query = parseMyRegistrationQuery('?status=WAITING&page=0002&pageSize=01&userId=999');
  assert.deepEqual(query, { status: 'WAITING', page: 2, pageSize: 1 });
  assert.equal(myRegistrationListPath(query), '/my-registrations?status=WAITING&page=2&pageSize=1');
  assert.equal(serializeMyRegistrationQuery(parseMyRegistrationQuery('?status=ALL&page=1&pageSize=10')), '');
});

test('invalid personal pagination and status cannot become API criteria; valid maximum and custom sizes survive', () => {
  for (const page of ['0', '-2', '1.5', '1e2', '2147483648', 'Infinity'])
    assert.equal(parseMyRegistrationQuery(`?page=${page}`).page, 1, page);
  for (const size of ['0', '-1', '101', '20oops', '1e2', '20.5'])
    assert.equal(parseMyRegistrationQuery(`?pageSize=${size}`).pageSize, 10, size);
  assert.deepEqual(parseMyRegistrationQuery('?status=ACTIVE&page=2147483647&pageSize=100'),
    { status: 'ACTIVE', page: 2147483647, pageSize: 100 });
  assert.deepEqual(parseMyRegistrationQuery('?status=active&pageSize=7'), { status: 'ALL', page: 1, pageSize: 7 });
  assert.equal(parseMyRegistrationQuery('?status=CHECKED_IN').status, 'ALL');
});

test('detail navigation accepts canonical personal and public lists without broadening the existing public-list validator', () => {
  const personal = '/my-registrations?status=ACTIVE&page=2&pageSize=20';
  const publicList = '/activities?keyword=%25_&status=OPEN&page=2&pageSize=24';
  assert.equal(safeActivityDetailReturn(personal), personal);
  assert.equal(safeActivityDetailReturn('/my-registrations?unknown=admin&status=WAITING&page=0003'),
    '/my-registrations?status=WAITING&page=3');
  assert.equal(safeActivityDetailReturn(publicList), publicList);
  assert.equal(safeActivityListPath(personal), '/activities');
  const href = myRegistrationDetailsPath(42, personal);
  assert.equal(href.split('?')[0], '/activities/42');
  assert.equal(new URLSearchParams(href.split('?')[1]).get('from'), personal);
  assert.equal(new URLSearchParams(activityDetailsPath(42, publicList).split('?')[1]).get('from'), publicList);
  assert.equal(activityDetailsPath(42), '/activities/42');
});

test('detail personal return cannot redirect to external, admin, detail, dotted, encoded path or fragment destinations', () => {
  for (const value of [null, {}, '//example.com/my-registrations', 'https://example.com/my-registrations',
    '/admin/activities', '/my-registrations/1', '/my-registrations/../admin', '/my-registrations%2f..%2fadmin',
    '/my-registrations#x', '/my-registrations?status=ACTIVE#x', '/my-registrations?from=\\bad',
    '/my-registrations\n', '/my-registrations?status=\u0000bad'])
    assert.equal(safeActivityDetailReturn(value), '/activities');
  assert.equal(safeActivityDetailReturn('/my-registrations?userId=22&from=https%3A%2F%2Fexample.com'), '/my-registrations');
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('account reads return real current results and surface current errors only once', async () => {
  const auth = new AuthRequestGuard();
  auth.beginAuthentication();
  const ticket = auth.beginAccountRequest(1);
  const controller = new AbortController();
  const signal = controller.signal;
  const isCurrent = () => auth.isSameAccount(ticket, 1);
  const errors = [];
  const data = { total: 13, items: [{ id: 7 }], summary: { activeRegistrations: 8 } };
  const result = await readAccountResource(async forwarded => { assert.equal(forwarded, signal); return data; }, signal, isCurrent,
    error => errors.push(error));
  assert.equal(result, data);
  assert.deepEqual(errors, []);
  const error = Object.assign(new Error('session expired'), { status: 401 });
  await assert.rejects(readAccountResource(async () => { throw error; }, signal, isCurrent,
    currentError => errors.push(currentError)), value => value === error);
  assert.deepEqual(errors, [error]);
});

test('late successful personal records cannot publish after another account or same-account authentication', async () => {
  for (const nextUserId of [1, 2]) {
    let currentUserId = 1;
    const auth = new AuthRequestGuard();
    auth.beginAuthentication();
    const ticket = auth.beginAccountRequest(1);
    const response = deferred();
    const pending = readAccountResource(() => response.promise, new AbortController().signal,
      () => auth.isSameAccount(ticket, currentUserId), () => assert.fail('obsolete read must not report errors'));
    auth.beginAuthentication();
    currentUserId = nextUserId;
    response.resolve({ total: 13, summary: { activeRegistrations: 8 } });
    await assert.rejects(pending, error => error.name === 'AbortError');
  }
});

test('a late 401 cannot expire the new authentication even when the numeric user ID is unchanged', async () => {
  const auth = new AuthRequestGuard();
  auth.beginAuthentication();
  const ticket = auth.beginAccountRequest(1);
  const response = deferred();
  let expired = 0;
  const pending = readAccountResource(() => response.promise, new AbortController().signal,
    () => auth.isSameAccount(ticket, 1), () => expired++);
  const newGeneration = auth.beginAuthentication();
  response.reject(Object.assign(new Error('old 401'), { status: 401 }));
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(expired, 0);
  assert.equal(auth.isCurrentAuthentication(newGeneration), true);
});

test('aborted page reads cannot publish success or errors, and pre-aborted reads never start a request', async () => {
  for (const failure of [false, true]) {
    const controller = new AbortController();
    const response = deferred();
    const pending = readAccountResource(() => response.promise, controller.signal, () => true,
      () => assert.fail('aborted read must not report errors'));
    controller.abort();
    if (failure) response.reject(new Error('old failure'));
    else response.resolve({ items: [] });
    await assert.rejects(pending, error => error.name === 'AbortError');
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readAccountResource(async () => assert.fail('request started after abort'), controller.signal,
    () => true, () => assert.fail('error callback after abort')), error => error.name === 'AbortError');
});
