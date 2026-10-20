import test from 'node:test';
import assert from 'node:assert/strict';
import type { CompanyProfile } from '../cache.js';
import { buildDailySummary, completedPeriod, marketDate, sessionClose, type PriceBatch, type PriceRun } from './daily-summary.js';

const session = (date: string, close = '16:00') => ({ date, open: '09:30', close });
test('period selection respects holidays, weekends, early closes, DST and publication delay', () => {
  const sessions = [session('2026-07-01'), session('2026-07-02', '13:00'), session('2026-07-06')];
  assert.equal(sessionClose(sessions[1]), Date.parse('2026-07-02T17:00:00Z'));
  assert.equal(completedPeriod(sessions, new Date('2026-07-02T18:29:59Z')), null);
  assert.deepEqual(completedPeriod(sessions, new Date('2026-07-02T18:30:00Z')),
    { startDate: '2026-07-01', endDate: '2026-07-02' });
  assert.deepEqual(completedPeriod(sessions, new Date('2026-07-06T19:00:00Z')),
    { startDate: '2026-07-01', endDate: '2026-07-02' });
  assert.deepEqual(completedPeriod(sessions, new Date('2026-07-06T21:30:00Z')),
    { startDate: '2026-07-02', endDate: '2026-07-06' });
  assert.equal(sessionClose(session('2026-11-02')), Date.parse('2026-11-02T21:00:00Z'));
  assert.equal(sessionClose(session('2026-10-30')), Date.parse('2026-10-30T20:00:00Z'));
  assert.equal(marketDate(new Date('2026-07-03T01:00:00Z')), '2026-07-02');
});

export const observed = new Date('2026-10-20T12:00:00Z');
export const profile = (symbol: string, overrides: Partial<CompanyProfile> = {}): CompanyProfile => ({ symbol,
  fetchedAt: observed.toISOString(), marketCap: 20e9, country: 'US', isEtf: false, isFund: false,
  industry: 'Software', sector: 'Technology', ...overrides });
const run: PriceRun = { id: 'test', startDate: '2026-10-16', endDate: '2026-10-19', assetCount: 9,
  batchCount: 1, status: 'complete', createdAt: observed.toISOString() };
const symbols = ['SMALL', 'WIN', 'LOSE', 'UNKNOWN', 'OLD', 'FUND', 'FOREIGN', 'NOPRICE', 'WARRANT'];
const batch: PriceBatch = { index: 0, observedAt: observed.toISOString(), assets: symbols.map(symbol => ({
  symbol, name: symbol === 'WARRANT' ? 'Example Warrants' : `${symbol} Company`, exchange: 'NASDAQ' })),
  bars: symbols.filter(symbol => symbol !== 'NOPRICE').flatMap(symbol => [
    { symbol, date: run.startDate, close: 100 },
    { symbol, date: run.endDate, close: symbol === 'LOSE' ? 80 : symbol === 'SMALL' ? 200 : 120 },
  ]) };
const profiles = [profile('SMALL', { marketCap: 1e6 }), profile('WIN'), profile('LOSE'),
  profile('OLD', { fetchedAt: '2020-01-01T00:00:00Z' }), profile('FUND', { isEtf: true, marketCap: null }),
  profile('FOREIGN', { country: 'CA' })];

test('saved summaries qualify by cap, rank returns, expose partial coverage and never invent missing closes', () => {
  const summary = buildDailySummary(run, [batch], profiles, { minimumMarketCap: 10e9, countPerDirection: 5 }, observed);
  assert.deepEqual(summary.gainers.map(stock => stock.symbol), ['WIN']);
  assert.deepEqual(summary.losers.map(stock => stock.symbol), ['LOSE']);
  assert.equal(summary.gainers[0].companyName, 'WIN Company');
  assert.equal(summary.gainers[0].profileObservedAt, observed.toISOString());
  assert.equal(summary.coverage.missingProfiles, 1);
  assert.equal(summary.coverage.expiredProfiles, 1);
  assert.equal(summary.coverage.missingPrices, 1);
  assert.equal(summary.coverage.excludedInstruments, 1);
  assert.equal(summary.coverage.funds, 1);
  assert.equal(summary.coverage.nonUs, 1);
  assert.equal(summary.profileCoverage, 'partial');
  assert.equal(summary.notificationEligible, false);
});

test('summary identities deduplicate unchanged content while allowing immutable coverage revisions', () => {
  const settings = { minimumMarketCap: 10e9, countPerDirection: 5 };
  const first = buildDailySummary(run, [batch], profiles, settings, observed);
  const repeat = buildDailySummary(run, [batch], profiles, settings, new Date(observed.getTime() + 3600000));
  assert.equal(first.id, repeat.id);
  const revision = buildDailySummary(run, [batch], [...profiles, profile('UNKNOWN')], settings, observed);
  assert.notEqual(revision.id, first.id);
  assert.equal(first.coverage.missingProfiles, 1);
  assert.equal(revision.coverage.missingProfiles, 0);
});

test('incomplete batches, invalid settings and no comparable prices never publish a summary', () => {
  assert.throws(() => buildDailySummary(run, [], profiles, { minimumMarketCap: 0, countPerDirection: 5 }, observed));
  assert.throws(() => buildDailySummary(run, [batch], profiles, { minimumMarketCap: NaN, countPerDirection: 5 }, observed));
  assert.throws(() => buildDailySummary(run, [{ ...batch, bars: [] }], profiles,
    { minimumMarketCap: 0, countPerDirection: 5 }, observed));
});
