# Summary app

The React/TypeScript PWA reads saved daily stock summaries from the existing AWS DynamoDB table. It does not collect prices, request company profiles, write to the table, or alter the job's daily provider allowance. Hosting stays in AWS, as selected by the user on October 20.

## Using it

Open the stack's `AppUrl` output. Sign in with your invited email and the temporary password AWS sends directly to you. The first sign-in asks you to choose a password. Never paste passwords or authentication tokens into an agent conversation. The app includes email password recovery.

On iPhone, open the HTTPS URL in Safari, choose Share → Add to Home Screen, and open the resulting icon. This installs the app shell; it does not enable market-mover push notifications. The data requires a connection. The service worker caches only public shell assets, never financial API responses or authentication calls.

The daily summary shows the price dates, minimum market cap, qualifying count, and gainers/losers. Tap a stock for both closing prices, cached market cap, industry, profile observation date and an external Yahoo Finance research link. Data & coverage lists exclusions and missing profiles. Partial coverage stays visible; the list is not presented as the whole market's top movers.

Refresh reads the latest stored snapshot; it does not trigger collection. The Saved Summary footer link opens that exact immutable revision using `?date=YYYY-MM-DD&id=HASH`. The home link returns to the latest saved summary. An older date is expected on weekends, holidays and before the collection close buffer. The actual price period is always displayed; the app does not call old data live.

## Hosting and authentication

`template.yaml` adds:

- `WebApp`: a separate Node.js 22 ARM Lambda serving the compiled app and a read-only API over an HTTPS function URL. It has a 15-second timeout and 256 MB memory; the collection worker is separate.
- `WebUserPool` / `WebUserClient`: Cognito Lite email sign-in, admin-created accounts only, no browser client secret, 12-character password policy, 15-minute access tokens and a 30-day refresh-token lifetime.
- Explicit URL-only public invocation permissions: the sign-in page and shell are public; every summary API request requires a verified Cognito access token for the configured pool/client. `AuthType: NONE` means Lambda IAM authentication is not used, not that summary data is public.
- A bounded web role with only `dynamodb:GetItem` for `SUMMARY` / `SUMMARY#*` partition keys, plus basic Lambda logs. No provider-secret permission or table writes. It uses the existing runtime permissions boundary.
- Fourteen-day sanitized logs and `WebErrors`, an operational alarm for three caught server failures in five minutes, sent to the existing SNS topic. Request headers, passwords, tokens, raw SDK errors and financial payloads are not logged.

`GET /api/config` returns public region/client metadata. `GET /api/summaries/latest` resolves the latest pointer. `GET /api/summaries/YYYY-MM-DD/HASH` reads a specific revision. These are the only data routes; table metadata is stripped from responses. API responses are `no-store`, and missing/expired/wrong-client tokens fail before a database read. Security headers restrict scripts, framing, browser capabilities and outbound connections.

The browser sends password authentication directly to Cognito over HTTPS. Tokens are stored in `sessionStorage` and never added to URLs or sent to the worker. Sign-out clears local state and asks Cognito to revoke the session; a previously issued JWT can remain valid for up to its 15-minute lifetime because server verification uses signatures/expiry rather than a revocation lookup. The current UI supports the initial password challenge and password recovery, not MFA challenges. Do not enable pool MFA without implementing the matching UI.

The new IAM deployment-policy statements are limited by the app tag `Application=stock-tracker-9000`; pool creation requires that request tag. Existing app-tagged pools can be managed, including user creation and pool/client deletion. The user explicitly approved this extension. Runtime-boundary contents are unchanged. Both pool and table have retain policies.

This personal-use version serves shell assets from Lambda to keep deployment small. It has no CDN, custom domain, public signup, paid data plan or always-running server. At larger traffic, move static assets behind CloudFront and add appropriate API throttling/protection; anonymous shell requests currently invoke Lambda. Do not claim a hard cost cap. The architecture adds request-based Lambda/auth use plus a custom metric/alarm and retained logs to the existing infrastructure.

## Development and deployment

```powershell
npm install
npm run typecheck
npm run web:test
npm run web:build
npm run web:dev
```

The local preview binds **only `127.0.0.1:4173`**. It uses AWS CLI profile `stock-tracker-deployer` in `ca-central-1` to discover the table and perform only summary `GetItem` calls. It deliberately bypasses Cognito on loopback; do not expose or deploy this development server. It never loads a local provider credential file. An expired CLI session needs `aws login --profile stock-tracker-deployer --region ca-central-1`.

`node scripts/check-web.mjs` uses installed Microsoft Edge through Playwright. It checks the live saved summary at desktop/iPhone widths, styling, direction switching, details, coverage, immutable links and overflow. The first-login/password-change/sign-out interaction uses mocked Cognito responses and test-only inputs; it does not verify a real user's password or claim a completed real sign-in.

Before SAM deployment, run both `npm run cloud:build` and `npm run web:build`, then cloud validation and SAM lint. Preserve all existing stack parameters, especially the enabled schedule and operational email, using the deployment instructions in AWS_SETUP.md. The web package includes only built browser assets and the bundled read-only handler. Credential files are never copied into it.

Create an invited account with Cognito `AdminCreateUser` using the app pool ID, the intended email as username, email/email_verified attributes, and EMAIL delivery. Let Cognito generate the temporary password; do not supply or print a password. The user authorized an invitation to their existing operational-alert email. Do not resend invitations without a reason.

Still pending: editable collection/notification settings, industry summaries, longer periods, push registration and delivery. Gainer/loser tabs change the display of a saved snapshot only.

## October 20 verification

CloudFormation finished `UPDATE_COMPLETE`. The live app URL is https://h2sdvt677kay6aydbxmjq72k7e0hkrqt.lambda-url.ca-central-1.on.aws/; the retained user pool is `ca-central-1_pnfh3u3c6`. AWS accepted the authorized email invitation, and the account status is `FORCE_CHANGE_PASSWORD`, awaiting the user's first sign-in.

The hosted page, stylesheet and public config returned HTTP 200; summary reads with no token or an invalid token returned HTTP 401 with `no-store`. A real hosted Edge/iPhone-size check found the styled login page, no horizontal overflow and no browser exceptions. Local read-only DynamoDB integration loaded the actual October 19 snapshot with five gainers/five losers. Browser checks covered stock details, direction switching, coverage, exact-revision links and a mocked first-password-change/sign-out flow. All 58 existing offline tests and four API security/projection tests pass, as do backend/frontend TypeScript, build checks and SAM lint. The user's actual authenticated sign-in and iOS installation remain user checks; no real password or token was obtained by the agent. No provider requests were made for frontend work.
