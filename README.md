# Stock_Tracker_9000

A personal iPhone market-movers app, delivered as a Home Screen web app. Daily summaries are available; market-mover push notifications are planned.

**[Open the summary app](https://h2sdvt677kay6aydbxmjq72k7e0hkrqt.lambda-url.ca-central-1.on.aws/)** — invited email sign-in, daily gainers/losers, stock details and coverage. On iPhone, open in Safari and use Share → Add to Home Screen. See [FRONTEND.md](FRONTEND.md) for setup and local development.

Read [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md) for the product decisions, architecture, FMP constraints, and next steps.

Enter your FMP API key in the local, Git-ignored `.env.local` file. See the handoff for handling instructions.

See [FMP_CAPABILITY_REPORT.md](FMP_CAPABILITY_REPORT.md) for the authenticated access findings and instructions for running the backend-only diagnostic. Price and industry samples worked; the screener returned HTTP 402, including with minimal parameters.

The selected stock-data design uses Alpaca's US asset list and historical bars, with FMP's individual company profiles for market cap and classification. Local diagnostics load credentials from the Git-ignored `.env.local`; the cloud worker reads Secrets Manager. Keep actual values out of the repository.

Alpaca access and four FMP profiles have now been tested with local credentials. See [ALPACA_SETUP.md](ALPACA_SETUP.md) for the verified results, cache design, and local commands.

A September 22 Alpaca price scan found two-date closing prices for 13,244 of 14,357 listed assets for September 18/21. This is historical diagnostic coverage, not current market coverage.

Bounded ranking and background profile enrichment are implemented. Optional local `profiles:fill` defaults to 25 new requests/run within its 200-attempt/day ceiling. See [ALPACA_SETUP.md](ALPACA_SETUP.md) for diagnostic commands and historical reports.

AWS serverless collection is deployed and **enabled hourly** in `ca-central-1`. The same worker collects profiles, daily Alpaca prices and saved stock-summary previews, using Lambda, DynamoDB, EventBridge Scheduler and Secrets Manager. Profiles refresh at 90 days and remain reusable under 180 days. Stop local provider scripts now that cloud collection is active. See [AWS_SETUP.md](AWS_SETUP.md) for operation and budget safeguards.

The first cloud price scan saved 145 batches and a daily summary for October 16 → 19, with 17 cached-profile companies qualifying under the selected $10B/five-per-direction settings. Coverage is explicitly partial while profiles accumulate. An unchanged repeat reused prices and snapshot without provider calls. See [DAILY_SUMMARIES.md](DAILY_SUMMARIES.md) for record keys, session handling, coverage limitations and verification. The authenticated PWA/API now displays these summaries. Industry summaries, longer periods and Web Push remain next.

Hourly recovery now retries temporary network/server failures after a 30-minute cooldown, counting every retry against the same daily limit. Authentication/quota pauses, repeated failures and missing progress have CloudWatch alarms connected to an operational email subscription. Confirm the AWS subscription email to receive alerts; normal hourly runs do not send email.
