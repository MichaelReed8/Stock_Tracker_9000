import { createHash } from 'node:crypto';
import type { AlpacaClient } from './alpaca.js';
import type { CacheDb } from './cache.js';

export type PriceCoverageReport = {
  status: 'complete' | 'incomplete';
  reason?: 'alpaca_request_failed' | 'request_safety_limit';
  startDate: string;
  endDate: string;
  assetCount: number;
  totalBatches: number;
  completedBatches: number;
  alpacaRequestsThisRun: number;
  coverage: { both: number; startOnly: number; endOnly: number; neither: number };
  feed: 'sip';
  adjustment: 'split';
};

export function priceScanKey(symbols: string[], startDate: string, endDate: string): string {
  return createHash('sha256').update(JSON.stringify({
    symbols, startDate, endDate, feed: 'sip', adjustment: 'split', batchSize: 100,
  })).digest('hex');
}

export async function scanPriceCoverage(
  client: AlpacaClient, cache: CacheDb, startDate: string, endDate: string,
  onProgress?: (completed: number, total: number) => void,
): Promise<PriceCoverageReport> {
  const assets = cache.getAssets();
  if (!assets.length) throw new Error('No cached Alpaca assets; run alpaca:probe first');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) ||
    startDate >= endDate ||
    (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 > 7) {
    throw new Error('Choose two ascending dates no more than seven days apart');
  }
  const symbols = assets.map(asset => asset.symbol);
  const runKey = priceScanKey(symbols, startDate, endDate);
  const totalBatches = Math.ceil(symbols.length / 100);
  const completed = cache.completedPriceBatches(runKey);
  let reason: PriceCoverageReport['reason'];
  for (let index = 0; index < totalBatches; index++) {
    if (completed.has(index)) continue;
    if (client.requestCount >= 190) { reason = 'request_safety_limit'; break; }
    try {
      const bars = await client.dailyBars(symbols.slice(index * 100, (index + 1) * 100), startDate, endDate);
      await cache.commitPriceBatch(runKey, index, bars);
      completed.add(index);
      if (completed.size % 10 === 0 || completed.size === totalBatches) onProgress?.(completed.size, totalBatches);
    } catch {
      reason = 'alpaca_request_failed';
      break;
    }
  }
  return {
    status: completed.size === totalBatches ? 'complete' : 'incomplete',
    ...(reason ? { reason } : {}), startDate, endDate,
    assetCount: symbols.length, totalBatches, completedBatches: completed.size,
    alpacaRequestsThisRun: client.requestCount,
    coverage: cache.priceCoverage(symbols, startDate, endDate),
    feed: 'sip', adjustment: 'split',
  };
}
