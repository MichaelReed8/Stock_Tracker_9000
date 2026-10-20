import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryApi, type WebEvent } from './web-api.js';
const id = 'a'.repeat(64);
const event = (path = '/api/summaries/latest', token = 'Bearer valid', method = 'GET'): WebEvent => ({ rawPath: path, headers: { authorization: token }, requestContext: { http: { method } } });
const item = { id, kind: 'daily_stock_summary', schemaVersion: 1, pk: 'SUMMARY#2026-10-19', sk: id, privateExtra: 'never_return', gainers: [], losers: [] };
test('missing and invalid tokens never read DynamoDB', async () => {
  let reads = 0;
  const read = async () => { reads++; return item; };
  assert.equal((await summaryApi(event(undefined, ''), read, async () => true)).statusCode, 401);
  assert.equal((await summaryApi(event(), read, async () => { throw new Error('expired'); })).statusCode, 401);
  assert.equal(reads, 0);
});
test('latest follows the saved pointer and strips table metadata', async () => {
  const keys: string[][] = [];
  const result = await summaryApi(event(), async (pk, sk) => { keys.push([pk, sk]); return pk === 'SUMMARY' ? { snapshotPk: item.pk, id } : item; }, async () => true);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(keys, [['SUMMARY', 'LATEST'], [item.pk, id]]);
  assert.equal(JSON.parse(result.body).id, id);
  assert.equal(JSON.parse(result.body).privateExtra, undefined);
  assert.equal(JSON.parse(result.body).pk, undefined);
  assert.equal(result.headers['cache-control'], 'no-store');
});
test('only summary revisions can be read, and writes are rejected', async () => {
  let reads = 0;
  const read = async () => { reads++; return item; };
  assert.equal((await summaryApi(event('/api/summaries/2026-10-19/' + id), read, async () => true)).statusCode, 200);
  assert.equal((await summaryApi(event('/api/PROFILE/AAPL'), read, async () => true)).statusCode, 404);
  assert.equal((await summaryApi(event(undefined, undefined, 'POST'), read, async () => true)).statusCode, 405);
  assert.equal(reads, 1);
});
test('missing snapshots and invalid pointer fail closed', async () => {
  assert.equal((await summaryApi(event(), async () => undefined, async () => true)).statusCode, 404);
  assert.equal((await summaryApi(event(), async () => ({ snapshotPk: 'PROFILE', id }), async () => true)).statusCode, 503);
});
