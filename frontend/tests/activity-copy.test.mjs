import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityCopyDraft, activityCopyPath, activityCreateRequest, ordinaryActivityCreatePath,
  parseActivityCopySource, readActivityCopySource } from '../src/activityCopy.ts';
import { AuthRequestGuard, readAccountResource } from '../src/authRequestGuard.ts';
import { safeReturnPath } from '../src/pages/authNavigation.ts';

test('copy sources accept exactly one positive safe integer while ordinary publishing has no source', () => {
  for (const search of ['', '?keyword=42', '?other=copyFrom'])
    assert.deepEqual(parseActivityCopySource(search), { kind: 'ordinary' });
  for (const [value, id] of [['1', 1], ['00042', 42], ['9007199254740991', Number.MAX_SAFE_INTEGER]])
    assert.deepEqual(parseActivityCopySource(`?copyFrom=${value}&ignored=value`), { kind: 'copy', id });
  for (const value of ['', '0', '000', '-1', '+1', ' 1 ', '1.0', '1e3', 'NaN', 'Infinity', '9007199254740992', 'https://example.com/1', '１'])
    assert.deepEqual(parseActivityCopySource(`?${new URLSearchParams({ copyFrom: value })}`), { kind: 'invalid' });
  for (const search of ['?copyFrom=1&copyFrom=1', '?copyFrom=&copyFrom=2', '?copyFrom=1&copyFrom=2'])
    assert.deepEqual(parseActivityCopySource(search), { kind: 'invalid' });
});

test('copy draft preserves the exact original text and only the five editable fields, with both times cleared', () => {
  const source = { id: 42, title: ' 原标题 <img src=x> ', description: '原介绍\n第二行', location: ' 原地点 ', category: 'SPORTS', capacity: 13,
    startsAt: '2000-01-01T00:00:00Z', endsAt: '2000-01-01T01:00:00Z', coverUrl: '/private-cover', coverHash: 'private-hash',
    registeredCount: 7, waitingCount: 2, registrationStatus: 'ACTIVE', checkedInAt: 'private-time', createdBy: 4,
    cancelled: true, cancellationReason: '旧取消原因', cancelledAt: 'private-time' };
  assert.deepEqual(activityCopyDraft(source), { title: source.title, description: source.description, location: source.location,
    category: 'SPORTS', capacity: 13, startsAt: undefined, endsAt: undefined });
  assert.equal(activityCopyDraft({ ...source, category: undefined }).category, 'UNCATEGORIZED');
  assert.equal(activityCopyDraft({ ...source, cancelled: false }).title, source.title);
  assert.equal(source.startsAt, '2000-01-01T00:00:00Z');
});

test('publishing whitelists a new activity body and converts freshly supplied Beijing times without copying history', () => {
  const values = { title: ' 新标题 ', description: ' 新介绍 ', location: ' 新地点 ', category: 'CULTURE', capacity: 11,
    startsAt: '2035-01-02T00:30', endsAt: '2035-01-02T02:00', id: 42, copyFrom: 42, coverUrl: '/old',
    registeredCount: 99, waitingCount: 44, cancelled: true, checkedInBy: 1, createdBy: 1 };
  assert.deepEqual(activityCreateRequest(values), { title: '新标题', description: '新介绍', location: '新地点', category: 'CULTURE',
    capacity: 11, startsAt: '2035-01-01T16:30:00.000Z', endsAt: '2035-01-01T18:00:00.000Z' });
  assert.equal(activityCreateRequest({ ...values, endsAt: '' }).endsAt, null);
});

test('ordinary and invalid sources never request an activity; a valid source is freshly read with cancellation', async () => {
  const calls = [], source = { id: 42, title: '来源' }, controller = new AbortController();
  const read = async (id, signal) => { calls.push({ id, signal }); return source; };
  assert.equal(await readActivityCopySource({ kind: 'ordinary' }, read, controller.signal), null);
  assert.equal(await readActivityCopySource({ kind: 'invalid' }, read, controller.signal), null);
  assert.deepEqual(calls, []);
  assert.equal(await readActivityCopySource({ kind: 'copy', id: 42 }, read, controller.signal), source);
  assert.deepEqual(calls, [{ id: '42', signal: controller.signal }]);
  await assert.rejects(readActivityCopySource({ kind: 'copy', id: 7 }, read, controller.signal), /不匹配/);
  controller.abort();
  await assert.rejects(readActivityCopySource({ kind: 'copy', id: 42 }, read, controller.signal), error => error.name === 'AbortError');
  assert.equal(calls.length, 2);
});

test('copy entry and login return remain canonical internal paths without discarding the source', () => {
  assert.equal(ordinaryActivityCreatePath, '/admin/activities/new');
  const path = activityCopyPath(42);
  assert.equal(path, '/admin/activities/new?copyFrom=42');
  assert.equal(safeReturnPath(path), path);
  assert.equal(safeReturnPath(ordinaryActivityCreatePath), ordinaryActivityCreatePath);
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) assert.throws(() => activityCopyPath(id));
});

test('late source reads and old 401 errors cannot publish after source changes, ordinary publishing, or reauthentication', async () => {
  for (const change of ['other-source', 'ordinary', 'same-user-login', 'another-user-login']) for (const failed of [false, true]) {
    const auth = new AuthRequestGuard(), ticket = auth.beginAccountRequest(1), controller = new AbortController();
    let userId = 1, scope = 'copy:42', done, fail, expired = 0, published = 0;
    const response = new Promise((resolve, reject) => { done = resolve; fail = reject; });
    const current = () => scope === 'copy:42' && auth.isSameAccount(ticket, userId);
    const pending = readAccountResource(signal => readActivityCopySource({ kind: 'copy', id: 42 }, () => response, signal),
      controller.signal, current, () => expired++).then(() => published++);
    if (change === 'other-source') scope = 'copy:99';
    if (change === 'ordinary') scope = 'ordinary';
    if (change.includes('login')) { auth.beginAuthentication(); if (change === 'another-user-login') userId = 2; }
    if (failed) fail(Object.assign(new Error('old source authentication'), { status: 401 }));
    else done({ id: 42, title: '旧来源' });
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(expired, 0);
    assert.equal(published, 0);
  }
});
