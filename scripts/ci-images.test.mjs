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
    'redis-session': ['node scripts/redis-session-check.mjs', 'npm run test:e2e:redis', 'npm run test:loading', 'AUTH_RATE_LIMIT_TEST_MODE=redis'],
    performance: ['npm run test:performance-safety', 'npm run check:performance'],
  };
  for (const [name, required] of Object.entries(commands)) {
    const job = jobs.get(name);
    assert.match(job, /needs: \[scope, frontend, backend, container-images\]/);
    assert.match(job, /CI_BACKEND_IMAGE: gather-ci-backend:\$\{\{ github\.sha \}\}/);
    assert.match(job, /CI_WEB_IMAGE: gather-ci-web:\$\{\{ github\.sha \}\}/);
    assert.match(job, /up --no-build -d --wait --wait-timeout 180/);
    assert.doesNotMatch(job, /up --build/);
    for (const command of required) {
      const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert(new RegExp(`${escaped}(?:\\s|$)`).test(job), `${name} must retain ${command}.`);
    }
    assert.match(job, /if: always\(\)[\s\S]*logs --no-color/);
    assert.match(job, /if: always\(\)\s+run: docker compose [^\r\n]+ down --volumes --remove-orphans/);
  }
  assert.match(jobs.get('backend'), /sh \.\/mvnw -B verify/);
  assert.match(jobs.get('frontend'), /npm test --prefix frontend/);
  assert.match(read('playwright.config.ts'), /workers: 1/);
});

test('fast and full gates preserve risk escalation, both devices, diagnostics and required results', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /redis_all_e2e:[\s\S]*type: boolean/);
  assert.match(workflow, /schedule:\s*\n[^\n]*\n\s*- cron: '0 18 \* \* \*'/);
  assert.match(jobs.get('scope'), /fetch-depth: 0/);
  assert.match(jobs.get('scope'), /node scripts\/ci-scope\.mjs/);
  for (const name of ['redis-session', 'performance'])
    assert.match(jobs.get(name), /if: needs\.scope\.outputs\.full == 'true'/);
  const compose = jobs.get('compose-e2e');
  assert.match(compose, /Run fast desktop and mobile smoke flows\s+if: needs\.scope\.outputs\.full != 'true'/);
  assert.match(compose, /npm run test:e2e:smoke/);
  assert.match(compose, /Run all desktop and mobile flows\s+if: needs\.scope\.outputs\.full == 'true'/);
  for (const name of ['Verify production route loading', 'Verify strict in-memory auth limits'])
    assert.match(compose, new RegExp(`${name}[^\\n]*\\n\\s+if: needs\\.scope\\.outputs\\.full == 'true'`));
  const gate = jobs.get('quality-gate');
  assert.match(jobs.get('redis-session'), /if: needs\.scope\.outputs\.redis_all == 'true'[\s\S]*npm run test:e2e /);
  assert.match(gate, /if: always\(\)/);
  assert.match(gate, /needs: \[scope, frontend, backend, container-images, compose-e2e, redis-session, performance\]/);
  assert.match(gate, /CI_JOB_RESULTS: \$\{\{ toJSON\(needs\) \}\}/);
  assert.match(gate, /node scripts\/ci-scope\.mjs verify/);
  assert.match(jobs.get('frontend'), /npm run check:e2e:types/);
  for (const device of ['desktop', 'mobile']) assert(read('playwright.config.ts').includes(`name: '${device}'`));
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
