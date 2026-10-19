import { percentChange, type PriceBar } from './alpaca.js';
import type { CompanyProfile } from './cache.js';
import type { ProfileResult } from './fmp-profile.js';

export type RankedStock = { symbol: string; changePercent: number; marketCap: number; industry: string | null;
  profileObservedAt: string };
export type RankResult =
  | { status: 'complete'; gainers: RankedStock[]; losers: RankedStock[]; checkedProfiles: number }
  | { status: 'incomplete'; reason: 'missing_prices' | 'profile_unavailable' | 'budget_exhausted'; checkedProfiles: number };

export async function rankStocks(
  symbols: string[], bars: PriceBar[], startDate: string, endDate: string,
  minimumMarketCap: number, countPerDirection: number,
  profileFor: (symbol: string) => Promise<ProfileResult>,
  selectedIndustries?: ReadonlySet<string>,
): Promise<RankResult> {
  if (minimumMarketCap < 0 || !Number.isFinite(minimumMarketCap) ||
    !Number.isInteger(countPerDirection) || countPerDirection < 1) throw new Error('Invalid ranking settings');
  const prices = new Map<string, Map<string, number>>();
  for (const bar of bars) {
    if (!prices.has(bar.symbol)) prices.set(bar.symbol, new Map());
    prices.get(bar.symbol)!.set(bar.date, bar.close);
  }
  const changes: { symbol: string; changePercent: number }[] = [];
  for (const symbol of new Set(symbols)) {
    const start = prices.get(symbol)?.get(startDate);
    const end = prices.get(symbol)?.get(endDate);
    if (start === undefined || end === undefined) {
      return { status: 'incomplete', reason: 'missing_prices', checkedProfiles: 0 };
    }
    changes.push({ symbol, changePercent: percentChange(start, end) });
  }
  changes.sort((a, b) => b.changePercent - a.changePercent);
  const gainers: RankedStock[] = [];
  const losers: RankedStock[] = [];
  const resolved = new Map<string, ProfileResult>();
  async function qualifies(candidate: { symbol: string; changePercent: number }): Promise<RankedStock | null | 'unavailable' | 'budget_exhausted'> {
    let result = resolved.get(candidate.symbol);
    if (!result) {
      result = await profileFor(candidate.symbol);
      resolved.set(candidate.symbol, result);
    }
    if (result.status !== 'available') return result.status;
    const p: CompanyProfile = result.profile;
    if (p.isEtf === true || p.isFund === true || (p.country !== null && p.country !== 'US')) return null;
    if (p.marketCap === null || p.isEtf === null || p.isFund === null || p.country === null) return 'unavailable';
    if (p.marketCap < minimumMarketCap) return null;
    if (selectedIndustries && !p.industry) return 'unavailable';
    if (selectedIndustries && !selectedIndustries.has(p.industry!)) return null;
    return { symbol: candidate.symbol, changePercent: candidate.changePercent,
      marketCap: p.marketCap, industry: p.industry, profileObservedAt: p.fetchedAt };
  }
  for (const [ordered, selected] of [
    [changes.filter(candidate => candidate.changePercent > 0), gainers],
    [[...changes].reverse().filter(candidate => candidate.changePercent < 0), losers],
  ] as const) {
    for (const candidate of ordered) {
      if (selected.length >= countPerDirection) break;
      const match = await qualifies(candidate);
      if (match === 'unavailable' || match === 'budget_exhausted') {
        return { status: 'incomplete', reason: match === 'unavailable' ? 'profile_unavailable' : match,
          checkedProfiles: resolved.size };
      }
      if (match) selected.push(match);
    }
  }
  return { status: 'complete', gainers, losers, checkedProfiles: resolved.size };
}
