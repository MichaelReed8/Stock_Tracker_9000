import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMarkets } from './collection.js';

test('FMP exhaustion and provider failure cannot suppress price work', async () => {
  for (const reason of ['daily_budget_exhausted', 'provider_paused', 'server_error']) {
    let priceCalls = 0;
    const result = await collectMarkets({ profiles: async () => ({ requests: 0, stopReason: reason }),
      prices: async () => { priceCalls++; return { status: 'complete', committedBatches: 10 }; } });
    assert.equal(priceCalls, 1);
    assert.equal(result.priceHealthy, 1);
  }
});

test('a profile exception still allows prices; healthy profiles cannot hide a failed price stage', async () => {
  const profileCrash = await collectMarkets({ profiles: async () => { throw new Error('secret'); },
    prices: async () => ({ status: 'complete', committedBatches: 1 }) });
  assert.equal(profileCrash.profileError, true);
  assert.equal(profileCrash.priceHealthy, 1);
  assert.equal(JSON.stringify(profileCrash).includes('secret'), false);
  const priceCrash = await collectMarkets({ profiles: async () => ({ requests: 0, stopReason: 'daily_budget_exhausted' }),
    prices: async () => { throw new Error('secret'); } });
  assert.equal(priceCrash.progressHealthy, 1);
  assert.equal(priceCrash.priceHealthy, 0);
  assert.equal(priceCrash.providerFailure, 1);
});
