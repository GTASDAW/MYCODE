import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const highRisk = [
  /^\.github\//, /^compose[^/]*\.ya?ml$/, /(^|\/)Dockerfile(?:\..*)?$/,
  /^playwright[^/]*\./, /^scripts\//, /^e2e\//,
  /(^|\/)(?:package(?:-lock)?\.json|pom\.xml|mvnw(?:\.cmd)?|\.env[^/]*|\.gitignore)$/,
  /^backend\/\.mvn\//, /^backend\/src\/main\/resources\//,
  /^backend\/src\/main\/java\/.*\/(?:security|config|mapper)\//,
  /^backend\/src\/(?:main|test)\/java\/.*\/(?:Auth\w*|Account\w*|Password\w*|Profile\w*|RegistrationService|ActivityService|DataInitializer)\.java$/,
  /^frontend\/src\/(?:api|auth[^/]*|.*[Rr]equest[Gg]uard|main|Layout|PageContentBoundary|pageBoundaryPolicy)\.[^/]+$/,
  /^frontend\/src\/pages\/(?:AccessPages|LoginPage|RegisterPage|ProfilePage|authNavigation)\.[^/]+$/,
  /^frontend\/(?:vite|tsconfig)[^/]*\./,
];

export function classifyChanges(files) {
  if (!Array.isArray(files) || !files.length) return { full: true, reason: 'No reliable change set' };
  for (const file of files) {
    if (typeof file !== 'string' || !file || /[\x00-\x1f]/.test(file) || file.includes('\\') || file.startsWith('/') || file.split('/').includes('..'))
      return { full: true, reason: 'Unrecognized path' };
    if (highRisk.some(pattern => pattern.test(file))) return { full: true, reason: 'Security, data, infrastructure or test contract changed' };
    if (!/^(?:frontend\/src\/|frontend\/tests\/|backend\/src\/(?:main\/java\/|test\/java\/)|docs\/)/.test(file)
      && !/^(?:README|AGENTS)\.md$/.test(file)) return { full: true, reason: 'Unknown change requires full verification' };
  }
  return { full: false, reason: 'Ordinary application change' };
}

export function eventScope(eventName, event, changedFiles) {
  const redisAll = event.ref?.startsWith('refs/tags/') === true
    || (eventName === 'workflow_dispatch' && [true, 'true'].includes(event.inputs?.redis_all_e2e));
  if (eventName === 'workflow_dispatch' || eventName === 'schedule' || event.ref?.startsWith('refs/tags/'))
    return { full: true, redisAll, reason: 'Manual, scheduled or release-tag verification' };
  if (!['push', 'pull_request'].includes(eventName)) return { full: true, redisAll, reason: 'Unknown event' };
  return { ...classifyChanges(changedFiles), redisAll };
}

export function verifyResults(needs) {
  assert.equal(needs.scope?.result, 'success', 'Scope classification must succeed');
  const full = needs.scope.outputs.full;
  assert(['true', 'false'].includes(full), 'Scope must explicitly select fast or full');
  assert(['true', 'false'].includes(needs.scope.outputs.redis_all), 'Redis scope must be explicit');
  assert(full === 'true' || needs.scope.outputs.redis_all === 'false', 'Release verification must run full CI');
  for (const name of ['frontend', 'backend', 'container-images', 'compose-e2e'])
    assert.equal(needs[name]?.result, 'success', `${name} must succeed`);
  for (const name of ['redis-session', 'performance'])
    assert.equal(needs[name]?.result, full === 'true' ? 'success' : 'skipped', `${name} must match the selected gate`);
}

export function readChanges(base, head, cwd = process.cwd()) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || /^0+$/.test(base) || !/^[a-f0-9]{40}$/.test(head ?? '')) return [];
  try {
    // A rename out of a protected directory must still include its deleted source path.
    return execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, head, '--'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch { return []; }
}

function main() {
  if (process.argv[2] === 'verify') {
    verifyResults(JSON.parse(process.env.CI_JOB_RESULTS));
    console.log('Selected CI quality gate passed.');
    return;
  }
  const eventName = process.env.GITHUB_EVENT_NAME;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  let files = [];
  const base = eventName === 'pull_request' ? event.pull_request?.base?.sha : event.before;
  const head = process.env.GITHUB_SHA;
  if (['push', 'pull_request'].includes(eventName)) files = readChanges(base, head);
  const scope = eventScope(eventName, event, files);
  appendFileSync(process.env.GITHUB_OUTPUT, `full=${scope.full}\nredis_all=${scope.redisAll}\n`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `CI mode: **${scope.full ? 'full' : 'fast'}**. Redis browsers: **${scope.redisAll ? 'all' : 'focused'}**. ${scope.reason}. Changed paths: ${files.length}.\n`);
  console.log(JSON.stringify({ ...scope, changedPaths: files.length }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
