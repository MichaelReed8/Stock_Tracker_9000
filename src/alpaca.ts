export type PriceBar = { symbol: string; date: string; close: number };
export type AlpacaAsset = { symbol: string; name: string; exchange: string };

const symbolPattern = /^[A-Z][A-Z0-9.-]{0,14}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class AlpacaClient {
  requestCount = 0;
  private lastRequestAt = 0;
  constructor(
    private readonly keyId: string,
    private readonly secretKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly minRequestSpacingMs = 350,
  ) {
    if (!keyId || !secretKey) throw new Error('Alpaca credentials are not configured');
  }

  private async get(url: URL): Promise<unknown> {
    try {
      const remaining = this.minRequestSpacingMs - (Date.now() - this.lastRequestAt);
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
      this.lastRequestAt = Date.now();
      this.requestCount++;
      const response = await this.fetchImpl(url, {
        headers: {
          'APCA-API-KEY-ID': this.keyId,
          'APCA-API-SECRET-KEY': this.secretKey,
        },
        signal: AbortSignal.timeout(20_000),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Alpaca returned HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      // Fetch errors can contain request URLs or headers. Never propagate them.
      if (error instanceof Error && /^Alpaca returned HTTP \d{3}$/.test(error.message)) throw error;
      throw new Error('Alpaca request failed or returned invalid JSON');
    }
  }

  async activeUsAssets(): Promise<AlpacaAsset[]> {
    const url = new URL('https://paper-api.alpaca.markets/v2/assets');
    url.searchParams.set('status', 'active');
    url.searchParams.set('asset_class', 'us_equity');
    const data = await this.get(url);
    if (!Array.isArray(data)) throw new Error('Alpaca assets response has an unexpected shape');
    return data.filter(isRecord).filter(row =>
      typeof row.symbol === 'string' && symbolPattern.test(row.symbol) &&
      typeof row.name === 'string' && typeof row.exchange === 'string'
    ).map(row => ({ symbol: row.symbol as string, name: row.name as string, exchange: row.exchange as string }));
  }

  async dailyBars(symbols: string[], start: string, end: string): Promise<PriceBar[]> {
    if (!symbols.length || symbols.length > 100 || symbols.some(symbol => !symbolPattern.test(symbol))) {
      throw new Error('Use 1 to 100 valid symbols per historical-bars request');
    }
    if (!datePattern.test(start) || !datePattern.test(end) || start > end) {
      throw new Error('Use valid ascending YYYY-MM-DD dates');
    }
    const bars: PriceBar[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < 100; page++) {
      const url = new URL('https://data.alpaca.markets/v2/stocks/bars');
      url.searchParams.set('symbols', symbols.join(','));
      url.searchParams.set('timeframe', '1Day');
      url.searchParams.set('start', start);
      url.searchParams.set('end', `${end}T23:59:59Z`);
      url.searchParams.set('limit', '10000');
      url.searchParams.set('feed', 'sip');
      url.searchParams.set('adjustment', 'split');
      if (pageToken) url.searchParams.set('page_token', pageToken);
      const data = await this.get(url);
      if (!isRecord(data) || !isRecord(data.bars)) throw new Error('Alpaca bars response has an unexpected shape');
      for (const symbol of symbols) {
        const rows = data.bars[symbol];
        if (rows === undefined) continue;
        if (!Array.isArray(rows)) throw new Error('Alpaca symbol bars have an unexpected shape');
        for (const row of rows) {
          if (!isRecord(row) || typeof row.t !== 'string' || !datePattern.test(row.t.slice(0, 10)) ||
            typeof row.c !== 'number' || !Number.isFinite(row.c) || row.c <= 0) {
            throw new Error('Alpaca returned an invalid daily price bar');
          }
          bars.push({ symbol, date: row.t.slice(0, 10), close: row.c });
        }
      }
      const next = data.next_page_token;
      if (next === null || next === undefined || next === '') return bars;
      if (typeof next !== 'string' || seenTokens.has(next)) throw new Error('Alpaca pagination did not advance');
      seenTokens.add(next);
      pageToken = next;
    }
    throw new Error('Alpaca pagination exceeded the safe page limit');
  }
}

export function percentChange(startClose: number, endClose: number): number {
  if (!Number.isFinite(startClose) || !Number.isFinite(endClose) || startClose <= 0 || endClose <= 0) {
    throw new Error('Both closing prices must be positive finite numbers');
  }
  return 100 * (endClose / startClose - 1);
}
