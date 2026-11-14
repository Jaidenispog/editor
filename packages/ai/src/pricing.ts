/** USD per million tokens for one model. */
export interface ModelRates {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

/** Rates keyed by model id. */
export type RateTable = Readonly<Record<string, ModelRates>>;

/**
 * Anthropic first-party list prices, current when this package was written (November 2026).
 * Cache writes are priced at the 5-minute TTL rate. Claude Haiku 5.5 is priced for prompts up to 100K
 * tokens, which covers every request this app makes. Prices change: pass an overriding table to the
 * providers (or to `estimateCost`) rather than editing these numbers in place.
 */
export const DEFAULT_MODEL_RATES: RateTable = {
  'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 },
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
  'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125 },
};

/** Token counts as reported by a provider. */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Result of a cost estimate. */
export interface CostEstimate {
  estimatedCostUsdCents: number;
  /** False when the model is not in the rate table; the cost is then reported as 0. */
  priced: boolean;
}

/** Returns a rate table with `overrides` layered over the defaults (use it to update prices without a code change). */
export function mergeRates(overrides: Readonly<Record<string, ModelRates>>, base: RateTable = DEFAULT_MODEL_RATES): RateTable {
  return { ...base, ...overrides };
}

/** Finds the rates for a model id, accepting exact ids and provider-specific suffixes such as "@2026…" or "-v1". */
export function ratesFor(model: string, table: RateTable = DEFAULT_MODEL_RATES): ModelRates | null {
  const exact = table[model];
  if (exact) return exact;
  const key = Object.keys(table)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(`${k}-`) || model.startsWith(`${k}@`) || model.endsWith(`.${k}`));
  return key ? (table[key] ?? null) : null;
}

/** Estimated cost of a call in US cents; unknown models are reported as 0 with `priced: false`. */
export function estimateCost(usage: TokenCounts, model: string, table: RateTable = DEFAULT_MODEL_RATES): CostEstimate {
  const rates = ratesFor(model, table);
  if (!rates) return { estimatedCostUsdCents: 0, priced: false };
  const usd =
    (usage.inputTokens * rates.inputPerMTok +
      usage.outputTokens * rates.outputPerMTok +
      usage.cacheReadTokens * rates.cacheReadPerMTok +
      usage.cacheWriteTokens * rates.cacheWritePerMTok) /
    1_000_000;
  return { estimatedCostUsdCents: Math.round(usd * 100 * 10_000) / 10_000, priced: true };
}

/** Shorthand for `estimateCost(...).estimatedCostUsdCents` (0 for models without known rates). */
export function estimateCostUsdCents(usage: TokenCounts, model: string, table: RateTable = DEFAULT_MODEL_RATES): number {
  return estimateCost(usage, model, table).estimatedCostUsdCents;
}
