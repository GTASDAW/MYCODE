import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayNameError, passwordError, usernameError } from '../src/accountValidation.ts';
import { AuthRequestGuard } from '../src/authRequestGuard.ts';
import { safeReturnPath } from '../src/pages/authNavigation.ts';

test('usernames validate ASCII before case normalization and enforce trimmed boundaries', () => {
  for (const value of [' AbC_123 ', 'a'.repeat(32)]) assert.equal(usernameError(value), null);
  for (const value of ['ab', 'a'.repeat(33), '1abc', 'abc.def', '中文abc', 'Kabc'])
    assert.ok(usernameError(value), value);
});

test('password validation uses the untrimmed UTF-16 length and limits UTF-8 bytes', () => {
  assert.equal(passwordError(' Abc123 '), null);
  assert.equal(passwordError('a1' + '中'.repeat(23)), null);
  assert.equal(passwordError('a1' + '中'.repeat(24)), '密码过长，请减少字符数量。');
  assert.equal(passwordError('a1' + '😀'.repeat(17)), null);
  assert.ok(passwordError('a1' + '😀'.repeat(18)));
  for (const value of ['abc1234', 'a1' + 'a'.repeat(63), 'abcdefgh', '12345678', '中文123456'])
    assert.ok(passwordError(value), value);
});

test('display names allow trimmed spaces but reject controls even at the edges', () => {
  assert.equal(displayNameError('  新昵称  '), null);
  assert.equal(displayNameError('😀'.repeat(20)), null);
  for (const value of ['', '   ', 'a'.repeat(41), '\n昵称', '昵称\t', '昵称\u0085'])
    assert.ok(displayNameError(value), JSON.stringify(value));
});

test('login return paths stay internal and cannot loop through account entry pages', () => {
  for (const value of [undefined, null, 42, '//evil.example', 'https://evil.example', '/\\evil.example', '/login', '/LOGIN', '/register?from=/profile', '/profile\n'])
    assert.equal(safeReturnPath(value), '/activities');
  assert.equal(safeReturnPath('/profile'), '/profile');
  assert.equal(safeReturnPath('/activities/12'), '/activities/12');
});

test('profile responses from an earlier authentication cannot update the same or another user', () => {
  const guard = new AuthRequestGuard();
  guard.beginAuthentication();
  const read = guard.beginProfileRead(1);
  const write = guard.beginProfileWrite(1);
  guard.beginAuthentication();
  assert.equal(guard.isCurrentProfileRead(read, 1), false);
  assert.equal(guard.finishProfileWrite(write, 1), false);
  assert.equal(guard.isSameAccount(read, 2), false);
});

test('only the newest concurrent profile read is accepted', () => {
  const guard = new AuthRequestGuard();
  const older = guard.beginProfileRead(1);
  const newer = guard.beginProfileRead(1);
  assert.equal(guard.isCurrentProfileRead(older, 1), false);
  assert.equal(guard.isCurrentProfileRead(newer, 1), true);
});

test('a save prevents reads started before or during it from restoring an older nickname', () => {
  const guard = new AuthRequestGuard();
  const before = guard.beginProfileRead(1);
  const write = guard.beginProfileWrite(1);
  assert.equal(guard.isCurrentProfileRead(before, 1), false);
  const during = guard.beginProfileRead(1);
  assert.equal(guard.finishProfileWrite(write, 1), true);
  assert.equal(guard.isCurrentProfileRead(during, 1), false);
  const after = guard.beginProfileRead(1);
  assert.equal(guard.isCurrentProfileRead(after, 1), true);
});

test('out of order saves cannot publish an older write result or invalidate a fresh read', () => {
  const guard = new AuthRequestGuard();
  const older = guard.beginProfileWrite(1);
  const newer = guard.beginProfileWrite(1);
  assert.equal(guard.finishProfileWrite(newer, 1), true);
  const read = guard.beginProfileRead(1);
  assert.equal(guard.finishProfileWrite(older, 1), false);
  assert.equal(guard.isCurrentProfileRead(read, 1), true);
});

test('late request errors are no longer current after another read, save or authentication', () => {
  const guard = new AuthRequestGuard();
  const olderRead = guard.beginProfileRead(1);
  guard.beginProfileRead(1);
  assert.equal(guard.isCurrentProfileRead(olderRead, 1), false);
  const beforeSave = guard.beginProfileRead(1);
  const olderWrite = guard.beginProfileWrite(1);
  assert.equal(guard.isCurrentProfileRead(beforeSave, 1), false);
  const newerWrite = guard.beginProfileWrite(1);
  assert.equal(guard.isCurrentProfileWrite(olderWrite, 1), false);
  assert.equal(guard.isCurrentProfileWrite(newerWrite, 1), true);
  guard.beginAuthentication();
  assert.equal(guard.isCurrentProfileWrite(newerWrite, 1), false);
});
