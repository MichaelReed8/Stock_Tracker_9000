import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand,
  UpdateCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import type { AlpacaAsset } from '../alpaca.js';
import type { ProfileEntry, ProfileJobStore } from './profile-job.js';

const conditionalFailure = (error: unknown) => error instanceof Error && error.name === 'ConditionalCheckFailedException';

export class CloudStore implements ProfileJobStore {
  private readonly db;
  constructor(private readonly table: string, client?: Pick<DynamoDBDocumentClient, 'send'>) {
    this.db = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 3 }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  }
  private async get(pk: string, sk: string) {
    return (await this.db.send(new GetCommand({ TableName: this.table, Key: { pk, sk }, ConsistentRead: true }))).Item;
  }
  private async put(item: Record<string, unknown>) {
    await this.db.send(new PutCommand({ TableName: this.table, Item: item }));
  }
  private async query(pk: string) {
    const items: Record<string, any>[] = [];
    let cursor: Record<string, any> | undefined;
    do {
      const page = await this.db.send(new QueryCommand({ TableName: this.table,
        KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': pk },
        ConsistentRead: true, ExclusiveStartKey: cursor }));
      items.push(...page.Items ?? []);
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return items;
  }
  async acquire(owner: string, now: Date) {
    try {
      await this.db.send(new PutCommand({ TableName: this.table,
        Item: { pk: 'LOCK', sk: 'PROFILE', owner, leaseUntil: now.getTime() + 660_000 },
        ConditionExpression: 'attribute_not_exists(pk) OR leaseUntil < :now',
        ExpressionAttributeValues: { ':now': now.getTime() } }));
      return true;
    } catch (error) { if (conditionalFailure(error)) return false; throw error; }
  }
  async release(owner: string) {
    try { await this.db.send(new DeleteCommand({ TableName: this.table, Key: { pk: 'LOCK', sk: 'PROFILE' },
      ConditionExpression: '#owner = :owner', ExpressionAttributeNames: { '#owner': 'owner' },
      ExpressionAttributeValues: { ':owner': owner } }));
    } catch (error) { if (!conditionalFailure(error)) throw error; }
  }
  async loadAssets() {
    const pointer = await this.get('UNIVERSE', 'CURRENT');
    if (!pointer) return null;
    if (Date.parse(pointer.observedAt) < Date.now() - 86_400_000) return null;
    const chunks = await this.query(`UNIVERSE#${pointer.generation}`);
    if (chunks.length !== pointer.chunks) throw new Error('Incomplete stored universe');
    return { observedAt: String(pointer.observedAt), assets: chunks.flatMap(row => row.assets as AlpacaAsset[]) };
  }
  async saveAssets(assets: AlpacaAsset[], now: Date) {
    const generation = randomUUID();
    const chunks = Math.ceil(assets.length / 100);
    for (let i = 0; i < chunks; i++) await this.put({ pk: `UNIVERSE#${generation}`, sk: String(i).padStart(6, '0'),
      assets: assets.slice(i * 100, (i + 1) * 100), expiresAt: Math.floor(now.getTime() / 1000) + 7 * 86400 });
    // Publish only after every chunk is durable; failed generations remain invisible.
    await this.put({ pk: 'UNIVERSE', sk: 'CURRENT', generation, chunks, observedAt: now.toISOString() });
  }
  async entries(): Promise<ProfileEntry[]> {
    return (await this.query('PROFILE')).map(row => ({ symbol: row.sk, profile: row.profile, retryAfter: row.retryAfter }));
  }
  async reserve(symbol: string, now: Date, dailyLimit: number) {
    const day = now.toISOString().slice(0, 10);
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: this.table, Key: { pk: 'BUDGET', sk: day },
          UpdateExpression: 'SET attempted = if_not_exists(attempted, :zero) + :one',
          ConditionExpression: ':zero < :limit AND (attribute_not_exists(attempted) OR attempted < :limit) AND attribute_not_exists(blocked)',
          ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':limit': dailyLimit } } },
        { Put: { TableName: this.table, Item: { pk: `ATTEMPT#${day}`, sk: symbol,
          expiresAt: Math.floor(now.getTime() / 1000) + 30 * 86400 }, ConditionExpression: 'attribute_not_exists(pk)' } },
      ] }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'TransactionCanceledException' &&
        'CancellationReasons' in error && Array.isArray(error.CancellationReasons) &&
        error.CancellationReasons.some(reason => reason.Code === 'ConditionalCheckFailed') &&
        error.CancellationReasons.every(reason => reason.Code === 'None' || reason.Code === 'ConditionalCheckFailed')) return false;
      throw error;
    }
  }
  async budgetAvailable(day: string, dailyLimit: number) {
    const budget = await this.get('BUDGET', day);
    return dailyLimit > 0 && !budget?.blocked && Number(budget?.attempted ?? 0) < dailyLimit;
  }
  async save(entry: ProfileEntry) { await this.put({ pk: 'PROFILE', sk: entry.symbol, ...entry }); }
  async blockDay(day: string) {
    await this.db.send(new UpdateCommand({ TableName: this.table, Key: { pk: 'BUDGET', sk: day },
      UpdateExpression: 'SET blocked = :yes', ExpressionAttributeValues: { ':yes': true } }));
  }
  async report(owner: string, report: Record<string, unknown>) {
    await this.put({ pk: 'RUN', sk: `${report.startedAt}#${owner}`, ...report,
      expiresAt: Math.floor(Date.now() / 1000) + 90 * 86400 });
  }
}
