import test from 'node:test';
import assert from 'node:assert/strict';
import type { AlpacaAsset, TradingSession } from '../alpaca.js';
import type { CompanyProfile } from '../cache.js';
import type { DailySummary, PriceBatch, PricePlan, PriceRun } from './daily-summary.js';
import { runPriceJob, type PriceJobStore } from './price-job.js';

const now = new Date('2026-10-20T12:00:00Z');
const assets: AlpacaAsset[] = Array.from({ length: 201 }, (_, i) => ({ symbol: `S${i}`, name: `Company ${i}`, exchange: 'NASDAQ' }));
const sessions: TradingSession[] = ['2026-10-16', '2026-10-19', '2026-10-20'].map(date => ({ date, open: '09:30', close: '16:00' }));
class MemoryPriceStore implements PriceJobStore {
  locked = false; run: PriceRun | null = null; plans: PricePlan[] = []; batches: PriceBatch[] = [];
  summaries = new Map<string, DailySummary>(); reports: Record<string, unknown>[] = [];
  profiles: CompanyProfile[] = [{ symbol: 'S0', fetchedAt: now.toISOString(), marketCap: 20e9,
    country: 'US', isFund: false, isEtf: false, sector: null, industry: null }];
  calendarCache: { fetchedAt: string; throughDate?: string; sessions: TradingSession[] } | null = null;
  async acquirePrice() { if (this.locked) return false; this.locked = true; return true; }
  async releasePrice() { this.locked = false; }
  async priceCalendar() { return this.calendarCache; }
  async savePriceCalendar(rows: TradingSession[], date: Date, throughDate: string) {
    this.calendarCache = { fetchedAt: date.toISOString(), throughDate, sessions: rows };
  }
  async loadAssets() { return { observedAt: now.toISOString(), assets }; }
  async saveAssets() {}
  async currentPriceRun() { return this.run; }
  async startPriceRun(run: PriceRun, plans: PricePlan[]) { this.run = run; this.plans = plans; this.batches = []; }
  async pricePlans() { return this.plans; }
  async priceBatches() { return [...this.batches]; }
  async savePriceBatch(_run: PriceRun, batch: PriceBatch) { this.batches.push(batch); }
  async completePriceRun(run: PriceRun) { this.run = { ...run, status: 'complete' }; }
  async entries() { return this.profiles.map(profile => ({ profile })); }
  async saveSummary(summary: DailySummary) {
    const created = !this.summaries.has(summary.id);
    if (created) this.summaries.set(summary.id, summary);
    return created;
  }
  async report(_owner: string, report: Record<string, unknown>) { this.reports.push(report); }
}
const options = () => ({ owner: 'test', settings: { minimumMarketCap: 10e9, countPerDirection: 5 },
  maxBatches: 160, delayMinutes: 90, now: () => now, remainingMs: () => 500000,
  assets: async () => assets, calendar: async () => sessions,
  bars: async (symbols: string[], start: string, end: string, through: Date) => {
    assert.ok(Number.isFinite(through.getTime()));
    return symbols.flatMap(symbol => [{ symbol, date: start, close: 100 }, { symbol, date: end, close: 110 }]);
  } });

test('a failed batch resumes from durable batches and never publishes a partial scan', async () => {
  const store = new MemoryPriceStore();
  const opts = options();
  let calls = 0;
  const flaky = { ...opts, bars: async (...args: Parameters<typeof opts.bars>) => {
    if (++calls === 2) throw new Error('fake-provider-key-error');
    return opts.bars(...args);
  } };
  const first = await runPriceJob(store, flaky);
  assert.equal(first.status, 'failed');
  assert.equal(store.batches.length, 1);
  assert.equal(store.summaries.size, 0);
  assert.equal(store.run!.status, 'collecting');
  assert.equal(JSON.stringify(first).includes('fake-provider-key'), false);
  const resumed = await runPriceJob(store, flaky);
  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.committedBatches, 2);
  assert.equal(calls, 4);
  assert.equal(store.batches.length, 3);
  assert.equal(store.summaries.size, 1);
});

test('unchanged sessions reuse prices and snapshots; new profiles create revisions without provider calls', async () => {
  const store = new MemoryPriceStore();
  const first = await runPriceJob(store, options());
  const noProvider = { ...options(), bars: async () => { throw new Error('Unexpected provider request'); },
    calendar: async () => { throw new Error('Calendar already cached'); } };
  const repeat = await runPriceJob(store, noProvider);
  assert.equal(repeat.status, 'complete');
  assert.equal(repeat.snapshotId, first.snapshotId);
  assert.equal(repeat.snapshotCreated, false);
  store.profiles.push({ ...store.profiles[0], symbol: 'S1' });
  const revised = await runPriceJob(store, noProvider);
  assert.equal(revised.status, 'complete');
  assert.notEqual(revised.snapshotId, first.snapshotId);
  assert.equal(store.summaries.size, 2);
});

test('batch and time bounds leave resumable work without a summary; overlap spends no requests', async () => {
  const store = new MemoryPriceStore();
  const limited = await runPriceJob(store, { ...options(), maxBatches: 1 });
  assert.equal(limited.status, 'incomplete');
  assert.equal(store.summaries.size, 0);
  const timed = await runPriceJob(store, { ...options(), remainingMs: () => 60000 });
  assert.equal(timed.status, 'incomplete');
  assert.equal(timed.committedBatches, 0);
  store.locked = true;
  const overlap = await runPriceJob(store, options());
  assert.equal(overlap.status, 'already_running');
});

test('an unfinished older period finishes before moving to a newer completed session', async () => {
  const store = new MemoryPriceStore();
  await runPriceJob(store, { ...options(), maxBatches: 1 });
  const evening = { ...options(), now: () => new Date('2026-10-20T22:00:00Z') };
  const older = await runPriceJob(store, evening);
  assert.equal(older.endDate, '2026-10-19');
  assert.equal(older.status, 'complete');
  const latest = await runPriceJob(store, evening);
  assert.equal(latest.endDate, '2026-10-20');
  assert.equal(latest.startDate, '2026-10-19');
});

test('a snapshot write failure leaves the run resumable and preserves completed prices', async () => {
  const store = new MemoryPriceStore();
  store.saveSummary = async () => { throw new Error('simulated storage error'); };
  const first = await runPriceJob(store, options());
  assert.equal(first.status, 'failed');
  assert.equal(store.run!.status, 'collecting');
  assert.equal(store.batches.length, 3);
  store.saveSummary = MemoryPriceStore.prototype.saveSummary;
  assert.equal((await runPriceJob(store, options())).status, 'complete');
});

test('a UTC-day calendar fetched before New York midnight cannot hide the next market session', async () => {
  const store = new MemoryPriceStore();
  store.calendarCache = { fetchedAt: '2026-10-20T00:30:00Z', throughDate: '2026-10-19',
    sessions: sessions.slice(0, 2) };
  let calendarRequests = 0;
  const result = await runPriceJob(store, { ...options(), now: () => new Date('2026-10-20T22:00:00Z'),
    calendar: async () => { calendarRequests++; return sessions; } });
  assert.equal(calendarRequests, 1);
  assert.equal(result.endDate, '2026-10-20');
  assert.equal(result.status, 'complete');
  assert.equal(store.calendarCache.throughDate, '2026-10-20');
});
