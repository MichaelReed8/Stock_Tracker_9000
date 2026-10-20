import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { parse } from 'yaml';

const template = parse(await readFile(new URL('../template.yaml', import.meta.url), 'utf8'));
const resources = template.Resources;
assert.equal(template.Parameters.ScheduleState.Default, 'DISABLED');
assert.equal(template.Parameters.ProfileDailyLimit.MaxValue, 200);
assert.equal(template.Parameters.ReserveWorkerConcurrency.Default, 'DISABLED');
assert.deepEqual(resources.ProfileWorker.Properties.ReservedConcurrentExecutions,
  { 'Fn::If': ['UseDedicatedConcurrency', 1, { Ref: 'AWS::NoValue' }] });
assert.deepEqual(resources.ProfileWorker.Properties.PermissionsBoundary, { Ref: 'RuntimeBoundaryArn' });
assert.deepEqual(resources.ProfileWorker.Properties.Events.HourlyCollection.Properties.PermissionsBoundary, { Ref: 'RuntimeBoundaryArn' });
assert.equal(resources.ProfileWorker.Properties.Events.HourlyCollection.Properties.Name, 'stock-tracker-9000-profile-collection');
assert.equal(resources.ProfileWorker.Properties.EventInvokeConfig.MaximumRetryAttempts, 0);
assert.equal(resources.ProfileWorker.Properties.Events.HourlyCollection.Properties.RetryPolicy.MaximumRetryAttempts, 0);
assert.equal(resources.DataTable.DeletionPolicy, 'Retain');
assert.equal(resources.DataTable.Properties.TimeToLiveSpecification.AttributeName, 'expiresAt');
assert.ok(resources.DeliveryFailures);
assert.ok(resources.WorkerErrors);
assert.equal(resources.NoCollectionProgress.Properties.TreatMissingData, 'breaching');
assert.equal(resources.NoCollectionProgress.Properties.EvaluationPeriods, 3);
assert.equal(resources.RepeatedProviderFailures.Properties.DatapointsToAlarm, 3);
assert.equal(resources.ProviderPaused.Properties.Threshold, 1);
assert.equal(template.Parameters.SummaryMinimumMarketCap.Default, 10000000000);
assert.equal(template.Parameters.PriceCloseDelayMinutes.MinValue, 20);
assert.equal(resources.PriceSummaryStalled.Properties.TreatMissingData, 'breaching');
for (const name of ['WorkerErrors', 'DeliveryFailures', 'ProviderPaused', 'RepeatedProviderFailures', 'NoCollectionProgress', 'PriceSummaryStalled']) {
  assert.deepEqual(resources[name].Properties.AlarmActions,
    { 'Fn::If': ['EnableEmailAlerts', [{ Ref: 'JobAlerts' }], { Ref: 'AWS::NoValue' }] });
}
assert.equal(resources.JobAlertEmail.Properties.Protocol, 'email');
assert.equal(resources.JobAlertPolicy.Properties.PolicyDocument.Statement[0].Principal.Service, 'cloudwatch.amazonaws.com');
assert.equal(resources.WebUserPool.Properties.AdminCreateUserConfig.AllowAdminCreateUserOnly, true);
assert.equal(resources.WebUserClient.Properties.GenerateSecret, false);
assert.deepEqual(resources.WebApp.Properties.PermissionsBoundary, { Ref: 'RuntimeBoundaryArn' });
assert.equal(resources.WebApp.Properties.Policies[0].Statement[0].Action, 'dynamodb:GetItem');
assert.equal(resources.WebApp.Properties.Environment.Variables.PROVIDER_SECRET_ARN, undefined);
assert.equal(resources.WebInvokePermission.Properties.InvokedViaFunctionUrl, true);
// Check the deployment artifact can load without invoking the handler or using credentials.
const module = await import('../dist/cloud/handler.mjs');
assert.equal(typeof module.handler, 'function');
console.log('Template parses, deployment safeguards pass, and Lambda bundle loads. AWS/SAM validation is still required before deployment.');
