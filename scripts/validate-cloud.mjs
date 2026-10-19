import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { parse } from 'yaml';

const template = parse(await readFile(new URL('../template.yaml', import.meta.url), 'utf8'));
const resources = template.Resources;
assert.equal(template.Parameters.ScheduleState.Default, 'DISABLED');
assert.equal(template.Parameters.ProfileDailyLimit.MaxValue, 200);
assert.equal(resources.ProfileWorker.Properties.ReservedConcurrentExecutions, 1);
assert.equal(resources.ProfileWorker.Properties.EventInvokeConfig.MaximumRetryAttempts, 0);
assert.equal(resources.ProfileWorker.Properties.Events.HourlyCollection.Properties.RetryPolicy.MaximumRetryAttempts, 0);
assert.equal(resources.DataTable.DeletionPolicy, 'Retain');
assert.equal(resources.DataTable.Properties.TimeToLiveSpecification.AttributeName, 'expiresAt');
assert.ok(resources.DeliveryFailures);
assert.ok(resources.WorkerErrors);
// Check the deployment artifact can load without invoking the handler or using credentials.
const module = await import('../dist/cloud/handler.mjs');
assert.equal(typeof module.handler, 'function');
console.log('Template parses, deployment safeguards pass, and Lambda bundle loads. AWS/SAM validation is still required before deployment.');
