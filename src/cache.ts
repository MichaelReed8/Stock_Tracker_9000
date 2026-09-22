import initSqlJs, { type Database } from 'sql.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { AlpacaAsset, PriceBar } from './alpaca.js';

const require = createRequire(import.meta.url);
const wasmFile = join(dirname(require.resolve('sql.js')), 'sql-wasm.wasm');

export type CompanyProfile = {
  symbol: string;
  fetchedAt: string;
  marketCap: number | null;
  industry: string | null;
  sector: string | null;
  country: string | null;
  isEtf: boolean | null;
  isFund: boolean | null;
};

export class CacheDb {
  private constructor(private readonly db: Database, private readonly file: string) {}

  static async open(file: string): Promise<CacheDb> {
    const SQL = await initSqlJs({ locateFile: () => wasmFile });
    let existing: Uint8Array | undefined;
    try { existing = await readFile(file); } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    const db = existing ? new SQL.Database(existing) : new SQL.Database();
    db.run(`CREATE TABLE IF NOT EXISTS price_bars (
      symbol TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL CHECK(close > 0),
      source TEXT NOT NULL, adjustment TEXT NOT NULL,
      PRIMARY KEY (symbol, date, source, adjustment)
    );
    CREATE TABLE IF NOT EXISTS company_profiles (
      symbol TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, market_cap REAL,
      industry TEXT, sector TEXT, country TEXT, is_etf INTEGER, is_fund INTEGER
    );
    CREATE TABLE IF NOT EXISTS fmp_request_budget (
      utc_date TEXT PRIMARY KEY, attempted INTEGER NOT NULL CHECK(attempted >= 0)
    );
    CREATE TABLE IF NOT EXISTS profile_enrichment_attempts (
      symbol TEXT NOT NULL, utc_date TEXT NOT NULL, outcome TEXT NOT NULL,
      PRIMARY KEY(symbol, utc_date)
    );
    CREATE TABLE IF NOT EXISTS alpaca_assets (
      symbol TEXT PRIMARY KEY, name TEXT NOT NULL, exchange TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_scan_batches (
      run_key TEXT NOT NULL, batch_index INTEGER NOT NULL, completed_at TEXT NOT NULL,
      row_count INTEGER NOT NULL, PRIMARY KEY(run_key, batch_index)
    );`);
    return new CacheDb(db, file);
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, this.db.export());
    await rename(tmp, this.file);
  }

  async putBars(bars: PriceBar[]): Promise<void> {
    this.db.run('BEGIN');
    try {
      const statement = this.db.prepare(`INSERT INTO price_bars
        (symbol, date, close, source, adjustment) VALUES (?, ?, ?, 'alpaca_sip', 'split')
        ON CONFLICT(symbol, date, source, adjustment) DO UPDATE SET close=excluded.close`);
      try { for (const bar of bars) statement.run([bar.symbol, bar.date, bar.close]); }
      finally { statement.free(); }
      this.db.run('COMMIT');
    } catch (error) { this.db.run('ROLLBACK'); throw error; }
    await this.save();
  }

  async commitPriceBatch(runKey: string, batchIndex: number, bars: PriceBar[]): Promise<void> {
    this.db.run('BEGIN');
    try {
      const statement = this.db.prepare(`INSERT INTO price_bars
        (symbol, date, close, source, adjustment) VALUES (?, ?, ?, 'alpaca_sip', 'split')
        ON CONFLICT(symbol, date, source, adjustment) DO UPDATE SET close=excluded.close`);
      try { for (const bar of bars) statement.run([bar.symbol, bar.date, bar.close]); }
      finally { statement.free(); }
      this.db.run(`INSERT INTO price_scan_batches
        (run_key, batch_index, completed_at, row_count) VALUES (?, ?, ?, ?)
        ON CONFLICT(run_key, batch_index) DO UPDATE SET
        completed_at=excluded.completed_at, row_count=excluded.row_count`,
      [runKey, batchIndex, new Date().toISOString(), bars.length]);
      this.db.run('COMMIT');
    } catch (error) { this.db.run('ROLLBACK'); throw error; }
    await this.save();
  }

  completedPriceBatches(runKey: string): Set<number> {
    const rows = this.db.exec('SELECT batch_index FROM price_scan_batches WHERE run_key=?', [runKey]);
    return new Set(rows[0]?.values.map(row => Number(row[0])) ?? []);
  }

  priceCoverage(symbols: string[], startDate: string, endDate: string): {
    both: number; startOnly: number; endOnly: number; neither: number;
  } {
    const rows = this.db.exec(`SELECT symbol, date FROM price_bars
      WHERE source='alpaca_sip' AND adjustment='split' AND date IN (?, ?)`, [startDate, endDate]);
    const dates = new Map<string, Set<string>>();
    for (const [symbol, date] of rows[0]?.values ?? []) {
      const key = String(symbol);
      if (!dates.has(key)) dates.set(key, new Set());
      dates.get(key)!.add(String(date));
    }
    const coverage = { both: 0, startOnly: 0, endOnly: 0, neither: 0 };
    for (const symbol of symbols) {
      const start = dates.get(symbol)?.has(startDate) ?? false;
      const end = dates.get(symbol)?.has(endDate) ?? false;
      if (start && end) coverage.both++;
      else if (start) coverage.startOnly++;
      else if (end) coverage.endOnly++;
      else coverage.neither++;
    }
    return coverage;
  }

  getBars(symbol: string): PriceBar[] {
    const result = this.db.exec(`SELECT symbol, date, close FROM price_bars
      WHERE symbol=? AND source='alpaca_sip' AND adjustment='split' ORDER BY date`, [symbol]);
    return result[0]?.values.map(row => ({ symbol: String(row[0]), date: String(row[1]), close: Number(row[2]) })) ?? [];
  }

  getBarsForDates(startDate: string, endDate: string): PriceBar[] {
    const result = this.db.exec(`SELECT symbol, date, close FROM price_bars
      WHERE source='alpaca_sip' AND adjustment='split' AND date IN (?, ?)`, [startDate, endDate]);
    return result[0]?.values.map(row => ({ symbol: String(row[0]), date: String(row[1]), close: Number(row[2]) })) ?? [];
  }

  async replaceAssets(assets: AlpacaAsset[], observedAt: string): Promise<void> {
    this.db.run('BEGIN');
    try {
      this.db.run('DELETE FROM alpaca_assets');
      const statement = this.db.prepare(`INSERT INTO alpaca_assets
        (symbol, name, exchange, observed_at) VALUES (?, ?, ?, ?)`);
      try { for (const asset of assets) statement.run([asset.symbol, asset.name, asset.exchange, observedAt]); }
      finally { statement.free(); }
      this.db.run('COMMIT');
    } catch (error) { this.db.run('ROLLBACK'); throw error; }
    await this.save();
  }

  getAssets(): AlpacaAsset[] {
    const result = this.db.exec('SELECT symbol, name, exchange FROM alpaca_assets ORDER BY symbol');
    return result[0]?.values.map(row => ({
      symbol: String(row[0]), name: String(row[1]), exchange: String(row[2]),
    })) ?? [];
  }

  async putProfile(profile: CompanyProfile): Promise<void> {
    this.db.run(`INSERT INTO company_profiles
      (symbol, fetched_at, market_cap, industry, sector, country, is_etf, is_fund)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET fetched_at=excluded.fetched_at,
      market_cap=excluded.market_cap, industry=excluded.industry, sector=excluded.sector,
      country=excluded.country, is_etf=excluded.is_etf, is_fund=excluded.is_fund`, [
      profile.symbol, profile.fetchedAt, profile.marketCap, profile.industry,
      profile.sector, profile.country,
      profile.isEtf === null ? null : Number(profile.isEtf),
      profile.isFund === null ? null : Number(profile.isFund),
    ]);
    await this.save();
  }

  getProfile(symbol: string): CompanyProfile | null {
    const rows = this.db.exec(`SELECT symbol, fetched_at, market_cap, industry, sector, country, is_etf, is_fund
      FROM company_profiles WHERE symbol=?`, [symbol]);
    const row = rows[0]?.values[0];
    return row ? {
      symbol: String(row[0]), fetchedAt: String(row[1]), marketCap: row[2] === null ? null : Number(row[2]),
      industry: row[3] === null ? null : String(row[3]),
      sector: row[4] === null ? null : String(row[4]),
      country: row[5] === null ? null : String(row[5]),
      isEtf: row[6] === null ? null : Boolean(row[6]),
      isFund: row[7] === null ? null : Boolean(row[7]),
    } : null;
  }

  getFmpAttempts(utcDate: string): number {
    return Number(this.db.exec('SELECT attempted FROM fmp_request_budget WHERE utc_date=?', [utcDate])[0]?.values[0]?.[0] ?? 0);
  }

  enrichmentAttempted(symbol: string, utcDate: string): boolean {
    return Boolean(this.db.exec('SELECT 1 FROM profile_enrichment_attempts WHERE symbol=? AND utc_date=?',
      [symbol, utcDate])[0]?.values.length);
  }

  async recordEnrichmentAttempt(symbol: string, utcDate: string, outcome: string): Promise<void> {
    this.db.run(`INSERT INTO profile_enrichment_attempts (symbol, utc_date, outcome) VALUES (?, ?, ?)
      ON CONFLICT(symbol, utc_date) DO UPDATE SET outcome=excluded.outcome`, [symbol, utcDate, outcome]);
    await this.save();
  }

  async reserveFmpRequest(utcDate: string, maxDailyAttempts = 200): Promise<boolean> {
    if (this.getFmpAttempts(utcDate) >= maxDailyAttempts) return false;
    this.db.run(`INSERT INTO fmp_request_budget (utc_date, attempted) VALUES (?, 1)
      ON CONFLICT(utc_date) DO UPDATE SET attempted=attempted+1`, [utcDate]);
    await this.save();
    return true;
  }

  close(): void { this.db.close(); }
}
