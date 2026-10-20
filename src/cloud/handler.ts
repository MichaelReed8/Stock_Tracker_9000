import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { setTimeout as delay } from 'node:timers/promises';
import { AlpacaClient } from '../alpaca.js';
import { CloudStore } from './store.js';
import { runProfileJob } from './profile-job.js';
import { runPriceJob } from './price-job.js';
import { collectMarkets } from './collection.js';

export async function handler(_event: unknown, context: { awsRequestId: string; getRemainingTimeInMillis(): number }) {
  try {
    const table = process.env.DATA_TABLE;
    const secretArn = process.env.PROVIDER_SECRET_ARN;
    if (!table || !secretArn) throw new Error('Missing deployment configuration');
    const secret = await new SecretsManagerClient({ maxAttempts: 3 }).send(new GetSecretValueCommand({ SecretId: secretArn }));
    const config = JSON.parse(secret.SecretString ?? '{}');
    const store = new CloudStore(table);
    let alpaca: AlpacaClient | undefined;
    const provider = () => {
      if (typeof config.ALPACA_API_KEY_ID !== 'string' || !config.ALPACA_API_KEY_ID.trim() ||
        typeof config.ALPACA_API_SECRET_KEY !== 'string' || !config.ALPACA_API_SECRET_KEY.trim()) throw new Error('Missing Alpaca configuration');
      return alpaca ??= new AlpacaClient(config.ALPACA_API_KEY_ID, config.ALPACA_API_SECRET_KEY, fetch, 350,
        { maxRequests: 190, shouldStop: () => context.getRemainingTimeInMillis() < 45000 });
    };
    const profileDeadline = Date.now() + 120000;
    const report = await collectMarkets({ profiles: () => runProfileJob(store, {
      owner: context.awsRequestId, key: typeof config.FMP_API_KEY === 'string' ? config.FMP_API_KEY.trim() : '',
      dailyLimit: Number(process.env.PROFILE_DAILY_LIMIT ?? 200), batchLimit: Number(process.env.PROFILE_BATCH_LIMIT ?? 25),
      assets: () => provider().activeUsAssets(),
      remainingMs: () => Math.min(context.getRemainingTimeInMillis(), profileDeadline - Date.now() + 45000),
      pause: () => delay(1000),
    }), prices: () => runPriceJob(store, {
      owner: context.awsRequestId,
      settings: { minimumMarketCap: Number(process.env.SUMMARY_MIN_CAP ?? 10000000000),
        countPerDirection: Number(process.env.SUMMARY_COUNT ?? 5) },
      delayMinutes: Number(process.env.PRICE_CLOSE_DELAY_MINUTES ?? 90), maxBatches: 160,
      assets: () => provider().activeUsAssets(), calendar: (start, end) => provider().calendar(start, end),
      bars: (symbols, start, end, through) => provider().dailyBars(symbols, start, end, through),
      remainingMs: () => context.getRemainingTimeInMillis(),
    }) });
    // Metric filters consume standalone JSON; console.log adds a Lambda text prefix.
    process.stdout.write(JSON.stringify({ ...report, alpacaRequests: alpaca?.requestCount ?? 0 }) + '\n');
    if (report.profileError) throw new Error('Profile stage failed');
    return report;
  } catch {
    // Never log SDK/fetch errors, secret payloads, events, or authenticated URLs.
    console.error('Scheduled profile worker failed; raw details suppressed. Check configuration and AWS metrics.');
    process.stdout.write(JSON.stringify({ event: 'worker_failed', providerFailure: 0, permanentProviderFailure: 0,
      progressHealthy: 0, priceHealthy: 0 }) + '\n');
    throw new Error('Scheduled profile worker failed');
  }
}
