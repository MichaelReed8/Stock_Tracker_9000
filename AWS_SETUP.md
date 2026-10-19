# AWS serverless collection

Selected October 19, 2026: EventBridge Scheduler + Lambda + DynamoDB, with provider credentials in Secrets Manager. This first slice automates profile collection and refresh. It does not yet collect closing prices in the cloud, calculate hosted summaries, serve the PWA, or send notifications. Existing price/ranking diagnostics remain local. Nothing has been deployed or scheduled from this workspace.

## What runs automatically

`template.yaml` defines an hourly Toronto-time schedule, a Node.js 22 ARM Lambda, an on-demand encrypted DynamoDB table with point-in-time recovery, a failure queue, 14-day sanitized logs, and error/queue alarms. The schedule defaults to **DISABLED** for initial configuration and import. Once enabled, the computer and editor can stay closed.

Each invocation refreshes the Alpaca asset list if older than one day, then processes up to 25 FMP profiles. The shared cloud ceiling is 200 attempted profile calls per UTC day, retaining 50 of the assumed 250-call allowance for industries/external usage. Every attempted request counts, including failures. Default hourly runs use the allowance across the day; profile collection runs on weekends too because metadata coverage can grow without a trading session. The schedule is for collection, not the eventual user notification schedule. Temporary provider failures become eligible for another attempt on the next UTC day, rather than receiving a seven-day per-symbol cooldown.

Four queue slots go to missing profiles for each one due refresh; unused capacity goes to the nonempty queue. Due refreshes are oldest first. Explicitly described warrants/rights are excluded. An HTTP 402 cools that symbol down for 30 days; invalid/empty profile results cool down for seven days. Provider authentication, rate-limit, network, other HTTP, or API-error payload failures pause further cloud profile requests for the rest of that UTC day. These pauses are visible in saved run reports. Reset time and vendor consumption remain unverified assumptions, not guaranteed entitlements.

## Cache policy

| Data | Refresh/reuse behavior |
| --- | --- |
| Profile/market cap | Queue refresh at 90 days; reuse observations less than 180 days old; retain older observations without automatic deletion. |
| Asset universe | Refresh at least daily when collection runs; publish a complete new generation only after every chunk is stored. |
| Price bars | Dated observations; never replace a required session's missing close with another date. Corporate-action refresh remains future work. |
| Saved alert summaries | Intended to remain immutable; not implemented yet. |

The 90/180-day profile settings are initial engineering defaults, not a claim that market caps remain accurate for six months. Returns use dated prices, while cap qualification uses a dated metadata observation. Local ranked results now include `profileObservedAt`. A company can cross the cutoff between profile refreshes; do not call its cached cap current. Prioritizing companies near a user's cap cutoff is future work, requiring the summary/settings pipeline. Non-US/fund classifications also use the stored observation and can change.

At the observed 13,631-candidate universe, refreshing all profiles every 90 days averages roughly 152 successes/day. This is more plausible than 1,948/day for seven-day refreshes, but startup collection, failed requests, retries and newly listed assets consume capacity too. A 200-call ceiling does not guarantee this cadence; refresh counts and observation ages must remain visible. A full initial fill still takes months. Local ranking refuses profiles at/over 180 days if it cannot refresh them. Background cloud collection and local diagnostics share this reuse policy, but only the cloud worker proactively queues refreshes at 90 days.

DynamoDB TTL applies only to temporary asset generations, attempt-deduplication records and run reports. **Profiles have no TTL.** Budget records are retained. Temporary TTL cleanup is not used for locks, budget reset, or deciding freshness.

## Reliability and scaling

- Lambda reserved concurrency is one for the initial single-account/provider-key worker. A conditional 11-minute lease outlasts the 10-minute function timeout. Ownership is checked before release.
- A DynamoDB transaction couples daily-budget reservation with one attempt per symbol per UTC day. A crash can waste a reserved call, but cannot refund it and overspend later. Automatic Lambda/Scheduler retries are disabled; later scheduled runs resume saved progress.
- Every successful profile is written immediately. Failed refreshes preserve the prior observation. The worker checks its remaining execution time before starting a request.
- AWS exceptions, provider errors and secret payloads are not logged. Reports contain counts and stop reasons. Alarms exist in CloudWatch, but have no email/SNS action configured yet. Provider pauses are saved as reports rather than thrown as Lambda errors.
- A generation-based universe snapshot avoids partially replacing the symbol list. Expired snapshots are fetched anew after downtime.
- This single-provider worker is intentionally serialized to enforce one provider allowance. Adding app users need not duplicate collection. Price retrieval, summaries and API reads can later use separate functions. Profile queries currently load all profile records under one partition; shard/index the queue if coverage grows far beyond this US universe.

## Prepare and deploy

AWS CLI 2.38.1 and SAM CLI 1.169.0 are now installed. `sam validate --lint --template-file template.yaml --region ca-central-1` passed. Browser sign-in succeeded for profile `stock-tracker-9000`, currently as the account root user. Configure a separate deployment identity before deploying. No resources have been deployed; a deployed smoke test remains required.

1. Install AWS CLI v2 and SAM CLI. Configure a deployment identity through AWS SSO or another normal AWS credential provider; do not put AWS keys in the repository or chat. Choose a region such as `ca-central-1` and confirm your account with `aws sts get-caller-identity`.
2. In the AWS console, create a Secrets Manager secret in that region using the default AWS-managed encryption key. Enter the values yourself under these JSON keys: `FMP_API_KEY`, `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`. Do not print/read back the secret or pass values in CLI arguments. The deployment takes only its ARN. A custom KMS key would also need an explicitly scoped decrypt permission, which this template does not grant.
3. Run the local build/checks, then AWS validation:

```powershell
npm ci
npm test
npm run typecheck
npm run cloud:build
npm run cloud:validate
sam validate --lint --template-file template.yaml
sam deploy --guided --template-file template.yaml
```

Use a stack name such as `stock-tracker-9000`, the chosen region, the existing secret ARN for `ProviderSecretArn`, and `ScheduleState=DISABLED`. SAM packages only `dist/cloud/`; no local environment file or SQLite database is part of the deployment artifact. Review the CloudFormation changeset and IAM permissions before deployment. The template permits reading only the supplied secret and accessing the created table. Initial resource creation incurs AWS charges.

4. With the schedule disabled, optionally migrate existing profiles using the `TableName` stack output:

```powershell
npm run cloud:import -- --table=YOUR_STACK_TABLE_NAME
```

This command reads only the local SQLite cache and writes profiles to AWS; it does not load `.env.local`, make provider requests, import old asset observations as current, or overwrite newer cloud profiles. It prints counts and today's locally tracked profile attempts. Do not run it concurrently with a worker. Prices and local budget records are not migrated.

5. Account for provider calls already made locally or elsewhere on the activation day. **Local SQLite and cloud counters are independent**: stop local provider scripts after switching to cloud collection. Either enable on a new UTC day with known usage, or lower `ProfileDailyLimit` to account for known calls already spent. Default 200 leaves a buffer but cannot account for arbitrary external usage. This is especially relevant to October 19's 25-request diagnostic.
6. Redeploy with `ScheduleState=ENABLED` once configuration and budget are correct. Check CloudWatch sanitized logs and `RUN` items in DynamoDB after the first scheduled invocation. Expect at most the configured batch limit and daily ceiling, persistent profiles, and no credential values. Confirm the next invocation resumes progress. This is the required deployed smoke test.
7. Configure alarm delivery to your preferred destination, an AWS monthly budget alert, and review actual billing. Disabling `ScheduleState` pauses collection. Setting `ProfileDailyLimit=0` stops provider requests. DataTable is retained when the stack is deleted, so data and its storage costs remain until explicitly removed.

Lambda/Scheduler usage should be small for this workload, but Secrets Manager, DynamoDB requests/storage/recovery, logs, failure queues and future hosting add separate charges. No fixed monthly total or free-tier eligibility is guaranteed. Keep the worker outside a VPC initially so public provider calls do not require a paid NAT gateway. A billing alert is not a hard spending cap.

## Next implementation slices

1. Deploy and enable collection; verify persisted progress and the actual provider allowance.
2. Add trading-calendar-aware closing-price ingestion, date-keyed durable bars, and summaries with honest coverage and profile-age metadata. No repeated manual ranking runs are required to develop this.
3. Add preferences, saved immutable summaries and the PWA/API, then the shared notification schedule and two Web Push types.

References: [SAM ScheduleV2](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-property-function-schedulev2.html), [Lambda Node.js runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html), [DynamoDB condition expressions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html).
