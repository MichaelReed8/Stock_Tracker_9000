# Stock Tracker 9000 — project handoff

Last updated: October 19, 2026. September provider observations remain historical; an October 19 bounded profile/ranking check is recorded below.

## October 19: serverless and cache policy update

The user selected AWS serverless so collection runs without opening the editor or keeping a PC awake. A first deployable slice now includes an hourly EventBridge Scheduler profile worker, Lambda, DynamoDB persistence/atomic budgets/leases, Secrets Manager access, failure queue and alarms. The schedule defaults disabled and nothing is deployed yet. See [AWS_SETUP.md](AWS_SETUP.md) for setup, safe local-cache migration, activation, limitations and the remaining cloud price/summary work. AWS CLI 2.38.1 and SAM CLI 1.169.0 are installed, and SAM lint validation passed. Browser sign-in succeeded for profile `stock-tracker-9000` as root; configure a separate deployment identity before deployment.

This supersedes the earlier seven-day hard profile expiry: queue proactive refresh at 90 days in the cloud worker; allow reuse under 180 days and retain older observations. Local ranking uses the same 180-day reuse limit, records profile observation dates, and still returns incomplete when necessary observations cannot be obtained. These are initial engineering settings; market caps near a filter cutoff may change sooner. Local and cloud counters are separate, so stop local provider jobs when cloud collection is enabled and account for activation-day usage. No provider calls or AWS deployment were made while implementing this slice.

The next milestone is deploying automatic profile collection, then adding hosted price ingestion and usable summaries, rather than repeating small manual ranking diagnostics.

## Latest provider decision

After the FMP screener returned HTTP 402, the user chose Alpaca for US symbols/prices and FMP profiles for market cap/classification plus FMP industry data. Alpaca credentials worked on September 22: the active asset list contained 14,357 entries and AAPL/MSFT split-adjusted SIP histories were retrieved. Initial FMP profile probes succeeded for AAPL, MSFT, SOUN and RIOT; subsequent enrichment and ranking runs expanded the sample as documented below, without proving universal access. FMP stock-list and profile-bulk returned HTTP 402. See [ALPACA_SETUP.md](ALPACA_SETUP.md) and [FMP_CAPABILITY_REPORT.md](FMP_CAPABILITY_REPORT.md).

A full Alpaca price coverage scan was subsequently completed for September 18 and 21, 2026: 144/144 batches succeeded, 144 Alpaca requests were made, and 13,244 of 14,357 active US asset entries had prices on both dates. This establishes usable price coverage for that interval, not company classification or market-cap qualification. No FMP requests were used in the full price scan. The resumable implementation and report are documented in [ALPACA_SETUP.md](ALPACA_SETUP.md).

Earlier on September 22, the user selected FMP Free for stocks and industries. The subsequent screener HTTP 402 findings superseded that direction: use Alpaca assets/prices and FMP individual profiles/industry data. Do not implement the inaccessible screener path. Alpha Vantage is not selected.

The user reaffirmed the 250-call daily budget as the starting assumption. The shared local profile ceiling is 200 attempts per UTC day, leaving 50 for industry data and other usage. It cannot observe external requests or verify the vendor reset time. Prioritize profile requests needed by return-ordered ranking; background alphabetical enrichment is optional and now defaults to at most 25 new requests per run within that same ceiling. Run ranking before optional filling. No automatic scheduler enforces this ordering yet. Report incomplete rankings explicitly rather than silently truncating them.

The September 22 enrichment report saved 73 profiles from 79 requests and recorded 111 cached candidate profiles, with 13,520 missing. It stopped after three HTTP 402 responses. The code was subsequently changed to skip consecutive per-symbol 402 responses while stopping on authentication, rate-limit, API-error payloads, or request failures. The saved report is historical and must not be rewritten to imply a new run.

A full weekly refresh of 13,631 candidates would require at least 1,948 profile requests/day, beyond the 200-attempt ceiling. Filling the missing 13,520 takes at least 68 days even if all 200 attempts/day succeed and none are used for refreshes or ranking. Do not wait for a fully fresh universe: use the 90-day refresh target/180-day reuse policy described above. Cached count alone does not establish usable coverage.

## Product intent

Build a personal financial app for the user's iPhone that sends customizable push notifications about interesting market movements and makes it easy to investigate them. Keep the interface simple, with essential stock information and external research links.

The central experience is: notification → matching market summary → stock or industry details → further investigation. An eventual AI layer explains movements using relevant news; it is not intended to issue buy/sell signals.

The original Copilot product discussion and implementation plan were reviewed with the user, who confirmed the overall understanding. The decisions below reflect subsequent corrections and choices made with Codex.

## Accepted decisions

| Topic | Decision |
| --- | --- |
| Audience | Personal use for now. |
| Delivery | Progressive Web App (PWA) added to the iPhone Home Screen. |
| Development machine | Windows; no Mac available. |
| Apple membership | Avoid a paid Apple Developer account by using Web Push. No TestFlight required for this approach. |
| Data vendors | Alpaca for US assets/prices; FMP Free individual profiles for market cap/classification and FMP industry data. |
| Freshness | End-of-day data is acceptable for the initial version. Live data remains a future preference if affordable. |
| Budget | Ideally around $20/month maximum; minimize costs. User would consider more if live data warrants it. Currency and whether this includes all infrastructure costs were not specified. |
| Initial stock coverage | Supported US individual stocks with Alpaca price coverage and usable FMP profiles. |
| Future coverage | Configurable US, Canadian, or combined coverage, including ETFs once supported. |
| ETFs | Explicitly deferred because the selected Free access does not include them. |
| Frequencies | Daily, weekly, biweekly, and monthly, with a user-configurable delivery time. |
| Weekly period | Friday delivery, covering Monday–Friday trading sessions. |
| Notification types | Exactly two types: stock movers and industry movers. Both share one frequency and delivery-time setting. No third notification type or separate additional schedules. |
| Directions | User can include gainers, losers, or both. |
| Industry performance | Equal-weighted: each company's percentage return has equal influence. |
| AI | Ship the first working version without AI. |

The industry-notification toggle remains part of the original requirement. When enabled, it follows the same schedule as stock notifications; the interaction between disabling industries and the two-notification rule should be made explicit during implementation.

## Notifications and interface

- Stock notifications identify the biggest percentage gainers and losers within supported coverage and the user's active filters.
- Industry notifications identify the best- and worst-performing selected industries.
- Settings include delivery frequency/time, minimum company market cap, selected industries, direction toggles, and counts of results.
- When both directions are enabled, each notification type can contain both gainers and losers; do not create separate pushes per direction.
- Persist the results that generated each notification. Tapping it opens that same saved summary rather than a newly calculated list.
- Opening the app normally shows the latest saved summary. A stock card shows ticker, company name, period return, and only useful basic information.
- Stock details show the period, return, available market cap/classification, and an external information link. No complex charts or portfolio manager are required.
- Industry details can show performance and member-stock information where the available data permits it.
- Clearly identify stock rankings as "Top movers among supported US stocks" until coverage broadens. Industry endpoint coverage may be broader and must be described separately.

Proposed screens: Market Summary, Stock Detail, Industry Detail, Settings. Notification history is a later improvement.

## PWA architecture

Use a React + TypeScript web interface, a Node.js + TypeScript backend, and standards-based Web Push. AWS Lambda/EventBridge/DynamoDB/Secrets Manager are now selected for the backend; local diagnostics retain SQLite. Frontend framework details and the PWA hosting configuration remain pending.

The backend should:

1. Collect Alpaca prices/assets and permitted FMP profiles/industry data within their request limits.
2. Cache company metadata and retain dated price/industry observations.
3. Apply preferences and calculate stock returns/rankings.
4. Save immutable alert snapshots.
5. Run scheduled jobs in the user's timezone, accounting for trading calendars and data-publication timing.
6. Send stock and industry Web Push messages and link each to its saved snapshot.

The PWA displays backend results and manages preferences and push enrollment. Market scans and notification scheduling run on the server rather than depending on the phone remaining open.

Host over HTTPS. Configure a web manifest, Home Screen icons, and the necessary push/service-worker behavior. Store push subscriptions on the backend. Choose lightweight hosting/database options after checking their capabilities and current pricing.

iPhone setup: iOS 16.4 or later → open the website → Add to Home Screen → launch the installed web app → tap an enable-notifications button → grant permission. Web Push does not require Apple Developer membership. Notifications can appear on the lock screen and in Notification Center.

References:

- [Apple Web Push documentation](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
- [WebKit: Web Push for iPhone Home Screen apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

## FMP access: latest user-provided understanding

The bullets below preserve the user's earlier documentation/account findings. Authenticated tests on September 22 now supersede the screener-access assumption: all three tested screener requests returned HTTP 402, including a request with only `limit=10`. AAPL profile, AAPL/MSFT light price histories, industry snapshot, and Biotechnology industry history succeeded. See [FMP_CAPABILITY_REPORT.md](FMP_CAPABILITY_REPORT.md) and the sanitized JSON reports. The exact cause of the screener restriction and broader symbol coverage remain unverified.

- Free allows 250 API calls/day and initial use of end-of-day data.
- Stock Screener: available filters are usable except the exchange filter/access option, according to the user's latest clarification. Do not discard the screener based on earlier uncertainty.
- Company Profile: available for all US stocks, per the user. It may provide market cap even where the separate market-cap endpoints are restricted. Verify actual fields and missing values.
- Basic Stock Chart: limited to a set of US stocks. The user accepts that limitation. Its exact supported-symbol list is still needed.
- Dedicated market-cap endpoints show symbol restrictions in the user's screenshots. Do not assume those restrictions apply identically to Company Profile.
- Biggest Stock Gainers and Losers are shown as accessible, but their leaderboard cannot directly implement the desired market-cap-qualified rankings. Do not use it as the sole candidate universe.
- Industry/sector snapshot and historical endpoints appear to cover US exchanges with up to one month of historical retrieval under the selected access.
- ETFs are unavailable for this version. Canadian coverage is deferred.

Actual access, response size/pagination, symbol coverage, missing fields, history depth, and request accounting must be checked with the user's key before finalizing scan capacity. The free-call allowance does not imply every endpoint supports every symbol.

FMP pricing changed or differed between fetched pages during the discussion. Do not rely on quoted paid-tier dollar figures from chat; verify current pricing if upgrading. The selected Free tier is the relevant starting point.

## Individual-stock approach

October 19 diagnostic: reran cached September 18/21 prices with the same test settings ($10B minimum cap, five per direction), capped at 25 new FMP requests. All 25 returned usable profiles and were cached; none qualified (below cap, non-US domicile, or fund/ETF). No fresh-cache hits were available for those candidates. The next candidate, NUAI, hit the local run limit, so the result was `incomplete` / `budget_exhausted`, with no winners and no loser pass. This was not vendor quota exhaustion. No Alpaca calls or notifications were made. `data/ranking-report.json` contains the latest report; `data/profile-enrichment-report.json` remains the historical September background-fill report. A subsequent bounded ranking run can reuse these refreshed profiles. Profiles describe current metadata, not historical market caps for the September prices.

Current approach: Alpaca asset list → split-adjusted SIP daily bars → calculate period returns → exclude explicitly described warrants/rights → inspect/cache FMP profiles in return order → apply market-cap, company/fund and industry criteria → save a summary only if the ranking completes. The paid FMP screener is not used. The older FMP endpoint table below is historical context for the initial provider evaluation.

The first cached ranking diagnostic used a $10B threshold and five results per direction (test settings). It made 50 new FMP requests across two attempts, cached 49 successful profiles, and stopped during the gainers pass before reaching qualifying results or checking losers. After excluding 602 explicitly described warrants/rights, 12,642 priced candidates remained. The per-run request limit triggered the expected incomplete result; this was not vendor quota exhaustion. See `data/ranking-report.json` and [ALPACA_SETUP.md](ALPACA_SETUP.md). Continue building on the cache instead of downloading Alpaca prices again for this interval.

Minimum market cap is a qualification filter. Rank the qualified stocks by percentage return, not by market cap. Filtering an already truncated global gainers/losers leaderboard can miss qualifying companies outside that leaderboard.

Candidate endpoints:

| Endpoint | Purpose |
| --- | --- |
| `/stable/company-screener` | Find companies matching supported filters; inspect market cap and classification fields. |
| `/stable/profile?symbol=AAPL` | Company metadata for display and filtering; cache it. |
| `/stable/historical-price-eod/light?symbol=AAPL` | Dated closing-price history within supported stock coverage. |

Documentation:

- [Stock Screener](https://site.financialmodelingprep.com/developer/docs/stable/search-company-screener)
- [Basic Stock Chart](https://site.financialmodelingprep.com/developer/docs/stable/historical-price-eod-light)
- [Company Profile APIs](https://site.financialmodelingprep.com/datasets/company-profile)
- [FMP plan comparison](https://site.financialmodelingprep.com/developer/docs/pricing)
- [FMP FAQ and request accounting](https://site.financialmodelingprep.com/faqs)

Stock period return:

```text
percent_return = 100 × (ending_close / starting_close − 1)
```

For a full Monday–Friday trading week, the proposed baseline is the prior Friday's close through the current Friday's close. Adjust to actual trading sessions around holidays. Confirm split adjustment so stock splits do not create false movers. Dividend treatment should be explicit: price return versus total return is not yet decided.

If screener results are truncated, retrieve the complete supported qualifying set using available pagination or other documented means; do not silently rank an arbitrary partial response.

An illustrative scan of 100 accessible stocks using one history request per stock takes 100 calls, plus metadata/industry requests. This is an estimate, not a verified entitlement or final stock count. Cache metadata and reuse downloaded history for multiple periods.

Batch means requesting several specified symbols together; bulk means downloading a large dataset or chunks of it. They can save calls if accessible, but we have not established Free access to broad batch/bulk data and must not assume it.

## Industry data and interpretation

The user supplied these documentation examples:

```json
[
  {
    "date": "2024-02-01",
    "industry": "Advertising Agencies",
    "exchange": "NASDAQ",
    "averageChange": 3.8660194344955996
  }
]
```

Industry Performance Snapshot example above; display approximately **+3.87%**.

```json
[
  {
    "date": "2024-03-01",
    "sector": "Energy",
    "exchange": "NASDAQ",
    "averageChange": 1.3989969286740689
  }
]
```

Historical Market Sector Performance example above; display approximately **+1.40%**. These are example dates, not current market observations.

`averageChange` is already a percentage, not a fractional return. Do not multiply it by 100 for display.

Potential endpoints include Industry Performance Snapshot, Historical Industry Performance, Market Sector Performance Snapshot, and Historical Market Sector Performance. Sector groups and industries differ in granularity; the UI's grouping choice remains open.

- [Industry snapshot documentation](https://site.financialmodelingprep.com/developer/docs/stable/industry-performance-snapshot)
- [Historical industry documentation](https://site.financialmodelingprep.com/developer/docs/stable/historical-industry-performance)

Verify FMP's weighting and each historical row's period. The field name alone does not prove equal weighting or a weekly/monthly return. Do not simply add daily returns. Compounding daily industry averages represents a different methodology from averaging each constituent's full-period return.

If FMP returns separate exchange-level averages, a combined equal-weighted average needs constituent counts and a defined treatment of duplicate listings. Averaging exchange averages equally would weight exchanges equally, not companies.

Provider industry aggregates cannot automatically reflect a custom minimum-market-cap filter on their constituents. Stock filters and industry group selection should remain explicit; do not imply personalized aggregate calculations without the underlying data.

## Proposed defaults and remaining questions

These are proposals, not all confirmed by the user:

- Biweekly means every two weeks, proposed delivery every second Friday; the anchor date is undecided.
- Monthly means the calendar month, proposed delivery on its final trading day.
- Use the user's timezone, provisionally America/Toronto from the workspace environment.
- Daily alerts cover the latest completed trading session. Choose a delivery time after FMP publishes closing data and define behavior when a requested time is earlier.
- Account for holidays, weekends, missed runs, stale data, and duplicate notification prevention.
- Missing market cap displays "Unavailable"; exclude unknown-cap stocks when a minimum-cap filter is active. This was proposed, not explicitly approved.
- Confirm counts per direction, minimum movement thresholds if desired, broad sectors versus finer industries, and shared frequency/period semantics.
- EPS filters were a Copilot proposal, not a confirmed user requirement.
- Future ETF size filtering could use fund assets, with ETFs excluded from company industry averages to avoid duplication. These future details were proposed but not confirmed.
- Live browsing versus fresh scheduled-alert data remains undecided for a future live tier.
- Database, hosting, personal access/authentication, and an external research-link destination remain implementation choices.

## Future AI layer

Fetch relevant company news and combine it with the saved price movement and company context. Produce a short explanation of the probable catalyst and whether the evidence appears consistent with the move, with sources and uncertainty. Avoid treating coincident news as proven causation.

Examples from the user's original idea: a new product announcement with a price increase might support the movement; a price increase despite a major fine might warrant further investigation. AI explanations are deferred and should attach to saved stock results without requiring a UI rewrite.

## Local API key setup

The root `.env.local` file was initially created with this blank entry; the user subsequently entered a key locally, and the backend probe confirmed configuration presence without exposing its value:

```dotenv
FMP_API_KEY=
```

The user should open `.env.local` manually in the editor, paste the key immediately after `=`, and save. Never put the actual value in this handoff, `.env.example`, chat, a source-code constant, or a frontend bundle.

`.env.local` is ignored by Git. `.env.example` is a safe, blank configuration template. AGENTS.md instructs agents not to inspect, search, display, or overwrite actual credential files. Backend code may load the key at runtime without returning its value to the agent. Redact authenticated URLs and errors, since FMP uses an API-key query parameter.

Git ignore and agent instructions do not create a technical filesystem access barrier. A readable local file could still be accessed by a process with permission. The intended protection here is keeping the key out of code/Git/model context and honoring explicit agent instructions; an enforced denial would require a separate permissions or secret-management setup.

The dependency-free Node diagnostic in `scripts/fmp-probe.mjs` implements backend-only environment loading. The cloud collection worker reads an existing Secrets Manager secret at runtime. The public application API is not yet built. Do not use a frontend-public variable such as `VITE_FMP_API_KEY`, `NEXT_PUBLIC_FMP_API_KEY`, or `EXPO_PUBLIC_FMP_API_KEY`.

## State at handoff and next steps

The repository includes local diagnostics plus a deployable scheduled AWS profile worker. No resources are deployed, and cloud price jobs, PWA/API, immutable notification snapshots and Web Push are not implemented. All 29 offline tests pass, including the final next-UTC-day retry adjustment. TypeScript, bundle building/loading, template safeguard checks, Git diff whitespace checks and SAM lint validation also pass. Commands: `npm test`, `npm run typecheck`, `npm run cloud:build`, `npm run cloud:validate`, `sam validate --lint --template-file template.yaml --region ca-central-1`. A deployed smoke test remains required.

Next session:

1. Read this handoff and AGENTS.md. Preserve the accepted PWA/Alpaca/FMP direction and latest user corrections.
2. Follow AWS_SETUP.md to configure/deploy the disabled worker, migrate existing profiles, then enable collection with the correct activation-day budget. Stop local provider commands once cloud jobs are active. Confirm the market-cap threshold and country/listing interpretation before product defaults are finalized.
3. Implement frequency-aware period selection using trading sessions; confirm industry methodology and request budget. Manual September 18/21 dates were only a daily coverage test.
4. Build hosted dated price ingestion and summaries on the selected AWS backend; resolve period/calculation details and frontend hosting configuration.
5. Scaffold the TypeScript PWA/backend, preferences and alert storage, then implement stock and industry summaries.
6. Add shared scheduling, the two Web Push notification types, and links to saved results. Validate on the user's iPhone.
7. Add polish/history and, later, ETF/Canadian/live data and AI as supported and desired.

Resume from the authenticated findings rather than repeating product discovery or assuming the screener is available.
