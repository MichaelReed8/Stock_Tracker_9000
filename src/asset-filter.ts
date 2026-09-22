import type { AlpacaAsset } from './alpaca.js';

// Conservative exclusions based on explicit security descriptions, never just
// a ticker ending in W or R. Remaining assets still require FMP qualification.
export function isExplicitNonStockInstrument(asset: AlpacaAsset): boolean {
  return /\bwarrants?\b/i.test(asset.name) || /\brights?\s*$/i.test(asset.name);
}
