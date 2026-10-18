import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityClosed, activityPhase, canManageActivity, cancellationReasonError, nextActivityBoundary } from '../src/activityLifecycle.ts';
import { activityEndInputError, beijingInputToIso, formatActivityEnd } from '../src/date.ts';

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

test('lifecycle uses real time at both boundaries with cancellation first and a legacy unknown end', () => {
  const activity = { ...future, startsAt: '2030-10-09T02:00:00Z', endsAt: '2030-10-09T03:00:00Z' };
  assert.equal(activityPhase(activity, now - 1), 'UPCOMING');
  assert.equal(activityPhase(activity, now), 'ONGOING');
  assert.equal(activityPhase(activity, now + 3600_000 - 1), 'ONGOING');
  assert.equal(activityPhase(activity, now + 3600_000), 'ENDED');
  assert.equal(activityClosed(activity, now), true);
  assert.equal(activityPhase({ ...activity, closed: true }, now - 1), 'UPCOMING');
  for (const endsAt of [null, undefined]) {
    assert.equal(activityPhase({ ...activity, endsAt }, now - 1), 'UPCOMING');
    assert.equal(activityPhase({ ...activity, endsAt }, now), 'STARTED');
    assert.equal(activityPhase({ ...activity, endsAt }, now + 100 * 86400_000), 'STARTED');
    assert.equal(formatActivityEnd(endsAt), '未提供');
  }
  for (const time of [now - 1, now, now + 3600_000])
    assert.equal(activityPhase({ ...activity, cancelled: true }, time), 'CANCELLED');
});

test('microseconds do not close an activity early and the page timer rounds boundaries up', () => {
  const activity = { ...future, startsAt: '2030-10-09T02:00:00.000001Z', endsAt: '2030-10-09T02:00:00.001001Z' };
  assert.equal(activityPhase(activity, now), 'UPCOMING');
  assert.equal(activityClosed(activity, now), false);
  assert.equal(activityPhase(activity, now + 1), 'ONGOING');
  assert.equal(activityPhase(activity, now + 2), 'ENDED');
  assert.equal(nextActivityBoundary([activity], now), now + 1);
  assert.equal(nextActivityBoundary([activity], now + 1), now + 2);
  assert.equal(nextActivityBoundary([activity], now + 2), null);
  assert.equal(nextActivityBoundary([{ ...activity, cancelled: true }], now), null);
  assert.equal(nextActivityBoundary([future, activity], now), now + 1);
});

test('Beijing creation input converts across UTC day boundaries and validates the stored microsecond precision', () => {
  assert.equal(beijingInputToIso('2030-01-02T00:30'), '2030-01-01T16:30:00.000Z');
  assert.equal(beijingInputToIso('2032-02-29T08:00:00.123456789'), '2032-02-29T00:00:00.123456Z');
  assert.equal(activityEndInputError('2030-01-01T23:59', '2030-01-02T00:01'), null);
  assert.equal(activityEndInputError('2030-01-02T00:30', undefined), null);
  assert.equal(activityEndInputError('2030-01-02T00:30:00.123456', '2030-01-02T00:30:00.123457'), null);
  for (const endsAt of ['2030-01-02T00:29', '2030-01-02T00:30'])
    assert.equal(activityEndInputError('2030-01-02T00:30', endsAt), '结束时间必须晚于开始时间');
  assert.equal(activityEndInputError('2030-01-02T00:30:00.1234561', '2030-01-02T00:30:00.1234569'), '结束时间必须晚于开始时间');
  for (const value of ['2030-02-29T08:00', '2030-02-30T08:00', '2030-01-01T24:00', '2030-01-01T08:60', 'invalid'])
    assert.throws(() => beijingInputToIso(value), /有效/);
});

test('cancellation reasons validate meaningful trimmed text and reject controls or newlines at any position', () => {
  for (const value of [' 场地临时维护 ', 'a'.repeat(500), '😀'.repeat(250)])
    assert.equal(cancellationReasonError(value), null);
  for (const value of ['', '   ', 'a'.repeat(501), '\n场地维护', '场地\n维护', '维护\r', '维护\t', '维护\u0085', '维护\u007f', '\u2028维护', '维护\u2029', '场地\u2028维护', '场地\u2029维护'])
    assert.ok(cancellationReasonError(value), JSON.stringify(value));
});
