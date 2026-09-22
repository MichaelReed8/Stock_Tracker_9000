# Stock_Tracker_9000

A personal iPhone market-movers app, delivered as a Home Screen web app with push notifications.

Read [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md) for the product decisions, architecture, FMP constraints, and next steps.

Enter your FMP API key in the local, Git-ignored `.env.local` file. See the handoff for handling instructions.

See [FMP_CAPABILITY_REPORT.md](FMP_CAPABILITY_REPORT.md) for the authenticated access findings and instructions for running the backend-only diagnostic. Price and industry samples worked; the screener returned HTTP 402, including with minimal parameters.

The current candidate stock-data design uses Alpaca's US asset list and historical bars, with FMP's individual company profiles for market cap and classification. Alpaca API credentials have blank placeholders in `.env.example`; put actual values only in the Git-ignored `.env.local` file when available. Do not replace the existing FMP key.

Alpaca access and four FMP profiles have now been tested with local credentials. See [ALPACA_SETUP.md](ALPACA_SETUP.md) for the verified results, cache design, and local commands.

A first full Alpaca price scan found two-date closing prices for 13,244 of 14,357 listed assets. Market-cap and individual-company filtering is the next coverage check.

The first bounded ranking check is now implemented and tested. It cached 49 additional FMP profiles, excluded explicitly described warrants/rights, and returned `incomplete` at its diagnostic request limit. See `data/ranking-report.json` and the setup document for reproduction and remaining work.
