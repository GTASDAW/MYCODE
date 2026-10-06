import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const originalFetch = globalThis.fetch;
let sequence = 0;
afterEach(() => { globalThis.fetch = originalFetch; });

async function freshApi() {
  return import(`../src/api.ts?test=${sequence++}`);
}

const response = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

test('an expired CSRF token is refreshed and the original write is replayed only once', async () => {
  const { api } = await freshApi();
  const calls = [];
  let tokenFetches = 0;
  let writeAttempts = 0;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/auth/csrf') {
      return response(200, { token: `token-${++tokenFetches}`, headerName: 'X-CSRF-TOKEN' });
    }
    writeAttempts++;
    if (writeAttempts === 1) return response(403, { code: 'CSRF_INVALID', message: '验证已失效' });
    return response(201, { id: 42 });
  };
  await api.refreshCsrf();
  const input = { title: '测试活动', description: '简介', location: '上海', startsAt: '2030-01-01T02:00:00Z', capacity: 10 };
  const result = await api.createActivity(input);
  assert.equal(result.id, 42);
  assert.equal(tokenFetches, 2);
  const writes = calls.filter(call => call.options.method === 'POST');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].options.headers.get('X-CSRF-TOKEN'), 'token-1');
  assert.equal(writes[1].options.headers.get('X-CSRF-TOKEN'), 'token-2');
  assert.equal(writes[0].options.body, writes[1].options.body);
  assert.equal(writes[1].options.credentials, 'same-origin');
});

test('an authorization rejection is visible and is never retried as a CSRF error', async () => {
  const { api, ApiError } = await freshApi();
  let tokenFetches = 0;
  let writes = 0;
  globalThis.fetch = async url => {
    if (url === '/api/auth/csrf') {
      tokenFetches++;
      return response(200, { token: 'valid', headerName: 'X-CSRF-TOKEN' });
    }
    writes++;
    return response(403, { code: 'FORBIDDEN', message: '仅组织者可发布活动' });
  };
  await assert.rejects(api.createActivity({}), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 403);
    assert.equal(error.code, 'FORBIDDEN');
    assert.equal(error.message, '仅组织者可发布活动');
    return true;
  });
  assert.equal(tokenFetches, 1);
  assert.equal(writes, 1);
});

test('a second CSRF rejection is surfaced without a retry loop', async () => {
  const { api } = await freshApi();
  let tokenFetches = 0;
  let writes = 0;
  globalThis.fetch = async url => {
    if (url === '/api/auth/csrf') {
      return response(200, { token: `token-${++tokenFetches}`, headerName: 'X-CSRF-TOKEN' });
    }
    writes++;
    return response(403, { code: 'CSRF_INVALID', message: '仍然无法验证请求' });
  };
  await assert.rejects(api.cancel(1), error => error.code === 'CSRF_INVALID' && error.message === '仍然无法验证请求');
  assert.equal(tokenFetches, 2);
  assert.equal(writes, 2);
});

test('successful login rotates the token used by the next write; failed logout remains an error', async () => {
  const { api } = await freshApi();
  let tokenFetches = 0;
  const writes = [];
  const user = { id: 1, username: 'demo', displayName: '参与者', role: 'USER' };
  globalThis.fetch = async (url, options) => {
    if (url === '/api/auth/csrf') return response(200, { token: `token-${++tokenFetches}`, headerName: 'X-CSRF-TOKEN' });
    writes.push({ url, options });
    if (url === '/api/auth/login') return response(200, user);
    if (url === '/api/auth/logout') return response(500, { code: 'INTERNAL_ERROR', message: '退出暂时失败' });
    return response(200, { id: 3 });
  };
  assert.deepEqual(await api.login('demo', 'Demo123!'), user);
  await api.register(3);
  assert.equal(writes[0].options.headers.get('X-CSRF-TOKEN'), 'token-1');
  assert.equal(writes[0].options.body.toString(), 'username=demo&password=Demo123%21');
  assert.equal(writes[1].options.headers.get('X-CSRF-TOKEN'), 'token-2');
  await assert.rejects(api.logout(), error => error.message === '退出暂时失败');
  assert.equal(tokenFetches, 2);
});
