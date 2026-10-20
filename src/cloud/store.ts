import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand,
  UpdateCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import type { AlpacaAsset, TradingSession } from '../alpaca.js';
import type { DailySummary, PriceBatch, PricePlan, PriceRun } from './daily-summary.js';
import type { ProfileEntry, ProfileJobStore, BudgetStatus } from './profile-job.js';

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
  async acquire(owner: string, now: Date, scope = 'PROFILE') {
    try {
      await this.db.send(new PutCommand({ TableName: this.table,
        Item: { pk: 'LOCK', sk: scope, owner, leaseUntil: now.getTime() + 660_000 },
        ConditionExpression: 'attribute_not_exists(pk) OR leaseUntil < :now',
        ExpressionAttributeValues: { ':now': now.getTime() } }));
      return true;
    } catch (error) { if (conditionalFailure(error)) return false; throw error; }
  }
  async release(owner: string, scope = 'PROFILE') {
    try { await this.db.send(new DeleteCommand({ TableName: this.table, Key: { pk: 'LOCK', sk: scope },
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
          ConditionExpression: ':zero < :limit AND (attribute_not_exists(attempted) OR attempted < :limit) AND attribute_not_exists(blocked) AND (attribute_not_exists(retryAt) OR retryAt <= :now)',
          ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':limit': dailyLimit, ':now': now.getTime() } } },
        { Put: { TableName: this.table, Item: { pk: `ATTEMPT#${day}`, sk: symbol,
          expiresAt: Math.floor(now.getTime() / 1000) + 30 * 86400 },
          ConditionExpression: 'attribute_not_exists(pk) OR retryAt <= :now',
          ExpressionAttributeValues: { ':now': now.getTime() } } },
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
  async budgetStatus(day: string, dailyLimit: number, now: Date): Promise<BudgetStatus> {
    const budget = await this.get('BUDGET', day);
    if (budget?.blocked) return 'provider_paused';
    if (dailyLimit === 0 || Number(budget?.attempted ?? 0) >= dailyLimit) return 'daily_budget_exhausted';
    if (Number(budget?.retryAt ?? 0) > now.getTime()) return 'provider_cooldown';
    return 'available';
  }
  async importLocalBudget(day: string, localAttempts: number) {
    if (!Number.isInteger(localAttempts) || localAttempts < 0) throw new Error('Invalid local budget');
    const previous = await this.get('LOCAL_BUDGET', day);
    const imported = Number(previous?.attempted ?? 0);
    const additional = localAttempts - imported;
    if (additional <= 0) return;
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { Update: { TableName: this.table, Key: { pk: 'BUDGET', sk: day },
        UpdateExpression: 'SET attempted = if_not_exists(attempted, :zero) + :additional',
        ExpressionAttributeValues: { ':zero': 0, ':additional': additional } } },
      { Put: { TableName: this.table, Item: { pk: 'LOCAL_BUDGET', sk: day, attempted: localAttempts },
        ConditionExpression: previous ? 'attempted = :previous' : 'attribute_not_exists(pk)',
        ...(previous ? { ExpressionAttributeValues: { ':previous': imported } } : {}) } },
    ] }));
  }
  async save(entry: ProfileEntry) { await this.put({ pk: 'PROFILE', sk: entry.symbol, ...entry }); }
  async blockDay(day: string, reason: string) {
    await this.db.send(new UpdateCommand({ TableName: this.table, Key: { pk: 'BUDGET', sk: day },
      UpdateExpression: 'SET blocked = :yes, blockedReason = :reason',
      ExpressionAttributeValues: { ':yes': true, ':reason': reason } }));
  }
  async retryLater(entry: ProfileEntry, now: Date, retryAt: Date) {
    const day = now.toISOString().slice(0, 10);
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: this.table, Item: { pk: 'PROFILE', sk: entry.symbol, ...entry, retryAfter: retryAt.toISOString() } } },
      { Update: { TableName: this.table, Key: { pk: `ATTEMPT#${day}`, sk: entry.symbol },
        UpdateExpression: 'SET retryAt = :retry', ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':retry': retryAt.getTime() } } },
      { Update: { TableName: this.table, Key: { pk: 'BUDGET', sk: day },
        UpdateExpression: 'SET retryAt = :retry', ExpressionAttributeValues: { ':retry': retryAt.getTime() } } },
    ] }));
  }
  async report(owner: string, report: Record<string, unknown>) {
    await this.put({ pk: 'RUN', sk: `${report.startedAt}#${owner}`, ...report,
      expiresAt: Math.floor(Date.now() / 1000) + 90 * 86400 });
  }
  async acquirePrice(owner: string, now: Date) { return this.acquire(owner, now, 'PRICE'); }
  async releasePrice(owner: string) { await this.release(owner, 'PRICE'); }
  async priceCalendar(): Promise<{ fetchedAt: string; throughDate?: string; sessions: TradingSession[] } | null> {
    const row = await this.get('CALENDAR', 'US');
    return row ? { fetchedAt: row.fetchedAt, throughDate: row.throughDate, sessions: row.sessions } : null;
  }
  async savePriceCalendar(sessions: TradingSession[], now: Date, throughDate: string) {
    await this.put({ pk: 'CALENDAR', sk: 'US', fetchedAt: now.toISOString(), throughDate, sessions });
  }
  async currentPriceRun(): Promise<PriceRun | null> {
    const pointer = await this.get('PRICE_CONTROL', 'CURRENT');
    if (!pointer) return null;
    const row = await this.get('PRICE_RUN', pointer.id);
    if (!row) throw new Error('Missing price run');
    const { pk, sk, ...run } = row;
    return run as PriceRun;
  }
  async startPriceRun(run: PriceRun, plans: PricePlan[]) {
    for (const plan of plans) await this.put({ pk: `PRICE_PLAN#${run.id}`, sk: String(plan.index).padStart(6, '0'), ...plan });
    await this.db.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: this.table, Item: { pk: 'PRICE_RUN', sk: run.id, ...run }, ConditionExpression: 'attribute_not_exists(pk)' } },
      { Put: { TableName: this.table, Item: { pk: 'PRICE_CONTROL', sk: 'CURRENT', id: run.id } } },
    ] }));
  }
  async pricePlans(id: string): Promise<PricePlan[]> {
    return (await this.query(`PRICE_PLAN#${id}`)).map(row => ({ index: row.index, assets: row.assets }));
  }
  async priceBatches(id: string): Promise<PriceBatch[]> {
    return (await this.query(`PRICE_BATCH#${id}`)).map(row => ({ index: row.index, assets: row.assets,
      bars: row.bars, observedAt: row.observedAt }));
  }
  async savePriceBatch(run: PriceRun, batch: PriceBatch) {
    await this.db.send(new PutCommand({ TableName: this.table, Item: {
      pk: `PRICE_BATCH#${run.id}`, sk: String(batch.index).padStart(6, '0'),
      startDate: run.startDate, endDate: run.endDate, source: 'alpaca_sip', adjustment: 'split', ...batch },
      ConditionExpression: 'attribute_not_exists(pk)' }));
  }
  async completePriceRun(run: PriceRun, now: Date) {
    await this.db.send(new UpdateCommand({ TableName: this.table, Key: { pk: 'PRICE_RUN', sk: run.id },
      UpdateExpression: 'SET #state = :complete, completedAt = :now',
      ExpressionAttributeNames: { '#state': 'status' },
      ExpressionAttributeValues: { ':complete': 'complete', ':now': now.toISOString() } }));
  }
  async saveSummary(summary: DailySummary) {
    let created = false;
    try {
      await this.db.send(new PutCommand({ TableName: this.table,
        Item: { pk: `SUMMARY#${summary.endDate}`, sk: summary.id, ...summary },
        ConditionExpression: 'attribute_not_exists(pk)' }));
      created = true;
    } catch (error) { if (!conditionalFailure(error)) throw error; }
    // Recover a crash after snapshot insertion without replacing the immutable item.
    try {
      await this.db.send(new PutCommand({ TableName: this.table,
        Item: { pk: 'SUMMARY', sk: 'LATEST', endDate: summary.endDate, id: summary.id,
          snapshotPk: `SUMMARY#${summary.endDate}`, updatedAt: summary.createdAt },
        ConditionExpression: 'attribute_not_exists(pk) OR endDate < :date OR (endDate = :date AND updatedAt <= :now)',
        ExpressionAttributeValues: { ':date': summary.endDate, ':now': summary.createdAt } }));
    } catch (error) { if (!conditionalFailure(error)) throw error; }
    return created;
  }
}
