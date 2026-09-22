import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { CacheDb } from './cache.js';
import { enrichProfiles } from './profile-enrichment.js';

let cache: CacheDb | undefined;
try {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--dry-run' && !/^--daily-limit=\d+$/.test(arg))) {
    throw new Error('Invalid arguments');
  }
  const dailyLimit = Number(args.find(arg => arg.startsWith('--daily-limit='))?.split('=')[1] ?? 200);
  const dryRun = args.includes('--dry-run');
  let key = '';
  if (!dryRun) {
    loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url)));
    key = process.env.FMP_API_KEY?.trim() ?? '';
    if (!key) throw new Error('Missing configuration');
  }
  cache = await CacheDb.open(fileURLToPath(new URL('../data/stock-cache.sqlite', import.meta.url)));
  const report = await enrichProfiles(cache, key, { dailyLimit, dryRun }, fetch, (requests, saved) => {
    if (requests % 10 === 0) console.log(`FMP requests this run: ${requests}; profiles saved: ${saved}`);
  });
  let output = JSON.stringify(report, null, 2);
  if (key) output = output.replaceAll(key, '[REDACTED]').replaceAll(encodeURIComponent(key), '[REDACTED]');
  if (!dryRun) await writeFile(fileURLToPath(new URL('../data/profile-enrichment-report.json', import.meta.url)), output + '\n');
  // The report contains the complete audit; keep console output to counts and stop reason.
  const { audit, ...summary } = JSON.parse(output);
  console.log(JSON.stringify(summary, null, 2));
} catch {
  console.error('Profile enrichment stopped due to a local/configuration error; details suppressed to protect credentials.');
  process.exitCode = 1;
} finally { cache?.close(); }
