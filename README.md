# Stock_Tracker_9000

A personal iPhone market-movers app, delivered as a Home Screen web app with push notifications.

Read [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md) for the product decisions, architecture, FMP constraints, and next steps.

Enter your FMP API key in the local, Git-ignored `.env.local` file. See the handoff for handling instructions.

See [FMP_CAPABILITY_REPORT.md](FMP_CAPABILITY_REPORT.md) for the authenticated access findings and instructions for running the backend-only diagnostic. Price and industry samples worked; the screener returned HTTP 402, including with minimal parameters.

The selected stock-data design uses Alpaca's US asset list and historical bars, with FMP's individual company profiles for market cap and classification. Local diagnostics load credentials from the Git-ignored `.env.local`; the cloud worker reads Secrets Manager. Keep actual values out of the repository.

Alpaca access and four FMP profiles have now been tested with local credentials. See [ALPACA_SETUP.md](ALPACA_SETUP.md) for the verified results, cache design, and local commands.

A September 22 Alpaca price scan found two-date closing prices for 13,244 of 14,357 listed assets for September 18/21. This is historical diagnostic coverage, not current market coverage.

Bounded ranking and background profile enrichment are implemented. Optional local `profiles:fill` defaults to 25 new requests/run within its 200-attempt/day ceiling. See [ALPACA_SETUP.md](ALPACA_SETUP.md) for diagnostic commands and historical reports.

AWS serverless is now selected. A deployable hourly profile worker uses Lambda, DynamoDB, EventBridge Scheduler and Secrets Manager, with atomic request accounting and persistent progress. Profiles are queued for refresh at 90 days, reusable under 180 days, and retained afterward. **Nothing is deployed or enabled yet.** See [AWS_SETUP.md](AWS_SETUP.md) for deployment, local-profile migration and budget safeguards. Cloud price ingestion, PWA/API, saved alerts and Web Push remain next steps.
