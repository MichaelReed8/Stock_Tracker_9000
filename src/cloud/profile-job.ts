import type { AlpacaAsset } from '../alpaca.js';
import type { CompanyProfile } from '../cache.js';
import { isExplicitNonStockInstrument } from '../asset-filter.js';
import { fetchProfile } from '../fmp-profile.js';
import { profileNeedsRefresh } from '../profile-policy.js';

export type ProfileEntry = { symbol: string; profile?: CompanyProfile; retryAfter?: string };
export interface ProfileJobStore {
  acquire(owner: string, now: Date): Promise<boolean>;
  release(owner: string): Promise<void>;
  loadAssets(): Promise<{ observedAt: string; assets: AlpacaAsset[] } | null>;
  saveAssets(assets: AlpacaAsset[], now: Date): Promise<void>;
  entries(): Promise<ProfileEntry[]>;
  reserve(symbol: string, now: Date, dailyLimit: number): Promise<boolean>;
  budgetAvailable(day: string, dailyLimit: number): Promise<boolean>;
  save(entry: ProfileEntry): Promise<void>;
  blockDay(day: string): Promise<void>;
  report(owner: string, report: Record<string, unknown>): Promise<void>;
}

// Four missing profiles then one refresh, so growing coverage cannot starve refreshes.
export function profileQueue(assets: AlpacaAsset[], entries: ProfileEntry[], now: Date): ProfileEntry[] {
  const bySymbol = new Map(entries.map(entry => [entry.symbol, entry]));
  const missing: ProfileEntry[] = [], refresh: ProfileEntry[] = [];
  for (const asset of [...assets].sort((a, b) => a.symbol.localeCompare(b.symbol))) {
    if (isExplicitNonStockInstrument(asset)) continue;
    const entry = bySymbol.get(asset.symbol) ?? { symbol: asset.symbol };
    if (entry.retryAfter && entry.retryAfter > now.toISOString()) continue;
    if (!entry.profile) missing.push(entry);
    else if (profileNeedsRefresh(entry.profile, now)) refresh.push(entry);
  }
  refresh.sort((a, b) => a.profile!.fetchedAt.localeCompare(b.profile!.fetchedAt));
  const queue: ProfileEntry[] = [];
  let m = 0, r = 0;
  while (m < missing.length || r < refresh.length) {
    for (let i = 0; i < 4 && m < missing.length; i++) queue.push(missing[m++]);
    if (r < refresh.length) queue.push(refresh[r++]);
  }
  return queue;
}

export async function runProfileJob(store: ProfileJobStore, options: {
  owner: string; key: string; dailyLimit: number; batchLimit: number;
  assets: () => Promise<AlpacaAsset[]>; remainingMs: () => number;
  now?: () => Date; fetchImpl?: typeof fetch; pause?: () => Promise<void>;
}): Promise<{ status?: string; requests: number; stopReason: string; savedProfiles?: number }> {
  if (!Number.isInteger(options.dailyLimit) || options.dailyLimit < 0 || options.dailyLimit > 200 ||
    !Number.isInteger(options.batchLimit) || options.batchLimit < 1 || options.batchLimit > 100) {
    throw new Error('Invalid worker limits');
  }
  if (!options.key) throw new Error('Missing provider configuration');
  const now = options.now ?? (() => new Date());
  const started = now();
  const day = started.toISOString().slice(0, 10);
  if (!await store.acquire(options.owner, started)) return { status: 'already_running', stopReason: 'already_running', requests: 0 };
  let requests = 0, saved = 0, denied = 0, pending = 0;
  let stopReason = 'queue_complete';
  try {
    if (!await store.budgetAvailable(day, options.dailyLimit)) {
      const report = { startedAt: started.toISOString(), stopReason: 'daily_budget_or_provider_pause', requests: 0 };
      await store.report(options.owner, report);
      return report;
    }
    let universe = await store.loadAssets();
    if (!universe || Date.parse(universe.observedAt) < started.getTime() - 86_400_000) {
      const assets = await options.assets();
      if (!assets.length) throw new Error('Empty asset universe');
      await store.saveAssets(assets, started);
      universe = { observedAt: started.toISOString(), assets };
    }
    const queue = profileQueue(universe.assets, await store.entries(), started);
    pending = queue.length;
    for (const entry of queue) {
      const current = now();
      if (current.toISOString().slice(0, 10) !== day) { stopReason = 'utc_day_changed'; break; }
      if (options.remainingMs() < 45_000) { stopReason = 'time_budget'; break; }
      if (requests >= options.batchLimit) { stopReason = 'batch_limit'; break; }
      if (!await store.reserve(entry.symbol, current, options.dailyLimit)) {
        if (!await store.budgetAvailable(day, options.dailyLimit)) { stopReason = 'daily_budget_or_provider_pause'; break; }
        continue;
      }
      requests++;
      const result = await fetchProfile(entry.symbol, options.key, options.fetchImpl, current);
      if (result.status === 'available') {
        await store.save({ symbol: entry.symbol, profile: result.profile });
        saved++;
      } else {
        const reason = result.status === 'unavailable' ? result.reason : result.status;
        if (reason === 'access_denied') denied++;
        // Preserve the last good observation when a refresh fails.
        const symbolFailure = reason === 'access_denied' || reason === 'invalid_payload' || reason === 'invalid_symbol';
        const retryAfter = symbolFailure
          ? new Date(current.getTime() + (reason === 'access_denied' ? 30 : 7) * 86_400_000)
          : new Date(`${day}T00:00:00Z`);
        if (!symbolFailure) retryAfter.setUTCDate(retryAfter.getUTCDate() + 1);
        await store.save({ ...entry, retryAfter: retryAfter.toISOString() });
        if (!symbolFailure) {
          await store.blockDay(day);
          stopReason = reason ?? 'provider_unavailable';
          break;
        }
      }
      if (options.pause) await options.pause();
    }
    if (pending && requests === 0 && stopReason === 'queue_complete') stopReason = 'no_reservations_available';
    const report = { startedAt: started.toISOString(), finishedAt: now().toISOString(),
      stopReason, pendingAtStart: pending, requests, savedProfiles: saved, accessDenied: denied,
      dailyLimit: options.dailyLimit, batchLimit: options.batchLimit, notificationEligible: false };
    await store.report(options.owner, report);
    return report;
  } finally { await store.release(options.owner); }
}
