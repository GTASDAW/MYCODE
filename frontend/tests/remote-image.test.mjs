import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { fetchRemoteImage, normalizeRemoteImageUrl, remoteImageMaxBytes, validateRemoteImagePixels } from '../src/remoteImage.ts';

const originalFetch = globalThis.fetch;
const originalImage = globalThis.Image;
const fetchError = '无法直接读取此图片，请先下载到本地后再上传。';
const decodeError = '无法解码这张图片，请先下载到本地后重新选择 PNG 或 JPEG 图片。';
const imageUrl = 'https://images.example.test/photo.png';
const options = () => ({ signal: new AbortController().signal });
const isAbort = error => error instanceof DOMException && error.name === 'AbortError';

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalImage === undefined) delete globalThis.Image;
  else globalThis.Image = originalImage;
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function response(chunks = [new Uint8Array([1, 2, 3])], type = 'image/png', headers = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': type, ...headers } });
}

function stalledResponse() {
  const read = deferred();
  let cancelled = 0, released = 0;
  const reader = {
    read: () => read.promise,
    cancel: () => { cancelled++; return new Promise(() => {}); },
    releaseLock: () => { released++; },
  };
  return {
    response: { status: 200, redirected: false, type: 'cors', headers: new Headers({ 'Content-Type': 'image/png' }), body: { getReader: () => reader } },
    read,
    cancelled: () => cancelled,
    released: () => released,
  };
}

test('public HTTPS URLs are normalized without DNS lookup or path/filename assumptions', () => {
  for (const [raw, expected] of [
    ['  HTTPS://IMAGES.EXAMPLE.TEST:443/a%23b?token=public  ', 'https://images.example.test/a%23b?token=public'],
    ['https://8.8.8.8/image', 'https://8.8.8.8/image'],
    ['https://1.1.1.1/', 'https://1.1.1.1/'],
    ['https://[2606:4700:4700::1111]/image', 'https://[2606:4700:4700::1111]/image'],
    ['https://[2001:4860:4860::8888]/', 'https://[2001:4860:4860::8888]/'],
    ['https://public.example.test:8443/a.jpg?download=1', 'https://public.example.test:8443/a.jpg?download=1'],
  ]) assert.equal(normalizeRemoteImageUrl(raw), expected);
});

test('URL errors are fixed and reject credentials, all fragments, local names, malformed and non-HTTPS inputs', () => {
  for (const raw of [
    '', 'no-url', 'http://images.example.test/a', '//images.example.test/a', 'data:image/png;base64,AA',
    'https://user:password@images.example.test/a', 'https://@images.example.test/a', 'https:////@images.example.test/a',
    imageUrl + '#', imageUrl + '#section', 'https://localhost/a', 'https://LOCALHOST./a',
    'https://sub.localhost/a', 'https://a.localhost.../a', 'https://machine.local/a', 'https://local/a',
    'https://%6cocalhost/a', 'https://images.example.test/a\nb', 'https://images.example.test/has space',
    'https:\\images.example.test/a', 'https://[fe80::1%25eth0]/a', null, 7,
  ]) {
    assert.throws(() => normalizeRemoteImageUrl(raw), {
      message: '请输入不含身份信息或片段的公开 HTTPS 图片链接。',
    }, String(raw));
  }
});

test('browser-normalized private and special IPv4 literals cannot bypass the public-address check', () => {
  for (const host of [
    '0.0.0.0', '0', '10.1.2.3', '127.0.0.1', '127.1', '2130706433', '0x7f000001',
    '0177.0.0.1', '0x7f.1', '127.0.0.1.', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '0300.0250.1.1', '100.64.0.1', '100.127.255.255', '192.0.0.1', '192.0.2.1',
    '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
  ]) assert.throws(() => normalizeRemoteImageUrl(`https://${host}/image`), undefined, host);
  for (const host of ['100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1'])
    assert.equal(new URL(normalizeRemoteImageUrl(`https://${host}/image`)).hostname, host);
});

test('IPv6 local, mapped and transition literals are rejected including expanded aliases', () => {
  for (const host of [
    '::', '::1', '0:0:0:0:0:0:0:1', 'fc00::1', 'fdff::1', 'fe80::1', 'febf::1', 'fec0::1',
    'ff02::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '::ffff:c0a8:101', '::127.0.0.1',
    '64:ff9b::c0a8:101', '2002:7f00:1::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:db8::1',
  ]) assert.throws(() => normalizeRemoteImageUrl(`https://[${host}]/image`), undefined, host);
});

test('fetch is an isolated browser CORS GET with no credentials, referrer, cache, redirect or app headers', async () => {
  let seen;
  globalThis.fetch = async (url, init) => { seen = { url, init }; return response(); };
  const file = await fetchRemoteImage(' ' + imageUrl + ' ', options());
  assert.equal(seen.url, imageUrl);
  assert.equal(seen.init.method, 'GET');
  assert.equal(seen.init.mode, 'cors');
  assert.equal(seen.init.credentials, 'omit');
  assert.equal(seen.init.referrerPolicy, 'no-referrer');
  assert.equal(seen.init.cache, 'no-store');
  assert.equal(seen.init.redirect, 'error');
  assert.equal(seen.init.headers, undefined);
  assert.equal(seen.init.signal instanceof AbortSignal, true);
  assert.equal(file.name, 'remote-image.png');
  assert.equal(file.type, 'image/png');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]);
});

test('MIME parameters and casing normalize to a safe JPEG filename independent of the remote path', async () => {
  globalThis.fetch = async () => response([new Uint8Array([1])], ' IMAGE/JPEG ; charset=binary');
  const file = await fetchRemoteImage('https://images.example.test/dangerous.svg?name=other.exe', options());
  assert.equal(file.name, 'remote-image.jpg');
  assert.equal(file.type, 'image/jpeg');
});

test('actual streamed bytes decide the 2 MiB boundary, ignoring small or large Content-Length claims', async () => {
  globalThis.fetch = async () => response([new Uint8Array(remoteImageMaxBytes)], 'image/png', { 'Content-Length': '999999999' });
  assert.equal((await fetchRemoteImage(imageUrl, options())).size, remoteImageMaxBytes);
  globalThis.fetch = async () => response([new Uint8Array(remoteImageMaxBytes), new Uint8Array([1])], 'image/png', { 'Content-Length': '1' });
  await assert.rejects(fetchRemoteImage(imageUrl, options()), { message: '链接返回的图片应大于 0 且不超过 2 MB。' });
});

test('empty bodies and unsupported or missing MIME never produce a File', async () => {
  for (const empty of [response([]), new Response(null, { headers: { 'Content-Type': 'image/png' } })]) {
    globalThis.fetch = async () => empty;
    await assert.rejects(fetchRemoteImage(imageUrl, options()), { message: '链接返回的图片应大于 0 且不超过 2 MB。' });
  }
  for (const type of ['', 'image/svg+xml', 'image/gif', 'text/html', 'application/octet-stream', 'image/jpg']) {
    globalThis.fetch = async () => response(undefined, type);
    await assert.rejects(fetchRemoteImage(imageUrl, options()), { message: '链接必须直接返回 PNG 或 JPEG 图片。' });
  }
});

test('external 401/403/429, redirects, opaque and network errors stay fixed without app authentication recovery', async () => {
  let calls = 0;
  for (const result of [
    new Response(null, { status: 401 }), new Response(null, { status: 403 }), new Response(null, { status: 429 }),
    new Response(null, { status: 302 }),
    Object.defineProperty(response(), 'redirected', { value: true }),
    Object.defineProperty(response(), 'type', { value: 'opaque' }),
    Object.defineProperty(response(), 'type', { value: 'opaqueredirect' }),
  ]) {
    globalThis.fetch = async () => { calls++; return result; };
    await assert.rejects(fetchRemoteImage(imageUrl, options()), { message: fetchError });
  }
  globalThis.fetch = async () => { calls++; throw new TypeError('CORS denied https://secret.example/token?password=hidden'); };
  await assert.rejects(fetchRemoteImage(imageUrl, options()), { message: fetchError });
  assert.equal(calls, 8);
});

test('already aborted or stale work starts no request even for an invalid URL', async () => {
  globalThis.fetch = () => assert.fail('obsolete work must not fetch');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchRemoteImage('invalid', { signal: controller.signal }), isAbort);
  await assert.rejects(fetchRemoteImage('invalid', { ...options(), isCurrent: () => false }), isAbort);
});

test('abort settles a fetch that ignores AbortSignal and discards its late body', async () => {
  const request = deferred(), controller = new AbortController();
  let cancelledBody = 0;
  globalThis.fetch = () => request.promise;
  const pending = fetchRemoteImage(imageUrl, { signal: controller.signal });
  const rejected = assert.rejects(pending, isAbort);
  controller.abort();
  await rejected;
  request.resolve({ body: { cancel: async () => { cancelledBody++; } } });
  await flush();
  assert.equal(cancelledBody, 1);
});

test('abort settles and cancels a body reader even when read and cancel never settle', async () => {
  const stalled = stalledResponse(), controller = new AbortController();
  globalThis.fetch = async () => stalled.response;
  const pending = fetchRemoteImage(imageUrl, { signal: controller.signal });
  const rejected = assert.rejects(pending, isAbort);
  await flush();
  controller.abort();
  await rejected;
  assert.equal(stalled.cancelled(), 1);
  assert.equal(stalled.released(), 1);
  stalled.read.resolve({ done: false, value: new Uint8Array([1]) });
  await flush();
});

test('a stale fetch or streamed result is AbortError and never exposes an old success or error', async () => {
  for (const fail of [false, true]) {
    const request = deferred();
    let current = true;
    globalThis.fetch = () => request.promise;
    const pending = fetchRemoteImage(imageUrl, { ...options(), isCurrent: () => current });
    const rejected = assert.rejects(pending, isAbort);
    current = false;
    if (fail) request.reject(new Error('old https://secret.example/token'));
    else request.resolve(response());
    await rejected;
  }
  const stalled = stalledResponse();
  let current = true;
  globalThis.fetch = async () => stalled.response;
  const pending = fetchRemoteImage(imageUrl, { ...options(), isCurrent: () => current });
  const rejected = assert.rejects(pending, isAbort);
  await flush();
  current = false;
  stalled.read.resolve({ done: false, value: new Uint8Array([1]) });
  await rejected;
  assert.equal(stalled.cancelled(), 1);
});

test('one exact 10 second deadline includes both fetch and a body that ignores abort', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const request = deferred(), stalled = stalledResponse();
  globalThis.fetch = () => request.promise;
  let finished = false;
  const pending = fetchRemoteImage(imageUrl, options()).finally(() => { finished = true; });
  const rejected = assert.rejects(pending, { message: fetchError });
  context.mock.timers.tick(6_000);
  request.resolve(stalled.response);
  await flush();
  context.mock.timers.tick(3_999);
  await flush();
  assert.equal(finished, false);
  context.mock.timers.tick(1);
  await rejected;
  assert.equal(stalled.cancelled(), 1);
});

test('a fetch that never resolves times out, aborts its own controller and discards later data', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const request = deferred();
  let signal, discarded = 0;
  globalThis.fetch = (_url, init) => { signal = init.signal; return request.promise; };
  const rejected = assert.rejects(fetchRemoteImage(imageUrl, options()), { message: fetchError });
  context.mock.timers.tick(10_000);
  await rejected;
  assert.equal(signal.aborted, true);
  request.resolve({ body: { cancel: async () => { discarded++; } } });
  await flush();
  assert.equal(discarded, 1);
});

function imageFixture(context) {
  const images = [], created = [], revoked = [];
  globalThis.Image = class {
    naturalWidth = 256;
    naturalHeight = 256;
    onload = null;
    onerror = null;
    sources = [];
    constructor() { images.push(this); }
    set src(value) { this.sources.push(value); }
    removeAttribute(name) { assert.equal(name, 'src'); this.removed = true; }
  };
  context.mock.method(URL, 'createObjectURL', file => { created.push(file); return 'blob:https://gather.test/image'; });
  context.mock.method(URL, 'revokeObjectURL', url => { revoked.push(url); });
  return { images, created, revoked };
}

function assertImageReleased(fixture) {
  assert.deepEqual(fixture.revoked, ['blob:https://gather.test/image']);
  assert.deepEqual(fixture.images[0].sources, ['blob:https://gather.test/image']);
  assert.equal(fixture.images[0].onload, null);
  assert.equal(fixture.images[0].onerror, null);
  assert.equal(fixture.images[0].removed, true);
}

test('pixel validation decodes only a temporary Blob URL and releases it after valid boundary dimensions', async context => {
  const fixture = imageFixture(context);
  const file = new File(['image'], 'remote-image.png', { type: 'image/png' });
  const pending = validateRemoteImagePixels(file, options());
  fixture.images[0].naturalWidth = 4096;
  fixture.images[0].naturalHeight = 3906;
  fixture.images[0].onload();
  await pending;
  assert.deepEqual(fixture.created, [file]);
  assertImageReleased(fixture);
});

test('decode failure has a fixed error and releases all temporary image state', async context => {
  const fixture = imageFixture(context);
  const pending = validateRemoteImagePixels(new File(['invalid'], 'remote-image.png'), options());
  const rejected = assert.rejects(pending, { message: decodeError });
  fixture.images[0].onerror(new Error('secret URL from browser'));
  await rejected;
  assertImageReleased(fixture);
});

test('pixel validation rejects zero dimensions, overlong edges and more than 16 million pixels', async context => {
  const fixture = imageFixture(context);
  for (const [width, height] of [[0, 256], [256, 0], [4097, 1], [1, 4097], [4001, 4000], [4096, 4096]]) {
    const pending = validateRemoteImagePixels(new File(['image'], 'image.jpg'), options());
    const rejected = assert.rejects(pending, { message: '图片宽高不能超过 4096 像素，且总像素不能超过 1600 万。' });
    const image = fixture.images.at(-1);
    image.naturalWidth = width;
    image.naturalHeight = height;
    image.onload();
    await rejected;
    assert.equal(image.onload, null);
    assert.equal(image.onerror, null);
    assert.equal(image.removed, true);
  }
  assert.equal(fixture.revoked.length, 6);
});

test('aborted and stale decoding preserve AbortError and release the Blob URL', async context => {
  const fixture = imageFixture(context), controller = new AbortController();
  const pending = validateRemoteImagePixels(new File(['image'], 'image.png'), { signal: controller.signal });
  const rejected = assert.rejects(pending, isAbort);
  const lateLoad = fixture.images[0].onload;
  controller.abort();
  await rejected;
  lateLoad();
  assertImageReleased(fixture);

  let current = true;
  const stale = validateRemoteImagePixels(new File(['image'], 'image.png'), { ...options(), isCurrent: () => current });
  const staleRejected = assert.rejects(stale, isAbort);
  current = false;
  fixture.images[1].onerror();
  await staleRejected;
  assert.equal(fixture.revoked.length, 2);
});

test('decoding without browser load/error events has a 10 second deadline and releases its Blob URL', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = imageFixture(context);
  const rejected = assert.rejects(validateRemoteImagePixels(new File(['image'], 'image.png'), options()), { message: decodeError });
  context.mock.timers.tick(10_000);
  await rejected;
  assertImageReleased(fixture);
});
