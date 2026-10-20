import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CacheDb } from '../cache.js';
import { CloudStore } from './store.js';

// Explicit migration command: AWS credentials use the normal SDK chain, never .env.local.
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0].startsWith('--table=') || !args[0].slice(8)) throw new Error('Set --table');
  const store = new CloudStore(args[0].slice(8));
  const owner = `import-${randomUUID()}`;
  if (!await store.acquire(owner, new Date())) throw new Error('Worker active');
  let cache: CacheDb | undefined;
  try {
    cache = await CacheDb.open(fileURLToPath(new URL('../../data/stock-cache.sqlite', import.meta.url)));
    const day = new Date().toISOString().slice(0, 10);
    const localAttempts = cache.getFmpAttempts(day);
    await store.importLocalBudget(day, localAttempts);
    const existing = new Map((await store.entries()).map(entry => [entry.symbol, entry]));
    let copied = 0;
    for (const asset of cache.getAssets()) {
      const profile = cache.getProfile(asset.symbol);
      if (!profile || !Number.isFinite(Date.parse(profile.fetchedAt))) continue;
      const current = existing.get(asset.symbol)?.profile;
      if (current && Date.parse(current.fetchedAt) >= Date.parse(profile.fetchedAt)) continue;
      await store.save({ symbol: asset.symbol, profile });
      copied++;
    }
    // Do not import the old asset list as a current observation; cloud fetches a new one.
    console.log(JSON.stringify({ copiedProfiles: copied, providerRequests: 0,
      localProfileAttemptsToday: localAttempts,
      note: 'Today\'s locally tracked attempts were carried into the cloud budget without double counting on repeat imports. Stop local provider jobs after migration; external usage remains untracked.' }));
  } finally { cache?.close(); await store.release(owner); }
}
main().catch(() => {
  console.error('Local profile import failed; raw AWS/local error details suppressed.');
  process.exitCode = 1;
});
