import test from 'node:test';
import assert from 'node:assert/strict';
import { probe } from './fmp-probe.mjs';

test('screener follow-up makes only two requests even when access is denied', async () => {
  const report = await probe('test-secret', { screenOnly: true, fetchImpl: async () => ({
    status: 402, ok: false,
  }) });
  assert.equal(report.attemptedRequests, 2);
  assert.equal(report.maxRequests, 2);
  assert.ok(report.results.every(result => result.outcome === 'access_denied'));
});

test('market-cap options probe only checks the two requested endpoints', async () => {
  const report = await probe('test-secret', { marketCapOptions: true, fetchImpl: async () => ({
    status: 402, ok: false,
  }) });
  assert.equal(report.attemptedRequests, 2);
  assert.deepEqual(report.results.map(result => result.endpoint), ['stock-list', 'profile-bulk']);
});

test('network failures never expose keys or authenticated URLs and stop requests', async () => {
  const secret = 'test-secret-value';
  const report = await probe(secret, { fetchImpl: async url => { throw new Error(String(url)); } });
  assert.equal(report.attemptedRequests, 1);
  assert.equal(report.results[0].outcome, 'network_or_timeout_error');
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.ok(!JSON.stringify(report).includes('apikey'));
});

test('rate limits stop the probe without reading error bodies', async () => {
  let reads = 0;
  const report = await probe('test-secret', { fetchImpl: async () => ({
    status: 429, ok: false, json: async () => { reads++; },
  }) });
  assert.equal(report.attemptedRequests, 1);
  assert.equal(reads, 0);
  assert.equal(report.results[0].outcome, 'rate_limited');
});

test('successful probe stays within eight requests and detects ignored filters', async () => {
  const report = await probe('test-secret', { fetchImpl: async () => ({
    status: 200, ok: true, json: async () => [{ symbol: 'NVDA', marketCap: 1,
      country: 'CA', industry: 'Technology', secret: 'test-secret' }],
  }) });
  assert.equal(report.attemptedRequests, 8);
  assert.equal(report.screen.belowRequestedCap, 1);
  assert.equal(report.screen.nonUSOrMissingCountry, 1);
  assert.ok(!JSON.stringify(report).includes('test-secret'));
});

test('HTTP 200 error payloads are suppressed and stop further spending', async () => {
  const report = await probe('test-secret', { fetchImpl: async () => ({
    status: 200, ok: true, json: async () => ({ 'Error Message': 'apikey=test-secret' }),
  }) });
  assert.equal(report.attemptedRequests, 1);
  assert.equal(report.results[0].outcome, 'unexpected_or_error_payload');
  assert.ok(!JSON.stringify(report).includes('test-secret'));
});
