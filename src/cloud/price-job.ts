import type { AlpacaAsset, PriceBar, TradingSession } from '../alpaca.js';
import type { CompanyProfile } from '../cache.js';
import { buildDailySummary, completedPeriod, digest, marketDate, validateDailySettings,
  type DailySettings, type DailySummary, type PriceBatch, type PricePlan, type PriceRun } from './daily-summary.js';

export interface PriceJobStore {
  acquirePrice(owner: string, now: Date): Promise<boolean>;
  releasePrice(owner: string): Promise<void>;
  priceCalendar(): Promise<{ fetchedAt: string; throughDate?: string; sessions: TradingSession[] } | null>;
  savePriceCalendar(sessions: TradingSession[], now: Date, throughDate: string): Promise<void>;
  loadAssets(): Promise<{ observedAt: string; assets: AlpacaAsset[] } | null>;
  saveAssets(assets: AlpacaAsset[], now: Date): Promise<void>;
  currentPriceRun(): Promise<PriceRun | null>;
  startPriceRun(run: PriceRun, plans: PricePlan[]): Promise<void>;
  pricePlans(id: string): Promise<PricePlan[]>;
  priceBatches(id: string): Promise<PriceBatch[]>;
  savePriceBatch(run: PriceRun, batch: PriceBatch): Promise<void>;
  completePriceRun(run: PriceRun, now: Date): Promise<void>;
  entries(): Promise<{ profile?: CompanyProfile }[]>;
  saveSummary(summary: DailySummary): Promise<boolean>;
  report(owner: string, report: Record<string, unknown>): Promise<void>;
}
export type PriceJobReport = { status: 'complete' | 'incomplete' | 'not_ready' | 'already_running' | 'failed';
  committedBatches: number; reason?: string; startDate?: string; endDate?: string;
  snapshotId?: string; snapshotCreated?: boolean; qualified?: number; missingProfiles?: number };

export async function runPriceJob(store: PriceJobStore, options: {
  owner: string; settings: DailySettings; delayMinutes: number; maxBatches: number;
  assets: () => Promise<AlpacaAsset[]>;
  calendar: (start: string, end: string) => Promise<TradingSession[]>;
  bars: (symbols: string[], start: string, end: string, through: Date) => Promise<PriceBar[]>;
  remainingMs: () => number; now?: () => Date;
}): Promise<PriceJobReport> {
  validateDailySettings(options.settings);
  if (!Number.isInteger(options.maxBatches) || options.maxBatches < 1 || options.maxBatches > 200 ||
    !Number.isInteger(options.delayMinutes) || options.delayMinutes < 20 || options.delayMinutes > 1440) throw new Error('Invalid price job limits');
  const now = options.now ?? (() => new Date());
  const started = now();
  if (!await store.acquirePrice(options.owner, started)) return { status: 'already_running', committedBatches: 0 };
  let committed = 0;
  let run: PriceRun | null = null;
  try {
    const finish = async (result: PriceJobReport) => {
      await store.report(`price-${options.owner}`, { startedAt: started.toISOString(), finishedAt: now().toISOString(),
        kind: 'price_collection', ...result });
      return result;
    };
    try {
      run = await store.currentPriceRun();
      // Resume the frozen universe/period before moving to a newer session after downtime.
      if (!run || run.status === 'complete') {
        let calendar = await store.priceCalendar();
        const throughDate = marketDate(started);
        if (!calendar || calendar.fetchedAt.slice(0, 10) !== started.toISOString().slice(0, 10) ||
          calendar.throughDate !== throughDate) {
          const start = new Date(started.getTime() - 45 * 86400000).toISOString().slice(0, 10);
          const sessions = await options.calendar(start, throughDate);
          if (!sessions.length) throw new Error('No market calendar');
          await store.savePriceCalendar(sessions, started, throughDate);
          calendar = { sessions, throughDate, fetchedAt: started.toISOString() };
        }
        const period = completedPeriod(calendar.sessions, started, options.delayMinutes);
        if (!period) return await finish({ status: 'not_ready', committedBatches: 0 });
        if (!run || run.endDate < period.endDate) {
          let universe = await store.loadAssets();
          if (!universe) {
            const assets = await options.assets();
            if (!assets.length) throw new Error('No asset universe');
            await store.saveAssets(assets, started);
            universe = { assets, observedAt: started.toISOString() };
          }
          const assets = [...universe.assets].sort((a, b) => a.symbol.localeCompare(b.symbol));
          if (!assets.length || new Set(assets.map(a => a.symbol)).size !== assets.length) throw new Error('Invalid universe');
          const plans = Array.from({ length: Math.ceil(assets.length / 100) }, (_, index) => ({ index,
            assets: assets.slice(index * 100, (index + 1) * 100) }));
          run = { id: digest({ ...period, symbols: assets.map(a => a.symbol), adjustment: 'split', schemaVersion: 1 }),
            ...period, assetCount: assets.length, batchCount: plans.length, status: 'collecting', createdAt: started.toISOString() };
          await store.startPriceRun(run, plans);
        }
      }
      const plans = await store.pricePlans(run.id);
      const batches = await store.priceBatches(run.id);
      if (plans.length !== run.batchCount) throw new Error('Incomplete stored price plan');
      const completed = new Set(batches.map(batch => batch.index));
      for (const plan of plans) {
        if (completed.has(plan.index)) continue;
        if (committed >= options.maxBatches || options.remainingMs() < 65000) {
          return await finish({ status: 'incomplete', reason: 'execution_budget', committedBatches: committed,
            startDate: run.startDate, endDate: run.endDate });
        }
        // Request both closes together so a split never mixes adjustment vintages.
        const received = await options.bars(plan.assets.map(asset => asset.symbol), run.startDate, run.endDate,
          new Date(now().getTime() - 20 * 60_000));
        const requested = new Set(plan.assets.map(asset => asset.symbol));
        const bars = received.filter(bar => requested.has(bar.symbol) && (bar.date === run!.startDate || bar.date === run!.endDate));
        if (bars.some(bar => !Number.isFinite(bar.close) || bar.close <= 0) ||
          new Set(bars.map(bar => `${bar.symbol}#${bar.date}`)).size !== bars.length) throw new Error('Invalid price bars');
        const batch = { ...plan, bars, observedAt: now().toISOString() };
        await store.savePriceBatch(run, batch);
        batches.push(batch);
        completed.add(plan.index);
        committed++;
      }
      if (completed.size !== run.batchCount) throw new Error('Incomplete price batches');
      const summary = buildDailySummary({ ...run, status: 'complete' }, batches,
        (await store.entries()).flatMap(entry => entry.profile ? [entry.profile] : []), options.settings, now());
      const snapshotCreated = await store.saveSummary(summary);
      if (run.status !== 'complete') await store.completePriceRun(run, now());
      return await finish({ status: 'complete', committedBatches: committed, startDate: run.startDate, endDate: run.endDate,
        snapshotId: summary.id, snapshotCreated, qualified: summary.coverage.qualified,
        missingProfiles: summary.coverage.missingProfiles + summary.coverage.expiredProfiles + summary.coverage.incompleteProfiles });
    } catch {
      return await finish({ status: 'failed', reason: 'price_or_storage_unavailable', committedBatches: committed,
        ...(run ? { startDate: run.startDate, endDate: run.endDate } : {}) });
    }
  } finally { await store.releasePrice(options.owner); }
}
