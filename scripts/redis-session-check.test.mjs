import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolatedSettings } from './redis-session-check.mjs';

const isolatedEnvironment = {
  COMPOSE_PROJECT_NAME: 'gather-redis-ci',
  E2E_DB_HOST: '127.0.0.1', E2E_DB_PORT: '33306', E2E_DB_NAME: 'activity_platform_e2e',
  E2E_DB_USERNAME: 'activity', E2E_DB_PASSWORD: 'sample-ci-only', REDIS_PASSWORD: 'sample-ci-only',
};

test('Redis lifecycle defaults target three distinct isolated loopback endpoints', () => {
  const settings = isolatedSettings(isolatedEnvironment);
  assert.equal(settings.web.origin, 'http://127.0.0.1:19088');
  assert.equal(settings.a.origin, 'http://127.0.0.1:19081');
  assert.equal(settings.b.origin, 'http://127.0.0.1:19082');
  assert.equal(settings.database.database, 'activity_platform_e2e');
});

test('Redis lifecycle rejects other projects/databases and remote or credential-bearing endpoints', () => {
  for (const override of [
    { COMPOSE_PROJECT_NAME: 'gather-ci' },
    { E2E_DB_NAME: 'activity_platform' },
    { E2E_DB_HOST: 'database.example.com' },
    { REDIS_TEST_A_URL: 'http://example.com:19081' },
    { REDIS_TEST_A_URL: 'http://user:secret@127.0.0.1:19081' },
    { REDIS_TEST_A_URL: 'https://127.0.0.1:19081' },
    { REDIS_TEST_A_URL: 'http://127.0.0.1:19088' },
  ]) assert.throws(() => isolatedSettings({ ...isolatedEnvironment, ...override }));
});

test('Redis lifecycle requires normal timeout/namespace and explicit isolated passwords', () => {
  for (const override of [
    { SESSION_TIMEOUT: '3s' }, { SESSION_NAMESPACE: 'other:session' },
    { SESSION_COOKIE_SECURE: 'true' },
    { E2E_DB_PASSWORD: undefined }, { REDIS_PASSWORD: undefined },
  ]) assert.throws(() => isolatedSettings({ ...isolatedEnvironment, ...override }));
});
