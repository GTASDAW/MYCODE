import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { avatarInitial, avatarMaxBytes, safeAvatarUrl, validateAvatar } from '../src/accountAvatar.ts';
import { AuthRequestGuard, readAccountResource } from '../src/authRequestGuard.ts';

const originalFetch = globalThis.fetch;
let sequence = 0;
afterEach(() => { globalThis.fetch = originalFetch; });
const freshApi = () => import(`../src/api.ts?avatars=${sequence++}`);
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const avatarUrl = '/api/me/avatar?v=' + 'a1'.repeat(32);
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('avatar selection validates format and exact byte boundaries before creating a preview', () => {
  for (const [name, type] of [['头像.PNG', 'image/png'], ['头像.jpg', 'image/jpeg'], ['PHOTO.JPEG', 'image/jpeg']])
    assert.equal(validateAvatar({ name, type, size: avatarMaxBytes }), null);
  for (const file of [
    { name: 'a.png', type: 'image/png', size: 0 }, { name: 'a.png', type: 'image/png', size: avatarMaxBytes + 1 },
    { name: 'a.gif', type: 'image/gif', size: 1 }, { name: 'a.svg', type: 'image/svg+xml', size: 1 },
    { name: 'a.png', type: 'image/jpeg', size: 1 }, { name: 'a.png.exe', type: 'image/png', size: 1 },
  ]) assert.equal(typeof validateAvatar(file), 'string');
  assert.equal(avatarInitial(' 😀中文 '), '😀');
  assert.equal(avatarInitial(''), '');
});

test('only the exact authenticated self endpoint and canonical hash may supply an avatar', () => {
  assert.equal(safeAvatarUrl(avatarUrl), avatarUrl);
  for (const value of [null, undefined, 42, '', 'blob:untrusted', 'data:image/jpeg;base64,AA',
    'https://example.com' + avatarUrl, '//example.com' + avatarUrl, avatarUrl + '\n', avatarUrl + '#x',
    avatarUrl + '&userId=2', avatarUrl.replace('/me/', '/users/1/'), avatarUrl.toUpperCase(), avatarUrl.slice(0, -1)])
    assert.equal(safeAvatarUrl(value), null, String(value));
});

test('upload and removal use self-only CSRF requests and multipart keeps its browser boundary', async () => {
  const { api } = await freshApi();
  const calls = [], controller = new AbortController();
  const user = { id: 7, displayName: '头像本人', role: 'USER', avatarUrl };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return json(200, url.endsWith('/csrf') ? { token: 'avatar-csrf', headerName: 'X-CSRF-TOKEN' } :
      { ...user, avatarUrl: options.method === 'DELETE' ? null : avatarUrl });
  };
  const file = new File(['PNG content'], '本人.png', { type: 'image/png' });
  assert.deepEqual(await api.uploadAvatar(file, controller.signal), user);
  assert.equal((await api.removeAvatar(controller.signal)).avatarUrl, null);
  const writes = calls.filter(call => call.url === '/api/me/avatar');
  assert.equal(writes.length, 2);
  for (const { options } of writes) {
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.signal, controller.signal);
    assert.equal(options.headers.get('X-CSRF-TOKEN'), 'avatar-csrf');
    assert.equal(options.headers.has('Content-Type'), false);
  }
  assert.equal(writes[0].options.method, 'POST');
  assert.deepEqual([...writes[0].options.body.keys()], ['file']);
  assert.equal(writes[0].options.body.get('file').name, '本人.png');
  assert.equal(await writes[0].options.body.get('file').text(), 'PNG content');
  assert.equal(writes[1].options.method, 'DELETE');
  assert.equal(writes[1].options.body, undefined);
});

test('authenticated JPEG reads are uncached, abortable and never carry client identity or CSRF', async () => {
  const { api } = await freshApi();
  const controller = new AbortController();
  globalThis.fetch = async (url, options) => {
    assert.equal(url, avatarUrl);
    assert.equal(options.signal, controller.signal);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.get('Accept'), 'image/jpeg, application/json');
    assert.equal(options.headers.has('X-CSRF-TOKEN'), false);
    assert.equal(options.body, undefined);
    return new Response(new Uint8Array([255, 216, 255, 217]), { headers: { 'Content-Type': 'image/jpeg' } });
  };
  const blob = await api.avatar(avatarUrl, controller.signal);
  assert.equal(blob.type, 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [255, 216, 255, 217]);
});

test('invalid sources and cancelled operations never fetch and JSON success cannot become an image', async () => {
  const { api } = await freshApi();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json(200, { avatarUrl }); };
  await assert.rejects(api.avatar('https://evil.example' + avatarUrl), { code: 'INVALID_AVATAR_URL' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.avatar(avatarUrl, controller.signal), { name: 'AbortError' });
  await assert.rejects(api.uploadAvatar(new File(['x'], 'x.png'), controller.signal), { name: 'AbortError' });
  await assert.rejects(api.removeAvatar(controller.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
  await assert.rejects(api.avatar(avatarUrl), { code: 'INVALID_RESPONSE' });
  assert.equal(calls, 1);
});

test('avatar reads preserve structured authentication and missing-image errors without treating them as JPEG', async () => {
  const { api } = await freshApi();
  for (const [status, code] of [[401, 'SESSION_REVOKED'], [404, 'AVATAR_NOT_FOUND'], [503, 'AUTHENTICATION_UNAVAILABLE']]) {
    globalThis.fetch = async () => json(status, { code, message: '头像读取不可用' });
    await assert.rejects(api.avatar(avatarUrl), error => error.status === status && error.code === code);
  }
});

test('cancellation during binary reading discards the late Blob', async () => {
  const { api } = await freshApi();
  const controller = new AbortController(), body = deferred(), started = deferred();
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Headers({ 'Content-Type': 'image/jpeg' }),
    blob: () => { started.resolve(); return body.promise; } });
  const cancelled = assert.rejects(api.avatar(avatarUrl, controller.signal), { name: 'AbortError' });
  await started.promise;
  controller.abort();
  body.resolve(new Blob(['late'], { type: 'image/jpeg' }));
  await cancelled;
});

test('avatar writes invalidate complete-profile reads from before and during the write', () => {
  const guard = new AuthRequestGuard();
  const before = guard.beginProfileRead(7), oldImage = guard.beginAvatarRead(7);
  const write = guard.beginAvatarWrite(7);
  assert.equal(guard.isCurrentProfileRead(before, 7), false);
  assert.equal(guard.isCurrentAvatarRead(oldImage, 7), false);
  const during = guard.beginProfileRead(7), duringImage = guard.beginAvatarRead(7);
  assert.equal(guard.finishAvatarWrite(write, 7), true);
  assert.equal(guard.isCurrentProfileRead(during, 7), false);
  assert.equal(guard.isCurrentAvatarRead(duringImage, 7), false);
  assert.equal(guard.isCurrentProfileRead(guard.beginProfileRead(7), 7), true);
  assert.equal(guard.isCurrentAvatarRead(guard.beginAvatarRead(7), 7), true);
});

test('nickname and avatar saves have independent ordering and superseded writes do not invalidate fresh reads', () => {
  const guard = new AuthRequestGuard();
  const nickname = guard.beginProfileWrite(7), older = guard.beginAvatarWrite(7), newer = guard.beginAvatarWrite(7);
  assert.equal(guard.finishProfileWrite(nickname, 7), true);
  assert.equal(guard.isCurrentAvatarWrite(older, 7), false);
  assert.equal(guard.finishAvatarWrite(newer, 7), true);
  const read = guard.beginProfileRead(7), image = guard.beginAvatarRead(7);
  assert.equal(guard.finishAvatarWrite(older, 7), false);
  assert.equal(guard.isCurrentProfileRead(read, 7), true);
  assert.equal(guard.isCurrentAvatarRead(image, 7), true);
});

test('new image reads supersede older ones, while nickname saves do not invalidate the image', () => {
  const guard = new AuthRequestGuard();
  const older = guard.beginAvatarRead(7), newer = guard.beginAvatarRead(7);
  guard.finishProfileWrite(guard.beginProfileWrite(7), 7);
  assert.equal(guard.isCurrentAvatarRead(older, 7), false);
  assert.equal(guard.isCurrentAvatarRead(newer, 7), true);
});

test('late image successes and errors from another authentication cannot publish or expire a same-account relogin', async () => {
  for (const failure of [false, true]) {
    const guard = new AuthRequestGuard(), delayed = deferred(), controller = new AbortController();
    const ticket = guard.beginAvatarRead(7), errors = [];
    const cancelled = assert.rejects(readAccountResource(async () => {
      await delayed.promise;
      if (failure) throw Object.assign(new Error('old unauthorized'), { status: 401 });
      return new Blob(['old']);
    }, controller.signal, () => guard.isCurrentAvatarRead(ticket, 7), error => errors.push(error)), { name: 'AbortError' });
    guard.beginAuthentication();
    const fresh = guard.beginAvatarRead(7);
    delayed.resolve();
    await cancelled;
    assert.deepEqual(errors, []);
    assert.equal(guard.isCurrentAvatarRead(fresh, 7), true);
    assert.equal(guard.isSameAccount(ticket, 8), false);
  }
});

test('avatar upload retries only explicit CSRF rejection once; validation, size and rate failures stay explicit', async () => {
  for (const [status, code, expected] of [[403, 'CSRF_INVALID', 2], [400, 'INVALID_AVATAR', 1],
    [413, 'UPLOAD_TOO_LARGE', 1], [403, 'ACCESS_DENIED', 1], [429, 'AUTH_RATE_LIMITED', 1]]) {
    const { api } = await freshApi();
    let writes = 0;
    globalThis.fetch = async url => url.endsWith('/csrf') ? json(200, { token: 'avatar-csrf', headerName: 'X-CSRF-TOKEN' }) :
      (++writes, json(status, { code, message: '请求未完成' }));
    await assert.rejects(api.uploadAvatar(new File(['x'], 'x.png', { type: 'image/png' })), error => error.status === status && error.code === code);
    assert.equal(writes, expected);
  }
});

test('a rejected avatar write publishes a new image revision even if its initial invalidation was already observed', async () => {
  const guard = new AuthRequestGuard(), firstImage = deferred(), failedUpload = deferred(), controller = new AbortController();
  const firstTicket = guard.beginAvatarRead(7), revisions = [];
  const discarded = assert.rejects(readAccountResource(() => firstImage.promise, controller.signal,
    () => guard.isCurrentAvatarRead(firstTicket, 7), () => assert.fail('stale image must not report errors')), { name: 'AbortError' });
  const write = guard.beginAvatarWrite(7);
  const observedDuringWrite = guard.captureAvatarVersion();
  const duringImage = guard.beginAvatarRead(7);
  const unsubscribe = guard.subscribeAvatarRevision(() => revisions.push(guard.captureAvatarVersion()));
  const upload = (async () => {
    try { await failedUpload.promise; throw new Error('INVALID_AVATAR'); }
    finally { guard.publishAvatarRevision(write, 7); }
  })();
  const rejected = assert.rejects(upload, /INVALID_AVATAR/);
  firstImage.resolve(new Blob(['outdated image']));
  await discarded;
  failedUpload.resolve();
  await rejected;
  assert.equal(revisions.length, 1);
  assert.ok(revisions[0] > observedDuringWrite);
  assert.equal(guard.isCurrentAvatarRead(duringImage, 7), false);
  const freshImage = guard.beginAvatarRead(7);
  assert.equal(guard.isCurrentAvatarRead(freshImage, 7), true);
  unsubscribe();
  guard.publishAvatarRevision(write, 7);
  assert.equal(revisions.length, 1);
});

test('a settled older avatar upload cannot refresh or invalidate the image of a newer write or authentication', () => {
  const guard = new AuthRequestGuard(), revisions = [];
  guard.subscribeAvatarRevision(() => revisions.push(guard.captureAvatarVersion()));
  const older = guard.beginAvatarWrite(7), newer = guard.beginAvatarWrite(7);
  const latestImage = guard.beginAvatarRead(7);
  guard.publishAvatarRevision(older, 7);
  assert.deepEqual(revisions, []);
  assert.equal(guard.isCurrentAvatarRead(latestImage, 7), true);
  guard.beginAuthentication();
  const reloginImage = guard.beginAvatarRead(7);
  guard.publishAvatarRevision(newer, 7);
  assert.deepEqual(revisions, []);
  assert.equal(guard.isCurrentAvatarRead(reloginImage, 7), true);
});
