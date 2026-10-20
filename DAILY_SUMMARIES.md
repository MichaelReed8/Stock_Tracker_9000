# Daily closing prices and saved stock summaries

The existing hourly Lambda now runs two stages: bounded FMP profile enrichment, then Alpaca daily-price collection and summary generation. There is no second scheduler, database, secret or worker role. Prices run even when the profile allowance is exhausted or the profile stage fails. Unexpected profile-stage crashes are still reported as Lambda errors after attempting the price stage. The profile stage has a two-minute target so it cannot consume the entire ten-minute invocation before prices start.

The user selected **$10B minimum market cap and five gainers/five losers** for the initial summaries on October 20. These are stack parameters, not yet editable through an app. Country qualification remains company domicile `US`, not all foreign companies listed in the US.

## Deployed verification — October 20

The first live scan covered October 16 → 19, 2026 (Friday's close to Monday's close), using 146 Alpaca requests: one calendar request and 145 price batches. The frozen universe contained 14,412 assets: 712 explicit warrants/rights excluded from rankings, 999 other entries missing one/both closes, and 12,701 priced candidates. Cached profiles resolved 301 candidates: 17 qualified, 129 were below the selected cap, 117 were funds and 38 had non-US domicile. Another 12,400 had no cached profile. The preview saved five gainers and five losers; it is not a whole-market leaderboard.

The immutable snapshot and `SUMMARY/LATEST` pointer were read back successfully. A second live invocation reused the same snapshot ID with `snapshotCreated=false`, zero new price batches and zero Alpaca requests. Both invocations made zero FMP requests because that day's tracked allowance was exhausted. All 58 offline tests, TypeScript, bundle validation and SAM lint pass. Failure/resume and holiday/DST scenarios were tested offline; no production failure or future session was fabricated.

Final review added a regression for a UTC-day calendar fetched before New York midnight. The horizon fix was deployed, and its live smoke check again reused the original snapshot with zero new price batches and zero FMP requests. CloudFormation reports `UPDATE_COMPLETE`; the original hourly schedule remains enabled, and the new price-health alarm is OK with the existing confirmed email topic.

## Trading periods and prices

- Query Alpaca's US trading calendar for the latest 45 calendar days. Cache validity checks both the UTC retrieval day and the New York market date covered by the request. A cache fetched before New York midnight cannot hide the next day's session. Session closes include holidays/early closures; New York timezone conversion handles DST.
- Select the latest session whose scheduled close is at least **90 minutes** old and the preceding trading session. A Friday-to-Monday interval is a daily return, not a weekend estimate or zero change. Before the latest session becomes eligible, keep the previous completed period.
- Request both dated closes together using SIP daily bars with `adjustment=split`. API `end` is capped at least 20 minutes behind current time for delayed-feed access. Return is `100 * (endClose / startClose - 1)`; dividends are not included. These are Alpaca daily-bar close observations, not a guarantee of an official closing-auction price or permanently unrevised vendor data. The 90-minute buffer is an engineering starting point.
- Freeze the run's active Alpaca asset list and process chunks of up to 100 symbols. Each chunk's two-date bars, asset metadata and observation timestamp commit as one immutable DynamoDB item. A crash after commit cannot leave a partially stored batch.
- Resume only missing batches after failure, then move to the latest eligible session. An unfinished older run finishes first. Outages spanning multiple completed sessions do not automatically backfill every intervening day; the next new run targets the latest eligible period. There is no weekly/monthly job yet.
- A Lambda invocation is bounded to 190 total Alpaca requests (including profile-stage asset requests, calendar and pagination), at least 350 ms between requests, 160 new price batches, and remaining execution time. Reaching a bound leaves the run resumable. Profile calls remain under the separate shared 200-attempt UTC-day FMP ceiling. The last completed summary remains available if the next run fails.

All prices for a company's return come from one request interval/adjustment vintage. Do not combine a starting close saved before a split with an ending close downloaded afterward. Different daily runs can contain different split-adjusted observations for the same calendar date; each retains its own observation time and the pair used. Reuse these pairs for auditing daily summaries. Future weekly/monthly returns need consistent endpoint adjustments, not blindly joining separately collected daily observations. Vendor revisions and future corporate actions do not rewrite an already saved summary.

## Honest initial coverage

A summary is saved only after every planned price batch has been committed and at least one non-warrant/right candidate has both prices. Missing bars are counted and excluded, never assigned a zero return. All candidates with two closes are checked against the cached profiles that exist at summary-generation time. Profiles older than the 180-day reuse window are excluded; the 90-day proactive refresh policy is unchanged.

Known funds/ETFs, non-US domiciles, missing classification/cap fields and companies below the minimum cap are counted separately. Qualifying stocks are ranked by percentage change, not company size. Gainers must be positive and losers negative; fewer than five can be returned when fewer qualify. Stocks include company name, closes, return, cap, industry and `profileObservedAt`.

The label is **Top movers among supported US stocks with cached profiles**. `scope=cached_profile_coverage`, the `coverage` counts and `profileCoverage=partial` identify an intentionally limited initial universe, not a claim about the whole market. `notificationEligible=false`: these saved summaries are previews for the coming app, not alert snapshots or push notifications. The earlier strict diagnostic that aborts on any unresolved leading profile remains available locally, but is not the initial preview pipeline. This follows the user's decision to build usable summaries while profile collection grows.

## Saved revisions

Snapshot IDs hash the period/run, settings, coverage and ranked contents. Rerunning unchanged inputs reuses the existing immutable snapshot. New cached profiles or changed qualifying results can create another immutable snapshot for the same end date, without redownloading the period's prices. The latest pointer advances only to the same or a later end date, with timestamp ordering for revisions. A crash after saving a snapshot but before updating the pointer is repaired by the next run. A price run is marked complete only after its summary is durably saved.

Prices, plans, completed run metadata and summaries have no TTL. Temporary universes/attempts and run reports retain their existing cleanup policies. Storage will grow with daily history; archival/retention settings can be added later. There is no public API or frontend yet.

## Find the records in DynamoDB

In the existing table, query the following `pk` values (and `sk` where listed):

| Partition key | Sort key / contents |
| --- | --- |
| `SUMMARY` | `LATEST`: latest snapshot's end date, ID and `snapshotPk`. |
| `SUMMARY#YYYY-MM-DD` | Immutable snapshot revisions for that end date. Expand `coverage`, `gainers` and `losers`. |
| `PRICE_CONTROL` | `CURRENT`: active/latest price-run ID. |
| `PRICE_RUN` | Run ID: date pair, asset/batch count, collecting/complete status. |
| `PRICE_PLAN#<run-id>` | Frozen batches of asset metadata. |
| `PRICE_BATCH#<run-id>` | Completed batch observations with both dates' bars and adjustment metadata. |
| `CALENDAR` | `US`: cached trading sessions and retrieval time. |
| `RUN` | Reports with `kind=price_collection`, status, committed batch count and snapshot ID. Existing profile reports remain here too. |

Operational logs expose only counts, dates, snapshot ID, stage status and request counts. Data rows are saved in DynamoDB rather than copied into the local JSON diagnostic files. No local provider scripts need to run.

## Viewing summaries

The [summary app](https://h2sdvt677kay6aydbxmjq72k7e0hkrqt.lambda-url.ca-central-1.on.aws/) displays these saved snapshots behind Cognito sign-in. Its read-only API resolves `SUMMARY/LATEST` or an exact date/hash revision. Page visits and refreshes never invoke providers or collection. Coverage and profile dates remain visible. See [FRONTEND.md](FRONTEND.md) for operation and limitations.

## Settings and monitoring

Preserve the existing stack settings and email parameter on updates. New parameters:

| Parameter | Initial value |
| --- | --- |
| `SummaryMinimumMarketCap` | `10000000000` |
| `SummaryCountPerDirection` | `5` |
| `PriceCloseDelayMinutes` | `90` (minimum 20) |

`PriceSummaryStalled` is a sixth operational email alarm. It watches an independent `priceHealthy` metric, so a healthy profile-budget-exhaustion report cannot hide a failed price scan. Three hourly periods without a completed summary or an expected waiting/overlap state trigger the alarm; missing health logs also breach. Incomplete scans remain unhealthy until the summary is complete. Price failures also contribute to the repeated-provider-failure metric. Existing FMP recovery/quota controls and the confirmed SNS subscription are retained. Disable both missing-progress alarm actions when deliberately disabling the entire schedule.

Full-universe daily prices add Alpaca requests, DynamoDB writes/history and some Lambda duration; the original profile-only cost estimate is not a cap for the expanded workload. No paid market-data plan, NAT gateway, extra database or new external service is provisioned by this change.

References: [Alpaca market calendar](https://docs.alpaca.markets/us/v1.4.2/reference/getcalendar-1), [historical bars and split adjustments](https://docs.alpaca.markets/us/reference/stockbars), [delayed SIP access](https://docs.alpaca.markets/us/docs/market-data-faq).
