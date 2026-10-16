import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../src/api.ts';
import { passwordError } from '../src/accountValidation.ts';
import { currentPasswordError, passwordChangeUnconfirmed, passwordConfirmationError,
  passwordUnconfirmedNotice, passwordUpdatedCsrfUnavailableNotice, passwordUpdatedNotice } from '../src/passwordChange.ts';
import { AuthRequestGuard, readAccountResource } from '../src/authRequestGuard.ts';

test('current password accepts legacy contents without trimming or imposing the new-password rules and bounds BCrypt bytes', () => {
  for (const password of [' ', 'x', '1234567', '中文', ' 旧密码 ', 'a'.repeat(72), '中'.repeat(24), '😀'.repeat(18)])
    assert.equal(currentPasswordError(password), null, JSON.stringify(password));
  assert.equal(currentPasswordError(''), '请输入当前密码。');
  for (const password of ['a'.repeat(73), '中'.repeat(25), '😀'.repeat(19)])
    assert.equal(currentPasswordError(password), '当前密码不能超过 72 个 UTF-8 字节。');
});

test('new password shares registration validation while confirmation compares unmodified contents exactly', () => {
  for (const password of [' Abc123 ', 'a1' + '中'.repeat(23), 'a1' + '😀'.repeat(17)]) {
    assert.equal(passwordError(password), null);
    assert.equal(passwordConfirmationError(password, password), null);
  }
  assert.ok(passwordError('a1' + '中'.repeat(24)));
  assert.equal(passwordConfirmationError(' Abc123 ', 'Abc123'), '两次输入的新密码不一致');
  assert.equal(passwordConfirmationError('Newpass123', 'newpass123'), '两次输入的新密码不一致');
  assert.equal(passwordConfirmationError('Abc123é', 'Abc123e\u0301'), '两次输入的新密码不一致');
  assert.equal(passwordConfirmationError('Newpass123', ''), '请再次输入新密码');
});

test('only uncertain transport, server or invalid-success outcomes enter confirmation; explicit validation and rate errors stay editable', () => {
  for (const error of [new ApiError(0, 'offline', 'NETWORK_ERROR'), new ApiError(500, 'unknown', 'PASSWORD_CHANGE_UNCONFIRMED'),
    new ApiError(503, 'unavailable', 'AUTHENTICATION_UNAVAILABLE'), new ApiError(200, 'bad success', 'INVALID_RESPONSE'), new TypeError('unexpected')])
    assert.equal(passwordChangeUnconfirmed(error), true);
  for (const [status, code] of [[400, 'CURRENT_PASSWORD_INCORRECT'], [400, 'PASSWORD_UNCHANGED'], [400, 'VALIDATION_ERROR'],
    [401, 'SESSION_REVOKED'], [403, 'CSRF_INVALID'], [429, 'AUTH_RATE_LIMITED']])
    assert.equal(passwordChangeUnconfirmed(new ApiError(status, 'known rejection', code)), false);
  assert.equal(passwordUpdatedNotice, '密码已更新，请重新登录。');
  assert.match(passwordUpdatedCsrfUnavailableNotice, /^密码已更新.*安全凭证暂不可用/);
  assert.equal(passwordUnconfirmedNotice, '结果未确认，请重新登录确认。');
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('late password success or 401/429 cannot begin sign-out, refresh CSRF or display errors under a newer authentication', async () => {
  for (const nextUserId of [1, 2]) for (const result of [undefined,
    new ApiError(401, 'old revoked session', 'SESSION_REVOKED'), new ApiError(429, 'old limit', 'AUTH_RATE_LIMITED', undefined, 5)]) {
    const auth = new AuthRequestGuard();
    const ticket = auth.beginAccountRequest(1);
    let currentUserId = 1;
    const response = deferred();
    let signOuts = 0;
    let csrfRefreshes = 0;
    let shownErrors = 0;
    const operation = readAccountResource(() => response.promise, new AbortController().signal,
      () => auth.isSameAccount(ticket, currentUserId), () => shownErrors++).then(() => { signOuts++; csrfRefreshes++; });
    const newer = auth.beginAuthentication();
    currentUserId = nextUserId;
    if (result instanceof Error) response.reject(result);
    else response.resolve(result);
    await assert.rejects(operation, error => error.name === 'AbortError');
    assert.equal(signOuts, 0);
    assert.equal(csrfRefreshes, 0);
    assert.equal(shownErrors, 0);
    assert.equal(auth.isCurrentAuthentication(newer), true);
  }
});

test('leaving the password page cancels both successful and failed results before any authentication side effect', async () => {
  for (const failed of [false, true]) {
    const controller = new AbortController();
    const response = deferred();
    let transitions = 0;
    const pending = readAccountResource(() => response.promise, controller.signal, () => true,
      () => assert.fail('aborted password attempt must not publish an error')).then(() => transitions++);
    controller.abort();
    if (failed) response.reject(new ApiError(500, 'old unknown result', 'PASSWORD_CHANGE_UNCONFIRMED'));
    else response.resolve(undefined);
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(transitions, 0);
  }
});
