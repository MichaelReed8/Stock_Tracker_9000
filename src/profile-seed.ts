import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { CacheDb } from './cache.js';
import { getCachedOrFetchProfile } from './fmp-profile.js';

try { loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url))); }
catch {
  console.log('Local configuration could not be loaded. No FMP requests made.');
  process.exit(1);
}
const key = process.env.FMP_API_KEY?.trim() || '';
if (!key) {
  console.log('FMP_API_KEY is not configured. No FMP requests made.');
  process.exit(1);
}
const cache = await CacheDb.open(fileURLToPath(new URL('../data/stock-cache.sqlite', import.meta.url)));
try {
  const symbols = ['AAPL', 'MSFT', 'SOUN', 'RIOT'];
  const results = [];
  for (const symbol of symbols) {
    const result = await getCachedOrFetchProfile(symbol, cache, key);
    results.push({ symbol, status: result.status,
      ...(result.status === 'available' ? {
        marketCapPresent: result.profile.marketCap !== null,
        industryPresent: result.profile.industry !== null,
        assetFlagsPresent: result.profile.isEtf !== null && result.profile.isFund !== null,
      } : {}) });
  }
  console.log(JSON.stringify({ results, fmpAttemptsToday: cache.getFmpAttempts(new Date().toISOString().slice(0, 10)),
    cache: 'data/stock-cache.sqlite' }, null, 2));
} catch {
  console.error('Profile check failed locally; details suppressed to protect credentials.');
  process.exitCode = 1;
} finally { cache.close(); }
