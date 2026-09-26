import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REFERENCE_PRICE_CARD,
  withPriceCard,
  estimateRowCost,
  rowCost,
  tokensTotal,
  formatUsd,
  TOKEN_CLASSES,
} from '../lib/price.js';

const M = 1_000_000;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

test('a row with no usage costs nothing', () => {
  const c = estimateRowCost({});
  assert.equal(c.usd, 0);
  assert.equal(c.storageUsd, 0);
  assert.equal(c.tokenUsd, 0);
});

test('the cost formula is the one in the README, term by term', () => {
  const row = {
    storageReads: 1_000_000,
    llmCalls: 100,
    tokensIn: 1 * M,
    tokensOut: 1 * M,
    tokensReasoning: 1 * M,
    tokensCacheRead: 1 * M,
    tokensCacheWrite: 1 * M,
  };
  const card = REFERENCE_PRICE_CARD;
  const expected =
    1_000_000 * card.readUnitUsd +
    100 * card.callUnitUsd +
    (M / M) * card.perMillion.tokensIn +
    (M / M) * card.perMillion.tokensOut +
    (M / M) * card.perMillion.tokensReasoning +
    (M / M) * card.perMillion.tokensCacheRead +
    (M / M) * card.perMillion.tokensCacheWrite;
  close(estimateRowCost(row).usd, expected);
});

test('reasoning tokens are priced as output, not as input', () => {
  const c = estimateRowCost({ tokensReasoning: 1_000_000 });
  assert.equal(c.perToken.tokensReasoning, REFERENCE_PRICE_CARD.perMillion.tokensReasoning);
  assert.notEqual(c.perToken.tokensReasoning, c.perToken.tokensIn);
});

test('cache reads are priced far below fresh input, so the meter rewards caching', () => {
  const cache = REFERENCE_PRICE_CARD.perMillion.tokensCacheRead;
  const input = REFERENCE_PRICE_CARD.perMillion.tokensIn;
  assert.ok(cache < input / 5, `cache-read ${cache} should be far cheaper than input ${input}`);
});

test('a per-million price of zero really is free', () => {
  const c = estimateRowCost({ tokensOut: 100_000_000 }, withPriceCard({ perMillion: { tokensOut: 0 } }));
  assert.equal(c.usd, 0);
});

test('withPriceCard merges partial overrides over the reference card', () => {
  const card = withPriceCard({ readUnitUsd: 0.000001, perMillion: { tokensOut: 99 } });
  assert.equal(card.readUnitUsd, 0.000001);
  assert.equal(card.perMillion.tokensOut, 99);
  assert.equal(card.perMillion.tokensIn, REFERENCE_PRICE_CARD.perMillion.tokensIn, 'untouched keys survive');
  assert.equal(REFERENCE_PRICE_CARD.perMillion.tokensOut, 15, 'the reference card itself is frozen');
});

test('withPriceCard ignores a non-numeric override instead of poisoning the maths', () => {
  const card = withPriceCard({ readUnitUsd: 'free', perMillion: { tokensIn: NaN } });
  assert.equal(card.readUnitUsd, REFERENCE_PRICE_CARD.readUnitUsd);
  assert.equal(card.perMillion.tokensIn, REFERENCE_PRICE_CARD.perMillion.tokensIn);
});

test('withPriceCard is not order-dependent: overrides do not leak into the reference', () => {
  withPriceCard({ readUnitUsd: 7 });
  assert.equal(REFERENCE_PRICE_CARD.readUnitUsd, 0.0000004);
  assert.equal(withPriceCard().readUnitUsd, 0.0000004);
});

test('withPriceCard(undefined) yields a usable card', () => {
  const card = withPriceCard(undefined);
  assert.ok(card.perMillion.tokensIn > 0);
});

test('rowCost believes a supplied cost and says so', () => {
  const r = rowCost({ tokensIn: 1_000_000, estimatedCostUsd: 12.34 });
  assert.equal(r.usd, 12.34);
  assert.equal(r.source, 'supplied');
});

test('rowCost derives a cost when none was supplied, and flags the source', () => {
  const r = rowCost({ tokensIn: 1_000_000 });
  assert.equal(r.source, 'priceCard');
  assert.equal(r.usd, REFERENCE_PRICE_CARD.perMillion.tokensIn);
});

test('a supplied zero cost is treated as absent, not as a free-of-charge claim', () => {
  const r = rowCost({ tokensIn: 1_000_000, estimatedCostUsd: 0 });
  assert.equal(r.source, 'priceCard');
  assert.ok(r.usd > 0);
});

test('tokensTotal sums every token class and ignores unknown keys', () => {
  assert.equal(tokensTotal({ tokensIn: 1, tokensOut: 2, tokensReasoning: 3, tokensCacheRead: 4, tokensCacheWrite: 5, storageReads: 99 }), 15);
  assert.equal(tokensTotal({}), 0);
  assert.equal(tokensTotal(null), 0);
  assert.deepEqual([...TOKEN_CLASSES], [
    'tokensIn',
    'tokensOut',
    'tokensReasoning',
    'tokensCacheRead',
    'tokensCacheWrite',
  ]);
});

test('a million document reads at the reference rate is $0.40', () => {
  close(estimateRowCost({ storageReads: M }).usd, 0.4);
});

test('formatUsd stays readable at both extremes', () => {
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(0.0004), '$0.0004');
  assert.equal(formatUsd(0.05), '$0.05');
  assert.equal(formatUsd(12.5), '$12.50');
  assert.equal(formatUsd(1234.5), '$1234.50');
  assert.equal(formatUsd(undefined), '$0.00');
});
