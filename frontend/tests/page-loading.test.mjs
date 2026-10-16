import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageBoundaryScope, reloadCurrentPage } from '../src/pageBoundaryPolicy.ts';

test('filter, pagination, hash and browser-history entries keep the current page scope while pathname changes reset it', () => {
  const before = { pathname: '/admin/dashboard', search: '?from=2026-09-17&to=2026-10-16', hash: '#attendance', key: 'old' };
  const after = { pathname: before.pathname, search: '?from=2026-01-01&to=2026-01-31&page=2&pageSize=20', hash: '#statistics', key: 'new' };
  assert.equal(pageBoundaryScope(before, 3), pageBoundaryScope(after, 3));
  assert.notEqual(pageBoundaryScope(before, 3), pageBoundaryScope({ ...before, pathname: '/admin/activities' }, 3));
});

test('authentication generations define recovery even when a person re-authenticates with the same route and user ID', () => {
  const location = { pathname: '/admin/audit-logs', userId: 1 };
  assert.notEqual(pageBoundaryScope(location, 3), pageBoundaryScope(location, 4));
  assert.equal(pageBoundaryScope(location, 4), pageBoundaryScope({ ...location, userId: 2 }, 4));
});

test('manual page recovery reloads the actual current location once without rebuilding or dropping its URL', () => {
  const location = {
    pathname: '/admin/audit-logs', search: '?action=EDIT&page=2&activityId=42', hash: '#changes',
    reloads: 0,
    reload() { this.reloads++; },
  };
  assert.equal(location.reloads, 0);
  reloadCurrentPage(location);
  assert.equal(location.reloads, 1);
  assert.equal(location.pathname + location.search + location.hash, '/admin/audit-logs?action=EDIT&page=2&activityId=42#changes');
});
