import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validWaitingPosition, waitingLifecycleText, waitingPositionText } from '../src/waitingPosition.ts';

const start = '2030-10-10T02:00:00Z';
const future = {
  cancelled: false,
  closed: false,
  startsAt: start,
  endsAt: '2030-10-10T03:00:00Z',
  registrationDeadline: '2030-10-10T01:00:00Z',
  registrationClosed: false,
};
const beforeDeadline = Date.parse('2030-10-10T00:59:59.999Z');
const atDeadline = Date.parse('2030-10-10T01:00:00Z');
const atStart = Date.parse(start);

test('waiting position accepts only positive safe integer JSON values', () => {
  assert.equal(validWaitingPosition(1), 1);
  assert.equal(validWaitingPosition(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  for (const value of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2', NaN, Infinity])
    assert.equal(validWaitingPosition(value), null, String(value));
  assert.equal(waitingPositionText(1), '候补第 1 位，前面还有 0 人');
  assert.equal(waitingPositionText(0), '候补顺位暂不可用');
  assert.equal(waitingPositionText(undefined), '候补顺位暂不可用');
});

test('waiting lifecycle checks cancellation first and uses the local clock at cutoff and start boundaries', () => {
  assert.equal(waitingLifecycleText({ ...future, cancelled: true }, 'WAITING', atStart), null);
  for (const status of ['ACTIVE', 'CANCELLED', null])
    assert.equal(waitingLifecycleText(future, status, atDeadline), null);
  assert.equal(waitingLifecycleText(future, 'WAITING', beforeDeadline), null);
  assert.equal(waitingLifecycleText(future, 'WAITING', atDeadline), '报名已截止，已有候补仍可在活动开始前递补');
  assert.equal(waitingLifecycleText(future, 'WAITING', atStart - 1), '报名已截止，已有候补仍可在活动开始前递补');
  assert.equal(waitingLifecycleText(future, 'WAITING', atStart), '活动已开始，候补递补已停止');
  assert.equal(waitingLifecycleText(future, 'WAITING', Date.parse('2030-10-10T03:00:00Z')), '活动已开始，候补递补已停止');
  assert.equal(waitingLifecycleText({ ...future, closed: true }, 'WAITING', beforeDeadline), '活动已开始，候补递补已停止');
});

test('unknown end time still stops waiting replacement at the exact start', () => {
  const activity = { ...future, endsAt: null };
  assert.equal(waitingLifecycleText(activity, 'WAITING', atStart - 1), '报名已截止，已有候补仍可在活动开始前递补');
  assert.equal(waitingLifecycleText(activity, 'WAITING', atStart), '活动已开始，候补递补已停止');
});
