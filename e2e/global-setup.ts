import type { FullConfig } from '@playwright/test';
import { initializeRun } from '../scripts/e2e-cleanup.mjs';

export default async function globalSetup(config: FullConfig) {
  // The run manifest is shared by workers, so fixture writes deliberately stay serial.
  if (config.workers !== 1) throw new Error('Gather E2E fixture tracking requires workers: 1.');
  await initializeRun(config.projects[0].use.baseURL!);
}
