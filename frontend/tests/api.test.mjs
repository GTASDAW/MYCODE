import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createServer } from 'node:http';

const originalFetch = globalThis.fetch;
let sequence = 0;
afterEach(() => { globalThis.fetch = originalFetch; });

async function freshApi() {
  return import(`../src/api.ts?test=${sequence++}`);
}

const response = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});

test('personal registration search sends only query criteria and the abort signal while legacy reads retain their array contract', async () => {
  const { api } = await freshApi();
  const controller = new AbortController();
  const calls = [];
  const page = { items: [{ id: 9, status: 'ACTIVE', checkedInAt: '2030-01-01T00:00:00Z' }],
    total: 11, page: 2, pageSize: 10,
    summary: { activeRegistrations: 8, waitingRegistrations: 2, cancelledRegistrations: 1, checkedInRegistrations: 1 } };
  const oldArray = [{ id: 9, status: 'ACTIVE', activity: { id: 22 } }];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return response(200, url.includes('/search?') ? page : oldArray);
  };
  assert.deepEqual(await api.searchRegistrations({ page: 2, pageSize: 10, status: 'ACTIVE', userId: 999 }, controller.signal), page);
  const parsed = new URL(calls[0].url, 'http://localhost');
  assert.equal(parsed.pathname, '/api/me/registrations/search');
  assert.deepEqual(Object.fromEntries(parsed.searchParams), { page: '2', pageSize: '10', status: 'ACTIVE' });
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.headers.get('Accept'), 'application/json');
  assert.deepEqual(await api.registrations(controller.signal), oldArray);
  assert.equal(calls[1].url, '/api/me/registrations');
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

test('public discovery sends literal query parameters and cancellation to the search endpoint without changing the legacy list API', async () => {
  const { api } = await freshApi();
  const controller = new AbortController();
  const query = { keyword: ' 上海 %_! ', status: 'OPEN', page: 2, pageSize: 24 };
  const page = {
    items: [{ id: 1 }], total: 51, page: 2, pageSize: 24,
    summary: { upcomingActivities: 51, availableSeats: 1000 },
  };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return response(200, url === '/api/activities' ? [{ id: 1 }] : page);
  };
  assert.deepEqual(await api.searchActivities(query, controller.signal), page);
  const requested = new URL(calls[0].url, 'http://localhost');
  assert.equal(requested.pathname, '/api/activities/search');
  assert.deepEqual(Object.fromEntries(requested.searchParams), {
    keyword: query.keyword, status: 'OPEN', category: 'ALL', page: '2', pageSize: '24',
  });
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.deepEqual(await api.activities(controller.signal), [{ id: 1 }]);
  assert.equal(calls[1].url, '/api/activities');
});

test('notification reads use the current session without client identity and preserve cancellation signals', async () => {
  const { api } = await freshApi();
  const controller = new AbortController();
  const calls = [];
  const result = { items: [{ id: 12 }], total: 31, page: 2, pageSize: 10, unreadCount: 23 };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return response(200, url.endsWith('/unread-count') ? { unreadCount: 23 } : result);
  };
  assert.deepEqual(await api.notifications({ page: 2, pageSize: 10, status: 'UNREAD', userId: 999 }, controller.signal), result);
  const path = new URL(calls[0].url, 'http://localhost');
  assert.equal(path.pathname, '/api/me/notifications');
  assert.deepEqual(Object.fromEntries(path.searchParams), { page: '2', pageSize: '10', status: 'UNREAD', type: 'ALL' });
  assert.deepEqual(await api.notificationUnreadCount(controller.signal), { unreadCount: 23 });
  assert.equal(calls[1].url, '/api/me/notifications/unread-count');
  for (const { options } of calls) {
    assert.equal(options.signal, controller.signal);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.method, undefined);
  }
});

test('marking a notification read uses CSRF without an identity body and replays only an explicit token failure', async () => {
  const { api } = await freshApi();
  const controller = new AbortController();
  const calls = [];
  let tokens = 0;
  let writes = 0;
  const item = { id: 12, readAt: '2030-01-01T00:00:00Z' };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/auth/csrf') return response(200, { token: `token-${++tokens}`, headerName: 'X-CSRF-TOKEN' });
    return ++writes === 1 ? response(403, { code: 'CSRF_INVALID', message: '验证已失效' }) : response(200, item);
  };
  assert.deepEqual(await api.readNotification(12, controller.signal), item);
  const attempts = calls.filter(call => call.options.method === 'POST');
  assert.equal(tokens, 2);
  assert.equal(attempts.length, 2);
  for (const { url, options } of attempts) {
    assert.equal(url, '/api/me/notifications/12/read');
    assert.equal(options.body, undefined);
    assert.equal(options.signal, controller.signal);
    assert.equal(options.credentials, 'same-origin');
  }
  assert.equal(attempts[0].options.headers.get('X-CSRF-TOKEN'), 'token-1');
  assert.equal(attempts[1].options.headers.get('X-CSRF-TOKEN'), 'token-2');
});

test('notification type and status criteria are combined without changing the global unread response', async () => {
  const { api } = await freshApi();
  const controller = new AbortController();
  const page = { items: [], total: 0, unreadCount: 17, page: 2, pageSize: 20 };
  globalThis.fetch = async (url, options) => {
    const path = new URL(url, 'http://localhost');
    assert.equal(path.pathname, '/api/me/notifications');
    assert.deepEqual(Object.fromEntries(path.searchParams), { page: '2', pageSize: '20', status: 'READ', type: 'PROMOTED' });
    assert.equal(options.signal, controller.signal);
    assert.equal(options.body, undefined);
    return response(200, page);
  };
  assert.deepEqual(await api.notifications({ page: 2, pageSize: 20, status: 'READ', type: 'PROMOTED', userId: 99 }, controller.signal), page);
});

test('bulk marking has no client identity, filter or body and only retries CSRF_INVALID once', async () => {
  for (const again of [false, true]) {
    const { api } = await freshApi();
    const controller = new AbortController();
    const calls = [];
    let tokens = 0;
    let writes = 0;
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/auth/csrf') return response(200, { token: `token-${++tokens}`, headerName: 'X-CSRF-TOKEN' });
      writes++;
      return writes === 1 || again ? response(403, { code: 'CSRF_INVALID' }) : response(200, { updatedCount: 7 });
    };
    if (again) await assert.rejects(api.readAllNotifications(controller.signal), error => error.code === 'CSRF_INVALID');
    else assert.deepEqual(await api.readAllNotifications(controller.signal), { updatedCount: 7 });
    const attempts = calls.filter(call => call.options.method === 'POST');
    assert.equal(tokens, 2);
    assert.equal(attempts.length, 2);
    for (const { url, options } of attempts) {
      assert.equal(url, '/api/me/notifications/read-all');
      assert.equal(options.body, undefined);
      assert.equal(options.signal, controller.signal);
      assert.equal(options.credentials, 'same-origin');
    }
    assert.equal(attempts[0].options.headers.get('X-CSRF-TOKEN'), 'token-1');
    assert.equal(attempts[1].options.headers.get('X-CSRF-TOKEN'), 'token-2');
  }
});

test('bulk marking never retries authorization, rate-limit, unknown server or network errors', async () => {
  for (const failure of [
    { status: 401, code: 'UNAUTHORIZED' }, { status: 403, code: 'FORBIDDEN' },
    { status: 403, code: 'UNKNOWN' }, { status: 429, code: 'AUTH_RATE_LIMITED' },
    { status: 503, code: 'SERVICE_UNAVAILABLE' }, { status: 0, code: 'NETWORK_ERROR' },
  ]) {
    const { api } = await freshApi();
    let tokens = 0;
    let writes = 0;
    globalThis.fetch = async url => {
      if (url === '/api/auth/csrf') { tokens++; return response(200, { token: 'valid', headerName: 'X-CSRF-TOKEN' }); }
      writes++;
      if (!failure.status) throw new TypeError('response lost');
      return response(failure.status, { code: failure.code });
    };
    await assert.rejects(api.readAllNotifications(), error => error.status === failure.status && error.code === failure.code);
    assert.equal(tokens, 1);
    assert.equal(writes, 1);
  }
});

test('notification ownership and authentication failures remain visible without replaying a read mutation', async () => {
  for (const [status, code] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [404, 'NOTIFICATION_NOT_FOUND']]) {
    const { api } = await freshApi();
    let writes = 0;
    globalThis.fetch = async url => {
      if (url === '/api/auth/csrf') return response(200, { token: 'valid', headerName: 'X-CSRF-TOKEN' });
      writes++;
      return response(status, { code, message: '操作未完成' });
    };
    await assert.rejects(api.readNotification(12), error => error.status === status && error.code === code);
    assert.equal(writes, 1);
  }
});

test('roster reads combine a literal keyword and both filters while CSV exports omit pagination and any client identity', async () => {
  const { api } = await freshApi();
  const controller = new AbortController();
  const calls = [];
  const query = { page: 2, pageSize: 10, status: 'ACTIVE', checkInStatus: 'NOT_CHECKED_IN', keyword: '中文 %_!+&?', userId: 999 };
  const csv = '\ufeff"报名记录 ID","姓名"\r\n"\t123","\t中文用户"\r\n';
  const page = { items: [{ id: 123 }], total: 21, page: 2, pageSize: 10,
    summary: { activeRegistrations: 31, checkedInRegistrations: 10, notCheckedInRegistrations: 21 } };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return url.includes('/export?') ? new Response(csv, { headers: { 'Content-Type': 'text/csv;charset=UTF-8' } }) : response(200, page);
  };
  assert.deepEqual(await api.adminRegistrations('25', query, controller.signal), page);
  const file = await api.exportAdminRegistrations('25', query, controller.signal);
  assert.ok(file instanceof Blob);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()).slice(0, 3), new Uint8Array([239, 187, 191]));
  assert.equal(await file.text(), csv.slice(1)); // Blob.text decodes and removes UTF-8 BOM.
  const paths = calls.map(call => new URL(call.url, 'http://localhost'));
  assert.equal(paths[0].pathname, '/api/admin/activities/25/registrations');
  assert.deepEqual(Object.fromEntries(paths[0].searchParams), { page: '2', pageSize: '10', status: 'ACTIVE', checkInStatus: 'NOT_CHECKED_IN', keyword: query.keyword });
  assert.equal(paths[1].pathname, '/api/admin/activities/25/registrations/export');
  assert.deepEqual(Object.fromEntries(paths[1].searchParams), { status: 'ACTIVE', checkInStatus: 'NOT_CHECKED_IN', keyword: query.keyword });
  for (const { options } of calls) {
    assert.equal(options.signal, controller.signal);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.body, undefined);
    assert.equal(options.headers.get('X-CSRF-TOKEN'), null);
  }
  assert.equal(calls[1].options.headers.get('Accept'), 'text/csv, application/json');
});

test('old roster and CSV callers omit keyword safely and retain their cancellation signals', async () => {
  const { api } = await freshApi();
  const controller = new AbortController(), calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return url.includes('/export?') ? new Response('header\r\n', { headers: { 'Content-Type': 'text/csv' } }) : response(200, { items: [] });
  };
  await api.adminRegistrations('25', { page: 1, pageSize: 10, status: 'ALL', checkInStatus: 'ALL' }, controller.signal);
  await api.exportAdminRegistrations('25', { status: 'ALL', checkInStatus: 'ALL', actorId: 77, page: 3, pageSize: 99 }, controller.signal);
  assert.deepEqual(Object.fromEntries(new URL(calls[0].url, 'http://localhost').searchParams),
    { page: '1', pageSize: '10', status: 'ALL', checkInStatus: 'ALL', keyword: '' });
  assert.deepEqual(Object.fromEntries(new URL(calls[1].url, 'http://localhost').searchParams),
    { status: 'ALL', checkInStatus: 'ALL', keyword: '' });
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[1].options.signal, controller.signal);
});

test('CSV JSON errors retain their code and request ID and GET never refreshes CSRF or replays', async () => {
  const requestId = '02dac041-2ba2-4d70-ae40-b50c395a647b';
  for (const [status, code] of [[401, 'UNAUTHORIZED'], [403, 'CSRF_INVALID'], [413, 'EXPORT_TOO_LARGE'], [500, 'INTERNAL_ERROR']]) {
    const { api, ApiError } = await freshApi();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return response(status, { code, message: '名单导出未完成' }, { 'X-Request-Id': requestId });
    };
    await assert.rejects(api.exportAdminRegistrations('25', { status: 'ALL', checkInStatus: 'ALL' }), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.equal(error.requestId, requestId);
      assert.equal(error.message, '名单导出未完成');
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('CSV response validation prevents JSON and HTML being offered as a successful download', async () => {
  for (const contentType of ['application/json', 'text/html', 'application/octet-stream']) {
    const { api } = await freshApi();
    globalThis.fetch = async () => new Response('not a CSV file', { headers: { 'Content-Type': contentType } });
    await assert.rejects(api.exportAdminRegistrations('25', { status: 'ALL', checkInStatus: 'ALL' }), error => error.code === 'INVALID_RESPONSE');
  }
});

test('check-in writes have no identity body, preserve abort and replay only one explicit CSRF rejection', async () => {
  const { api } = await freshApi();
  const controller = new AbortController();
  const calls = [];
  let tokens = 0;
  let attempts = 0;
  const result = { id: 123, checkedInAt: '2030-01-01T00:00:00Z', checkedInBy: 1 };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/auth/csrf') return response(200, { token: `token-${++tokens}`, headerName: 'X-CSRF-TOKEN' });
    return ++attempts === 1 ? response(403, { code: 'CSRF_INVALID' }) : response(200, result);
  };
  assert.deepEqual(await api.checkInRegistration('25', 123, controller.signal), result);
  const writes = calls.filter(call => call.options.method === 'POST');
  assert.equal(tokens, 2);
  assert.equal(writes.length, 2);
  for (const { url, options } of writes) {
    assert.equal(url, '/api/admin/activities/25/registrations/123/check-in');
    assert.equal(options.body, undefined);
    assert.equal(options.signal, controller.signal);
    assert.equal(options.credentials, 'same-origin');
  }
  assert.equal(writes[0].options.headers.get('X-CSRF-TOKEN'), 'token-1');
  assert.equal(writes[1].options.headers.get('X-CSRF-TOKEN'), 'token-2');
});

test('check-in conflicts and ownership failures remain visible without write replay', async () => {
  for (const [status, code] of [[403, 'FORBIDDEN'], [404, 'REGISTRATION_NOT_FOUND'], [409, 'CHECK_IN_NOT_OPEN'], [409, 'REGISTRATION_NOT_ACTIVE']]) {
    const { api } = await freshApi();
    let writes = 0;
    globalThis.fetch = async url => {
      if (url === '/api/auth/csrf') return response(200, { token: 'valid', headerName: 'X-CSRF-TOKEN' });
      writes++;
      return response(status, { code, message: '不能签到' });
    };
    await assert.rejects(api.checkInRegistration('25', 123), error => error.status === status && error.code === code);
    assert.equal(writes, 1);
  }
});

test('cancelled CSV reads and check-in writes preserve AbortError without starting an obsolete request', async () => {
  const { api } = await freshApi();
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response(200, {}); };
  await assert.rejects(api.exportAdminRegistrations('25', { status: 'ALL', checkInStatus: 'ALL' }, controller.signal), error => error.name === 'AbortError');
  await assert.rejects(api.checkInRegistration('25', 123, controller.signal), error => error.name === 'AbortError');
  assert.equal(calls, 0);
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: new Headers({ 'Content-Type': 'text/csv' }),
    blob: async () => { throw new DOMException('cancelled body', 'AbortError'); },
  });
  await assert.rejects(api.exportAdminRegistrations('25', { status: 'ALL', checkInStatus: 'ALL' }), error => error.name === 'AbortError');
});

test('authentication limits expose only validated retry seconds without retrying or refreshing CSRF', async () => {
  const requestId = '02dac041-2ba2-4d70-ae40-b50c395a647b';
  for (const [jsonSeconds, header, expected] of [
    [7, '7', 7], [7, '9', 9], [9, '7', 9], [7, undefined, 7],
    [undefined, '8', 8], ['8', '6', 6], [0, '0', undefined],
    [-1, '-1', undefined], [1.5, '1.5', undefined], ['8', '08', undefined],
    [86_400, '86400', 86_400], [86_401, '86401', undefined],
    [null, 'Wed, 21 Oct 2030 07:28:00 GMT', undefined], [null, 'Infinity', undefined],
  ]) {
    const { api, ApiError } = await freshApi();
    const calls = [];
    globalThis.fetch = async url => {
      calls.push(url);
      if (url === '/api/auth/csrf') return response(200, { token: 'valid', headerName: 'X-CSRF-TOKEN' });
      return response(429, { code: 'AUTH_RATE_LIMITED', message: '请求过于频繁', retryAfterSeconds: jsonSeconds }, {
        'X-Request-Id': requestId, ...(header === undefined ? {} : { 'Retry-After': header }),
      });
    };
    await assert.rejects(api.login('demo', 'wrong'), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 429);
      assert.equal(error.code, 'AUTH_RATE_LIMITED');
      assert.equal(error.retryAfterSeconds, expected);
      assert.equal(error.requestId, requestId);
      return true;
    });
    assert.deepEqual(calls, ['/api/auth/csrf', '/api/auth/login']);
  }
});

test('register limits and unavailable stores remain errors without writes being replayed', async () => {
  for (const [status, code, expected] of [
    [429, 'AUTH_RATE_LIMITED', 3], [429, 'UNKNOWN_LIMIT', undefined],
    [403, 'AUTH_RATE_LIMITED', undefined], [503, 'AUTH_RATE_LIMIT_UNAVAILABLE', undefined],
  ]) {
    const { api } = await freshApi();
    let tokenFetches = 0;
    let writes = 0;
    globalThis.fetch = async url => {
      if (url === '/api/auth/csrf') {
        tokenFetches++;
        return response(200, { token: 'valid', headerName: 'X-CSRF-TOKEN' });
      }
      writes++;
      return response(status, { code, message: '稍后重试', retryAfterSeconds: 3 }, { 'Retry-After': '3' });
    };
    await assert.rejects(api.registerUser({ username: 'new_user', displayName: '昵称', password: 'Abc12345' }), error => {
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.equal(error.retryAfterSeconds, expected);
      return true;
    });
    assert.equal(writes, 1);
    assert.equal(tokenFetches, 1);
  }
});

test('cancelled successful login cannot refresh CSRF or publish an obsolete result', async () => {
  const { api } = await freshApi();
  const controller = new AbortController();
  let tokenFetches = 0;
  const user = { id: 1, username: 'demo', displayName: '参与者', role: 'USER' };
  globalThis.fetch = async (url, options) => {
    if (url === '/api/auth/csrf') {
      tokenFetches++;
      return response(200, { token: 'valid', headerName: 'X-CSRF-TOKEN' });
    }
    assert.equal(options.signal, controller.signal);
    controller.abort();
    return response(200, user);
  };
  await assert.rejects(api.login('demo', 'Demo123!', controller.signal), error => error.name === 'AbortError');
  assert.equal(tokenFetches, 1);
});

function deferredResponse() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('a login cancelled after its CSRF refresh starts cannot cache that response or lend its promise to another write', async () => {
  const { api } = await freshApi();
  const controller = new AbortController();
  const oldRefresh = deferredResponse();
  const refreshStarted = deferredResponse();
  let tokenFetches = 0;
  let ownedRefreshSignal;
  const writes = [];
  globalThis.fetch = async (url, options) => {
    if (url === '/api/auth/csrf') {
      tokenFetches++;
      if (tokenFetches === 2) {
        ownedRefreshSignal = options.signal;
        assert.ok(ownedRefreshSignal instanceof AbortSignal);
        refreshStarted.resolve();
        // Deliberately return after cancellation, as an already delivered body
        // or an intermediary may do. The cache still has to reject the result.
        return oldRefresh.promise;
      }
      return response(200, { token: tokenFetches === 1 ? 'initial' : 'current', headerName: 'X-CSRF-TOKEN' });
    }
    writes.push({ url, token: options.headers.get('X-CSRF-TOKEN') });
    return response(200, { id: 1, username: 'demo', role: 'USER' });
  };
  const rejectedLogin = assert.rejects(api.login('demo', 'Demo123!', controller.signal), error => error.name === 'AbortError');
  await refreshStarted.promise;
  controller.abort();
  assert.equal(ownedRefreshSignal.aborted, true);
  await api.register(25);
  assert.equal(tokenFetches, 3);
  oldRefresh.resolve(response(200, { token: 'obsolete', headerName: 'X-CSRF-TOKEN' }));
  await rejectedLogin;
  await api.register(26);
  assert.deepEqual(writes.slice(1), [
    { url: '/api/activities/25/registration', token: 'current' },
    { url: '/api/activities/26/registration', token: 'current' },
  ]);
});

test('a new login obtains its own CSRF refresh and a slower preceding refresh cannot replace the new session token', async () => {
  const { api } = await freshApi();
  const oldRefresh = deferredResponse();
  const refreshStarted = deferredResponse();
  let tokenFetches = 0;
  const writes = [];
  globalThis.fetch = async (url, options) => {
    if (url === '/api/auth/csrf') {
      tokenFetches++;
      if (tokenFetches === 2) {
        refreshStarted.resolve();
        return oldRefresh.promise;
      }
      return response(200, { token: `token-${tokenFetches}`, headerName: 'X-CSRF-TOKEN' });
    }
    writes.push({ url, token: options.headers.get('X-CSRF-TOKEN') });
    return response(200, { id: options.body?.get?.('username') === 'admin' ? 2 : 1 });
  };
  const rejectedOldLogin = assert.rejects(api.login('demo', 'Demo123!'), error => error.name === 'AbortError');
  await refreshStarted.promise;
  assert.equal((await api.login('admin', 'Admin123!')).id, 2);
  assert.equal(tokenFetches, 4);
  oldRefresh.resolve(response(200, { token: 'old-session-token', headerName: 'X-CSRF-TOKEN' }));
  await rejectedOldLogin;
  await api.register(25);
  assert.deepEqual(writes.at(-1), { url: '/api/activities/25/registration', token: 'token-4' });
  assert.equal(tokenFetches, 4);
});

test('a stale refresh failure cannot erase the newer shared promise or cause it to be fetched again', async () => {
  const { api } = await freshApi();
  const oldRefresh = deferredResponse();
  const oldStarted = deferredResponse();
  const newInitial = deferredResponse();
  const newInitialStarted = deferredResponse();
  const newRefresh = deferredResponse();
  const newRefreshStarted = deferredResponse();
  let tokenFetches = 0;
  let writeToken;
  globalThis.fetch = async (url, options) => {
    if (url === '/api/auth/csrf') {
      tokenFetches++;
      if (tokenFetches === 2) { oldStarted.resolve(); return oldRefresh.promise; }
      if (tokenFetches === 3) { newInitialStarted.resolve(); return newInitial.promise; }
      if (tokenFetches === 4) { newRefreshStarted.resolve(); return newRefresh.promise; }
      return response(200, { token: 'initial', headerName: 'X-CSRF-TOKEN' });
    }
    writeToken = options.headers.get('X-CSRF-TOKEN');
    return response(200, { id: 2 });
  };
  const rejectedOldLogin = assert.rejects(api.login('demo', 'Demo123!'), error => error.name === 'AbortError');
  await oldStarted.promise;
  const newLogin = api.login('admin', 'Admin123!');
  await newInitialStarted.promise;
  oldRefresh.reject(new TypeError('late obsolete network failure'));
  await rejectedOldLogin;
  const joinedRefresh = api.refreshCsrf();
  assert.equal(tokenFetches, 3);
  newInitial.resolve(response(200, { token: 'before-new-login', headerName: 'X-CSRF-TOKEN' }));
  await joinedRefresh;
  await newRefreshStarted.promise;
  assert.equal(tokenFetches, 4);
  newRefresh.resolve(response(200, { token: 'new-session-token', headerName: 'X-CSRF-TOKEN' }));
  await newLogin;
  await api.register(25);
  assert.equal(writeToken, 'new-session-token');
  assert.equal(tokenFetches, 4);
});

test('concurrent initialization refreshes retain their shared CSRF fetch and supply the next write', async () => {
  const { api } = await freshApi();
  const initial = deferredResponse();
  let tokenFetches = 0;
  let writeToken;
  globalThis.fetch = async (url, options) => {
    if (url === '/api/auth/csrf') { tokenFetches++; return initial.promise; }
    writeToken = options.headers.get('X-CSRF-TOKEN');
    return response(200, { id: 25 });
  };
  const first = api.refreshCsrf();
  const second = api.refreshCsrf();
  assert.equal(tokenFetches, 1);
  initial.resolve(response(200, { token: 'shared-initial', headerName: 'X-CSRF-TOKEN' }));
  await Promise.all([first, second]);
  await api.register(25);
  assert.equal(writeToken, 'shared-initial');
  assert.equal(tokenFetches, 1);
});

test('audit list and detail reads send only approved criteria, preserve their metadata and never request CSRF', async () => {
  const { api } = await freshApi();
  const controller = new AbortController();
  const item = { id: 81, action: 'CHECK_IN', activityId: 42, activityTitle: '活动当时名称', actorUserId: 1,
    actorUsername: 'admin', actorDisplayName: '当时昵称', registrationId: 101, targetUsername: 'demo',
    targetDisplayName: '参与者当时昵称', occurredAt: '2030-01-01T08:00:00.123456Z' };
  const page = { items: [item], total: 23, page: 2, pageSize: 10 };
  const detail = { ...item, changes: [{ field: 'checkedInAt', before: null, after: item.occurredAt }] };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return response(200, url.includes('/81') ? detail : page);
  };
  assert.deepEqual(await api.adminAuditLogs({ action: 'CHECK_IN', page: 2, pageSize: 10, activityId: 42, userId: 999, actorId: 888 }, controller.signal), page);
  assert.deepEqual(await api.adminAuditLog(81, controller.signal), detail);
  assert.deepEqual(Object.fromEntries(new URL(calls[0].url, 'http://localhost').searchParams),
    { page: '2', pageSize: '10', action: 'CHECK_IN', activityId: '42' });
  assert.equal(calls[1].url, '/api/admin/audit-logs/81');
  await api.adminAuditLogs({ action: 'ALL', page: 1, pageSize: 10, activityId: null });
  assert.equal(new URL(calls[2].url, 'http://localhost').searchParams.has('activityId'), false);
  assert.equal(calls.length, 3);
  for (const { options } of calls) {
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers.get('X-CSRF-TOKEN'), null);
    assert.equal(options.body, undefined);
    assert.equal(options.method, undefined);
  }
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[1].options.signal, controller.signal);
});

test('audit authentication, permission and missing-record errors retain request IDs without replaying reads', async () => {
  const requestId = '02dac041-2ba2-4d70-ae40-b50c395a647b';
  for (const [status, code] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [404, 'AUDIT_LOG_NOT_FOUND'], [500, 'INTERNAL_ERROR']]) {
    const { api } = await freshApi();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return response(status, { code, message: '记录读取失败' }, { 'X-Request-Id': requestId });
    };
    await assert.rejects(api.adminAuditLog(81), error => error.status === status && error.code === code && error.requestId === requestId);
    assert.equal(calls, 1);
  }
  const { api } = await freshApi();
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async () => assert.fail('cancelled audit request must not start');
  await assert.rejects(api.adminAuditLog(81, controller.signal), error => error.name === 'AbortError');
  await assert.rejects(api.adminAuditLogs({ action: 'ALL', page: 1, pageSize: 10, activityId: null }, controller.signal), error => error.name === 'AbortError');
});

test('attendance uses only committed date and page criteria and preserves full weighted statistics independently of the returned page', async () => {
  const { api } = await freshApi();
  const controller = new AbortController();
  const query = { from: '2026-09-16', to: '2026-10-15', page: 2, pageSize: 10, userId: 999, includeCancelled: true };
  const page = { items: [{ id: 42, title: '已开始活动', location: '北京', startsAt: '2026-10-15T00:00:00Z', capacity: 1,
    activeRegistrations: 1, checkedInRegistrations: 1, notCheckedInRegistrations: 0, checkInRate: 100 }],
    total: 11, page: 2, pageSize: 10, from: query.from, to: query.to, asOf: '2026-10-15T08:00:00.123456Z',
    summary: { totalActivities: 11, activeRegistrations: 100, checkedInRegistrations: 25, notCheckedInRegistrations: 75, checkInRate: 25 } };
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return response(200, page); };
  assert.deepEqual(await api.adminAttendance(query, controller.signal), page);
  const path = new URL(calls[0].url, 'http://localhost');
  assert.equal(path.pathname, '/api/admin/attendance');
  assert.deepEqual(Object.fromEntries(path.searchParams), { from: query.from, to: query.to, page: '2', pageSize: '10' });
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.headers.get('X-CSRF-TOKEN'), null);
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls.length, 1);
});

test('attendance errors preserve authentication, validation and incident codes without a read retry or CSRF request', async () => {
  const requestId = '02dac041-2ba2-4d70-ae40-b50c395a647b';
  for (const [status, code] of [[400, 'VALIDATION_ERROR'], [401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [500, 'INTERNAL_ERROR']]) {
    const { api } = await freshApi();
    let calls = 0;
    globalThis.fetch = async () => { calls++; return response(status, { code, message: '签到分析读取失败' }, { 'X-Request-Id': requestId }); };
    await assert.rejects(api.adminAttendance({ from: '2026-09-16', to: '2026-10-15', page: 1, pageSize: 10 }),
      error => error.status === status && error.code === code && error.requestId === requestId);
    assert.equal(calls, 1);
  }
  const { api } = await freshApi();
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async () => assert.fail('obsolete attendance read must not start');
  await assert.rejects(api.adminAttendance({ from: '2026-09-16', to: '2026-10-15', page: 1, pageSize: 10 }, controller.signal), error => error.name === 'AbortError');
});

test('password change sends only the unmodified current/new passwords with CSRF and cancellation without logging in or out', async () => {
  const { api } = await freshApi();
  const controller = new AbortController();
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/auth/csrf') return response(200, { token: 'current-session-token', headerName: 'X-CSRF-TOKEN' });
    return response(200, { success: true });
  };
  assert.equal(await api.changePassword(' 旧密码 ', ' Newpass123 ', controller.signal), undefined);
  assert.deepEqual(calls.map(call => call.url), ['/api/auth/csrf', '/api/me/password']);
  const write = calls[1].options;
  assert.equal(write.method, 'POST');
  assert.equal(write.signal, controller.signal);
  assert.equal(write.headers.get('X-CSRF-TOKEN'), 'current-session-token');
  assert.equal(write.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(write.body), { currentPassword: ' 旧密码 ', newPassword: ' Newpass123 ' });
});

test('password rejections and uncertain outcomes are never automatically replayed or refreshed as CSRF failures', async () => {
  for (const [status, code] of [[400, 'CURRENT_PASSWORD_INCORRECT'], [400, 'PASSWORD_UNCHANGED'], [400, 'VALIDATION_ERROR'],
    [401, 'SESSION_REVOKED'], [429, 'AUTH_RATE_LIMITED'], [503, 'AUTH_RATE_LIMIT_UNAVAILABLE'],
    [503, 'AUTHENTICATION_UNAVAILABLE'], [500, 'PASSWORD_CHANGE_UNCONFIRMED']]) {
    const { api } = await freshApi();
    let tokenFetches = 0;
    let writes = 0;
    const requestId = '02dac041-2ba2-4d70-ae40-b50c395a647b';
    globalThis.fetch = async url => {
      if (url === '/api/auth/csrf') { tokenFetches++; return response(200, { token: 'valid', headerName: 'X-CSRF-TOKEN' }); }
      writes++;
      return response(status, { code, message: '改密未完成', retryAfterSeconds: 5 }, { 'X-Request-Id': requestId, 'Retry-After': '5' });
    };
    await assert.rejects(api.changePassword('Oldpass123', 'Newpass123'), error => error.status === status && error.code === code &&
      error.requestId === requestId && error.retryAfterSeconds === (status === 429 ? 5 : undefined));
    assert.equal(tokenFetches, 1);
    assert.equal(writes, 1);
  }
});

test('password changes retry only one explicit CSRF rejection while network failures and invalid success responses remain uncertain', async () => {
  const { api } = await freshApi();
  let tokens = 0;
  let writes = 0;
  globalThis.fetch = async url => {
    if (url === '/api/auth/csrf') return response(200, { token: `token-${++tokens}`, headerName: 'X-CSRF-TOKEN' });
    return ++writes === 1 ? response(403, { code: 'CSRF_INVALID' }) : response(200, { success: true });
  };
  await api.changePassword('Oldpass123', 'Newpass123');
  assert.equal(tokens, 2);
  assert.equal(writes, 2);
  for (const badSuccess of [{}, { success: false }, { success: 'true' }, null]) {
    const { api } = await freshApi();
    let writes = 0;
    globalThis.fetch = async url => url === '/api/auth/csrf' ? response(200, { token: 'valid', headerName: 'X-CSRF-TOKEN' })
      : (writes++, response(200, badSuccess));
    await assert.rejects(api.changePassword('Oldpass123', 'Newpass123'), error => error.code === 'INVALID_RESPONSE');
    assert.equal(writes, 1);
  }
  const isolated = await freshApi();
  let attempts = 0;
  globalThis.fetch = async url => {
    if (url === '/api/auth/csrf') return response(200, { token: 'valid', headerName: 'X-CSRF-TOKEN' });
    attempts++;
    throw new TypeError('uncertain transport failure');
  };
  await assert.rejects(isolated.api.changePassword('Oldpass123', 'Newpass123'), error => error.code === 'NETWORK_ERROR');
  assert.equal(attempts, 1);
});

test('manual password confirmation logout carries cancellation and refreshes only the current anonymous CSRF token', async () => {
  const { api } = await freshApi();
  const controller = new AbortController();
  const refresh = deferredResponse();
  const refreshStarted = deferredResponse();
  let tokenFetches = 0;
  let ownedRefreshSignal;
  globalThis.fetch = async (url, options) => {
    if (url === '/api/auth/csrf') {
      if (++tokenFetches === 2) {
        ownedRefreshSignal = options.signal;
        assert.ok(ownedRefreshSignal instanceof AbortSignal);
        refreshStarted.resolve();
        return refresh.promise;
      }
      return response(200, { token: 'initial', headerName: 'X-CSRF-TOKEN' });
    }
    assert.equal(url, '/api/auth/logout');
    assert.equal(options.signal, controller.signal);
    return response(200, {});
  };
  const cancelledLogout = assert.rejects(api.logout(controller.signal), error => error.name === 'AbortError');
  await refreshStarted.promise;
  controller.abort();
  assert.equal(ownedRefreshSignal.aborted, true);
  refresh.resolve(response(200, { token: 'obsolete-anonymous-token', headerName: 'X-CSRF-TOKEN' }));
  await cancelledLogout;
  await api.refreshCsrf();
  assert.equal(tokenFetches, 3);
});

test('cancelling one initial-token subscriber keeps the shared fetch alive for another page write', async () => {
  const { api } = await freshApi();
  const first = new AbortController();
  const second = new AbortController();
  const tokenResponse = deferredResponse();
  let tokenFetches = 0;
  let sharedSignal;
  const writes = [];
  globalThis.fetch = async (url, options) => {
    if (url === '/api/auth/csrf') {
      tokenFetches++;
      sharedSignal = options.signal;
      return tokenResponse.promise;
    }
    writes.push({ url, token: options.headers.get('X-CSRF-TOKEN') });
    return response(200, { id: 26 });
  };
  const firstCancelled = assert.rejects(api.register(25, first.signal), error => error.name === 'AbortError');
  const secondWrite = api.register(26, second.signal);
  assert.equal(tokenFetches, 1);
  assert.notEqual(sharedSignal, first.signal);
  first.abort();
  await firstCancelled;
  assert.equal(sharedSignal.aborted, false);
  tokenResponse.resolve(response(200, { token: 'shared-token', headerName: 'X-CSRF-TOKEN' }));
  await secondWrite;
  assert.deepEqual(writes, [{ url: '/api/activities/26/registration', token: 'shared-token' }]);
  assert.equal(sharedSignal.aborted, false);
});

test('the last departing initial-token subscriber aborts the actual shared fetch without sending any write', async () => {
  const { api } = await freshApi();
  const first = new AbortController();
  const second = new AbortController();
  let sharedSignal;
  let networkAborts = 0;
  let writes = 0;
  globalThis.fetch = async (url, options) => {
    if (url !== '/api/auth/csrf') { writes++; return response(200, {}); }
    sharedSignal = options.signal;
    return new Promise((resolve, reject) => sharedSignal.addEventListener('abort', () => {
      networkAborts++;
      reject(new DOMException('network request cancelled', 'AbortError'));
    }, { once: true }));
  };
  const firstCancelled = assert.rejects(api.register(25, first.signal), error => error.name === 'AbortError');
  const secondCancelled = assert.rejects(api.register(26, second.signal), error => error.name === 'AbortError');
  first.abort();
  assert.equal(sharedSignal.aborted, false);
  second.abort();
  await Promise.all([firstCancelled, secondCancelled]);
  assert.equal(sharedSignal.aborted, true);
  assert.equal(networkAborts, 1);
  assert.equal(writes, 0);
});

test('an unbound initialization subscriber keeps deduplication when an unrelated page cancels', async () => {
  const { api } = await freshApi();
  const tokenResponse = deferredResponse();
  const page = new AbortController();
  let tokenFetches = 0;
  let sharedSignal;
  globalThis.fetch = async (url, options) => {
    if (url === '/api/auth/csrf') { tokenFetches++; sharedSignal = options.signal; return tokenResponse.promise; }
    return response(200, { id: 26 });
  };
  const initialization = api.refreshCsrf();
  const cancelled = assert.rejects(api.register(25, page.signal), error => error.name === 'AbortError');
  page.abort();
  await cancelled;
  assert.equal(sharedSignal.aborted, false);
  tokenResponse.resolve(response(200, { token: 'initialization-token', headerName: 'X-CSRF-TOKEN' }));
  await initialization;
  await api.register(26);
  assert.equal(tokenFetches, 1);
});

test('leaving the sole explicit-CSRF-recovery page aborts its recovery fetch and never replays the write', async () => {
  const { api } = await freshApi();
  const controller = new AbortController();
  const recoveryStarted = deferredResponse();
  let recoverySignal;
  let tokenFetches = 0;
  let writes = 0;
  let networkAborts = 0;
  globalThis.fetch = async (url, options) => {
    if (url === '/api/auth/csrf') {
      if (++tokenFetches === 1) return response(200, { token: 'expired', headerName: 'X-CSRF-TOKEN' });
      recoverySignal = options.signal;
      recoveryStarted.resolve();
      return new Promise((resolve, reject) => recoverySignal.addEventListener('abort', () => {
        networkAborts++;
        reject(new DOMException('recovery cancelled', 'AbortError'));
      }, { once: true }));
    }
    writes++;
    return response(403, { code: 'CSRF_INVALID' });
  };
  const cancelled = assert.rejects(api.register(25, controller.signal), error => error.name === 'AbortError');
  await recoveryStarted.promise;
  controller.abort();
  await cancelled;
  assert.equal(recoverySignal.aborted, true);
  assert.equal(networkAborts, 1);
  assert.equal(tokenFetches, 2);
  assert.equal(writes, 1);
});

test('new authentication aborts an older shared 403-recovery fetch and the next write uses the new-session token', async () => {
  const { api } = await freshApi();
  const recoveryStarted = deferredResponse();
  let tokenFetches = 0;
  let recoverySignal;
  let networkAborts = 0;
  const writes = [];
  globalThis.fetch = async (url, options) => {
    if (url === '/api/auth/csrf') {
      if (++tokenFetches === 2) {
        recoverySignal = options.signal;
        recoveryStarted.resolve();
        return new Promise((resolve, reject) => recoverySignal.addEventListener('abort', () => {
          networkAborts++;
          reject(new DOMException('old identity cancelled', 'AbortError'));
        }, { once: true }));
      }
      return response(200, { token: `token-${tokenFetches}`, headerName: 'X-CSRF-TOKEN' });
    }
    writes.push({ url, token: options.headers.get('X-CSRF-TOKEN') });
    return url === '/api/activities/25/registration' ? response(403, { code: 'CSRF_INVALID' }) : response(200, { id: 1 });
  };
  const cancelledOldWrite = assert.rejects(api.register(25), error => error.name === 'AbortError');
  await recoveryStarted.promise;
  await api.login('demo', 'Demo123!');
  await cancelledOldWrite;
  assert.equal(recoverySignal.aborted, true);
  assert.equal(networkAborts, 1);
  await api.register(26);
  assert.deepEqual(writes.at(-1), { url: '/api/activities/26/registration', token: 'token-4' });
  assert.equal(writes.filter(write => write.url === '/api/activities/25/registration').length, 1);
});

test('a new login closes an actual in-flight HTTP initialization fetch before it can deliver old response headers', async () => {
  const { api } = await freshApi();
  const initialStarted = deferredResponse();
  const initialClosed = deferredResponse();
  let tokenFetches = 0;
  let finalWriteToken;
  const server = createServer((request, reply) => {
    if (request.url === '/api/auth/csrf') {
      if (++tokenFetches === 1) {
        initialStarted.resolve();
        reply.on('close', () => initialClosed.resolve({ finished: reply.writableFinished, headersSent: reply.headersSent }));
        return;
      }
      reply.writeHead(200, { 'Content-Type': 'application/json' });
      reply.end(JSON.stringify({ token: `http-token-${tokenFetches}`, headerName: 'X-CSRF-TOKEN' }));
      return;
    }
    if (request.url === '/api/activities/26/registration') finalWriteToken = request.headers['x-csrf-token'];
    request.resume();
    reply.writeHead(200, { 'Content-Type': 'application/json' });
    reply.end(JSON.stringify({ id: 1 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  globalThis.fetch = (url, options) => originalFetch(`http://127.0.0.1:${address.port}${url}`, options);
  try {
    const cancelledInitialization = assert.rejects(api.refreshCsrf(), error => error.name === 'AbortError');
    await initialStarted.promise;
    await api.login('demo', 'Demo123!');
    await cancelledInitialization;
    assert.deepEqual(await initialClosed.promise, { finished: false, headersSent: false });
    await api.register(26);
    assert.equal(finalWriteToken, 'http-token-3');
    assert.equal(tokenFetches, 3);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('an old explicit CSRF rejection delivered after a new login cannot refresh tokens or replay its write across identities', async () => {
  const { api } = await freshApi();
  const oldWrite = deferredResponse();
  const oldDispatched = deferredResponse();
  let tokenFetches = 0;
  const writes = [];
  globalThis.fetch = async (url, options) => {
    if (url === '/api/auth/csrf') return response(200, { token: `token-${++tokenFetches}`, headerName: 'X-CSRF-TOKEN' });
    writes.push({ url, token: options.headers.get('X-CSRF-TOKEN') });
    if (url === '/api/activities/25/registration') { oldDispatched.resolve(); return oldWrite.promise; }
    return response(200, { id: 1 });
  };
  const oldCancelled = assert.rejects(api.register(25), error => error.name === 'AbortError');
  await oldDispatched.promise;
  await api.login('demo', 'Demo123!');
  assert.equal(tokenFetches, 2);
  oldWrite.resolve(response(403, { code: 'CSRF_INVALID' }));
  await oldCancelled;
  assert.equal(tokenFetches, 2);
  assert.equal(writes.filter(write => write.url === '/api/activities/25/registration').length, 1);
  await api.register(26);
  assert.deepEqual(writes.at(-1), { url: '/api/activities/26/registration', token: 'token-2' });
  assert.equal(tokenFetches, 2);
});

test('public and admin category searches combine only their criteria and retain real category values in the response', async () => {
  const { api } = await freshApi();
  const controller = new AbortController();
  const calls = [];
  const page = { items: [{ id: 42, category: 'TECHNOLOGY' }], total: 13, page: 2, pageSize: 10,
    summary: { upcomingActivities: 13, availableSeats: 99 } };
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return response(200, page); };
  const query = { keyword: ' 上海 %_ ', status: 'OPEN', category: 'TECHNOLOGY', page: 2, pageSize: 10, userId: 999 };
  assert.deepEqual(await api.searchActivities(query, controller.signal), page);
  assert.deepEqual(await api.adminActivities(query, controller.signal), page);
  for (const { url, options } of calls) {
    assert.deepEqual(Object.fromEntries(new URL(url, 'http://localhost').searchParams),
      { keyword: query.keyword, status: 'OPEN', category: 'TECHNOLOGY', page: '2', pageSize: '10' });
    assert.equal(options.signal, controller.signal);
    assert.equal(options.body, undefined);
    assert.equal(options.credentials, 'same-origin');
  }
});

test('category writes retain old omitted/null calls, whitelist editable fields, and carry cancellation on publishing', async () => {
  const { api } = await freshApi();
  const controller = new AbortController();
  const writes = [];
  globalThis.fetch = async (url, options) => {
    if (url === '/api/auth/csrf') return response(200, { token: 'valid', headerName: 'X-CSRF-TOKEN' });
    writes.push({ url, options, body: JSON.parse(options.body) });
    return response(200, { id: 42, category: JSON.parse(options.body).category ?? 'UNCATEGORIZED' });
  };
  const create = { title: '分类活动', description: '说明', location: '上海', startsAt: '2030-01-01T00:00:00Z', capacity: 10 };
  for (const category of [undefined, null, 'SPORTS']) {
    await api.createActivity({ ...create, category }, controller.signal);
    await api.updateActivity(42, { title: '新标题', description: '说明', location: '上海', category, capacity: 999,
      startsAt: '2100-01-01T00:00:00Z', createdBy: 999 }, controller.signal);
  }
  assert.equal(Object.hasOwn(writes[0].body, 'category'), false);
  assert.equal(Object.hasOwn(writes[1].body, 'category'), false);
  assert.equal(writes[2].body.category, null);
  assert.equal(writes[3].body.category, null);
  assert.deepEqual(writes[5].body, { title: '新标题', description: '说明', location: '上海', category: 'SPORTS' });
  for (const write of writes) {
    assert.equal(write.options.signal, controller.signal);
    assert.equal(write.options.headers.get('X-CSRF-TOKEN'), 'valid');
  }
});

test('registration deadlines preserve old creation calls and explicit null or UTC values while edits cannot change the deadline', async () => {
  const { api } = await freshApi();
  const controller = new AbortController(), writes = [];
  globalThis.fetch = async (url, options) => {
    if (url === '/api/auth/csrf') return response(200, { token: 'valid', headerName: 'X-CSRF-TOKEN' });
    const body = JSON.parse(options.body);
    writes.push({ url, options, body });
    return response(200, { id: 42, registrationDeadline: body.registrationDeadline ?? null, registrationClosed: false });
  };
  const create = { title: '截止活动', description: '说明', location: '上海', startsAt: '2035-01-01T01:00:00Z', capacity: 10 };
  for (const registrationDeadline of [undefined, null, '2035-01-01T00:00:00.123456Z']) {
    const result = await api.createActivity({ ...create, registrationDeadline }, controller.signal);
    assert.equal(result.registrationDeadline, registrationDeadline ?? null);
    assert.equal(result.registrationClosed, false);
  }
  assert.equal(Object.hasOwn(writes[0].body, 'registrationDeadline'), false);
  assert.equal(writes[1].body.registrationDeadline, null);
  assert.equal(writes[2].body.registrationDeadline, '2035-01-01T00:00:00.123456Z');
  await api.updateActivity(42, { title: '更新', description: '说明', location: '上海', registrationDeadline: null }, controller.signal);
  assert.deepEqual(writes[3].body, { title: '更新', description: '说明', location: '上海' });
  for (const write of writes) {
    assert.equal(write.options.signal, controller.signal);
    assert.equal(write.options.headers.get('X-CSRF-TOKEN'), 'valid');
  }
});

test('invalid category errors remain explicit without automatic write replay and an abandoned publication never starts', async () => {
  const { api } = await freshApi();
  let writes = 0;
  globalThis.fetch = async url => {
    if (url === '/api/auth/csrf') return response(200, { token: 'valid', headerName: 'X-CSRF-TOKEN' });
    writes++;
    return response(400, { code: 'VALIDATION_ERROR', message: '活动分类无效' });
  };
  await assert.rejects(api.updateActivity(42, { title: '标题', description: '说明', location: '上海', category: 'bad' }),
    error => error.status === 400 && error.code === 'VALIDATION_ERROR');
  assert.equal(writes, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.createActivity({}, controller.signal), error => error.name === 'AbortError');
  assert.equal(writes, 1);
});
