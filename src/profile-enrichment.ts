import { setTimeout as delay } from 'node:timers/promises';
import type { CacheDb } from './cache.js';
import { getCachedOrFetchProfile, profileIsFresh } from './fmp-profile.js';
import { isExplicitNonStockInstrument } from './asset-filter.js';

export async function enrichProfiles(cache: CacheDb, key: string,
  options: { dailyLimit: number; dryRun?: boolean; spacingMs?: number },
  fetchImpl: typeof fetch = fetch,
  onProgress?: (requests: number, saved: number) => void,
) {
  if (!Number.isInteger(options.dailyLimit) || options.dailyLimit < 0 || options.dailyLimit > 250) {
    throw new Error('Daily limit must be between 0 and 250');
  }
  const startedAt = new Date().toISOString();
  const utcDate = startedAt.slice(0, 10);
  const assets = cache.getAssets();
  const candidates = assets.filter(asset => !isExplicitNonStockInstrument(asset));
  // Missing profiles first, so repeated daily runs grow coverage before refreshing old entries.
  const missing = candidates.filter(asset => !cache.getProfile(asset.symbol));
  const stale = candidates.filter(asset => {
    const profile = cache.getProfile(asset.symbol);
    return profile && !profileIsFresh(profile);
  });
  const pending = [...missing, ...stale].filter(asset => !cache.enrichmentAttempted(asset.symbol, utcDate));
  const attemptsBefore = cache.getFmpAttempts(utcDate);
  const audit: { symbol: string; outcome: string }[] = [];
  let saved = 0;
  let stopReason = options.dryRun ? 'dry_run' : 'queue_complete';
  if (!options.dryRun) for (const asset of pending) {
    if (new Date().toISOString().slice(0, 10) !== utcDate) { stopReason = 'utc_day_changed'; break; }
    if (cache.getFmpAttempts(utcDate) >= options.dailyLimit) { stopReason = 'local_daily_limit'; break; }
    if (audit.length) await delay(options.spacingMs ?? 1000);
    const result = await getCachedOrFetchProfile(asset.symbol, cache, key, fetchImpl, new Date(), options.dailyLimit);
    const outcome = result.status === 'unavailable' ? result.reason ?? 'unavailable' : result.status;
    await cache.recordEnrichmentAttempt(asset.symbol, utcDate, outcome);
    audit.push({ symbol: asset.symbol, outcome });
    if (result.status === 'available') saved++;
    onProgress?.(cache.getFmpAttempts(utcDate) - attemptsBefore, saved);
    if (['rate_limited', 'missing_key', 'unauthorized', 'forbidden', 'api_error_payload', 'request_failed', 'http_error', 'budget_exhausted'].includes(outcome)) {
      stopReason = outcome; break;
    }
    // HTTP 402 can affect consecutive preferred-share listings; skip them without retrying.
  }
  return { startedAt, finishedAt: new Date().toISOString(), utcDate, stopReason,
    dailyTrackedLimit: options.dailyLimit, trackedAttemptsBefore: attemptsBefore,
    trackedAttemptsAfter: cache.getFmpAttempts(utcDate),
    newRequests: cache.getFmpAttempts(utcDate) - attemptsBefore, savedProfiles: saved,
    totalAssets: assets.length, excludedKnownInstruments: assets.length - candidates.length,
    candidateCount: candidates.length, pendingBefore: pending.length,
    cachedCandidateProfiles: candidates.filter(asset => cache.getProfile(asset.symbol)).length,
    candidatesWithoutProfiles: candidates.filter(asset => !cache.getProfile(asset.symbol)).length,
    alpacaRequests: 0, audit };
}
