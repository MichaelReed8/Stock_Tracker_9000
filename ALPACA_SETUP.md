# Alpaca pricing and local cache

The first backend slice now reads split-adjusted historical US stock bars from Alpaca's consolidated SIP feed and saves them in a local SQLite database. It also caches Alpaca's active US asset list and FMP company profiles. The SQLite file is `data/stock-cache.sqlite`; `data/` is Git-ignored. This is a single-process local cache, not yet a hosted database or a scheduled notification service.

## Verified September 22, 2026

- Alpaca credentials in the user's `.env.local` worked for historical bars and the active US asset list.
- The asset list contained 14,357 entries. This is a mixed equity universe; each candidate still needs stock/fund classification from a company profile.
- AAPL and MSFT each returned ten daily SIP bars between September 8 and 21. The probe requested `adjustment=split`, then calculated percentage change from the first and last returned closes. The two results were approximately +7.20% and +1.55%. These are probe examples, not scheduled alert rankings.
- FMP profiles for AAPL, MSFT, SOUN, and RIOT returned market cap, industry, and ETF/fund flags. All four were cached. This broadens the sample but does not establish access for every symbol.
- A local FMP request counter recorded those four profile calls. It cannot see requests made outside this app or those made by the earlier diagnostic. The current automatic ceiling is 200 profile attempts per UTC day, leaving a buffer relative to the user's reported 250-call plan allowance.

### Full price coverage check

The first full scan compared the completed trading sessions of September 18 and September 21, 2026. All 144 batches of up to 100 symbols succeeded, using 144 Alpaca requests and no FMP requests. Of the 14,357 cached active US asset entries, **13,244 (92.2%) had split-adjusted SIP closing prices on both dates**. Another 3 had a close only on September 21, none had a close only on September 18, and 1,110 had neither. The sanitized report is saved at `data/price-scan-report.json`; the price bars are in the SQLite cache. The scan is resumable and rerunning it for the same asset list and dates skips completed batches.

`status: complete` means every Alpaca batch was fetched; it does not mean all 13,244 entries are individual companies or meet the user's market-cap threshold. The 13,244 are the price-qualified universe for this one daily interval. Company/fund classification and market-cap qualification still require FMP profiles. Missing prices were excluded from the price-qualified count rather than silently counted as zero movers.

Sources: [Alpaca historical bars](https://docs.alpaca.markets/us/reference/stockbars), [Alpaca assets](https://docs.alpaca.markets/us/reference/get-v2-assets-1), [FMP company profile](https://site.financialmodelingprep.com/developer/docs/stable/profile-symbol).

## Run locally

### First cached ranking check

On September 22, the cached September 18/21 prices were ranked with diagnostic settings of a $10B minimum market cap, five gainers and five losers, and 50 new FMP requests across two attempts. These are test settings, not accepted app defaults. The first attempt fetched 39 profiles and stopped on an access-denied response for IRAB.WS. Its cached Alpaca description explicitly identified redeemable warrants.

The revised candidate filter excludes descriptions explicitly identifying warrants or ending in Right/Rights. It does not guess from a symbol ending in W or R and is not a complete security-type classifier. This excluded 602 of the 13,244 priced assets, leaving 12,642 candidates still requiring FMP qualification. ETF/fund exclusions still use FMP flags.

The second attempt reused 24 cached profiles and fetched ten more, reaching the 50-request diagnostic allowance across both attempts. No checked candidate met all filters, and the scan stopped during the gainers pass before checking losers. It returned `incomplete` and produced no alert. This was a local per-run limit, not evidence that FMP's account quota was exhausted. Forty-nine successful new profiles were saved across both attempts. Reports are in `data/ranking-first-attempt.json` and `data/ranking-report.json`.

Market caps come from the latest profiles (cached for up to seven days), not historical market caps for September 18/21. The current country check means company domicile `US`; it does not mean every US-listed foreign company qualifies. Dates remain manual diagnostic inputs; report-frequency/calendar selection and notification scheduling are still pending.

Use Node 20.12 or later. Keep actual credentials only in `.env.local`:

```dotenv
FMP_API_KEY=your-local-value
ALPACA_API_KEY_ID=your-local-value
ALPACA_API_SECRET_KEY=your-local-value
```

The values above are placeholders. Never put actual keys in this file, `.env.example`, Git, chat, or frontend code.

```powershell
npm ci
npm run alpaca:probe
npm run price:scan -- --start=2026-09-18 --end=2026-09-21
npm run ranking:check -- --start=2026-09-18 --end=2026-09-21 --min-cap=10000000000 --count=5 --max-new-requests=50
npm run profiles:seed
npm test
npm run typecheck
```

The Alpaca probe fetches the active asset list and up to 15 calendar days of bars for AAPL and MSFT. Running it again refreshes those cached bars. The profile seed checks four named stocks and reuses profiles until they are seven days old. No script prints keys, authenticated URLs, raw vendor errors, or raw response bodies.

The `price:scan` command fetches two explicitly chosen dates up to seven calendar days apart. It reads the cached Alpaca asset list, requests up to 100 symbols per batch, records each completed batch in SQLite, and writes only counts to the report. It stops with `status: incomplete` on a failed request or at its 190-request safety limit. Choose dates that are completed trading sessions; the command does not yet use an exchange calendar.

`ranking:check` requires a completed cached price scan for the same asset list and dates. It makes no Alpaca calls, reuses fresh profiles, and stops at the specified new-request limit or the shared 200-per-UTC-day local profile ceiling. The report contains a per-symbol filtering audit. All diagnostics have `notificationEligible: false`, even when ranking completes; scheduled immutable alert snapshots are a later step. A rerun can advance past previously checked symbols using cached profiles. Incomplete rankings contain no partial winners; the script sets exit code 2 (npm/Windows may expose this as a generic failure).

## How stock filtering will work

### Fill the profile cache with unused requests

`npm run profiles:fill -- --dry-run` shows the pending cache queue and local daily counter without loading credentials or calling either provider. `npm run profiles:fill` processes the cached Alpaca asset list in symbol order, prioritizing missing profiles before stale profiles. Explicit warrants/rights are excluded; other classifications are cached for later filtering. It saves every successful profile immediately and records attempts so unavailable symbols are not repeatedly requested by this command on the same UTC day. Fresh profiles are reused. No price requests or notifications are made.

The default shared profile ceiling remains 200 attempts per UTC day. On September 22 the user authorized using the reserve as well: `npm run profiles:fill -- --daily-limit=240` allows 240 tracked profile attempts, accounting for the ten earlier probe calls outside that counter against the assumed 250-call allowance. This override is specific to the known usage that day; external requests and the vendor's reset time are not observable from the local counter. The fill stops on rate limiting, repeated access denials, network/HTTP errors, the selected local ceiling, or a UTC date change. It does not retry automatically. Single-symbol access denials can be skipped; three consecutive denials stop the run.

The sanitized result is written to `data/profile-enrichment-report.json`. Run only one cache writer at a time. Subsequent runs resume from saved profiles/attempts; they do not imply complete ranking coverage.

`scanStockUniverse` in `src/stock-scan.ts` reads the cached Alpaca asset universe and requests daily bars in batches of at most 100 symbols. It stores dated closes, calculates period returns, then checks FMP company profiles for the highest gainers and losers in order. Profiles supply market cap, industry, country, and fund/ETF flags. A market-cap threshold qualifies a company; return determines its rank. Profile results are cached for seven days.

The scan returns `status: incomplete` if Alpaca fails, there are no usable prices, a needed profile is unavailable, or the local FMP request ceiling is reached. A future notification job must send only when `status: complete`; it must not send partial lists. The result also reports how many Alpaca assets had prices on both requested dates, so the UI can label the actual ranking coverage. Alpaca assets may contain funds and listings that have no price bars; they do not become candidates without two dated closes and qualifying FMP profile fields.

This scan is a backend function, not a scheduled job yet. Before production notifications, choose exact trading-session dates, confirm acceptable cap freshness, handle corporate actions and symbol changes, and validate coverage and provider quotas across a full scan. The local SQLite writer must run in one process at a time; hosted deployment will need a database with concurrency support or a dedicated single worker.
