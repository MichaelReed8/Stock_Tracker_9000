import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionHealth } from './health.js';

test('budget completion and empty queues are healthy idle states, provider pauses are not', () => {
  for (const reason of ['daily_budget_exhausted', 'queue_complete', 'already_running']) {
    assert.equal(collectionHealth({ requests: 0, stopReason: reason }).progressHealthy, 1);
  }
  const paused = collectionHealth({ requests: 0, stopReason: 'provider_paused' });
  assert.equal(paused.progressHealthy, 0);
  assert.equal(paused.permanentProviderFailure, 1);
});

test('temporary failures trigger repeated-failure monitoring even with partial progress', () => {
  const health = collectionHealth({ requests: 2, savedProfiles: 1, stopReason: 'server_error' });
  assert.deepEqual(health, { providerFailure: 1, permanentProviderFailure: 0, progressHealthy: 1 });
  assert.equal(collectionHealth({ requests: 1, savedProfiles: 0, stopReason: 'request_failed' }).progressHealthy, 0);
  assert.equal(collectionHealth({ requests: 0, stopReason: 'provider_cooldown' }).providerFailure, 1);
});

test('unusable symbols and failed reservations do not masquerade as collection progress', () => {
  assert.equal(collectionHealth({ requests: 25, savedProfiles: 0, stopReason: 'batch_limit' }).progressHealthy, 0);
  assert.equal(collectionHealth({ requests: 0, stopReason: 'no_reservations_available' }).progressHealthy, 0);
});
