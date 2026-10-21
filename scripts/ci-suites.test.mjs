import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { resolve } from 'node:path';

function collect(suite) {
  return [...(suite.specs ?? []).flatMap(spec => spec.tests.map(item => ({
    file: spec.file ?? suite.file, title: spec.title, project: item.projectName,
  }))), ...(suite.suites ?? []).flatMap(collect)];
}
function list(tag) {
  const report = JSON.parse(execFileSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test',
    ...(tag ? ['--grep', tag] : []), '--list', '--reporter=json'], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' }));
  assert.deepEqual(report.errors, []);
  return collect(report);
}
const key = item => JSON.stringify([item.file, item.title, item.project]);
const full = list(), smoke = list('@smoke'), redis = list('@redis');

test('smoke and Redis selections remain real subsets on both desktop and mobile', () => {
  const all = new Set(full.map(key));
  assert(full.length > redis.length);
  for (const [selection, count] of [[smoke, 8], [redis, 40]]) {
    assert.equal(selection.length, count);
    for (const project of ['desktop', 'mobile']) assert.equal(selection.filter(item => item.project === project).length, count / 2);
    for (const item of selection) assert(all.has(key(item)));
  }
  const focused = new Set(redis.map(key));
  for (const item of smoke) assert(focused.has(key(item)));
});

test('Redis retains every password recovery case and both suites retain real notification flows', () => {
  const focused = new Set(redis.map(key));
  for (const item of full.filter(item => item.file.endsWith('password.spec.ts'))) assert(focused.has(key(item)));
  for (const project of ['desktop', 'mobile']) {
    assert(smoke.some(item => item.project === project && item.file.endsWith('notifications.spec.ts')));
    assert(redis.some(item => item.project === project && item.file.endsWith('notification-bulk.spec.ts')));
  }
});
