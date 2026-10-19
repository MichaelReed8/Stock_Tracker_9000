import test from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CloudStore } from './store.js';

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
  assert.equal(attempt.Put.ConditionExpression, 'attribute_not_exists(pk)');
  assert.equal(attempt.Put.Item.sk, 'AAA');
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
