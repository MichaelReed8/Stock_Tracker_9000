import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlpacaClient } from './alpaca.js';
import { CacheDb } from './cache.js';
import { rankStocks } from './rank.js';
import { scanPriceCoverage } from './price-coverage.js';
import { priceScanKey } from './price-coverage.js';
import { rankCachedPrices } from './cached-ranking.js';
import { isExplicitNonStockInstrument } from './asset-filter.js';
import { enrichProfiles } from './profile-enrichment.js';
import type { CompanyProfile } from './cache.js';

test('multi-symbol historical bars follow pagination and request split-adjusted SIP data', async () => {
  const requested: URL[] = [];
  const fetchImpl = (async (url: URL) => {
    requested.push(url);
    return { ok: true, json: async () => requested.length === 1
      ? { bars: { AAPL: [{ t: '2026-09-18T04:00:00Z', c: 100 }] }, next_page_token: 'page-2' }
      : { bars: { MSFT: [{ t: '2026-09-18T04:00:00Z', c: 200 }] }, next_page_token: null },
    } as Response;
  }) as typeof fetch;
  const rows = await new AlpacaClient('id', 'secret', fetchImpl)
    .dailyBars(['AAPL', 'MSFT'], '2026-09-18', '2026-09-18');
  assert.equal(rows.length, 2);
  assert.equal(requested[0].searchParams.get('feed'), 'sip');
  assert.equal(requested[0].searchParams.get('adjustment'), 'split');
  assert.equal(requested[1].searchParams.get('page_token'), 'page-2');
});

test('network errors do not expose Alpaca credentials', async () => {
  const fetchImpl = (async () => { throw new Error('secret-value'); }) as typeof fetch;
  await assert.rejects(new AlpacaClient('id', 'secret-value', fetchImpl)
    .dailyBars(['AAPL'], '2026-09-18', '2026-09-18'), error =>
      error instanceof Error && !error.message.includes('secret-value'));
});

test('SQLite cache persists bars and refuses FMP calls after the configured reserve', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stock-tracker-test-'));
  const file = join(dir, 'cache.sqlite');
  const db = await CacheDb.open(file);
  await db.replaceAssets([{ symbol: 'AAPL', name: 'Apple', exchange: 'NASDAQ' }], '2026-09-22T00:00:00Z');
  await db.putBars([{ symbol: 'AAPL', date: '2026-09-18', close: 100 }]);
  assert.equal(await db.reserveFmpRequest('2026-09-22', 1), true);
  assert.equal(await db.reserveFmpRequest('2026-09-22', 1), false);
  db.close();
  const reopened = await CacheDb.open(file);
  assert.equal(reopened.getBars('AAPL')[0].close, 100);
  assert.equal(reopened.getFmpAttempts('2026-09-22'), 1);
  assert.equal(reopened.getAssets()[0].symbol, 'AAPL');
  reopened.close();
});

test('ranking returns incomplete and no winners when a leading profile cannot be checked', async () => {
  const bars = [
    { symbol: 'AAPL', date: '2026-09-17', close: 100 },
    { symbol: 'AAPL', date: '2026-09-18', close: 120 },
    { symbol: 'MSFT', date: '2026-09-17', close: 100 },
    { symbol: 'MSFT', date: '2026-09-18', close: 105 },
  ];
  const profile: CompanyProfile = { symbol: 'MSFT', fetchedAt: '2026-09-22T00:00:00Z',
    marketCap: 100_000_000_000, industry: 'Software', sector: 'Technology',
    country: 'US', isEtf: false, isFund: false };
  const result = await rankStocks(['AAPL', 'MSFT'], bars, '2026-09-17', '2026-09-18',
    10_000_000_000, 1, async symbol => symbol === 'AAPL'
      ? { status: 'budget_exhausted' } : { status: 'available', profile });
  assert.deepEqual(result, { status: 'incomplete', reason: 'budget_exhausted', checkedProfiles: 1 });
});

test('market-cap filtering ranks eligible stocks by return rather than size', async () => {
  const bars = [
    { symbol: 'SMALL', date: '2026-09-17', close: 100 },
    { symbol: 'SMALL', date: '2026-09-18', close: 140 },
    { symbol: 'QUAL', date: '2026-09-17', close: 100 },
    { symbol: 'QUAL', date: '2026-09-18', close: 120 },
    { symbol: 'LARGE', date: '2026-09-17', close: 100 },
    { symbol: 'LARGE', date: '2026-09-18', close: 90 },
  ];
  const caps: Record<string, number> = { SMALL: 1_000_000, QUAL: 20_000_000_000, LARGE: 500_000_000_000 };
  const result = await rankStocks(Object.keys(caps), bars, '2026-09-17', '2026-09-18',
    10_000_000_000, 1, async symbol => ({ status: 'available', profile: {
      symbol, fetchedAt: '2026-09-22T00:00:00Z', marketCap: caps[symbol],
      industry: 'Software', sector: 'Technology', country: 'US', isEtf: false, isFund: false,
    } }));
  assert.equal(result.status, 'complete');
  if (result.status === 'complete') {
    assert.equal(result.gainers[0].symbol, 'QUAL');
    assert.equal(result.losers[0].symbol, 'LARGE');
  }
});

test('full price scan resumes completed batches and reports two-date coverage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stock-tracker-scan-test-'));
  const db = await CacheDb.open(join(dir, 'cache.sqlite'));
  const assets = Array.from({ length: 101 }, (_, i) => ({
    symbol: `S${i}`, name: `Company ${i}`, exchange: 'NASDAQ',
  }));
  await db.replaceAssets(assets, '2026-09-22T00:00:00Z');
  let calls = 0;
  const fetchImpl = (async (url: URL) => {
    calls++;
    if (calls === 2) throw new Error('simulated network loss');
    const symbols = url.searchParams.get('symbols')!.split(',');
    return { ok: true, json: async () => ({
      bars: Object.fromEntries(symbols.map(symbol => [symbol, [
        { t: '2026-09-18T04:00:00Z', c: 100 },
        { t: '2026-09-21T04:00:00Z', c: 110 },
      ]])), next_page_token: null,
    }) } as Response;
  }) as typeof fetch;
  const client = new AlpacaClient('id', 'secret', fetchImpl, 0);
  const first = await scanPriceCoverage(client, db, '2026-09-18', '2026-09-21');
  assert.equal(first.status, 'incomplete');
  assert.equal(first.completedBatches, 1);
  const second = await scanPriceCoverage(client, db, '2026-09-18', '2026-09-21');
  assert.equal(second.status, 'complete');
  assert.equal(second.coverage.both, 101);
  assert.equal(second.coverage.neither, 0);
  assert.equal(calls, 3);
  db.close();
});

test('cached ranking respects new-request budget, resumes with cached profiles, and keeps losers negative', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ranking-test-'));
  const db = await CacheDb.open(join(dir, 'cache.sqlite'));
  const symbols = ['AAA', 'BBB'];
  await db.replaceAssets(symbols.map(symbol => ({ symbol, name: symbol, exchange: 'NASDAQ' })), new Date().toISOString());
  await db.commitPriceBatch(priceScanKey(symbols, '2026-09-18', '2026-09-21'), 0, [
    { symbol: 'AAA', date: '2026-09-18', close: 100 }, { symbol: 'AAA', date: '2026-09-21', close: 120 },
    { symbol: 'BBB', date: '2026-09-18', close: 100 }, { symbol: 'BBB', date: '2026-09-21', close: 110 },
  ]);
  let requests = 0;
  const fetchImpl = (async (url: URL) => {
    requests++;
    return { ok: true, json: async () => [{ symbol: url.searchParams.get('symbol'),
      marketCap: 20_000_000_000, country: 'US', industry: 'Software', isEtf: false, isFund: false }] } as Response;
  }) as typeof fetch;
  const settings = { startDate: '2026-09-18', endDate: '2026-09-21', minimumMarketCap: 10_000_000_000,
    countPerDirection: 2, maxNewRequests: 1 };
  const first = await rankCachedPrices(db, 'fake-key', settings, fetchImpl);
  assert.equal(first.result.status, 'incomplete');
  assert.equal(first.newFmpRequests, 1);
  assert.equal(first.notificationEligible, false);
  const second = await rankCachedPrices(db, 'fake-key', settings, fetchImpl);
  assert.equal(second.cacheHits, 1);
  assert.equal(second.result.status, 'complete');
  if (second.result.status === 'complete') {
    assert.equal(second.result.gainers.length, 2);
    assert.equal(second.result.losers.length, 0);
  }
  assert.equal(requests, 2);
  db.close();
});

test('known ETFs are excluded without requiring a company market cap', async () => {
  const result = await rankStocks(['FUND'], [
    { symbol: 'FUND', date: '2026-09-18', close: 100 }, { symbol: 'FUND', date: '2026-09-21', close: 105 },
  ], '2026-09-18', '2026-09-21', 10_000_000_000, 1, async symbol => ({ status: 'available', profile: {
    symbol, fetchedAt: new Date().toISOString(), marketCap: null, isEtf: true, isFund: null,
    country: null, industry: null, sector: null,
  } }));
  assert.equal(result.status, 'complete');
  if (result.status === 'complete') assert.deepEqual(result.gainers, []);
});

test('explicit warrant/right descriptions are excluded without guessing from ticker suffixes', () => {
  const asset = (symbol: string, name: string) => ({ symbol, name, exchange: 'NYSE' });
  assert.equal(isExplicitNonStockInstrument(asset('IRAB.WS', 'Iris Acquisition Corp II Redeemable Warrants')), true);
  assert.equal(isExplicitNonStockInstrument(asset('CAPNR', 'Cayson Acquisition Corp Right')), true);
  assert.equal(isExplicitNonStockInstrument(asset('W', 'Wayfair Inc. Class A Common Stock')), false);
  assert.equal(isExplicitNonStockInstrument(asset('RIGHT', 'Right Company Common Stock')), false);
});

test('profile enrichment uses remaining daily budget and resumes without duplicate requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enrichment-test-'));
  const file = join(dir, 'cache.sqlite');
  let db = await CacheDb.open(file);
  await db.replaceAssets(['AAA', 'BBB', 'CCC'].map(symbol => ({ symbol, name: symbol, exchange: 'NASDAQ' })), new Date().toISOString());
  const day = new Date().toISOString().slice(0, 10);
  await db.reserveFmpRequest(day, 3);
  let calls = 0;
  const fetchImpl = (async (url: URL) => {
    calls++;
    return new Response(JSON.stringify([{ symbol: url.searchParams.get('symbol'), marketCap: 1000 }]));
  }) as typeof fetch;
  const first = await enrichProfiles(db, 'fake-key', { dailyLimit: 3, spacingMs: 0 }, fetchImpl);
  assert.equal(first.savedProfiles, 2);
  assert.equal(first.newRequests, 2);
  assert.equal(first.stopReason, 'local_daily_limit');
  db.close();
  db = await CacheDb.open(file);
  const second = await enrichProfiles(db, 'fake-key', { dailyLimit: 4, spacingMs: 0 }, fetchImpl);
  assert.equal(second.savedProfiles, 1);
  assert.equal(second.cachedCandidateProfiles, 3);
  assert.equal(calls, 3);
  db.close();
});

test('profile enrichment persists failed attempts and stops immediately at vendor rate limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enrichment-limit-test-'));
  const db = await CacheDb.open(join(dir, 'cache.sqlite'));
  await db.replaceAssets(['AAA', 'BBB', 'CCC'].map(symbol => ({ symbol, name: symbol, exchange: 'NASDAQ' })), new Date().toISOString());
  let calls = 0;
  const fetchImpl = (async () => new Response(null, { status: ++calls === 1 ? 402 : 429 })) as typeof fetch;
  const report = await enrichProfiles(db, 'fake-key', { dailyLimit: 10, spacingMs: 0 }, fetchImpl);
  assert.equal(report.stopReason, 'rate_limited');
  assert.equal(report.newRequests, 2);
  assert.equal(report.savedProfiles, 0);
  assert.equal(db.enrichmentAttempted('AAA', report.utcDate), true);
  assert.equal(db.enrichmentAttempted('BBB', report.utcDate), true);
  assert.equal(db.enrichmentAttempted('CCC', report.utcDate), false);
  db.close();
});

test('profile enrichment passes consecutive paywalled listings but stops on HTTP 200 API errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enrichment-paywall-test-'));
  const db = await CacheDb.open(join(dir, 'cache.sqlite'));
  await db.replaceAssets(['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map(symbol => ({ symbol, name: symbol, exchange: 'NASDAQ' })), new Date().toISOString());
  let calls = 0;
  const fetchImpl = (async () => ++calls <= 3 ? new Response(null, { status: 402 })
    : new Response(JSON.stringify({ 'Error Message': 'simulated quota error' }))) as typeof fetch;
  const report = await enrichProfiles(db, 'fake-key', { dailyLimit: 10, spacingMs: 0 }, fetchImpl);
  assert.equal(report.stopReason, 'api_error_payload');
  assert.equal(report.newRequests, 4);
  assert.equal(calls, 4);
  db.close();
});

test('background enrichment bounds spending, reports stale coverage, and resumes within the daily ceiling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'enrichment-budget-test-'));
  const db = await CacheDb.open(join(dir, 'cache.sqlite'));
  try {
    const symbols = Array.from({ length: 30 }, (_, i) => `S${i}`);
    await db.replaceAssets(symbols.map(symbol => ({ symbol, name: symbol, exchange: 'NASDAQ' })), new Date().toISOString());
    await db.putProfile({ symbol: 'S0', fetchedAt: '2020-01-01T00:00:00Z', marketCap: 100,
      country: 'US', industry: null, sector: null, isEtf: false, isFund: false });
    let calls = 0;
    const fetchImpl = (async (url: URL) => {
      calls++;
      return new Response(JSON.stringify([{ symbol: url.searchParams.get('symbol'), marketCap: 100 }]));
    }) as typeof fetch;
    const dry = await enrichProfiles(db, '', { dailyLimit: 28, dryRun: true }, fetchImpl);
    assert.equal(calls, 0);
    assert.equal(dry.staleCandidateProfiles, 1);
    assert.equal(dry.freshCandidateProfiles, 0);
    assert.equal(dry.plannedRequests, 25);
    assert.equal(dry.fullUniverseWeeklyRefreshDailyRequests, 5);
    const first = await enrichProfiles(db, 'fake-key', { dailyLimit: 28, spacingMs: 0 }, fetchImpl);
    assert.equal(first.newRequests, 25);
    assert.equal(first.stopReason, 'run_request_limit');
    assert.equal(first.remainingTrackedDailyRequests, 3);
    assert.equal(db.getProfile('S0')!.fetchedAt, '2020-01-01T00:00:00Z');
    const next = await enrichProfiles(db, 'fake-key', { dailyLimit: 28, spacingMs: 0 }, fetchImpl);
    assert.equal(next.newRequests, 3);
    assert.equal(next.stopReason, 'local_daily_limit');
    const zero = await enrichProfiles(db, 'fake-key', { dailyLimit: 200, maxNewRequests: 0 }, fetchImpl);
    assert.equal(zero.newRequests, 0);
    assert.equal(zero.stopReason, 'run_request_limit');
    assert.equal(calls, 28);
    await assert.rejects(enrichProfiles(db, '', { dailyLimit: 200, maxNewRequests: -1 }, fetchImpl));
  } finally { db.close(); }
});
