# AWS serverless app and collection

## Summary app (October 20)

Open [the summary app](https://h2sdvt677kay6aydbxmjq72k7e0hkrqt.lambda-url.ca-central-1.on.aws/), also available as the stack's `AppUrl` output. The React PWA uses a separate read-only Lambda and Cognito email sign-in; self-signup is disabled. The user-authorized initial invitation was requested from AWS, and the account is awaiting its first password change. No passwords were supplied or retrieved by the agent. See [FRONTEND.md](FRONTEND.md) for use, Home Screen installation, architecture and remaining features.

Build **both** deployment packages (`npm run cloud:build` and `npm run web:build`) before SAM deployment. `npm run typecheck` covers backend and frontend; `npm run web:test` checks API authorization/projection, and `node scripts/check-web.mjs` checks the browser UI with `npm run web:dev` running. The existing hourly job remains enabled. `WebErrors` adds a seventh operational alarm, using a sanitized log-derived metric for caught server failures. The runtime permissions boundary is unchanged; the user approved a tag-scoped Cognito extension to the deployment policy.

Deployed and enabled in `ca-central-1`: EventBridge Scheduler + Lambda + DynamoDB, with provider credentials in Secrets Manager. Stack `stock-tracker-9000` is `UPDATE_COMPLETE` and the existing schedule `stock-tracker-9000-profile-collection` is `ENABLED`. As of October 20, the same worker collects profiles, daily Alpaca prices and immutable stock-summary previews. The PWA/API is implemented as described above; market-mover push notifications remain unimplemented. Operational error emails are configured and confirmed. Do not run local provider diagnostics alongside cloud collection. See [DAILY_SUMMARIES.md](DAILY_SUMMARIES.md) for price semantics, partial-coverage labels, record keys and live verification.

The migration copied 126 cached profiles and carried 25 locally tracked attempts into the October 19 UTC budget. The deployed Lambda smoke test completed in about 30 seconds: 25 attempts, 19 profiles saved, three access denials and three unusable payloads, stopping at the batch limit. The persisted `RUN` record matches those counts; the persisted daily counter was 50 after migration plus the smoke test. October 20 RUN items confirm scheduled hourly invocations, and that day's counter reached 200 without a provider block. The 50-call buffer does not track requests outside these jobs. No secret values were retrieved into tool output or model context.

## What runs automatically

The original profile stage is followed by an independent daily-price/summary stage. FMP exhaustion or a failed profile stage cannot skip prices. Profiles have a two-minute target; prices have their own lease, request/time bounds and resumable batch records. Completed prices are reused until a newer eligible session, with snapshot revisions as profile coverage changes. The user selected $10B minimum cap and five gainers/five losers; collection waits 90 minutes after the scheduled market close. Summary previews explicitly cover cached profiles and remain ineligible for notifications.

`template.yaml` defines an hourly Toronto-time schedule, a Node.js 22 ARM Lambda, an on-demand encrypted DynamoDB table with point-in-time recovery, a failure queue, 14-day sanitized logs, and error/queue alarms. The template defaults to **DISABLED** for initial configuration and import; the deployed stack explicitly uses **ENABLED**. The computer and editor can stay closed.

Each invocation refreshes the Alpaca asset list if older than one day, then processes up to 25 FMP profiles. The shared cloud ceiling is 200 attempted profile calls per UTC day, retaining 50 of the assumed 250-call allowance for industries/external usage. Every attempted request counts, including failures and retries. Default hourly runs use the allowance across the day; profile collection runs on weekends too because metadata coverage can grow without a trading session. The schedule is for collection, not the eventual user notification schedule.

Four queue slots go to missing profiles for each one due refresh; unused capacity goes to the nonempty queue. Due refreshes are oldest first. Explicitly described warrants/rights are excluded. HTTP 402 cools that symbol down for 30 days; invalid/empty profile results cool down for seven days. Network failures, timeouts, HTTP 408 and HTTP 5xx end the current run with a **30-minute provider/symbol cooldown**, so a later hourly run can recover that same UTC day. Authentication failures, rate limits, other HTTP errors and unclassified HTTP-200 API error payloads conservatively pause requests for the rest of that UTC day. These pauses are visible in saved run reports. Reset time and vendor consumption remain unverified assumptions, not guaranteed entitlements.

## Recovery and operational alerts (October 20)

Keep hourly collection: if an invocation fails, its saved profiles remain durable and a later hour resumes progress. The job does not run a tight retry loop or reset its daily allowance. For a transient profile failure, one transaction preserves the last observation, sets its retry time, marks the attempted symbol retryable after that time, and pauses that day's provider requests until the cooldown expires. Each retry must reserve another call atomically. Successful requests restore same-day deduplication. Old attempt records without a retry time remain deduplicated. UTC rollover creates a new budget; a symbol's cooldown can extend across midnight.

Six CloudWatch alarms target SNS topic `stock-tracker-9000-job-alerts` when `NotificationEmail` is configured:

| Alarm | Trigger |
| --- | --- |
| WorkerErrors | Lambda execution errors. |
| DeliveryFailures | Messages waiting in the scheduler/Lambda failure queue. |
| ProviderPaused | Authentication/quota or other conservative day-long provider pause. |
| RepeatedProviderFailures | Provider failures in three consecutive hourly periods, including failures after partial progress. |
| NoCollectionProgress | Three hourly periods with neither profile writes nor a healthy idle report; missing reports also breach. |
| PriceSummaryStalled | Three hourly periods without completed price/summary work or healthy waiting/overlap status; independent of the profile budget. |

Budget exhaustion, an empty queue, and an overlapping invocation skipped by the lease are healthy idle reports. Exhausting the allowance does not raise a no-progress alarm. Crashes before logging are covered by Lambda errors and eventually missing health data. Alpaca/Secrets Manager failures already throw sanitized errors; subsequent hourly invocations retry without blocking the FMP budget. A stalled run after reserving a call still counts that reservation; only a recorded transient response unlocks the same symbol for a same-day retry.

Health logs use standalone JSON with separate `profiles` and `prices` reports. Metric filters read `providerFailure`, `permanentProviderFailure`, `progressHealthy` and `priceHealthy`; `alpacaRequests` shows downloaded versus reused data. No request URLs, provider error bodies, credential values or symbol audit lists are logged. Four custom metrics and extra alarms add charges beyond the original deployment; the previous profile-only estimate is not a cap for price collection/history.

The recipient must confirm the AWS subscription email. Once confirmed, notifications are sent on transitions to ALARM; there is no routine hourly email and no phone market-mover push yet. `NotificationEmail` is a NoEcho stack parameter; keep the address out of repository configuration. The topic policy permits publishing only from this account's app-prefixed CloudWatch alarms. Deployment permissions manage only this app topic; the Lambda execution role does not gain SNS access. If deliberately disabling the schedule, disable both NoCollectionProgress and PriceSummaryStalled alarm actions so the intentional absence of runs does not notify you. Existing paused-day markers are not cleared by deployment.

The requested subscription was confirmed on October 20 and verified by its assigned subscription ARN. All six alarm actions point to the topic. Final CloudFormation status is `UPDATE_COMPLETE` and Scheduler remains `ENABLED`. The deployment smoke checks exercised the exhausted-budget path without making provider requests; CloudWatch's JSON filter matched the final standalone report with `requests=0`, `providerFailure=0`, `permanentProviderFailure=0` and `progressHealthy=1`. Failure/recovery behavior was simulated offline rather than deliberately causing production provider failures. No artificial alarm email was sent.

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

- A conditional 11-minute DynamoDB lease outlasts the 10-minute function timeout. Ownership is checked before release. Optional `ReserveWorkerConcurrency=ENABLED` also reserves one Lambda execution, but defaults disabled because this account has a regional limit of 10 and AWS requires 100 executions left unreserved. The lease and atomic reservations remain active either way.
- A DynamoDB transaction couples daily-budget reservation with symbol attempt tracking. Normally a symbol is attempted once per UTC day; recorded transient failures alone allow a later same-day attempt after cooldown, with another budget reservation. A crash can waste a reserved call but cannot refund it and overspend later. Automatic Lambda/Scheduler retries remain disabled; scheduled runs handle recovery.
- Every successful profile is written immediately. Failed refreshes preserve the prior observation. The worker checks its remaining execution time before starting a request.
- AWS exceptions, provider errors and secret payloads are not logged. Reports contain counts, stop reasons and a retry time for transient failures. Alarms target the configured operational email topic; provider pauses emit health metrics rather than masquerading as successful progress or requiring a thrown Lambda error.
- A generation-based universe snapshot avoids partially replacing the symbol list. Expired snapshots are fetched anew after downtime.
- This single-provider worker is intentionally serialized to enforce one provider allowance. Adding app users need not duplicate collection. Price retrieval, summaries and API reads can later use separate functions. Profile queries currently load all profile records under one partition; shard/index the queue if coverage grows far beyond this US universe.

## Prepare and deploy

AWS CLI 2.38.1 and SAM CLI 1.169.0 are installed. `sam validate --lint --template-file template.yaml --region ca-central-1` passed. Browser sign-in and STS identity checks confirm profile `stock-tracker-deployer` uses IAM user `stock-tracker-deployer`. The provider secret has a saved current version (metadata checked only). The private artifact bucket is created with all public access blocked. Changesets were reviewed before execution. All 58 offline tests, TypeScript and bundle checks pass; the recovery update includes same-day retry and alert monitoring tests.

Deployment identity bootstrap is complete: IAM user `stock-tracker-deployer` has managed policies `stock-tracker-9000-deployment` and AWS `SignInLocalDevelopmentAccess`. The `stock-tracker-9000-runtime-boundary` managed policy limits app execution roles. Source policies are in `infra/`; account/region-rendered copies are generated under ignored `.aws-sam/`. IAM Access Analyzer returned no policy errors, and SAM lint passes with the boundary applied to both generated roles. The user enabled console access and set their password directly in AWS. No administrator policy or access keys were created. Use profile `stock-tracker-deployer` for deployment. The prior root profile remains configured for IAM bootstrap/policy maintenance; it was not used for app deployment.

The deployment policy manages app resources in `ca-central-1`, the `stock-tracker-9000` stack, and its account-specific artifact bucket. It can create only app-prefixed IAM roles with the required runtime boundary and cannot change/remove that boundary. It permits secret creation/update/metadata for `stock-tracker-9000/providers`, but not reading secret values. Secrets Manager console listing, Lambda account settings and log-group listing require read-only metadata permissions on `*`; these are included. The policy is scoped for this initial stack and may need deliberate updates as new services are introduced. CLI sign-in can reuse an active root browser session: verify STS identity after login, and accept overwriting the old profile when switching to the IAM user.

1. Install AWS CLI v2 and SAM CLI. Configure a deployment identity through AWS SSO or another normal AWS credential provider; do not put AWS keys in the repository or chat. Choose a region such as `ca-central-1` and confirm your account with `aws sts get-caller-identity`.
2. In the AWS console, create the Secrets Manager secret named `stock-tracker-9000/providers` in that region using the default AWS-managed encryption key. Enter the values yourself under these JSON keys: `FMP_API_KEY`, `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`. Do not print/read back the secret or pass values in CLI arguments. The deployment takes only its ARN. The runtime boundary is scoped to this secret name. A custom KMS key would also need an explicitly scoped decrypt permission, which this template does not grant.
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

Use stack name `stock-tracker-9000`, region `ca-central-1`, profile `stock-tracker-deployer`, the existing secret ARN for `ProviderSecretArn`, the created boundary policy ARN for `RuntimeBoundaryArn`, and `ScheduleState=DISABLED`. Supply the account-specific `stock-tracker-9000-artifacts-ACCOUNT_ID-ca-central-1` bucket explicitly rather than creating SAM's separate managed bootstrap stack, which this deployment identity cannot manage. SAM packages only `dist/cloud/`; no local environment file or SQLite database is part of the deployment artifact. Review the CloudFormation changeset and IAM permissions before deployment. The template permits reading only the supplied secret and accessing the created table, intersected with the runtime boundary. Initial resource creation incurs AWS charges.

The steps above describe initial setup. For updates to the existing active stack, preserve `ScheduleState=ENABLED` unless deliberately pausing collection, and preserve `ReserveWorkerConcurrency=DISABLED` for the observed 10-execution regional quota. Obtain current secret/boundary ARNs from metadata; never retrieve secret values. Rebuild the Lambda bundle before packaging code changes.

4. With the schedule disabled, optionally migrate existing profiles using the `TableName` stack output:

```powershell
npm run cloud:import -- --table=YOUR_STACK_TABLE_NAME
```

This command reads only the local SQLite cache and writes profiles to AWS; it does not load `.env.local`, make provider requests, import old asset observations as current, or overwrite newer cloud profiles. It carries today's locally tracked profile attempts into the cloud daily budget using a transaction and a migration marker, so repeat imports add only newly observed local attempts. It prints counts, not profile contents. Do not run it concurrently with a worker. Prices are not migrated.

5. The importer accounts for locally tracked profile requests at migration time. **Local SQLite and cloud counters remain independent afterward**: stop local provider scripts after switching to cloud collection. External/probe requests are not tracked by the migration. Account for those separately or lower the daily ceiling; the default 200 leaves a buffer but cannot account for arbitrary external usage.
6. Redeploy with `ScheduleState=ENABLED` once configuration and budget are correct. Check CloudWatch sanitized logs and `RUN` items in DynamoDB after the first scheduled invocation. Expect at most the configured batch limit and daily ceiling, persistent profiles, and no credential values. Confirm the next invocation resumes progress. This is the required deployed smoke test.
7. Set `NotificationEmail` to configure the operational email subscription, confirm the AWS email, and preserve that parameter on later deployments. Configure an AWS monthly budget alert separately and review actual billing. Disabling `ScheduleState` pauses collection; disable both missing-progress alarm actions for an intentional pause. Setting `ProfileDailyLimit=0` stops provider requests. DataTable is retained when the stack is deleted, so data and its storage costs remain until explicitly removed.

Lambda/Scheduler usage should be small for this workload, but Secrets Manager, DynamoDB requests/storage/recovery, logs, failure queues and future hosting add separate charges. No fixed monthly total or free-tier eligibility is guaranteed. Keep the worker outside a VPC initially so public provider calls do not require a paid NAT gateway. A billing alert is not a hard spending cap.

## Next implementation slices

1. Observe automatic profile growth and new-session price summaries. Live collection, durable snapshots and zero-download reruns passed; no daily manual action is required.
2. Build the PWA/API around saved summaries and preferences, showing coverage and observation dates. Add weekly/biweekly/monthly periods and settle industry methodology.
3. Add the shared user notification schedule and two Web Push types linked to saved snapshots, then validate on the iPhone.

References: [SAM ScheduleV2](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-property-function-schedulev2.html), [Lambda Node.js runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html), [DynamoDB condition expressions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html).
