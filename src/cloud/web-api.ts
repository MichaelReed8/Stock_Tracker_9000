import type { DailySummary } from './daily-summary.js';

export type ReadItem = (pk: string, sk: string) => Promise<Record<string, any> | undefined>;
export type WebEvent = { rawPath: string; headers: Record<string, string | undefined>; requestContext: { http: { method: string } } };
export const securityHeaders = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self'; connect-src 'self' https://cognito-idp.ca-central-1.amazonaws.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'strict-transport-security': 'max-age=31536000', 'permissions-policy': 'camera=(), microphone=(), geolocation=()' };
export function json(statusCode: number, value: unknown) { return { statusCode, headers: { ...securityHeaders, 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(value) }; }

export async function summaryApi(event: WebEvent, read: ReadItem, authorize: (token: string) => Promise<unknown>) {
  if (event.requestContext.http.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  const token = /^Bearer (\S+)$/i.exec(event.headers.authorization || event.headers.Authorization || '')?.[1];
  if (!token) return json(401, { error: 'sign_in_required' });
  try { await authorize(token); } catch { return json(401, { error: 'sign_in_required' }); }
  let pk: string, sk: string;
  if (event.rawPath === '/api/summaries/latest') {
    const pointer = await read('SUMMARY', 'LATEST');
    if (!pointer) return json(404, { error: 'summary_not_ready' });
    if (!/^SUMMARY#\d{4}-\d{2}-\d{2}$/.test(pointer.snapshotPk) || !/^[a-f0-9]{64}$/.test(pointer.id)) return json(503, { error: 'summary_unavailable' });
    pk = pointer.snapshotPk; sk = pointer.id;
  } else {
    const match = /^\/api\/summaries\/(\d{4}-\d{2}-\d{2})\/([a-f0-9]{64})$/.exec(event.rawPath);
    if (!match) return json(404, { error: 'not_found' });
    pk = `SUMMARY#${match[1]}`; sk = match[2];
  }
  const item = await read(pk, sk);
  if (!item || item.kind !== 'daily_stock_summary' || item.schemaVersion !== 1) return json(404, { error: 'summary_not_ready' });
  // Project the saved public summary fields; never return arbitrary table attributes.
  const { id, createdAt, kind, schemaVersion, priceRunId, startDate, endDate, settings, label, scope,
    profileCoverage, returnType, feed, countryBasis, notificationEligible, coverage, gainers, losers } = item as DailySummary;
  return json(200, { id, createdAt, kind, schemaVersion, priceRunId, startDate, endDate, settings, label, scope,
    profileCoverage, returnType, feed, countryBasis, notificationEligible, coverage, gainers, losers });
}
