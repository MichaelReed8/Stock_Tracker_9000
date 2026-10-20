import { createHash } from 'node:crypto';
import { percentChange, type AlpacaAsset, type PriceBar, type TradingSession } from '../alpaca.js';
import type { CompanyProfile } from '../cache.js';
import { isExplicitNonStockInstrument } from '../asset-filter.js';
import { profileIsUsable, profileNeedsRefresh } from '../profile-policy.js';

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type DailySettings = { minimumMarketCap: number; countPerDirection: number };
export type PriceRun = { id: string; startDate: string; endDate: string; assetCount: number;
  batchCount: number; status: 'collecting' | 'complete'; createdAt: string };
export type PricePlan = { index: number; assets: AlpacaAsset[] };
export type PriceBatch = PricePlan & { bars: PriceBar[]; observedAt: string };

export function marketDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric',
    month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function sessionClose(session: TradingSession): number {
  const nominal = Date.parse(`${session.date}T${session.close}:00Z`);
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
    timeZoneName: 'longOffset' }).formatToParts(new Date(nominal)).find(p => p.type === 'timeZoneName')!.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(zone);
  if (!match || !Number.isFinite(nominal)) throw new Error('Invalid session close');
  const offset = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '+' ? 1 : -1);
  return nominal - offset * 60_000;
}

export function completedPeriod(sessions: TradingSession[], now: Date, delayMinutes = 90) {
  if (!Number.isFinite(delayMinutes) || delayMinutes < 20) throw new Error('Invalid closing-data buffer');
  const sorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(sorted.map(s => s.date)).size !== sorted.length) throw new Error('Duplicate calendar date');
  const completed = sorted.filter(session => sessionClose(session) + delayMinutes * 60_000 <= now.getTime());
  if (completed.length < 2) return null;
  return { startDate: completed.at(-2)!.date, endDate: completed.at(-1)!.date };
}

export function validateDailySettings(settings: DailySettings) {
  if (!Number.isFinite(settings.minimumMarketCap) || settings.minimumMarketCap < 0 ||
    !Number.isInteger(settings.countPerDirection) || settings.countPerDirection < 1 || settings.countPerDirection > 20) {
    throw new Error('Invalid daily summary settings');
  }
}

export function buildDailySummary(run: PriceRun, batches: PriceBatch[], profiles: CompanyProfile[], settings: DailySettings, now: Date) {
  validateDailySettings(settings);
  if (run.status !== 'complete' || batches.length !== run.batchCount ||
    new Set(batches.map(b => b.index)).size !== run.batchCount ||
    batches.some(b => b.index < 0 || b.index >= run.batchCount) ||
    batches.reduce((n, b) => n + b.assets.length, 0) !== run.assetCount) throw new Error('Incomplete price scan');
  const bySymbol = new Map(profiles.map(p => [p.symbol, p]));
  const coverage = { assets: run.assetCount, excludedInstruments: 0, missingPrices: 0, pricedCandidates: 0,
    missingProfiles: 0, expiredProfiles: 0, incompleteProfiles: 0, funds: 0, nonUs: 0,
    belowMinimumCap: 0, qualified: 0, refreshDueProfiles: 0 };
  const qualified: { symbol: string; companyName: string; changePercent: number; startClose: number;
    endClose: number; marketCap: number; industry: string | null; profileObservedAt: string }[] = [];
  for (const batch of batches) {
    const prices = new Map(batch.bars.map(bar => [`${bar.symbol}#${bar.date}`, bar.close]));
    for (const asset of batch.assets) {
      if (isExplicitNonStockInstrument(asset)) { coverage.excludedInstruments++; continue; }
      const start = prices.get(`${asset.symbol}#${run.startDate}`), end = prices.get(`${asset.symbol}#${run.endDate}`);
      if (start === undefined || end === undefined) { coverage.missingPrices++; continue; }
      coverage.pricedCandidates++;
      const p = bySymbol.get(asset.symbol);
      if (!p) { coverage.missingProfiles++; continue; }
      if (!profileIsUsable(p, now)) { coverage.expiredProfiles++; continue; }
      if (profileNeedsRefresh(p, now)) coverage.refreshDueProfiles++;
      if (p.isEtf === true || p.isFund === true) { coverage.funds++; continue; }
      if (p.country !== null && p.country !== 'US') { coverage.nonUs++; continue; }
      if (p.marketCap === null || !Number.isFinite(p.marketCap) || p.marketCap < 0 ||
        p.country === null || p.isEtf === null || p.isFund === null) { coverage.incompleteProfiles++; continue; }
      if (p.marketCap < settings.minimumMarketCap) { coverage.belowMinimumCap++; continue; }
      coverage.qualified++;
      qualified.push({ symbol: asset.symbol, companyName: asset.name, changePercent: percentChange(start, end),
        startClose: start, endClose: end, marketCap: p.marketCap, industry: p.industry, profileObservedAt: p.fetchedAt });
    }
  }
  if (!coverage.pricedCandidates) throw new Error('No comparable prices');
  const unresolved = coverage.missingProfiles + coverage.expiredProfiles + coverage.incompleteProfiles;
  const body = { kind: 'daily_stock_summary', schemaVersion: 1, priceRunId: run.id,
    startDate: run.startDate, endDate: run.endDate, settings,
    label: 'Top movers among supported US stocks with cached profiles',
    scope: 'cached_profile_coverage', profileCoverage: unresolved ? 'partial' : 'complete_among_priced_candidates',
    returnType: 'split_adjusted_price_return', feed: 'alpaca_sip', countryBasis: 'US company domicile',
    notificationEligible: false, coverage,
    gainers: qualified.filter(stock => stock.changePercent > 0)
      .sort((a, b) => b.changePercent - a.changePercent || a.symbol.localeCompare(b.symbol)).slice(0, settings.countPerDirection),
    losers: qualified.filter(stock => stock.changePercent < 0)
      .sort((a, b) => a.changePercent - b.changePercent || a.symbol.localeCompare(b.symbol)).slice(0, settings.countPerDirection) };
  return { id: digest(body), createdAt: now.toISOString(), ...body };
}

export type DailySummary = ReturnType<typeof buildDailySummary>;
