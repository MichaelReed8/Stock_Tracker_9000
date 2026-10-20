import type { JobReport } from './profile-job.js';
import type { PriceJobReport } from './price-job.js';
import { collectionHealth } from './health.js';

export async function collectMarkets(options: {
  profiles: () => Promise<JobReport>; prices: () => Promise<PriceJobReport>;
}) {
  let profileError = false;
  let profiles: JobReport;
  try { profiles = await options.profiles(); }
  catch { profileError = true; profiles = { requests: 0, stopReason: 'profile_job_failed' }; }
  let prices: PriceJobReport;
  try { prices = await options.prices(); }
  catch { prices = { status: 'failed', reason: 'price_job_failed', committedBatches: 0 }; }
  const health = collectionHealth(profiles);
  return { profiles, prices, profileError,
    ...health,
    providerFailure: Math.max(health.providerFailure, Number(prices.status === 'failed')),
    priceHealthy: Number(['complete', 'not_ready', 'already_running'].includes(prices.status)) };
}
