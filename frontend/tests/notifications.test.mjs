import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNotificationQuery, serializeNotificationQuery } from '../src/notificationQuery.ts';
import { NotificationRequestOrder } from '../src/notificationRequestOrder.ts';
import { AuthRequestGuard } from '../src/authRequestGuard.ts';

test('notification URL restores pagination and filters, drops unknown fields and canonicalizes defaults', () => {
  assert.deepEqual(parseNotificationQuery(''), { page: 1, pageSize: 10, status: 'ALL' });
  const query = parseNotificationQuery('?page=002&pageSize=20&status=UNREAD&userId=999');
  assert.deepEqual(query, { page: 2, pageSize: 20, status: 'UNREAD' });
  assert.equal(serializeNotificationQuery(query), '?status=UNREAD&page=2&pageSize=20');
  assert.equal(serializeNotificationQuery(parseNotificationQuery('?page=1&pageSize=10&status=ALL')), '');
  assert.equal(serializeNotificationQuery(parseNotificationQuery('?status=READ&pageSize=1')), '?status=READ&pageSize=1');
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
