import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { classifyChanges, eventScope, readChanges, verifyResults } from './ci-scope.mjs';

test('ordinary notification, UI and backend changes keep full MySQL and smoke gates in fast CI', () => {
  for (const file of ['frontend/src/pages/NotificationsPage.tsx', 'frontend/src/notificationQuery.ts',
    'backend/src/main/java/com/example/gather/service/NotificationService.java',
    'backend/src/test/java/com/example/gather/NotificationIntegrationTest.java', 'docs/notification-guide.md'])
    assert.equal(classifyChanges([file]).full, false, file);
});

test('authentication, data, transport, dependencies and infrastructure cannot select fast CI', () => {
  for (const file of ['.github/workflows/ci.yml', 'compose.redis.yaml', 'backend/Dockerfile', 'frontend/package-lock.json',
    'backend/pom.xml', 'backend/.mvn/wrapper/maven-wrapper.properties', 'backend/src/main/resources/db/migration/V13__future.sql',
    'backend/src/main/java/com/example/gather/security/SessionVersionFilter.java',
    'backend/src/main/java/com/example/gather/config/SecurityConfig.java',
    'backend/src/main/java/com/example/gather/mapper/NotificationMapper.java',
    'backend/src/main/java/com/example/gather/service/PasswordService.java',
    'backend/src/main/java/com/example/gather/api/ProfileController.java',
    'backend/src/main/java/com/example/gather/service/RegistrationService.java',
    'frontend/src/auth.tsx', 'frontend/src/api.ts', 'frontend/src/authRequestGuard.ts',
    'frontend/src/PageContentBoundary.tsx', 'frontend/src/main.tsx', 'frontend/src/Layout.tsx',
    'frontend/src/pages/AccessPages.tsx', 'frontend/src/pages/LoginPage.tsx', 'frontend/src/pages/authNavigation.ts',
    'frontend/vite.config.ts', 'playwright.config.ts',
    'scripts/e2e-cleanup.mjs', 'e2e/notifications.spec.ts'])
    assert.equal(classifyChanges(['frontend/src/pages/NotificationsPage.tsx', file]).full, true, file);
});

test('missing history, unknown paths and manual, scheduled or release runs fail closed to full', () => {
  for (const files of [[], undefined, ['new-root/file.txt'], ['../frontend/src/page.ts'], ['frontend\\src\\page.ts'], ['']])
    assert.equal(classifyChanges(files).full, true);
  for (const name of ['schedule', 'workflow_dispatch', 'unknown'])
    assert.equal(eventScope(name, {}, ['frontend/src/style.css']).full, true);
  assert.equal(eventScope('push', { ref: 'refs/tags/v1.0.0' }, ['docs/release.md']).full, true);
  assert.equal(eventScope('push', { ref: 'refs/tags/v1.0.0' }, ['docs/release.md']).redisAll, true);
  assert.equal(eventScope('workflow_dispatch', { inputs: { redis_all_e2e: 'true' } }, []).redisAll, true);
  assert.equal(eventScope('workflow_dispatch', {}, []).redisAll, false);
  assert.equal(eventScope('pull_request', {}, ['frontend/src/style.css']).full, false);
});

function results(full) {
  return { scope: { result: 'success', outputs: { full: String(full), redis_all: 'false' } },
    ...Object.fromEntries(['frontend', 'backend', 'container-images', 'compose-e2e'].map(name => [name, { result: 'success' }])),
    ...Object.fromEntries(['redis-session', 'performance'].map(name => [name, { result: full ? 'success' : 'skipped' }])) };
}

test('quality gate cannot turn required, cancelled or skipped verification into success', () => {
  for (const full of [true, false]) {
    assert.doesNotThrow(() => verifyResults(results(full)));
    for (const name of ['scope', 'frontend', 'backend', 'container-images', 'compose-e2e', ...(full ? ['redis-session', 'performance'] : [])]) {
      for (const state of ['failure', 'cancelled', 'skipped']) {
        const changed = results(full); changed[name].result = state;
        assert.throws(() => verifyResults(changed), undefined, `${full}/${name}/${state}`);
      }
    }
  }
  const missing = results(false); delete missing.scope.outputs.full;
  assert.throws(() => verifyResults(missing));
  const unexpected = results(false); unexpected['redis-session'].result = 'failure';
  assert.throws(() => verifyResults(unexpected));
  const release = results(false); release.scope.outputs.redis_all = 'true';
  assert.throws(() => verifyResults(release));
});

test('real Git history retains protected rename sources and missing history requires full verification', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gather-ci-scope-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '--quiet');
    mkdirSync(join(directory, 'frontend/src'), { recursive: true });
    writeFileSync(join(directory, 'frontend/src/auth.ts'), 'protected authentication transport\n');
    git('add', '.'); git('-c', 'user.name=CI test', '-c', 'user.email=ci@localhost', 'commit', '--quiet', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    renameSync(join(directory, 'frontend/src/auth.ts'), join(directory, 'frontend/src/ordinary.ts'));
    git('add', '.'); git('-c', 'user.name=CI test', '-c', 'user.email=ci@localhost', 'commit', '--quiet', '-m', 'rename');
    const head = git('rev-parse', 'HEAD');
    assert.deepEqual(readChanges(base, head, directory).sort(), ['frontend/src/auth.ts', 'frontend/src/ordinary.ts']);
    assert.equal(classifyChanges(readChanges(base, head, directory)).full, true);
    assert.equal(classifyChanges(readChanges('f'.repeat(40), head, directory)).full, true);
    assert.equal(classifyChanges(readChanges('0'.repeat(40), head, directory)).full, true);
  } finally {
    assert.equal(dirname(realpathSync(directory)), realpathSync(tmpdir()));
    assert(basename(directory).startsWith('gather-ci-scope-'));
    rmSync(directory, { recursive: true, force: true });
  }
});
