import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNotificationQuery, serializeNotificationQuery } from '../src/notificationQuery.ts';
import { NotificationRequestOrder } from '../src/notificationRequestOrder.ts';
import { NotificationRequests } from '../src/notificationRequests.ts';
import { AuthRequestGuard } from '../src/authRequestGuard.ts';

test('notification URL restores pagination and filters, drops unknown fields and canonicalizes defaults', () => {
  assert.deepEqual(parseNotificationQuery(''), { page: 1, pageSize: 10, status: 'ALL', type: 'ALL' });
  const query = parseNotificationQuery('?page=002&pageSize=20&type=PROMOTED&status=UNREAD&userId=999');
  assert.deepEqual(query, { page: 2, pageSize: 20, status: 'UNREAD', type: 'PROMOTED' });
  assert.equal(serializeNotificationQuery(query), '?status=UNREAD&type=PROMOTED&page=2&pageSize=20');
  assert.equal(serializeNotificationQuery(parseNotificationQuery('?page=1&pageSize=10&status=ALL&type=ALL')), '');
  assert.equal(serializeNotificationQuery(parseNotificationQuery('?status=READ&pageSize=1')), '?status=READ&pageSize=1');
  assert.equal(serializeNotificationQuery(parseNotificationQuery('?type=ACTIVITY_CANCELLED')), '?type=ACTIVITY_CANCELLED');
  assert.equal(serializeNotificationQuery({ page: 1, pageSize: 10, status: 'ALL' }), '');
});

test('malformed notification URLs cannot send invalid pages, sizes or statuses to the API', () => {
  for (const page of ['0', '-1', '2.5', '1e2', 'Infinity', '2147483648', '999999999999999999999999999999'])
    assert.equal(parseNotificationQuery(`?page=${page}`).page, 1, page);
  for (const size of ['0', '-1', '101', '1e2', '10.5'])
    assert.equal(parseNotificationQuery(`?pageSize=${size}`).pageSize, 10, size);
  assert.equal(parseNotificationQuery('?page=2147483647&pageSize=100').page, 2147483647);
  assert.equal(parseNotificationQuery('?pageSize=100').pageSize, 100);
  assert.equal(parseNotificationQuery('?status=unread').status, 'ALL');
  assert.equal(parseNotificationQuery('?status=ACTIVE').status, 'ALL');
  for (const type of ['', 'promoted', 'CANCELLED', 'ALL,READ', 'unknown']) {
    assert.equal(parseNotificationQuery(`?type=${type}`).type, 'ALL', type);
    assert.equal(serializeNotificationQuery(parseNotificationQuery(`?type=${type}`)), '');
  }
});

test('a newer list snapshot protects the bell from a slower earlier unread-count request', () => {
  const order = new NotificationRequestOrder();
  const topbar = order.beginRead();
  const list = order.beginRead();
  assert.equal(order.isCurrent(list), true);
  assert.equal(order.isCurrent(topbar), false);
  const laterPage = order.beginRead();
  assert.equal(order.isCurrent(list), false);
  assert.equal(order.isCurrent(laterPage), true);
});

test('marking read invalidates statistics fetched both before and during the write', () => {
  const order = new NotificationRequestOrder();
  const before = order.beginRead();
  order.invalidateReads();
  assert.equal(order.isCurrent(before), false);
  const during = order.beginRead();
  order.invalidateReads();
  assert.equal(order.isCurrent(during), false);
  const refreshed = order.beginRead();
  assert.equal(order.isCurrent(refreshed), true);
});

test('notification success and error tickets expire after account switch or same-account re-login', () => {
  const auth = new AuthRequestGuard();
  const order = new NotificationRequestOrder();
  auth.beginAuthentication();
  const identity = auth.beginAccountRequest(1);
  const read = order.beginRead();
  const accepted = (userId) => auth.isSameAccount(identity, userId) && order.isCurrent(read);
  assert.equal(accepted(1), true);
  assert.equal(accepted(2), false);
  auth.beginAuthentication();
  // Even when the numeric user ID is unchanged, neither a successful old list
  // nor an old 401 may publish statistics or expire the new session.
  assert.equal(accepted(1), false);
  const freshIdentity = auth.beginAccountRequest(1);
  assert.equal(auth.isSameAccount(freshIdentity, 1), true);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function options(pending, current = () => true) {
  const controller = new AbortController();
  const events = [];
  return { events, controller, input: {
    signal: controller.signal,
    isCurrent: current,
    request: signal => { assert.equal(signal, controller.signal); return pending.promise; },
    onStart: () => events.push('start'),
    onSuccess: result => events.push(result),
    onError: error => events.push(error),
  } };
}

test('a filtered empty notification list still publishes its global unread snapshot', async () => {
  const requests = new NotificationRequests();
  const pending = deferred();
  const request = options(pending);
  const running = requests.read(request.input);
  const page = { items: [], total: 0, page: 1, pageSize: 10, unreadCount: 23 };
  pending.resolve(page);
  assert.deepEqual(await running, page);
  assert.deepEqual(request.events, ['start', page]);
});

test('an obsolete or pre-aborted read cannot invalidate an active notification snapshot', async () => {
  for (const inactive of ['scope', 'aborted']) {
    const requests = new NotificationRequests();
    const pending = deferred();
    const active = options(pending);
    const running = requests.read(active.input);
    const obsolete = options(deferred(), () => inactive !== 'scope');
    if (inactive === 'aborted') obsolete.controller.abort();
    obsolete.input.request = () => { assert.fail('obsolete read must not dispatch'); };
    await assert.rejects(requests.read(obsolete.input), error => error.name === 'AbortError');
    assert.deepEqual(obsolete.events, []);
    const snapshot = { unreadCount: 4 };
    pending.resolve(snapshot);
    assert.deepEqual(await running, snapshot);
    assert.deepEqual(active.events, ['start', snapshot]);
  }
});

test('a type/query render change suppresses list success and old 401 before cleanup aborts it', async () => {
  for (const outcome of ['success', 'error']) {
    const requests = new NotificationRequests();
    let scope = '/notifications:1:UNREAD:PROMOTED:1:10:0';
    const started = scope;
    const pending = deferred();
    const request = options(pending, () => scope === started);
    const running = requests.read(request.input);
    const rejected = assert.rejects(running, error => error.name === 'AbortError');
    scope = '/notifications:1:READ:ACTIVITY_CANCELLED:1:10:0';
    assert.equal(request.controller.signal.aborted, false);
    if (outcome === 'success') pending.resolve({ unreadCount: 99 });
    else pending.reject(Object.assign(new Error('expired'), { status: 401 }));
    await rejected;
    assert.deepEqual(request.events, ['start']);
  }
});

test('newer reads suppress slow badge successes and errors, including authentication errors', async () => {
  for (const outcome of ['success', 'error']) {
    const requests = new NotificationRequests();
    const older = deferred();
    const olderOptions = options(older);
    const first = requests.read(olderOptions.input);
    const rejected = assert.rejects(first, error => error.name === 'AbortError');
    const newer = deferred();
    const newerOptions = options(newer);
    const second = requests.read(newerOptions.input);
    newer.resolve({ unreadCount: 3 });
    await second;
    if (outcome === 'success') older.resolve({ unreadCount: 50 });
    else older.reject(Object.assign(new Error('expired'), { status: 401 }));
    await rejected;
    assert.deepEqual(olderOptions.events, ['start']);
    assert.deepEqual(newerOptions.events, ['start', { unreadCount: 3 }]);
  }
});

test('both write outcomes invalidate count reads from before and during bulk or single marking', async () => {
  for (const outcome of ['success', 'error']) {
    const requests = new NotificationRequests();
    const before = deferred();
    const beforeOptions = options(before);
    const earlier = requests.read(beforeOptions.input);
    const earlierRejected = assert.rejects(earlier, error => error.name === 'AbortError');
    const mutation = deferred();
    const writeOptions = options(mutation);
    const write = requests.write(writeOptions.input);
    const expectedError = new Error('unknown write result');
    const writeRejected = outcome === 'error' ? assert.rejects(write, expectedError) : null;
    const during = deferred();
    const duringOptions = options(during);
    const intermediate = requests.read(duringOptions.input);
    const intermediateRejected = assert.rejects(intermediate, error => error.name === 'AbortError');
    if (outcome === 'success') { mutation.resolve({ updatedCount: 7 }); await write; }
    else { mutation.reject(expectedError); await writeRejected; }
    before.resolve({ unreadCount: 20 });
    during.reject(Object.assign(new Error('old unauthorized'), { status: 401 }));
    await Promise.all([earlierRejected, intermediateRejected]);
    assert.deepEqual(beforeOptions.events, ['start']);
    assert.deepEqual(duringOptions.events, ['start']);
    const fresh = deferred();
    const freshOptions = options(fresh);
    const refreshed = requests.read(freshOptions.input);
    fresh.resolve({ unreadCount: 2 }); // New arrivals are obtained from the server.
    await refreshed;
    assert.deepEqual(freshOptions.events, ['start', { unreadCount: 2 }]);
  }
});

test('stale writes and reads cannot publish after same-account re-login or navigation', async () => {
  for (const method of ['read', 'write']) for (const outcome of ['success', 'error']) {
    const requests = new NotificationRequests();
    const auth = new AuthRequestGuard();
    auth.beginAuthentication();
    const identity = auth.beginAccountRequest(1);
    let pathname = '/notifications';
    const pending = deferred();
    const request = options(pending, () => pathname === '/notifications' && auth.isSameAccount(identity, 1));
    const running = requests[method](request.input);
    const rejected = assert.rejects(running, error => error.name === 'AbortError');
    auth.beginAuthentication();
    pathname = '/activities';
    if (outcome === 'success') pending.resolve({ updatedCount: 8 });
    else pending.reject(Object.assign(new Error('expired old login'), { status: 401 }));
    await rejected;
    assert.deepEqual(request.events, ['start']);
  }
});

test('abort and render-time scope changes prevent dispatch and late mutation callbacks', async () => {
  for (const method of ['read', 'write']) {
    const requests = new NotificationRequests();
    const never = options(deferred(), () => false);
    await assert.rejects(requests[method](never.input), error => error.name === 'AbortError');
    assert.deepEqual(never.events, []);
    const pending = deferred();
    const request = options(pending);
    const running = requests[method](request.input);
    const rejected = assert.rejects(running, error => error.name === 'AbortError');
    request.controller.abort();
    pending.resolve({ updatedCount: 8 });
    await rejected;
    assert.deepEqual(request.events, ['start']);
  }
});
