import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { AlpacaClient } from './alpaca.js';
import { CacheDb } from './cache.js';
import { scanPriceCoverage } from './price-coverage.js';

const startDate = process.argv.find(arg => arg.startsWith('--start='))?.slice(8) ?? '';
const endDate = process.argv.find(arg => arg.startsWith('--end='))?.slice(6) ?? '';
if (!startDate || !endDate) {
  console.log('Usage: npm run price:scan -- --start=YYYY-MM-DD --end=YYYY-MM-DD');
  process.exit(1);
}
try { loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url))); }
catch {
  console.log('Local configuration could not be loaded. No Alpaca requests made.');
  process.exit(1);
}
const keyId = process.env.ALPACA_API_KEY_ID?.trim() || '';
const secret = process.env.ALPACA_API_SECRET_KEY?.trim() || '';
if (!keyId || !secret) {
  console.log('Alpaca credentials are not configured. No Alpaca requests made.');
  process.exit(1);
}
const cache = await CacheDb.open(fileURLToPath(new URL('../data/stock-cache.sqlite', import.meta.url)));
try {
  const client = new AlpacaClient(keyId, secret);
  const report = await scanPriceCoverage(client, cache, startDate, endDate, (completed, total) => {
    console.log(`Completed ${completed}/${total} price batches`);
  });
  await writeFile(new URL('../data/price-scan-report.json', import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'complete') process.exitCode = 1;
} catch {
  console.error('Price scan could not start; details suppressed to protect credentials.');
  process.exitCode = 1;
} finally { cache.close(); }
