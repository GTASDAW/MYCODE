import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const originalFetch = globalThis.fetch;
let sequence = 0;
afterEach(() => { globalThis.fetch = originalFetch; });

async function freshApi() {
  return import(`../src/api.ts?test=${sequence++}`);
}

const response = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
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

test('server errors retain a UUID request ID and show it only in the incident message', async () => {
  const { api, ApiError, errorMessage } = await freshApi();
  const requestId = '02dac041-2ba2-4d70-ae40-b50c395a647b';
  globalThis.fetch = async () => response(500, { message: '暂时无法读取指标', code: 'INTERNAL_ERROR' }, { 'X-Request-Id': requestId });
  await assert.rejects(api.adminMonitoring(), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.requestId, requestId);
    assert.equal(error.message, '暂时无法读取指标');
    assert.equal(errorMessage(error), `暂时无法读取指标（问题编号：${requestId}）`);
    return true;
  });
  globalThis.fetch = async () => response(403, { message: '仅组织者可访问', code: 'FORBIDDEN' }, { 'X-Request-Id': requestId });
  await assert.rejects(api.adminMonitoring(), error => {
    assert.equal(error.requestId, requestId);
    assert.equal(errorMessage(error), '仅组织者可访问');
    return true;
  });
});

test('arbitrary request ID headers and network errors never add incident IDs', async () => {
  const { api, errorMessage } = await freshApi();
  globalThis.fetch = async () => response(500, { message: '稍后重试' }, { 'X-Request-Id': '<script>untrusted-id</script>' });
  await assert.rejects(api.adminMonitoring(), error => {
    assert.equal(error.requestId, undefined);
    assert.equal(errorMessage(error), '稍后重试');
    return true;
  });
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(api.adminMonitoring(), error => {
    assert.equal(error.requestId, undefined);
    assert.equal(error.code, 'NETWORK_ERROR');
    return true;
  });
});

test('an invalid JSON error response preserves its validated request ID', async () => {
  const { api, errorMessage } = await freshApi();
  const requestId = '02dac041-2ba2-4d70-ae40-b50c395a647b';
  globalThis.fetch = async () => new Response('invalid JSON', { status: 502, headers: { 'X-Request-Id': requestId } });
  await assert.rejects(api.adminMonitoring(), error => {
    assert.equal(error.code, 'INVALID_RESPONSE');
    assert.equal(error.requestId, requestId);
    assert.ok(errorMessage(error).includes(requestId));
    return true;
  });
});

test('account registration preserves the password, uses CSRF and does not automatically log in', async () => {
  const { api } = await freshApi();
  const calls = [];
  const user = { id: 9, username: 'new_user', displayName: '新用户', role: 'USER' };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/auth/csrf') return response(200, { token: 'valid', headerName: 'X-CSRF-TOKEN' });
    return response(201, user);
  };
  const input = { username: 'new_user', password: ' Abc123 ', displayName: '新用户' };
  assert.deepEqual(await api.registerUser(input), user);
  assert.deepEqual(calls.map(call => call.url), ['/api/auth/csrf', '/api/auth/register']);
  const write = calls[1].options;
  assert.equal(write.method, 'POST');
  assert.equal(write.headers.get('X-CSRF-TOKEN'), 'valid');
  assert.deepEqual(JSON.parse(write.body), input);
});

test('profile requests pass cancellation through and writes contain only the editable nickname', async () => {
  const { api } = await freshApi();
  const controller = new AbortController();
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/auth/csrf') return response(200, { token: 'valid', headerName: 'X-CSRF-TOKEN' });
    return response(200, { id: 9, username: 'new_user', displayName: '新昵称', role: 'USER' });
  };
  await api.me(controller.signal);
  await api.updateProfile('新昵称', controller.signal);
  assert.equal(calls[0].options.signal, controller.signal);
  const patch = calls.find(call => call.url === '/api/me/profile');
  assert.equal(patch.options.method, 'PATCH');
  assert.equal(patch.options.signal, controller.signal);
  assert.equal(patch.options.headers.get('X-CSRF-TOKEN'), 'valid');
  assert.deepEqual(JSON.parse(patch.options.body), { displayName: '新昵称' });
});

test('duplicate usernames are surfaced without replaying a registration', async () => {
  const { api } = await freshApi();
  let writes = 0;
  globalThis.fetch = async url => {
    if (url === '/api/auth/csrf') return response(200, { token: 'valid', headerName: 'X-CSRF-TOKEN' });
    writes++;
    return response(409, { code: 'USERNAME_TAKEN', message: '用户名已被使用' });
  };
  await assert.rejects(api.registerUser({}), error => error.status === 409 && error.code === 'USERNAME_TAKEN');
  assert.equal(writes, 1);
});

test('activity editing sends only mutable fields and cancellation sends only its reason, with CSRF and abort signals', async () => {
  const { api } = await freshApi();
  const calls = [];
  const controller = new AbortController();
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/auth/csrf') return response(200, { token: 'valid', headerName: 'X-CSRF-TOKEN' });
    return response(200, { id: 25, title: '更新标题', cancelled: url.endsWith('/cancel') });
  };
  await api.updateActivity(25, { title: '更新标题', description: '更新介绍', location: '更新地点', capacity: 999, startsAt: '2030-01-01T00:00:00Z' }, controller.signal);
  const result = await api.cancelActivity(25, '场地维护', controller.signal);
  assert.equal(result.cancelled, true);
  const writes = calls.filter(call => call.options.method);
  assert.deepEqual(writes.map(call => [call.url, call.options.method]), [
    ['/api/admin/activities/25', 'PATCH'], ['/api/admin/activities/25/cancel', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(writes[0].options.body), { title: '更新标题', description: '更新介绍', location: '更新地点' });
  assert.deepEqual(JSON.parse(writes[1].options.body), { reason: '场地维护' });
  for (const { options } of writes) {
    assert.equal(options.signal, controller.signal);
    assert.equal(options.headers.get('X-CSRF-TOKEN'), 'valid');
    assert.equal(options.credentials, 'same-origin');
  }
});

test('closed or cancelled activity conflicts remain visible and never replay a management write', async () => {
  const { api } = await freshApi();
  let writes = 0;
  globalThis.fetch = async url => {
    if (url === '/api/auth/csrf') return response(200, { token: 'valid', headerName: 'X-CSRF-TOKEN' });
    writes++;
    return response(409, { code: 'ACTIVITY_CANCELLED', message: '活动已取消，不能编辑' });
  };
  await assert.rejects(api.updateActivity(25, {}), error => error.status === 409 && error.code === 'ACTIVITY_CANCELLED');
  assert.equal(writes, 1);
});
