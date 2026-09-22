import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { AlpacaClient, percentChange } from './alpaca.js';
import { CacheDb } from './cache.js';

try { loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url))); }
catch {
  console.log('Local configuration could not be loaded. No Alpaca requests made.');
  process.exit(1);
}

const keyId = process.env.ALPACA_API_KEY_ID?.trim() || '';
const secret = process.env.ALPACA_API_SECRET_KEY?.trim() || '';
if (!keyId || !secret) {
  console.log('Alpaca credentials are not configured in .env.local. No Alpaca requests made.');
  process.exit(1);
}

const today = new Date();
const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
end.setUTCDate(end.getUTCDate() - 1);
const start = new Date(end);
start.setUTCDate(start.getUTCDate() - 14);
const startDate = start.toISOString().slice(0, 10);
const endDate = end.toISOString().slice(0, 10);
const cache = await CacheDb.open(fileURLToPath(new URL('../data/stock-cache.sqlite', import.meta.url)));
try {
  const client = new AlpacaClient(keyId, secret);
  const assets = await client.activeUsAssets();
  await cache.replaceAssets(assets, today.toISOString());
  const symbols = ['AAPL', 'MSFT'];
  const bars = await client.dailyBars(symbols, startDate, endDate);
  await cache.putBars(bars);
  const summary = symbols.map(symbol => {
    const rows = cache.getBars(symbol).filter(row => row.date >= startDate && row.date <= endDate);
    return { symbol, bars: rows.length,
      firstDate: rows[0]?.date ?? null, lastDate: rows.at(-1)?.date ?? null,
      sampleChangePercent: rows.length >= 2
        ? Number(percentChange(rows[0].close, rows.at(-1)!.close).toFixed(4)) : null };
  });
  console.log(JSON.stringify({ provider: 'Alpaca', feed: 'sip', adjustment: 'split',
    activeUsAssetCount: assets.length, interval: { startDate, endDate },
    summary, cache: 'data/stock-cache.sqlite' }, null, 2));
} catch {
  console.error('Alpaca pricing check failed. Request details suppressed to protect credentials.');
  process.exitCode = 1;
} finally { cache.close(); }
