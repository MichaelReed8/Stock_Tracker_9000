import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { setTimeout as delay } from 'node:timers/promises';
import { AlpacaClient } from '../alpaca.js';
import { CloudStore } from './store.js';
import { runProfileJob } from './profile-job.js';

export async function handler(_event: unknown, context: { awsRequestId: string; getRemainingTimeInMillis(): number }) {
  try {
    const table = process.env.DATA_TABLE;
    const secretArn = process.env.PROVIDER_SECRET_ARN;
    if (!table || !secretArn) throw new Error('Missing deployment configuration');
    const secret = await new SecretsManagerClient({ maxAttempts: 3 }).send(new GetSecretValueCommand({ SecretId: secretArn }));
    const config = JSON.parse(secret.SecretString ?? '{}');
    for (const name of ['FMP_API_KEY', 'ALPACA_API_KEY_ID', 'ALPACA_API_SECRET_KEY']) {
      if (typeof config[name] !== 'string' || !config[name].trim()) throw new Error('Missing provider configuration');
    }
    const alpaca = new AlpacaClient(config.ALPACA_API_KEY_ID, config.ALPACA_API_SECRET_KEY);
    const report = await runProfileJob(new CloudStore(table), {
      owner: context.awsRequestId, key: config.FMP_API_KEY,
      dailyLimit: Number(process.env.PROFILE_DAILY_LIMIT ?? 200), batchLimit: Number(process.env.PROFILE_BATCH_LIMIT ?? 25),
      assets: () => alpaca.activeUsAssets(), remainingMs: () => context.getRemainingTimeInMillis(),
      pause: () => delay(1000),
    });
    console.log(JSON.stringify(report));
    return report;
  } catch {
    // Never log SDK/fetch errors, secret payloads, events, or authenticated URLs.
    console.error('Scheduled profile worker failed; raw details suppressed. Check configuration and AWS metrics.');
    throw new Error('Scheduled profile worker failed');
  }
}
