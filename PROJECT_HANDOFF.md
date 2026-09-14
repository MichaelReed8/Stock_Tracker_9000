# Stock Tracker 9000 — project handoff

Last updated: September 14, 2026.

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
| Data vendor | Financial Modeling Prep (FMP). Start on Free; allow a later tier upgrade. |
| Freshness | End-of-day data is acceptable for the initial version. Live data remains a future preference if affordable. |
| Budget | Ideally around $20/month maximum; minimize costs. User would consider more if live data warrants it. Currency and whether this includes all infrastructure costs were not specified. |
| Initial stock coverage | Supported US individual stocks only, limited by Free historical-price access. |
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

Use a React + TypeScript web interface, a Node.js + TypeScript backend, a database, and standards-based Web Push. These are the working technical direction; exact framework, database vendor, and hosting vendor are not yet selected.

The backend should:

1. Collect permitted FMP data within the daily allowance.
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

Treat these as the user's documentation/account findings. No authenticated endpoint tests have been performed yet.

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

Use Stock Screener → intersect with Basic Stock Chart's supported symbols → retrieve closing-price histories → calculate returns → sort gainers and losers → save alert snapshot.

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

The root `.env.local` file has been created with a blank entry:

```dotenv
FMP_API_KEY=
```

The user should open `.env.local` manually in the editor, paste the key immediately after `=`, and save. Never put the actual value in this handoff, `.env.example`, chat, a source-code constant, or a frontend bundle.

`.env.local` is ignored by Git. `.env.example` is a safe, blank configuration template. AGENTS.md instructs agents not to inspect, search, display, or overwrite actual credential files. Backend code may load the key at runtime without returning its value to the agent. Redact authenticated URLs and errors, since FMP uses an API-key query parameter.

Git ignore and agent instructions do not create a technical filesystem access barrier. A readable local file could still be accessed by a process with permission. The intended protection here is keeping the key out of code/Git/model context and honoring explicit agent instructions; an enforced denial would require a separate permissions or secret-management setup.

No backend exists yet, so environment loading still needs implementation. Do not use a frontend-public variable such as `VITE_FMP_API_KEY`, `NEXT_PUBLIC_FMP_API_KEY`, or `EXPO_PUBLIC_FMP_API_KEY`.

## State at handoff and next steps

The repository originally contained only a project-name README. No application, database, authenticated API probe, market scan, or push integration has been implemented. This handoff and local configuration placeholders are the first project additions. No credentials have been supplied.

Next session:

1. Read this handoff and AGENTS.md. Preserve the accepted PWA/FMP Free direction and latest user corrections.
2. After the user enters the key locally, implement a sanitized backend-only capability probe. Inspect response fields/status without exposing credentials.
3. Establish Basic Stock Chart's exact supported-symbol set, usable screener fields, profile fields, history availability/adjustments, industry methodology, and scan request budget.
4. Choose lightweight hosting/database options and resolve any period/calculation details needed for a concrete implementation.
5. Scaffold the TypeScript PWA/backend, preferences and alert storage, then implement stock and industry summaries.
6. Add shared scheduling, the two Web Push notification types, and links to saved results. Validate on the user's iPhone.
7. Add polish/history and, later, ETF/Canadian/live data and AI as supported and desired.

The user stopped for the day and requested this written handoff and a place to enter the API key. Resume from here rather than repeating the product-discovery conversation.
