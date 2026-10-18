import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const workflow = read('.github/workflows/ci.yml');
const jobs = new Map([...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\r?\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\r?$|(?![\s\S]))/gm)]
  .map(([, name, body]) => [name, body]));

test('builds each production Dockerfile once with independent cache scopes and revision tags', () => {
  const build = jobs.get('container-images');
  assert(build);
  assert.match(build, /image: backend\s+context: backend/);
  assert.match(build, /image: web\s+context: frontend/);
  assert.equal((workflow.match(/uses: docker\/build-push-action@/g) ?? []).length, 1);
  assert.match(build, /platforms: linux\/amd64/);
  assert.match(build, /tags: gather-ci-\$\{\{ matrix\.image \}\}:\$\{\{ github\.sha \}\}/);
  assert.match(build, /labels: org\.opencontainers\.image\.revision=\$\{\{ github\.sha \}\}/);
  assert.match(build, /cache-from: type=gha,version=2,scope=gather-\$\{\{ matrix\.image \}\}/);
  assert.match(build, /cache-to: type=gha,version=2,scope=gather-\$\{\{ matrix\.image \}\},mode=max/);
  assert.match(build, /image=moby\/buildkit:v[\d.]+@sha256:[0-9a-f]{64}/);
  for (const action of workflow.matchAll(/uses: ([^\s]+)/g)) {
    assert.match(action[1], /@[0-9a-f]{40}$/, 'All external actions must remain pinned to a full commit.');
  }
});

test('transfers only same-run image artifacts without including image archives in diagnostics', () => {
  const build = jobs.get('container-images');
  assert.match(build, /name: gather-ci-image-\$\{\{ matrix\.image \}\}/);
  assert.match(build, /path: \$\{\{ runner\.temp \}\}\/\$\{\{ matrix\.image \}\}\.tar/);
  assert.match(build, /compression-level: 0/);
  assert.match(build, /retention-days: 1/);
  assert.match(build, /if-no-files-found: error/);
  for (const name of ['compose-e2e', 'redis-session', 'performance']) {
    const job = jobs.get(name);
    assert.match(job, /pattern: gather-ci-image-\*/);
    assert.match(job, /path: \$\{\{ runner\.temp \}\}\/gather-ci-images/);
    assert.match(job, /merge-multiple: true/);
    assert.doesNotMatch(job, /run-id:|github-token:|repository:/);
    for (const image of ['backend', 'web']) {
      assert.match(job, new RegExp(`docker load --input "\\$RUNNER_TEMP/gather-ci-images/${image}\\.tar"`));
    }
    assert.match(job, /org\.opencontainers\.image\.revision/);
    assert.match(job, /= "\$GITHUB_SHA"/);
    assert.match(job, /docker image inspect --format '\{\{\.RepoTags\}\} \{\{\.Id\}\}'/);
    assert.doesNotMatch(job.slice(job.indexOf('uses: actions/upload-artifact@')), /gather-ci-images/);
  }
});

test('keeps both test prerequisites and isolated runtime gates while disabling rebuilds', () => {
  const commands = {
    'compose-e2e': ['node scripts/compose-smoke.mjs', 'npm run test:e2e', 'npm run test:loading', 'AUTH_RATE_LIMIT_TEST_MODE=memory'],
    'redis-session': ['node scripts/redis-session-check.mjs', 'npm run test:e2e', 'npm run test:loading', 'AUTH_RATE_LIMIT_TEST_MODE=redis'],
    performance: ['npm run test:performance-safety', 'npm run check:performance'],
  };
  for (const [name, required] of Object.entries(commands)) {
    const job = jobs.get(name);
    assert.match(job, /needs: \[frontend, backend, container-images\]/);
    assert.match(job, /CI_BACKEND_IMAGE: gather-ci-backend:\$\{\{ github\.sha \}\}/);
    assert.match(job, /CI_WEB_IMAGE: gather-ci-web:\$\{\{ github\.sha \}\}/);
    assert.match(job, /up --no-build -d --wait --wait-timeout 180/);
    assert.doesNotMatch(job, /up --build/);
    for (const command of required) assert(job.includes(command), `${name} must retain ${command}.`);
    assert.match(job, /if: always\(\)[\s\S]*logs --no-color/);
    assert.match(job, /if: always\(\)\s+run: docker compose [^\r\n]+ down --volumes --remove-orphans/);
  }
  assert.match(jobs.get('backend'), /sh \.\/mvnw -B verify/);
  assert.match(jobs.get('frontend'), /npm test --prefix frontend/);
  assert.match(read('playwright.config.ts'), /workers: 1/);
});

test('CI overlays share the backend image between Redis replicas and retain local build fallbacks', () => {
  const base = read('compose.yaml');
  const redis = read('compose.redis.yaml');
  const ci = read('.github/compose.ci.yaml');
  const redisCi = read('.github/compose.redis-ci.yaml');
  assert.match(base, /build: \.\/backend/);
  assert.match(base, /build: \.\/frontend/);
  assert.match(redis, /build: \.\/backend/);
  assert.doesNotMatch(base + redis, /CI_BACKEND_IMAGE|CI_WEB_IMAGE/);
  assert.match(ci, /image: \$\{CI_BACKEND_IMAGE:-\$\{COMPOSE_PROJECT_NAME:-gather-ci\}-backend\}/);
  assert.match(ci, /image: \$\{CI_WEB_IMAGE:-\$\{COMPOSE_PROJECT_NAME:-gather-ci\}-web\}/);
  assert.match(redisCi, /image: \$\{CI_BACKEND_IMAGE:-\$\{COMPOSE_PROJECT_NAME:-gather-redis-ci\}-backend2\}/);
});
