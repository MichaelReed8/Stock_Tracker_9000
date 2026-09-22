import { loadEnvFile } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';

// Dependency-free Node 20.12+ backend diagnostic. Never log payloads or errors.
const root = new URL('../', import.meta.url);
const knownFields = ['symbol', 'companyName', 'marketCap', 'sector', 'industry',
  'country', 'exchange', 'exchangeShortName', 'isEtf', 'isFund', 'isActivelyTrading',
  'date', 'price', 'close', 'adjClose', 'volume', 'averageChange'];
const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const isSymbol = value => typeof value === 'string' && /^[A-Z][A-Z0-9.-]{0,14}$/.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function safeJson(value, key) {
  let output = JSON.stringify(value, null, 2);
  for (const secret of [key, encodeURIComponent(key)]) {
    if (secret) output = output.split(secret).join('[REDACTED]');
  }
  return output;
}

export function summarize(rows) {
  const objects = rows.filter(row => row && typeof row === 'object' && !Array.isArray(row));
  const dates = objects.map(row => row.date).filter(isDate).sort();
  return {
    rowCount: rows.length,
    fieldsPresent: knownFields.filter(field => objects.some(row => Object.hasOwn(row, field))),
    ...(dates.length ? { firstDate: dates[0], lastDate: dates.at(-1) } : {}),
    numericPriceRows: objects.filter(row => finite(row.price) && row.price > 0).length,
    numericMarketCapRows: objects.filter(row => finite(row.marketCap)).length,
    numericAverageChangeRows: objects.filter(row => finite(row.averageChange)).length,
  };
}

export async function probe(key, { fetchImpl = fetch, now = new Date(), screenOnly = false, marketCapOptions = false } = {}) {
  // Previous weekday is a diagnostic date, not a production exchange calendar.
  const day = new Date(now.toISOString().slice(0, 10));
  do { day.setUTCDate(day.getUTCDate() - 1); } while ([0, 6].includes(day.getUTCDay()));
  const to = day.toISOString().slice(0, 10);
  day.setUTCDate(day.getUTCDate() - 28);
  const from = day.toISOString().slice(0, 10);
  const report = {
    checkedAt: now.toISOString(), keyConfigured: Boolean(key),
    maxRequests: screenOnly || marketCapOptions ? 2 : 8, attemptedRequests: 0, results: [],
    assumptions: { marketCapMoreThan: 10_000_000_000, country: 'US', from, to },
    limitations: [
      'Sample only; does not establish the complete supported-symbol set.',
      'Request count is local attempts, not verified vendor billing or remaining quota.',
      'Screen completeness and pagination must be verified separately.',
      'Price adjustment and industry weighting/period methodology remain unverified.',
      'Prior weekday may be a holiday; empty data does not prove lack of access.',
    ],
  };
  let stopped = !key;
  async function request(label, endpoint, params) {
    if (stopped || report.attemptedRequests >= report.maxRequests) return [];
    const entry = { label, endpoint, parameters: params };
    report.results.push(entry);
    const url = new URL(`https://financialmodelingprep.com/stable/${endpoint}`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
    url.searchParams.set('apikey', key);
    report.attemptedRequests++;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
      entry.httpStatus = response.status;
      if (!response.ok) {
        entry.outcome = response.status === 401 ? 'authentication_rejected'
          : response.status === 402 || response.status === 403 ? 'access_denied'
          : response.status === 429 ? 'rate_limited' : 'http_error';
        // Do not read or print HTTP error bodies, which may echo authenticated URLs.
        await response.body?.cancel();
        if ([401, 429].includes(response.status) || response.status >= 500) stopped = true;
        return [];
      }
      let payload;
      try { payload = await response.json(); } catch {
        entry.outcome = 'invalid_json';
        stopped = true;
        return [];
      }
      if (!Array.isArray(payload)) {
        entry.outcome = 'unexpected_or_error_payload';
        // Some API failures use HTTP 200. Stop without returning the body.
        stopped = true;
        return [];
      }
      entry.outcome = payload.length ? 'data_received' : 'empty';
      entry.summary = summarize(payload);
      return payload.filter(row => row && typeof row === 'object' && !Array.isArray(row));
    } catch {
      entry.outcome = 'network_or_timeout_error';
      stopped = true;
      return [];
    }
  }

  if (marketCapOptions) {
    await request('stock_list', 'stock-list', {});
    await request('profile_bulk_first_part', 'profile-bulk', { part: 0 });
    report.stoppedEarly = stopped;
    return JSON.parse(safeJson(report, key));
  }
  if (screenOnly) {
    await request('screener_minimal', 'company-screener', { limit: 10 });
    await request('screener_market_cap_only', 'company-screener', { marketCapMoreThan: 10_000_000_000, limit: 10 });
    report.stoppedEarly = stopped;
    return JSON.parse(safeJson(report, key));
  }

  const filters = { marketCapMoreThan: 10_000_000_000, country: 'US',
    isEtf: false, isFund: false, isActivelyTrading: true, limit: 1000 };
  const screened = await request('market_cap_screen', 'company-screener', filters);
  if (screened.length) {
    report.screen = {
      returned: screened.length, reachedRequestedLimit: screened.length >= filters.limit,
      missingOrInvalidMarketCaps: screened.filter(row => !finite(row.marketCap)).length,
      belowRequestedCap: screened.filter(row => finite(row.marketCap) && row.marketCap <= filters.marketCapMoreThan).length,
      nonUSOrMissingCountry: screened.filter(row => row.country !== 'US').length,
      etfsOrFundsReturned: screened.filter(row => row.isEtf === true || row.isFund === true).length,
      sampleSymbols: screened.map(row => row.symbol).filter(isSymbol).slice(0, 5),
    };
    const industry = screened.find(row => typeof row.industry === 'string' && /^[A-Za-z0-9 &(),./-]{1,100}$/.test(row.industry))?.industry;
    if (industry) {
      const filtered = await request('industry_filter_screen', 'company-screener', { ...filters, industry });
      report.industryFilter = { requested: industry, returned: filtered.length,
        mismatchedRows: filtered.filter(row => row.industry !== industry).length };
    }
  }
  await request('company_profile', 'profile', { symbol: 'AAPL' });
  const extra = screened.map(row => row.symbol).find(symbol => isSymbol(symbol) && !['AAPL', 'MSFT'].includes(symbol));
  for (const symbol of ['AAPL', 'MSFT', ...(extra ? [extra] : [])]) {
    await request(`price_history_${symbol}`, 'historical-price-eod/light', { symbol, from, to });
  }
  await request('industry_snapshot', 'industry-performance-snapshot', { date: to });
  await request('industry_history', 'historical-industry-performance', { industry: 'Biotechnology', from, to });
  report.stoppedEarly = stopped;
  // Only the sanitized, allowlisted report crosses the backend boundary.
  return JSON.parse(safeJson(report, key));
}

async function main() {
  try { loadEnvFile(fileURLToPath(new URL('.env.local', root))); } catch {
    console.log('Local configuration could not be loaded. No requests made.');
    process.exitCode = 1;
    return;
  }
  const key = process.env.FMP_API_KEY?.trim() || '';
  if (!key) {
    console.log('FMP_API_KEY is not configured. No requests made.');
    process.exitCode = 1;
    return;
  }
  const screenOnly = process.argv.includes('--screen-only');
  const marketCapOptions = process.argv.includes('--market-cap-options');
  const report = await probe(key, { screenOnly, marketCapOptions });
  const output = safeJson(report, key);
  const reportName = marketCapOptions ? 'fmp-market-cap-options-report.json'
    : screenOnly ? 'fmp-screener-report.json' : 'fmp-probe-report.json';
  await writeFile(new URL(reportName, root), `${output}\n`, 'utf8');
  console.log(output);
  if (report.stoppedEarly) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    console.error('Probe failed locally; error details suppressed to protect credentials.');
    process.exitCode = 1;
  });
}
