import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { CacheDb } from './cache.js';
import { rankCachedPrices } from './cached-ranking.js';

const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
async function main() {
  const startDate = arg('start') ?? '';
  const endDate = arg('end') ?? '';
  const minimumMarketCap = Number(arg('min-cap'));
  const countPerDirection = Number(arg('count'));
  const maxNewRequests = Number(arg('max-new-requests'));
  if (!startDate || !endDate || !Number.isFinite(minimumMarketCap) || !Number.isInteger(countPerDirection) ||
    !Number.isInteger(maxNewRequests)) throw new Error('Invalid diagnostic arguments');
  loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url)));
  const key = process.env.FMP_API_KEY?.trim() || '';
  if (!key) {
    console.log('FMP_API_KEY is not configured. No requests made.');
    process.exitCode = 1;
    return;
  }
  const cache = await CacheDb.open(fileURLToPath(new URL('../data/stock-cache.sqlite', import.meta.url)));
  try {
    const report = await rankCachedPrices(cache, key, { startDate, endDate, minimumMarketCap, countPerDirection, maxNewRequests },
      fetch, (checked, requested) => {
        if (checked % 10 === 0) console.log(`Checked ${checked} profiles; ${requested} new FMP requests`);
      });
    let safeOutput = JSON.stringify(report, null, 2);
    for (const value of [key, encodeURIComponent(key)]) safeOutput = safeOutput.split(value).join('[REDACTED]');
    await writeFile(new URL('../data/ranking-report.json', import.meta.url), `${safeOutput}\n`, 'utf8');
    console.log(safeOutput);
    if (report.result.status === 'incomplete') process.exitCode = 2;
  } finally { cache.close(); }
}
main().catch(() => {
  console.error('Ranking diagnostic failed locally. Raw error details suppressed to protect credentials.');
  process.exitCode = 1;
});
