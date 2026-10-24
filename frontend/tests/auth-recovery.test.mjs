import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../src/api.ts';
import { AuthRequestGuard } from '../src/authRequestGuard.ts';
import { confirmLogoutSession } from '../src/authRecovery.ts';

const user = { id: 7, username: 'own_user', displayName: '仍已登录', role: 'USER', avatarUrl: null };
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('failed logout recovery confirms the Session and refreshes CSRF through reads without retrying logout', async () => {
  const guard = new AuthRequestGuard(), generation = guard.beginAuthentication(), controller = new AbortController(), calls = [];
  const result = await confirmLogoutSession({ signal: controller.signal,
    isCurrent: () => guard.isCurrentAuthentication(generation),
    readSession: async signal => { calls.push('GET me'); assert.equal(signal, controller.signal); return user; },
    refreshCsrf: async signal => { calls.push('GET csrf'); assert.equal(signal, controller.signal); },
  });
  assert.deepEqual(result, { user, csrfReady: true });
  assert.deepEqual(calls, ['GET me', 'GET csrf']);
});

test('a lost logout response with an anonymous Session is confirmed while a CSRF failure stays explicit', async () => {
  for (const csrfReady of [true, false]) {
    const result = await confirmLogoutSession({ signal: new AbortController().signal, isCurrent: () => true,
      readSession: async () => { throw new ApiError(401, 'anonymous', 'UNAUTHENTICATED'); },
      refreshCsrf: async () => { if (!csrfReady) throw new ApiError(503, 'csrf unavailable'); },
    });
    assert.deepEqual(result, { user: null, csrfReady });
  }
});

test('unconfirmed Session failures cannot pretend the user is logged in or anonymously signed out', async () => {
  let refreshes = 0;
  await assert.rejects(confirmLogoutSession({ signal: new AbortController().signal, isCurrent: () => true,
    readSession: async () => { throw new ApiError(503, 'authentication unavailable'); },
    refreshCsrf: async () => { refreshes++; },
  }), { status: 503 });
  assert.equal(refreshes, 0);
});

test('late logout recovery success or 401 cannot publish or refresh CSRF after a same-account relogin', async () => {
  for (const status of [200, 401, 503]) {
    const guard = new AuthRequestGuard(), generation = guard.beginAuthentication(), session = deferred();
    let refreshes = 0;
    const cancelled = assert.rejects(confirmLogoutSession({ signal: new AbortController().signal,
      isCurrent: () => guard.isCurrentAuthentication(generation), readSession: () => session.promise,
      refreshCsrf: async () => { refreshes++; },
    }), { name: 'AbortError' });
    guard.beginAuthentication();
    if (status === 200) session.resolve(user); else session.reject(new ApiError(status, 'late response'));
    await cancelled;
    assert.equal(refreshes, 0);
  }
});

test('late CSRF recovery success or failure cannot finish logout recovery after identity change or cancellation', async () => {
  for (const failure of [false, true]) {
    const guard = new AuthRequestGuard(), generation = guard.beginAuthentication(), csrf = deferred(), started = deferred();
    const controller = new AbortController();
    const cancelled = assert.rejects(confirmLogoutSession({ signal: controller.signal,
      isCurrent: () => guard.isCurrentAuthentication(generation), readSession: async () => user,
      refreshCsrf: async () => { started.resolve(); return csrf.promise; },
    }), { name: 'AbortError' });
    await started.promise;
    guard.beginAuthentication();
    controller.abort();
    if (failure) csrf.reject(new ApiError(503, 'late failure')); else csrf.resolve();
    await cancelled;
  }
});

test('a cancelled recovery never starts a Session read', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(confirmLogoutSession({ signal: controller.signal, isCurrent: () => true,
    readSession: () => assert.fail('cancelled recovery read'), refreshCsrf: () => assert.fail('cancelled CSRF read'),
  }), { name: 'AbortError' });
});
