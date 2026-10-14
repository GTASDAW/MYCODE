import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolatedSettings, verifyDeclaredSettings, verifyOwnedRateOperation } from './auth-rate-limit-check.mjs';

const environment = {
  AUTH_RATE_LIMIT_TEST_MODE: 'redis', COMPOSE_PROJECT_NAME: 'gather-redis-ci',
  E2E_DB_HOST: '127.0.0.1', E2E_DB_PORT: '33306', E2E_DB_NAME: 'activity_platform_e2e',
  E2E_DB_USERNAME: 'activity', E2E_DB_PASSWORD: 'sample-ci-only', REDIS_PASSWORD: 'sample-ci-only',
};

function declaration(settings) {
  const common = {
    DB_URL: 'jdbc:mysql://mysql:3306/activity_platform_e2e?characterEncoding=UTF-8',
    DB_USERNAME: 'activity', DB_PASSWORD: environment.E2E_DB_PASSWORD,
    AUTH_RATE_LIMIT_LOGIN_SOURCE_LIMIT: '10000', AUTH_RATE_LIMIT_LOGIN_PAIR_LIMIT: '1000',
    AUTH_RATE_LIMIT_REGISTER_SOURCE_LIMIT: '10000', AUTH_RATE_LIMIT_LOGIN_SOURCE_WINDOW_SECONDS: '60',
    AUTH_RATE_LIMIT_LOGIN_PAIR_WINDOW_SECONDS: '60', AUTH_RATE_LIMIT_REGISTER_SOURCE_WINDOW_SECONDS: '600',
    AUTH_RATE_LIMIT_MAX_BUCKETS: '10000', AUTH_RATE_LIMIT_NAMESPACE: 'gather:auth-rate-limit-ci', AUTH_RATE_LIMIT_TRUSTED_PROXY_IPS: '',
    ...(settings.redis ? { SPRING_PROFILES_ACTIVE: 'redis', REDIS_HOST: 'redis', REDIS_PORT: '6379',
      REDIS_PASSWORD: environment.REDIS_PASSWORD, SESSION_TIMEOUT: '30m', SESSION_NAMESPACE: 'gather:session' } : {}),
  };
  return { name: settings.project, services: {
    mysql: { environment: { MYSQL_DATABASE: 'activity_platform_e2e', MYSQL_USER: 'activity', MYSQL_PASSWORD: environment.E2E_DB_PASSWORD } },
    backend: { environment: { ...common } },
    ...(settings.redis ? { backend2: { environment: { ...common } }, redis: { environment: { REDIS_PASSWORD: environment.REDIS_PASSWORD } } } : {}),
  } };
}

test('strict auth checks select exact memory or two distinct Redis loopback endpoints', () => {
  const redis = isolatedSettings(environment);
  assert.deepEqual(redis.endpoints.map(url => url.origin), ['http://127.0.0.1:19081', 'http://127.0.0.1:19082']);
  assert.equal(redis.web.origin, 'http://127.0.0.1:19088');
  const memory = isolatedSettings({ ...environment, AUTH_RATE_LIMIT_TEST_MODE: 'memory', COMPOSE_PROJECT_NAME: 'gather-ci' });
  assert.equal(memory.web.origin, 'http://127.0.0.1:18088');
  assert.equal(memory.endpoints.length, 1);
  for (const settings of [redis, memory]) verifyDeclaredSettings(settings, declaration(settings), environment);
});

test('strict auth checks refuse unknown/shared projects, databases, ports and forwarded credential-bearing URLs before mutation', () => {
  for (const override of [
    { AUTH_RATE_LIMIT_TEST_MODE: 'disabled' }, { COMPOSE_PROJECT_NAME: 'gather' }, { COMPOSE_PROJECT_NAME: 'gather-ci' },
    { E2E_DB_NAME: 'activity_platform' }, { E2E_DB_PORT: '3306' }, { E2E_DB_HOST: 'localhost' }, { E2E_DB_USERNAME: 'root' },
    { E2E_BASE_URL: 'http://localhost:19088' }, { E2E_BASE_URL: 'http://127.0.0.1:19088/activities' },
    { REDIS_TEST_A_URL: 'http://user:secret@127.0.0.1:19081' }, { REDIS_TEST_B_URL: 'https://127.0.0.1:19082' },
    { REDIS_TEST_A_URL: 'http://remote.example:19081' }, { E2E_DB_PASSWORD: undefined }, { REDIS_PASSWORD: undefined },
    { SESSION_TIMEOUT: '3s' }, { SESSION_NAMESPACE: 'shared' }, { SESSION_COOKIE_SECURE: 'true' },
  ]) assert.throws(() => isolatedSettings({ ...environment, ...override }));
});

test('strict auth declarations refuse identity, profile, proxy and mismatched dual-instance limits without exposing secrets', () => {
  const settings = isolatedSettings(environment);
  const changes = [
    declared => { declared.name = 'shared'; },
    declared => { declared.services.backend.environment.DB_URL = 'jdbc:mysql://shared/production?'; },
    declared => { declared.services.backend.environment.DB_PASSWORD = 'changed-private-value'; },
    declared => { declared.services.backend2.environment.SPRING_PROFILES_ACTIVE = ''; },
    declared => { declared.services.backend2.environment.AUTH_RATE_LIMIT_LOGIN_PAIR_LIMIT = '3'; },
    declared => { declared.services.backend.environment.AUTH_RATE_LIMIT_TRUSTED_PROXY_IPS = '127.0.0.1'; },
    declared => { declared.services.backend2.environment.AUTH_RATE_LIMIT_NAMESPACE = 'shared'; },
    declared => { declared.services.backend.environment.SESSION_TIMEOUT = '3s'; },
    declared => { declared.services.redis.environment.REDIS_PASSWORD = 'changed-private-value'; },
  ];
  for (const change of changes) {
    const declared = declaration(settings);
    change(declared);
    assert.throws(() => verifyDeclaredSettings(settings, declared, environment), thrown => {
      assert(!thrown.message.includes('changed-private-value') && !thrown.message.includes('sample-ci-only'));
      return true;
    });
  }
});

test('strict auth settings accept only the declared dedicated stage and keep Session settings independent', () => {
  const settings = isolatedSettings(environment);
  const strict = { ...environment, AUTH_RATE_LIMIT_LOGIN_SOURCE_LIMIT: '6', AUTH_RATE_LIMIT_LOGIN_PAIR_LIMIT: '3',
    AUTH_RATE_LIMIT_REGISTER_SOURCE_LIMIT: '2', AUTH_RATE_LIMIT_LOGIN_SOURCE_WINDOW_SECONDS: '8',
    AUTH_RATE_LIMIT_LOGIN_PAIR_WINDOW_SECONDS: '8', AUTH_RATE_LIMIT_REGISTER_SOURCE_WINDOW_SECONDS: '8',
    AUTH_RATE_LIMIT_NAMESPACE: 'gather:auth-rate-limit-ci-own-window' };
  const declared = declaration(settings);
  for (const service of ['backend', 'backend2']) for (const [key, value] of Object.entries(strict)) {
    if (key.startsWith('AUTH_RATE_LIMIT_') && key !== 'AUTH_RATE_LIMIT_TEST_MODE') declared.services[service].environment[key] = value;
  }
  verifyDeclaredSettings(settings, declared, strict);
  assert.equal(declared.services.backend.environment.SESSION_TIMEOUT, '30m');
});

test('controlled Redis damage can delete only its exact UUID expiry index and cannot read values or touch Session keys', () => {
  const namespace = 'gather:auth-rate-limit-ci-72eeb604-2adb-448e-8331-2bfd87592520';
  const prefix = `${namespace}:{auth-rate-limit}:`;
  verifyOwnedRateOperation(namespace, 'EXISTS', `${prefix}counts`);
  verifyOwnedRateOperation(namespace, 'EXISTS', `${prefix}expires`);
  verifyOwnedRateOperation(namespace, 'DEL', `${prefix}expires`);
  for (const [name, command, key] of [
    [namespace, 'DEL', `${prefix}counts`], [namespace, 'DEL', 'gather:session:sessions:example'],
    [namespace, 'GET', `${prefix}counts`], [namespace, 'FLUSHDB', `${prefix}expires`],
    [namespace, 'EXISTS', `${prefix}expires:other`], ['gather:auth-rate-limit', 'DEL', `${prefix}expires`],
    [namespace, 'DEL', 'gather:auth-rate-limit-ci-other:{auth-rate-limit}:expires'],
  ]) assert.throws(() => verifyOwnedRateOperation(name, command, key));
});
