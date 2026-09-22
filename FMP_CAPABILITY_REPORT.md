# FMP capability check

Checked September 22, 2026 using the user's locally configured key. Ten HTTP requests were attempted in total, including two follow-up requests for alternative stock and market-cap sources. Vendor quota consumption and remaining allowance were not returned or verified.

| Check | Result |
| --- | --- |
| Screener: US, market cap above $10B, active, excluding funds/ETFs | HTTP 402; access denied |
| Screener: limit 10 only | HTTP 402; access denied |
| Screener: market cap above $10B and limit 10 only | HTTP 402; access denied |
| AAPL company profile | Success; market cap, sector, industry, and company name present |
| AAPL Basic Stock Chart | Success; 20 dated price rows |
| MSFT Basic Stock Chart | Success; 20 dated price rows |
| Industry snapshot for September 21 | Success; 127 rows with industry, exchange, date, and numeric averageChange |
| Biotechnology industry history | Success; 21 rows with industry, exchange, date, and numeric averageChange |
| FMP stock list | HTTP 402; access denied |
| FMP bulk company profiles, first part | HTTP 402; access denied |

The requested history interval was August 24 through September 21, 2026. Both stock histories spanned those dates. The industry history also spanned those dates; its row count is not a count of unique trading sessions. No performance calculations were performed.

## Interpretation

The current key works for the sampled price/profile and industry requests. The screener failed even without country, asset-type, activity, or market-cap filters. This contradicts the earlier assumption of screener access on this account. HTTP 402 suggests an entitlement restriction, but its precise cause should be confirmed with FMP/account information; raw error bodies were deliberately not retained.

The intended screener-to-price-history scan cannot yet be completed. Do not substitute a truncated movers leaderboard. Resolve screener entitlement with FMP, or choose an explicit stock universe and use cached profiles to filter it locally. The latter would rank only that universe, not the whole US market, and its symbols' price access would still need checking.

Alpaca is being evaluated as a source of the active US symbol universe and historical prices. Its documented asset records do not include market capitalization. FMP's single-symbol profile did return market cap for AAPL, while FMP's stock list and bulk profile endpoints returned HTTP 402. A hybrid design would fetch Alpaca price bars, rank raw returns, and request/cache FMP profiles for high-ranking candidates until enough qualifying stocks are found for each direction. It must report incomplete rankings if the profile budget is exhausted before all higher-ranked candidates are classified. Industry filtering needs the same profile coverage.

## Still unverified

- Complete supported price-symbol set and access beyond AAPL/MSFT.
- Screener fields, pagination, qualifying stock count, and final scan capacity.
- Split/dividend adjustment of the light price endpoint.
- Industry weighting, exchange aggregation, and each historical row's return period.
- Actual daily quota accounting and publication timing.

The $10B threshold was a diagnostic example, not an accepted app default. No exhaustive scan was attempted.

## Reproduce

Requires Node 20.12 or later. From the repository directory:

```powershell
node --test scripts/fmp-probe.test.mjs
node scripts/fmp-probe.mjs
node scripts/fmp-probe.mjs --screen-only
node scripts/fmp-probe.mjs --market-cap-options
```

Tests use fake responses and do not load local credentials or call FMP. The normal probe attempts at most eight requests; each follow-up mode attempts at most two. Each invocation spends additional requests; no automatic retries are used. The probe stops on authentication failures, rate limits, server errors, unexpected payloads, and network failures.

The backend loads `.env.local` without printing it. Only allowlisted summaries are written to `fmp-probe-report.json`, `fmp-screener-report.json`, and `fmp-market-cap-options-report.json`; raw responses, errors, and authenticated URLs are never logged. Exit code zero means the diagnostic completed, not that all endpoints were accessible. Review each result's outcome.
