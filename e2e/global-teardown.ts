import { cleanupRun } from '../scripts/e2e-cleanup.mjs';

export default async function globalTeardown() {
  if (!process.env.E2E_RUN_MANIFEST) throw new Error('E2E fixture manifest is missing; cleanup could not be verified.');
  // Throwing makes a failed cleanup fail the run, including after test assertion failures.
  await cleanupRun(process.env.E2E_RUN_MANIFEST);
}
