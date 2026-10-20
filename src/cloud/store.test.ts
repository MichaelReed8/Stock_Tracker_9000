import test from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CloudStore } from './store.js';
import type { DailySummary, PriceRun } from './daily-summary.js';

test('cloud reservation atomically couples budget and per-symbol deduplication, with no refund path', async () => {
  let input: any;
  const client = { send: async (command: any) => { input = command.input; return {}; } } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
  const store = new CloudStore('test-table', client);
  assert.equal(await store.reserve('AAA', new Date('2026-10-19T00:00:00Z'), 200), true);
  const [budget, attempt] = input.TransactItems;
  assert.deepEqual(budget.Update.Key, { pk: 'BUDGET', sk: '2026-10-19' });
  assert.match(budget.Update.ConditionExpression, /:zero < :limit/);
  assert.match(budget.Update.ConditionExpression, /attempted < :limit/);
  assert.match(budget.Update.ConditionExpression, /attribute_not_exists\(blocked\)/);
  assert.equal(budget.Update.ExpressionAttributeValues[':limit'], 200);
  assert.equal(attempt.Put.ConditionExpression, 'attribute_not_exists(pk) OR retryAt <= :now');
  assert.match(budget.Update.ConditionExpression, /retryAt <= :now/);
  assert.equal(attempt.Put.Item.sk, 'AAA');
});

test('temporary failure records cooldown and retry eligibility atomically while preserving the budget', async () => {
  let input: any;
  const client = { send: async (command: any) => { input = command.input; return {}; } } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
  const store = new CloudStore('test-table', client);
  const now = new Date('2026-10-20T12:00:00Z'), retry = new Date('2026-10-20T12:30:00Z');
  await store.retryLater({ symbol: 'AAA' }, now, retry);
  const [profile, attempt, budget] = input.TransactItems;
  assert.equal(profile.Put.Item.retryAfter, retry.toISOString());
  assert.deepEqual(attempt.Update.Key, { pk: 'ATTEMPT#2026-10-20', sk: 'AAA' });
  assert.equal(attempt.Update.ConditionExpression, 'attribute_exists(pk)');
  assert.equal(budget.Update.UpdateExpression, 'SET retryAt = :retry');
  assert.equal(JSON.stringify(input).includes('attempted'), false);
});

test('conditional reservation failure skips safely but infrastructure errors propagate', async () => {
  const failure = Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }] });
  const client = { send: async () => { throw failure; } } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
  const store = new CloudStore('test-table', client);
  assert.equal(await store.reserve('AAA', new Date(), 200), false);
  failure.CancellationReasons = [{ Code: 'TransactionConflict' }];
  await assert.rejects(store.reserve('AAA', new Date(), 200));
});

test('lock acquisition is conditional and release verifies the owner', async () => {
  const inputs: any[] = [];
  const client = { send: async (command: any) => { inputs.push(command.input); return {}; } } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
  const store = new CloudStore('test-table', client);
  const now = new Date();
  assert.equal(await store.acquire('owner-1', now), true);
  await store.release('owner-1');
  assert.equal(inputs[0].Item.leaseUntil, now.getTime() + 660000);
  assert.match(inputs[0].ConditionExpression, /leaseUntil < :now/);
  assert.equal(inputs[1].ExpressionAttributeValues[':owner'], 'owner-1');
});

test('migration adds only newly observed local attempts and guards against duplicate accounting', async () => {
  const inputs: any[] = [];
  let prior: number | undefined;
  const client = { send: async (command: any) => {
    inputs.push(command.input);
    if (command.input.Key) return prior === undefined ? {} : { Item: { attempted: prior } };
    return {};
  } } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
  const store = new CloudStore('test-table', client);
  await store.importLocalBudget('2026-10-19', 25);
  assert.equal(inputs[1].TransactItems[0].Update.ExpressionAttributeValues[':additional'], 25);
  assert.equal(inputs[1].TransactItems[1].Put.ConditionExpression, 'attribute_not_exists(pk)');
  prior = 25;
  inputs.length = 0;
  await store.importLocalBudget('2026-10-19', 25);
  assert.equal(inputs.length, 1);
  inputs.length = 0;
  await store.importLocalBudget('2026-10-19', 30);
  assert.equal(inputs[1].TransactItems[0].Update.ExpressionAttributeValues[':additional'], 5);
  assert.equal(inputs[1].TransactItems[1].Put.ExpressionAttributeValues[':previous'], 25);
});

test('price plans are durable before the run cursor is published, and batches commit as single immutable items', async () => {
  const inputs: any[] = [];
  const client = { send: async (command: any) => { inputs.push(command.input); return {}; } } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
  const store = new CloudStore('test-table', client);
  const run: PriceRun = { id: 'run', startDate: '2026-10-16', endDate: '2026-10-19',
    assetCount: 1, batchCount: 1, status: 'collecting', createdAt: '2026-10-20T12:00:00Z' };
  const plan = { index: 0, assets: [{ symbol: 'AAA', name: 'Company', exchange: 'NASDAQ' }] };
  await store.startPriceRun(run, [plan]);
  assert.equal(inputs[0].Item.pk, 'PRICE_PLAN#run');
  assert.equal(inputs[1].TransactItems[0].Put.ConditionExpression, 'attribute_not_exists(pk)');
  assert.equal(inputs[1].TransactItems[1].Put.Item.pk, 'PRICE_CONTROL');
  await store.savePriceBatch(run, { ...plan, observedAt: run.createdAt,
    bars: [{ symbol: 'AAA', date: run.startDate, close: 100 }] });
  assert.equal(inputs[2].Item.adjustment, 'split');
  assert.equal(inputs[2].ConditionExpression, 'attribute_not_exists(pk)');
  assert.equal(JSON.stringify(inputs).includes('BUDGET'), false);
});

test('duplicate summary insertion never overwrites a snapshot and still repairs the latest pointer', async () => {
  const inputs: any[] = [];
  const client = { send: async (command: any) => {
    inputs.push(command.input);
    if (command.input.Item.pk.startsWith('SUMMARY#')) {
      throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
    }
    return {};
  } } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
  const store = new CloudStore('test-table', client);
  const summary = { id: 'snapshot', endDate: '2026-10-19', createdAt: '2026-10-20T12:00:00Z' } as DailySummary;
  assert.equal(await store.saveSummary(summary), false);
  assert.equal(inputs[0].ConditionExpression, 'attribute_not_exists(pk)');
  assert.equal(inputs[1].Item.pk, 'SUMMARY');
  assert.match(inputs[1].ConditionExpression, /endDate < :date/);
  assert.match(inputs[1].ConditionExpression, /updatedAt <= :now/);
});
