import test from 'node:test';
import assert from 'node:assert/strict';
import type { CompanyProfile } from './cache.js';
import { profileAgeDays, profileIsUsable, profileNeedsRefresh } from './profile-policy.js';

test('profiles have a refresh target separate from reuse cutoff, with invalid/future observations rejected', () => {
  const now = new Date('2026-10-19T00:00:00Z');
  const profile = (age: number): CompanyProfile => ({ symbol: 'AAA',
    fetchedAt: new Date(now.getTime() - age * 86400000).toISOString(), marketCap: 100,
    country: 'US', isEtf: false, isFund: false, sector: null, industry: null });
  assert.equal(profileIsUsable(profile(30), now), true);
  assert.equal(profileNeedsRefresh(profile(89), now), false);
  assert.equal(profileNeedsRefresh(profile(90), now), true);
  assert.equal(profileIsUsable(profile(179), now), true);
  assert.equal(profileIsUsable(profile(180), now), false);
  assert.equal(profileIsUsable(profile(-1), now), false);
  assert.equal(profileAgeDays({ ...profile(0), fetchedAt: 'invalid' }, now), null);
  assert.equal(profileNeedsRefresh(null, now), true);
});
