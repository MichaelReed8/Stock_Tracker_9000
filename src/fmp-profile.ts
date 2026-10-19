import type { CacheDb, CompanyProfile } from './cache.js';
import { profileIsUsable } from './profile-policy.js';

const symbolPattern = /^[A-Z][A-Z0-9.-]{0,14}$/;
const stringOrNull = (value: unknown): string | null => typeof value === 'string' && value.length ? value : null;
const booleanOrNull = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;

export type ProfileResult =
  | { status: 'available'; profile: CompanyProfile }
  | { status: 'budget_exhausted' }
  | { status: 'unavailable'; reason?: 'missing_key' | 'invalid_symbol' | 'access_denied' | 'unauthorized' | 'forbidden' | 'rate_limited' | 'http_error' | 'api_error_payload' | 'invalid_payload' | 'request_failed' };

export function profileIsFresh(profile: CompanyProfile | null, now = new Date()): boolean {
  return profileIsUsable(profile, now);
}

export async function getCachedOrFetchProfile(
  symbol: string, cache: CacheDb, key: string,
  fetchImpl: typeof fetch = fetch, now = new Date(),
  maxDailyAttempts = 200,
): Promise<ProfileResult> {
  if (!symbolPattern.test(symbol)) return { status: 'unavailable', reason: 'invalid_symbol' };
  const cached = cache.getProfile(symbol);
  // Retain observations; the worker queues refresh at 90 days, reuse ends at 180.
  if (cached && profileIsFresh(cached, now)) {
    return { status: 'available', profile: cached };
  }
  if (!key) return { status: 'unavailable', reason: 'missing_key' };
  const utcDate = now.toISOString().slice(0, 10);
  // Reserve before the attempt, including failures. Leave at least 50 of the
  // user-reported 250 daily calls for industry requests and manual checks.
  if (!Number.isInteger(maxDailyAttempts) || maxDailyAttempts < 0 || maxDailyAttempts > 250) {
    throw new Error('Daily profile limit must be between 0 and 250');
  }
  if (!await cache.reserveFmpRequest(utcDate, maxDailyAttempts)) return { status: 'budget_exhausted' };
  const result = await fetchProfile(symbol, key, fetchImpl, now);
  if (result.status === 'available') await cache.putProfile(result.profile);
  return result;
}

export async function fetchProfile(symbol: string, key: string, fetchImpl: typeof fetch = fetch,
  now = new Date()): Promise<ProfileResult> {
  if (!symbolPattern.test(symbol)) return { status: 'unavailable', reason: 'invalid_symbol' };
  if (!key) return { status: 'unavailable', reason: 'missing_key' };
  const url = new URL('https://financialmodelingprep.com/stable/profile');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('apikey', key);
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: 'unavailable', reason: response.status === 401 ? 'unauthorized'
        : response.status === 403 ? 'forbidden' : response.status === 402 ? 'access_denied'
        : response.status === 429 ? 'rate_limited' : 'http_error' };
    }
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) return { status: 'unavailable', reason: 'api_error_payload' };
    if (!Array.isArray(payload) || payload.length !== 1 ||
      typeof payload[0] !== 'object' || payload[0] === null || payload[0].symbol !== symbol) {
      return { status: 'unavailable', reason: 'invalid_payload' };
    }
    const row = payload[0] as Record<string, unknown>;
    const profile: CompanyProfile = {
      symbol, fetchedAt: now.toISOString(),
      marketCap: typeof row.marketCap === 'number' && Number.isFinite(row.marketCap) && row.marketCap >= 0
        ? row.marketCap : null,
      industry: stringOrNull(row.industry), sector: stringOrNull(row.sector),
      country: stringOrNull(row.country), isEtf: booleanOrNull(row.isEtf),
      isFund: booleanOrNull(row.isFund),
    };
    return { status: 'available', profile };
  } catch {
    // Never return raw HTTP or parse errors; FMP's query URL contains the key.
    return { status: 'unavailable', reason: 'request_failed' };
  }
}
