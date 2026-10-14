import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remainingAuthWait, watchAuthWait } from '../src/authRateLimit.ts';
import { AuthRequestGuard, readAccountResource } from '../src/authRequestGuard.ts';

test('authentication wait uses a deadline and recovers from delayed/background callbacks without drift', context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const observed = [];
  const stop = watchAuthWait(18_000, value => observed.push(value));
  assert.deepEqual(observed, [8]);
  context.mock.timers.tick(1000);
  assert.deepEqual(observed, [8, 7]);
  // Simulate a throttled tab: the next callback sees actual elapsed wall time.
  context.mock.timers.setTime(17_900);
  context.mock.timers.tick(1);
  assert.equal(observed.at(-1), 1);
  context.mock.timers.tick(99);
  assert.equal(observed.at(-1), 0);
  const count = observed.length;
  context.mock.timers.tick(10_000);
  assert.equal(observed.length, count);
  stop();
});

test('leaving or remounting an authentication page clears the old timer rather than duplicating callbacks', context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const abandoned = [];
  const stop = watchAuthWait(15_000, value => abandoned.push(value));
  stop();
  const current = [];
  const stopCurrent = watchAuthWait(15_000, value => current.push(value));
  context.mock.timers.tick(1000);
  assert.deepEqual(abandoned, [5]);
  assert.deepEqual(current, [5, 4]);
  stopCurrent();
  context.mock.timers.tick(10_000);
  assert.deepEqual(current, [5, 4]);
  assert.equal(remainingAuthWait(15_000), 0);
  assert.equal(remainingAuthWait(15_000, 14_999), 1);
});

test('anonymous authentication tickets do not change the account generation and reject old registration results and errors', async () => {
  for (const lateValue of [{ id: 1 }, Object.assign(new Error('old limit'), { status: 429 }),
    Object.assign(new Error('old login failure'), { status: 401 })]) {
    const guard = new AuthRequestGuard();
    const ticket = guard.captureAuthentication();
    assert.equal(guard.captureAuthentication(), ticket);
    let resolve;
    let reject;
    const response = new Promise((done, fail) => { resolve = done; reject = fail; });
    let publishedError = 0;
    const pending = readAccountResource(() => response, new AbortController().signal,
      () => guard.isCurrentAuthentication(ticket), () => publishedError++);
    const newer = guard.beginAuthentication();
    if (lateValue instanceof Error) reject(lateValue);
    else resolve(lateValue);
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(publishedError, 0);
    assert.equal(guard.isCurrentAuthentication(newer), true);
  }
});
