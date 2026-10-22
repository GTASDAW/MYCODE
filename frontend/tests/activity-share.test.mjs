import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActivityShareRequests, buildActivityShareUrl } from '../src/activityShare.ts';
import { AuthRequestGuard } from '../src/authRequestGuard.ts';

test('share URLs contain only the current site origin and the canonical activity ID', () => {
  assert.equal(buildActivityShareUrl(12, 'http://127.0.0.1:5173'), 'http://127.0.0.1:5173/activities/12');
  assert.equal(buildActivityShareUrl(12, 'https://Gather.Example:8443/activities/0012?from=%2Fadmin&userId=7#private'),
    'https://gather.example:8443/activities/12');
  assert.equal(buildActivityShareUrl(Number.MAX_SAFE_INTEGER, 'http://[::1]:5173'), `http://[::1]:5173/activities/${Number.MAX_SAFE_INTEGER}`);
});

test('invalid IDs, credentials and non-web origins cannot become share links', () => {
  for (const id of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '12', null, undefined])
    assert.throws(() => buildActivityShareUrl(id, 'https://gather.example'), /活动链接不正确/);
  for (const origin of ['', 'not a URL', '/activities', 'javascript:alert(1)', 'data:text/plain,hello', 'file:///tmp',
    'ftp://gather.example', 'https://user:secret@gather.example', 'https://user@gather.example'])
    assert.throws(() => buildActivityShareUrl(12, origin), /活动链接不正确/);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}
function options(pending, isCurrent = () => true) {
  const events = [];
  return { events, input: {
    url: 'https://gather.example/activities/12', isCurrent,
    write: url => { events.push(['write', url]); return pending.promise; },
    onStart: () => events.push('start'), onSuccess: () => events.push('success'),
    onFallback: () => events.push('manual'), onFinish: () => events.push('finish'),
  } };
}

test('the native write starts immediately and a pending copy suppresses duplicate clicks', async () => {
  const requests = new ActivityShareRequests();
  const pending = deferred(), first = options(pending), duplicate = options(deferred());
  const running = requests.copy(first.input);
  assert.deepEqual(first.events, ['start', ['write', first.input.url]]);
  await requests.copy(duplicate.input);
  assert.deepEqual(duplicate.events, []);
  pending.resolve(); await running;
  assert.deepEqual(first.events, ['start', ['write', first.input.url], 'success', 'finish']);
});

test('unsupported or rejected clipboard writes fall back once and require an explicit retry', async () => {
  for (const synchronous of [true, false]) {
    const requests = new ActivityShareRequests();
    const attempt = options(deferred());
    let writes = 0;
    attempt.input.write = () => { writes++; if (synchronous) throw new Error('unavailable'); return Promise.reject(new Error('denied')); };
    await requests.copy(attempt.input);
    await Promise.resolve();
    assert.equal(writes, 1);
    assert.deepEqual(attempt.events, ['start', 'manual', 'finish']);
    const retry = options(deferred());
    retry.input.write = () => { writes++; return Promise.resolve(); };
    await requests.copy(retry.input);
    assert.equal(writes, 2);
    assert.deepEqual(retry.events, ['start', 'success', 'finish']);
  }
});

test('page conditions invalidate late success, failure and finish before effect cleanup', async () => {
  for (const outcome of ['success', 'failure']) {
    const requests = new ActivityShareRequests();
    let scope = 'activity:12:from:favorites:hash:a';
    const initial = scope, pending = deferred(), attempt = options(pending, () => scope === initial);
    const running = requests.copy(attempt.input);
    scope = 'activity:12:from:registrations:hash:b';
    if (outcome === 'success') pending.resolve(); else pending.reject(new Error('late denied'));
    await running;
    assert.deepEqual(attempt.events, ['start', ['write', attempt.input.url]]);
  }
});

test('an old completion cannot clear a newer pending operation or open its fallback', async () => {
  for (const outcome of ['success', 'failure']) {
    const requests = new ActivityShareRequests();
    const oldPending = deferred(), older = options(oldPending);
    const oldCopy = requests.copy(older.input);
    requests.invalidate();
    const newPending = deferred(), newer = options(newPending);
    const newCopy = requests.copy(newer.input);
    if (outcome === 'success') oldPending.resolve(); else oldPending.reject(new Error('old failure'));
    await oldCopy;
    const extra = options(deferred()); await requests.copy(extra.input);
    assert.deepEqual(extra.events, []);
    assert.deepEqual(older.events, ['start', ['write', older.input.url]]);
    newPending.reject(new Error('current denial')); await newCopy;
    assert.deepEqual(newer.events, ['start', ['write', newer.input.url], 'manual', 'finish']);
  }
});

test('account changes and same-account re-login suppress all old clipboard outcomes', async () => {
  for (const outcome of ['success', 'failure']) {
    const auth = new AuthRequestGuard();
    auth.beginAuthentication();
    const generation = auth.captureAuthentication();
    const requests = new ActivityShareRequests(), pending = deferred();
    const attempt = options(pending, () => auth.isCurrentAuthentication(generation));
    const running = requests.copy(attempt.input);
    auth.beginAuthentication();
    if (outcome === 'success') pending.resolve(); else pending.reject(new Error('old failure'));
    await running;
    assert.deepEqual(attempt.events, ['start', ['write', attempt.input.url]]);
  }
});

test('inactive scope and leaving the page cannot dispatch or publish clipboard work', async () => {
  const requests = new ActivityShareRequests(), inactive = options(deferred(), () => false);
  await requests.copy(inactive.input);
  assert.deepEqual(inactive.events, []);
  const pending = deferred(), active = options(pending), running = requests.copy(active.input);
  requests.invalidate(); pending.resolve(); await running;
  assert.deepEqual(active.events, ['start', ['write', active.input.url]]);
});

test('authentication subscribers synchronously read the new generation after all old tickets expire', () => {
  const auth = new AuthRequestGuard();
  const oldGeneration = auth.captureAuthentication();
  const account = auth.beginAccountRequest(7);
  const write = auth.beginProfileWrite(7);
  const read = auth.beginProfileRead(7);
  const observed = [];
  const unsubscribe = auth.subscribeAuthentication(() => {
    observed.push(auth.captureAuthentication());
    assert.equal(auth.isCurrentAuthentication(oldGeneration), false);
    assert.equal(auth.isSameAccount(account, 7), false);
    assert.equal(auth.isCurrentProfileRead(read, 7), false);
    assert.equal(auth.isCurrentProfileWrite(write, 7), false);
    const nextRead = auth.beginProfileRead(7);
    assert.equal(nextRead.generation, oldGeneration + 1);
    assert.equal(nextRead.version, read.version + 1);
    assert.equal(auth.isCurrentProfileRead(nextRead, 7), true);
  });
  assert.deepEqual(observed, []);
  assert.equal(auth.beginAuthentication(), oldGeneration + 1);
  assert.deepEqual(observed, [oldGeneration + 1]);
  unsubscribe();
});

test('duplicate authentication subscriptions own independent idempotent cleanup', () => {
  const auth = new AuthRequestGuard(), observed = [];
  const listener = () => observed.push(auth.captureAuthentication());
  const firstCleanup = auth.subscribeAuthentication(listener);
  const secondCleanup = auth.subscribeAuthentication(listener);
  auth.beginAuthentication();
  assert.deepEqual(observed, [1, 1]);
  firstCleanup(); firstCleanup();
  auth.beginAuthentication();
  assert.deepEqual(observed, [1, 1, 2]);
  secondCleanup(); secondCleanup();
  auth.beginAuthentication();
  assert.deepEqual(observed, [1, 1, 2]);
});

test('authentication subscriptions survive Strict Mode cleanup and setup without leaking listeners', () => {
  const auth = new AuthRequestGuard(), observed = [];
  const listener = () => observed.push(auth.captureAuthentication());
  for (let mount = 0; mount < 4; mount++) {
    const replayCleanup = auth.subscribeAuthentication(listener);
    replayCleanup(); replayCleanup();
    const cleanup = auth.subscribeAuthentication(listener);
    auth.beginAuthentication();
    assert.equal(observed.length, mount + 1);
    cleanup(); cleanup();
    auth.beginAuthentication();
    assert.equal(observed.length, mount + 1);
  }
  assert.deepEqual(observed, [1, 3, 5, 7]);
});
