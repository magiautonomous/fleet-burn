// The cost model: four priced dimensions, one table, no magic.
//
//   estimated USD = reads  * readUnitUsd
//                + calls  * callUnitUsd
//                + tokens / 1e6 * tokenUsd[class]
//
// The default card is a *reference card* — a blended, round-number price list
// used so the meter has something honest to divide by when a fleet's own
// provider does not report a price. Every field is overridable, because the
// only number that matters is the one your invoice agrees with.
//
// Cache-read tokens are priced separately and cheaply on purpose: that is the
// whole reason a fleet should be caching. Price them like fresh input and the
// meter will tell you to stop caching, which would be bad advice.

/** Per-1M-token list prices in USD. */
export const REFERENCE_PRICE_CARD = Object.freeze({
  id: 'reference-2026-09',
  readUnitUsd: 0.0000004, // 1 Firestore document read = $0.40 per 1M
  callUnitUsd: 0.0, // a model call's cost is in its tokens, not a flat fee
  perMillion: Object.freeze({
    tokensIn: 3.0,
    tokensOut: 15.0,
    tokensReasoning: 15.0, // reasoning tokens are billed as output
    tokensCacheRead: 0.3,
    tokensCacheWrite: 3.75,
  }),
});

// Token classes that feed the per-token term, in the order they are summed.
export const TOKEN_CLASSES = Object.freeze([
  'tokensIn',
  'tokensOut',
  'tokensReasoning',
  'tokensCacheRead',
  'tokensCacheWrite',
]);

export function tokensTotal(row) {
  return TOKEN_CLASSES.reduce((a, k) => a + (Number(row?.[k]) || 0), 0);
}

// Merges a partial card over the reference card. Any field the caller supplies
// wins, including a `perMillion` object that is merged key by key. A scalar
// override that is not a finite number is ignored rather than allowed to turn
// the whole cost model into NaN.
export function withPriceCard(overrides) {
  if (!overrides || typeof overrides !== 'object') return { ...REFERENCE_PRICE_CARD };
  const { perMillion, ...rest } = overrides;
  const card = { ...REFERENCE_PRICE_CARD };
  for (const key of ['readUnitUsd', 'callUnitUsd', 'id']) {
    if (rest[key] === undefined) continue;
    if (key === 'id') {
      if (typeof rest.id === 'string') card.id = rest.id;
      continue;
    }
    const v = Number(rest[key]);
    if (Number.isFinite(v) && v >= 0) card[key] = v;
  }
  card.perMillion = { ...REFERENCE_PRICE_CARD.perMillion };
  if (perMillion && typeof perMillion === 'object') {
    for (const key of Object.keys(REFERENCE_PRICE_CARD.perMillion)) {
      const v = perMillion[key];
      if (Number.isFinite(Number(v)) && Number(v) >= 0) card.perMillion[key] = Number(v);
    }
  }
  return card;
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

// Cost of one meter row. Returns a plain object so callers can sum or
// inspect the parts without re-deriving the formula.
export function estimateRowCost(row, card = REFERENCE_PRICE_CARD) {
  const c = withPriceCard(card);
  const perToken = {};
  let usd = num(row.storageReads) * c.readUnitUsd + num(row.llmCalls) * c.callUnitUsd;
  for (const key of TOKEN_CLASSES) {
    const t = num(row[key]);
    const rate = c.perMillion[key];
    const part = (t / 1e6) * rate;
    perToken[key] = part;
    usd += part;
  }
  return {
    usd,
    rounded: round(usd, 6),
    usdPerDay: round(usd, 6),
    storageUsd: round(num(row.storageReads) * c.readUnitUsd, 6),
    llmUsd: round(num(row.llmCalls) * c.callUnitUsd, 6),
    tokenUsd: round(Object.values(perToken).reduce((a, b) => a + b, 0), 6),
    perToken,
  };
}

// A row that already carries an estimatedCostUsd is believed rather than
// re-priced — the emitting fleet may have a better price than our card — but the
// derived number is kept alongside so a mismatch is visible, not silent.
export function rowCost(row, card = REFERENCE_PRICE_CARD) {
  const derived = estimateRowCost(row, card);
  const supplied = Number(row?.estimatedCostUsd);
  if (Number.isFinite(supplied) && supplied > 0) {
    return { ...derived, usd: supplied, rounded: round(supplied, 6), usdPerDay: round(supplied, 6), source: 'supplied' };
  }
  return { ...derived, source: 'priceCard' };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function formatUsd(n) {
  const v = Number(n) || 0;
  if (v === 0) return '$0.00';
  if (Math.abs(v) < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}
