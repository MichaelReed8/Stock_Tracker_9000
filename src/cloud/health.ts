import type { JobReport } from './profile-job.js';

const temporaryFailures = new Set(['request_failed', 'server_error', 'provider_cooldown']);
const persistentFailures = new Set(['unauthorized', 'forbidden', 'missing_key', 'rate_limited',
  'http_error', 'api_error_payload', 'provider_unavailable', 'provider_paused']);

export function collectionHealth(report: JobReport) {
  const providerFailure = temporaryFailures.has(report.stopReason) || persistentFailures.has(report.stopReason);
  const expectedIdle = report.stopReason === 'daily_budget_exhausted' || report.stopReason === 'already_running' ||
    (report.stopReason === 'queue_complete' && report.requests === 0);
  return {
    providerFailure: Number(providerFailure),
    permanentProviderFailure: Number(persistentFailures.has(report.stopReason)),
    progressHealthy: Number((report.savedProfiles ?? 0) > 0 || expectedIdle),
  };
}
