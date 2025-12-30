jest.mock('../priceCacheService', () => ({
  getCachedPrices: jest.fn(),
  normalizeAdjustment: (value) => value,
  fetchLatestPrice: jest.fn(),
}));

const fs = require('fs');
const path = require('path');

const { evaluateDefsymphonyStrategy } = require('../defsymphonyEvaluator');
const { getCachedPrices } = require('../priceCacheService');

const buildPriceResponseFromSeries = (closes) => ({
  bars: closes.map((close, index) => {
    const value = Number(Number(close).toFixed(8));
    const timestamp = new Date(2020, 0, index + 1).toISOString();
    return {
      t: timestamp,
      o: value,
      h: value,
      l: value,
      c: value,
      v: 1000,
    };
  }),
});

const buildClosesFromReturnPattern = ({ start, pattern, length }) => {
  const closes = [start];
  for (let idx = 1; idx < length; idx += 1) {
    const prior = closes[closes.length - 1];
    const dailyReturn = pattern[(idx - 1) % pattern.length];
    closes.push(prior * (1 + dailyReturn));
  }
  return closes;
};

const buildClosesWithTail = ({ baseClose, length, tail }) => {
  const closes = Array.from({ length }, () => baseClose);
  tail.forEach((value, idx) => {
    closes[length - tail.length + idx] = value;
  });
  return closes;
};

const installPriceMapMock = (priceMap) => {
  getCachedPrices.mockImplementation(async ({ symbol }) => {
    const entry = priceMap[symbol.toUpperCase()];
    if (!entry) {
      throw new Error(`Missing mock price data for ${symbol}`);
    }
    return entry;
  });
};

describe('evaluateDefsymphonyStrategy (Composer parity)', () => {
  beforeEach(() => {
    getCachedPrices.mockReset();
  });

  it('defaults to dividend-adjusted pricing (Composer-style) when evaluating returns-based filters', async () => {
    const barsLength = 120;

    const gld = buildClosesFromReturnPattern({
      start: 100,
      pattern: [0],
      length: barsLength,
    });
    const spySplit = buildClosesFromReturnPattern({
      start: 100,
      pattern: [-0.01],
      length: barsLength,
    });
    const spyAll = buildClosesFromReturnPattern({
      start: 100,
      pattern: [0.01],
      length: barsLength,
    });

    getCachedPrices.mockImplementation(async ({ symbol, adjustment }) => {
      const upper = symbol.toUpperCase();
      if (upper === 'GLD') {
        return buildPriceResponseFromSeries(gld);
      }
      if (upper === 'SPY') {
        return buildPriceResponseFromSeries(adjustment === 'all' ? spyAll : spySplit);
      }
      throw new Error(`Unexpected symbol ${symbol}`);
    });

    const strategy = `
      (defsymphony "Adjustment Test" {}
        (filter
          (moving-average-return {:window 60})
          (select-bottom 1)
          [
            (asset "SPY")
            (asset "GLD")
          ]))
    `;

    const defaultResult = await evaluateDefsymphonyStrategy({
      strategyText: strategy,
      budget: 10000,
    });
    expect(defaultResult.positions.map((pos) => pos.symbol)).toEqual(['GLD']);

    const splitResult = await evaluateDefsymphonyStrategy({
      strategyText: strategy,
      budget: 10000,
      dataAdjustment: 'split',
    });
    expect(splitResult.positions.map((pos) => pos.symbol)).toEqual(['SPY']);
  });

  it('computes inverse-volatility weights using child portfolio volatility (not a representative ticker)', async () => {
    const barsLength = 80;
    const aaa = buildClosesFromReturnPattern({
      start: 100,
      pattern: [0.01, -0.01],
      length: barsLength,
    });
    const bbb = buildClosesFromReturnPattern({
      start: 100,
      pattern: [0.05, -0.05],
      length: barsLength,
    });

    getCachedPrices.mockImplementation(async ({ symbol }) => {
      const upper = symbol.toUpperCase();
      if (upper === 'AAA') {
        return buildPriceResponseFromSeries(aaa);
      }
      if (upper === 'BBB') {
        return buildPriceResponseFromSeries(bbb);
      }
      throw new Error(`Unexpected symbol ${symbol}`);
    });

    const strategy = `
      (defsymphony "Nested Inverse Volatility" {}
        (weight-inverse-volatility 20
          [
            (asset "AAA")
            (asset "BBB")
            (weight-equal
              [
                (asset "AAA")
                (asset "BBB")
              ])
          ]))
    `;

    const result = await evaluateDefsymphonyStrategy({ strategyText: strategy, budget: 10000 });
    const weights = Object.fromEntries(result.positions.map((pos) => [pos.symbol, pos.weight]));

    // Expected weights:
    // - vol(AAA) = 0.01, vol(BBB) = 0.05, vol(equal-weight(AAA,BBB)) = 0.03
    // - parent weights ∝ 1/vol -> AAA:15/23, BBB:3/23, portfolio:5/23
    // - portfolio splits equally -> +5/46 each
    // => AAA = 35/46, BBB = 11/46
    expect(weights.AAA).toBeCloseTo(35 / 46, 6);
    expect(weights.BBB).toBeCloseTo(11 / 46, 6);
  });

  it('parity: evaluates the full sorts + inverse-volatility fixture deterministically', async () => {
    const strategy = fs.readFileSync(
      path.join(__dirname, 'fixtures/test_sorts_inverse_volatility.edn'),
      'utf8'
    );

    const barsLength = 360;
    const priceMap = {
      DULL: buildPriceResponseFromSeries(
        buildClosesFromReturnPattern({ start: 100, pattern: [-0.01], length: barsLength })
      ),
      GLD: buildPriceResponseFromSeries(
        buildClosesFromReturnPattern({ start: 100, pattern: [0], length: barsLength })
      ),
      PSQ: buildPriceResponseFromSeries(
        buildClosesFromReturnPattern({ start: 100, pattern: [0.03, -0.03], length: barsLength })
      ),
      QLD: buildPriceResponseFromSeries(
        buildClosesFromReturnPattern({ start: 100, pattern: [0], length: barsLength })
      ),
      QQQE: buildPriceResponseFromSeries(
        buildClosesFromReturnPattern({ start: 100, pattern: [0.01], length: barsLength })
      ),
      SHNY: buildPriceResponseFromSeries(
        buildClosesFromReturnPattern({ start: 100, pattern: [0.01], length: barsLength })
      ),
      SOXL: buildPriceResponseFromSeries(
        buildClosesFromReturnPattern({ start: 100, pattern: [0.01], length: barsLength })
      ),
      SOXS: buildPriceResponseFromSeries(
        buildClosesFromReturnPattern({ start: 100, pattern: [0.05, -0.05], length: barsLength })
      ),
      SPXL: buildPriceResponseFromSeries(
        buildClosesFromReturnPattern({ start: 100, pattern: [0.02, -0.02], length: barsLength })
      ),
      SPY: buildPriceResponseFromSeries(
        buildClosesFromReturnPattern({ start: 100, pattern: [0.01], length: barsLength })
      ),
      SQQQ: buildPriceResponseFromSeries(
        buildClosesWithTail({
          baseClose: 100,
          length: barsLength,
          tail: [100, 80, 85, 90, 95],
        })
      ),
      SVXY: buildPriceResponseFromSeries(
        buildClosesFromReturnPattern({ start: 100, pattern: [0.01], length: barsLength })
      ),
      TECL: buildPriceResponseFromSeries(
        buildClosesFromReturnPattern({ start: 100, pattern: [0.01], length: barsLength })
      ),
      TECS: buildPriceResponseFromSeries(
        buildClosesFromReturnPattern({ start: 100, pattern: [0.02, -0.02], length: barsLength })
      ),
      TLT: buildPriceResponseFromSeries(
        buildClosesFromReturnPattern({ start: 100, pattern: [0.01, -0.01], length: barsLength })
      ),
      TQQQ: buildPriceResponseFromSeries(
        buildClosesWithTail({
          baseClose: 100,
          length: barsLength,
          tail: [100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109],
        })
      ),
      UPRO: buildPriceResponseFromSeries(
        buildClosesFromReturnPattern({ start: 100, pattern: [0.01, -0.01], length: barsLength })
      ),
      UVIX: buildPriceResponseFromSeries(
        buildClosesFromReturnPattern({ start: 100, pattern: [-0.01], length: barsLength })
      ),
      UVXY: buildPriceResponseFromSeries(
        buildClosesFromReturnPattern({ start: 100, pattern: [-0.01], length: barsLength })
      ),
      VIXM: buildPriceResponseFromSeries(
        buildClosesFromReturnPattern({ start: 100, pattern: [0.001], length: barsLength })
      ),
      VIXY: buildPriceResponseFromSeries(
        buildClosesFromReturnPattern({ start: 100, pattern: [-0.01], length: barsLength })
      ),
    };

    installPriceMapMock(priceMap);

    const result = await evaluateDefsymphonyStrategy({ strategyText: strategy, budget: 10000 });
    expect(result.positions).toHaveLength(11);

    const symbols = result.positions.map((pos) => pos.symbol).sort();
    expect(symbols).toEqual(['DULL', 'GLD', 'PSQ', 'QQQE', 'SOXL', 'SOXS', 'TECL', 'TLT', 'TQQQ', 'UPRO', 'UVXY'].sort());

    const weights = Object.fromEntries(result.positions.map((pos) => [pos.symbol, pos.weight]));
    expect(weights.SOXS).toBeCloseTo(1 / 12, 6);
    expect(weights.UPRO).toBeCloseTo(1 / 12, 6);
    expect(weights.TECL).toBeCloseTo(1 / 12, 6);
    expect(weights.GLD).toBeCloseTo(1 / 12, 6);
    expect(weights.SOXL).toBeCloseTo(1 / 12, 6);
    expect(weights.UVXY).toBeCloseTo(1 / 12, 6);
    expect(weights.QQQE).toBeCloseTo(1 / 12, 6);
    expect(weights.DULL).toBeCloseTo(1 / 12, 6);
    expect(weights.TQQQ).toBeCloseTo(1 / 6, 6);

    expect(weights.TLT).toBeCloseTo(1 / 8, 6);
    expect(weights.PSQ).toBeCloseTo(1 / 24, 6);

    const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0);
    expect(totalWeight).toBeCloseTo(1, 10);
  });
});
