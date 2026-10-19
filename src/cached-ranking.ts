import type { CacheDb } from './cache.js';
import { priceScanKey } from './price-coverage.js';
import { getCachedOrFetchProfile, profileIsFresh } from './fmp-profile.js';
import { rankStocks } from './rank.js';
import { isExplicitNonStockInstrument } from './asset-filter.js';

export async function rankCachedPrices(
  cache: CacheDb, key: string,
  settings: { startDate: string; endDate: string; minimumMarketCap: number; countPerDirection: number; maxNewRequests: number },
  fetchImpl: typeof fetch = fetch,
  onProgress?: (checked: number, newRequests: number) => void,
) {
  if (!Number.isInteger(settings.maxNewRequests) || settings.maxNewRequests < 0 || settings.maxNewRequests > 200) {
    throw new Error('Set a new-profile request limit between 0 and 200');
  }
  const assets = cache.getAssets();
  const symbols = assets.map(asset => asset.symbol);
  const runKey = priceScanKey(symbols, settings.startDate, settings.endDate);
  const completed = cache.completedPriceBatches(runKey);
  if (!symbols.length || Array.from({ length: Math.ceil(symbols.length / 100) }, (_, i) => i).some(i => !completed.has(i))) {
    throw new Error('A completed price scan for this asset list and date pair is required');
  }
  const bars = cache.getBarsForDates(settings.startDate, settings.endDate);
  const dates = new Map<string, Set<string>>();
  for (const bar of bars) {
    if (!dates.has(bar.symbol)) dates.set(bar.symbol, new Set());
    dates.get(bar.symbol)!.add(bar.date);
  }
  const allPriced = symbols.filter(symbol => dates.get(symbol)?.has(settings.startDate) && dates.get(symbol)?.has(settings.endDate));
  const excluded = new Set(assets.filter(isExplicitNonStockInstrument).map(asset => asset.symbol));
  const priced = allPriced.filter(symbol => !excluded.has(symbol));
  if (!priced.length) throw new Error('No assets have both required closes');
  const audit: { symbol: string; outcome: string; cacheHit: boolean; marketCap?: number | null }[] = [];
  let newRequests = 0;
  let cacheHits = 0;
  const result = await rankStocks(priced, bars, settings.startDate, settings.endDate,
    settings.minimumMarketCap, settings.countPerDirection, async symbol => {
      const now = new Date();
      const cached = cache.getProfile(symbol);
      const cacheHit = profileIsFresh(cached, now);
      if (!cacheHit && newRequests >= settings.maxNewRequests) {
        audit.push({ symbol, outcome: 'run_request_limit', cacheHit });
        return { status: 'budget_exhausted' };
      }
      const utcDate = now.toISOString().slice(0, 10);
      const before = cache.getFmpAttempts(utcDate);
      const profileResult = await getCachedOrFetchProfile(symbol, cache, key, fetchImpl, now);
      newRequests += cache.getFmpAttempts(utcDate) - before;
      if (cacheHit) cacheHits++;
      if (profileResult.status === 'available') {
        const p = profileResult.profile;
        const outcome = p.isEtf === true || p.isFund === true ? 'fund_or_etf'
          : p.country !== null && p.country !== 'US' ? 'non_us'
          : p.marketCap === null || p.isEtf === null || p.isFund === null || p.country === null ? 'missing_fields'
          : p.marketCap < settings.minimumMarketCap ? 'below_market_cap' : 'qualifies';
        audit.push({ symbol, outcome, cacheHit, marketCap: p.marketCap });
      } else {
        audit.push({ symbol, cacheHit, outcome: profileResult.status === 'unavailable'
          ? profileResult.reason ?? 'unavailable' : profileResult.status });
      }
      onProgress?.(audit.length, newRequests);
      return profileResult;
    });
  return {
    checkedAt: new Date().toISOString(), diagnostic: true, settings,
    profileBasis: 'Dated profile observations under 180 days old; refresh queued at 90 days. Not historical market caps for the price dates.',
    assetCount: symbols.length, pricedCount: allPriced.length,
    candidateCount: priced.length, excludedKnownInstruments: allPriced.length - priced.length,
    excludedForMissingPrices: symbols.length - allPriced.length,
    alpacaRequests: 0, newFmpRequests: newRequests, cacheHits,
    notificationEligible: false,
    result, profileAudit: audit,
  };
}
