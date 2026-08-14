/**
 * Per-model list prices, in dollars per million tokens.
 *
 * These produce a NOTIONAL figure: on a subscription plan no dollars change hands,
 * so every surface that shows this number must label it "equivalent API value",
 * never "cost" or "spend".
 *
 * Ids are matched by prefix, so a dated id (claude-haiku-4-5-20251001) resolves to
 * its family. An unknown model returns null rather than 0 — "we do not know" and
 * "it was free" are different facts and the UI shows them differently.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

const PRICES: ReadonlyArray<readonly [string, ModelPrice]> = [
  ['claude-opus-5',   { input: 15,  output: 75, cacheRead: 1.5,  cacheCreate: 18.75 }],
  ['claude-sonnet-5', { input: 3,   output: 15, cacheRead: 0.3,  cacheCreate: 3.75 }],
  ['claude-haiku-4-5',{ input: 0.8, output: 4,  cacheRead: 0.08, cacheCreate: 1 }],
  ['claude-fable-5',  { input: 3,   output: 15, cacheRead: 0.3,  cacheCreate: 3.75 }],
];

export function priceFor(model: string): ModelPrice | null {
  if (!model) return null;
  for (const [prefix, price] of PRICES) {
    if (model.startsWith(prefix)) return price;
  }
  return null;
}

export function notionalValueUsd(t: {
  model: string; input: number; output: number; cacheRead: number; cacheCreate: number;
}): number | null {
  const p = priceFor(t.model);
  if (!p) return null;
  return (t.input / 1e6) * p.input
       + (t.output / 1e6) * p.output
       + (t.cacheRead / 1e6) * p.cacheRead
       + (t.cacheCreate / 1e6) * p.cacheCreate;
}
