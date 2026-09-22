import type { AlpacaClient, PriceBar } from './alpaca.js';
import type { CacheDb } from './cache.js';
import { getCachedOrFetchProfile } from './fmp-profile.js';
import { rankStocks, type RankResult } from './rank.js';
import { isExplicitNonStockInstrument } from './asset-filter.js';

export type ScanResult = (RankResult | {
  status: 'incomplete'; reason: 'alpaca_unavailable'; checkedProfiles: 0;
}) & { assetCount: number; pricedCount: number };

// This is a single-process job. Callers send notifications only for status=complete.
// The date pair must be chosen from the intended completed trading sessions.
export async function scanStockUniverse(
  alpaca: AlpacaClient, cache: CacheDb, fmpKey: string,
  startDate: string, endDate: string, minimumMarketCap: number, countPerDirection: number,
  selectedIndustries?: ReadonlySet<string>,
): Promise<ScanResult> {
  const assets = cache.getAssets().filter(asset => !isExplicitNonStockInstrument(asset));
  if (!assets.length) return { status: 'incomplete', reason: 'missing_prices',
    checkedProfiles: 0, assetCount: 0, pricedCount: 0 };
  const bars: PriceBar[] = [];
  for (let offset = 0; offset < assets.length; offset += 100) {
    const batch = assets.slice(offset, offset + 100).map(asset => asset.symbol);
    // A failed batch aborts the scan; no notification is eligible for sending.
    try {
      const fetched = await alpaca.dailyBars(batch, startDate, endDate);
      await cache.putBars(fetched);
      bars.push(...fetched);
    } catch {
      return { status: 'incomplete', reason: 'alpaca_unavailable', checkedProfiles: 0,
        assetCount: assets.length, pricedCount: 0 };
    }
  }
  const datesBySymbol = new Map<string, Set<string>>();
  for (const bar of bars) {
    if (!datesBySymbol.has(bar.symbol)) datesBySymbol.set(bar.symbol, new Set());
    datesBySymbol.get(bar.symbol)!.add(bar.date);
  }
  const priced = assets.map(asset => asset.symbol).filter(symbol =>
    datesBySymbol.get(symbol)?.has(startDate) && datesBySymbol.get(symbol)?.has(endDate));
  if (!priced.length) return { status: 'incomplete', reason: 'missing_prices',
    checkedProfiles: 0, assetCount: assets.length, pricedCount: 0 };
  const result = await rankStocks(priced, bars, startDate, endDate,
    minimumMarketCap, countPerDirection,
    symbol => getCachedOrFetchProfile(symbol, cache, fmpKey), selectedIndustries);
  return { ...result, assetCount: assets.length, pricedCount: priced.length };
}
