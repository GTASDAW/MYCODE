import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityClosed, canManageActivity, cancellationReasonError } from '../src/activityLifecycle.ts';

const now = Date.parse('2030-10-09T02:00:00Z');
const future = { cancelled: false, closed: false, startsAt: '2030-10-10T02:00:00Z' };

test('activity cancellation closes management and signup even before its original start time', () => {
  assert.equal(canManageActivity(future, now), true);
  assert.equal(activityClosed({ ...future, cancelled: true }, now), true);
  assert.equal(canManageActivity({ ...future, cancelled: true }, now), false);
  assert.equal(canManageActivity({ ...future, closed: true }, now), false);
});

test('a browser whose activity snapshot is old still closes operations at the exact deadline', () => {
  const activity = { ...future, startsAt: new Date(now).toISOString() };
  assert.equal(canManageActivity(activity, now - 1), true);
  assert.equal(activityClosed(activity, now), true);
  assert.equal(canManageActivity(activity, now + 1), false);
});

test('cancellation reasons validate meaningful trimmed text and reject controls or newlines at any position', () => {
  for (const value of [' 场地临时维护 ', 'a'.repeat(500), '😀'.repeat(250)])
    assert.equal(cancellationReasonError(value), null);
  for (const value of ['', '   ', 'a'.repeat(501), '\n场地维护', '场地\n维护', '维护\r', '维护\t', '维护\u0085', '维护\u007f', '\u2028维护', '维护\u2029', '场地\u2028维护', '场地\u2029维护'])
    assert.ok(cancellationReasonError(value), JSON.stringify(value));
});
