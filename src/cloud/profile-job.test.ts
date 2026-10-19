import test from 'node:test';
import assert from 'node:assert/strict';
import type { AlpacaAsset } from '../alpaca.js';
import type { CompanyProfile } from '../cache.js';
import { profileQueue, runProfileJob, type ProfileEntry, type ProfileJobStore } from './profile-job.js';

const now = new Date('2026-10-19T00:00:00Z');
const assets: AlpacaAsset[] = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'].map(symbol => ({ symbol, name: symbol, exchange: 'NASDAQ' }));
const old: CompanyProfile = { symbol: 'FFF', fetchedAt: '2026-01-01T00:00:00Z', marketCap: 100,
  country: 'US', sector: null, industry: null, isFund: false, isEtf: false };
class MemoryStore implements ProfileJobStore {
  locked = false; spent = 0; blocked = false; attempts = new Set<string>();
  profiles: ProfileEntry[] = []; reports: Record<string, unknown>[] = [];
  universe: { observedAt: string; assets: AlpacaAsset[] } | null = { observedAt: now.toISOString(), assets };
  async acquire() { if (this.locked) return false; this.locked = true; return true; }
  async release() { this.locked = false; }
  async loadAssets() { return this.universe; }
  async saveAssets(rows: AlpacaAsset[], date: Date) { this.universe = { observedAt: date.toISOString(), assets: rows }; }
  async entries() { return this.profiles; }
  async budgetAvailable(_day: string, limit: number) { return !this.blocked && this.spent < limit; }
  async reserve(symbol: string, date: Date, limit: number) {
    const id = `${date.toISOString().slice(0, 10)}#${symbol}`;
    if (this.blocked || this.spent >= limit || this.attempts.has(id)) return false;
    this.attempts.add(id); this.spent++; return true;
  }
  async save(entry: ProfileEntry) { this.profiles = [...this.profiles.filter(p => p.symbol !== entry.symbol), entry]; }
  async blockDay() { this.blocked = true; }
  async report(_owner: string, report: Record<string, unknown>) { this.reports.push(report); }
}
const options = () => ({ owner: 'test', key: 'fake-key', dailyLimit: 4, batchLimit: 2,
  assets: async () => assets, remainingMs: () => 500000, now: () => now,
  fetchImpl: (async (url: URL) => new Response(JSON.stringify([{ symbol: url.searchParams.get('symbol'), marketCap: 100 }]))) as typeof fetch });

test('queue reserves a fifth of slots for oldest refreshes, respects cooldowns and excludes warrants', () => {
  const queue = profileQueue([...assets, { symbol: 'WWW', name: 'Example Warrants', exchange: 'NYSE' }],
    [{ symbol: 'FFF', profile: old }], now);
  assert.deepEqual(queue.map(p => p.symbol), ['AAA', 'BBB', 'CCC', 'DDD', 'FFF', 'EEE']);
  assert.equal(profileQueue(assets, [{ symbol: 'AAA', retryAfter: '2026-11-01T00:00:00Z' }], now).some(p => p.symbol === 'AAA'), false);
});

test('scheduled runs resume durable progress and share a daily ceiling', async () => {
  const store = new MemoryStore();
  const first = await runProfileJob(store, options());
  assert.equal(first.requests, 2);
  assert.equal(first.stopReason, 'batch_limit');
  await runProfileJob(store, options());
  assert.equal(store.spent, 4);
  assert.equal(store.profiles.length, 4);
  const third = await runProfileJob(store, options());
  assert.equal(third.requests, 0);
  assert.equal(store.locked, false);
});

test('rate limit pauses remaining runs that UTC day and preserves the last good profile', async () => {
  const store = new MemoryStore();
  store.universe = { observedAt: now.toISOString(), assets: [assets[5]] };
  store.profiles = [{ symbol: 'FFF', profile: old }];
  const result = await runProfileJob(store, { ...options(),
    fetchImpl: (async () => new Response(null, { status: 429 })) as typeof fetch });
  assert.equal(result.stopReason, 'rate_limited');
  assert.equal(store.blocked, true);
  assert.deepEqual(store.profiles[0].profile, old);
  assert.equal(store.profiles[0].retryAfter, '2026-10-20T00:00:00.000Z');
  assert.equal((await runProfileJob(store, options())).requests, 0);
});

test('access denial cools down a symbol and duplicate attempts cannot spend twice', async () => {
  const store = new MemoryStore();
  const opts = { ...options(), batchLimit: 1,
    fetchImpl: (async () => new Response(null, { status: 402 })) as typeof fetch };
  await runProfileJob(store, opts);
  assert.equal(store.profiles[0].retryAfter, '2026-11-18T00:00:00.000Z');
  await runProfileJob(store, opts);
  assert.equal(store.spent, 2);
  assert.equal(await store.reserve('AAA', now, 10), false);
});

test('overlap, impending timeout, empty universe and UTC rollover spend no profile requests', async () => {
  const store = new MemoryStore();
  store.locked = true;
  assert.equal((await runProfileJob(store, options())).status, 'already_running');
  store.locked = false;
  assert.equal((await runProfileJob(store, { ...options(), remainingMs: () => 40000 })).stopReason, 'time_budget');
  let ticks = 0;
  assert.equal((await runProfileJob(store, { ...options(), now: () => ticks++ === 0 ? now : new Date('2026-10-20T00:00:00Z') })).stopReason, 'utc_day_changed');
  store.universe = null;
  await assert.rejects(runProfileJob(store, { ...options(), assets: async () => [] }));
  assert.equal(store.locked, false);
  assert.equal(store.spent, 0);
});

test('crash after reservation retains spent budget and next run skips that symbol', async () => {
  const store = new MemoryStore();
  store.save = async () => { throw new Error('simulated database write failure'); };
  await assert.rejects(runProfileJob(store, options()));
  assert.equal(store.spent, 1);
  assert.equal(store.locked, false);
  store.save = MemoryStore.prototype.save;
  await runProfileJob(store, options());
  assert.equal(store.profiles.some(entry => entry.symbol === 'AAA'), false);
  assert.equal(store.spent, 3);
});
