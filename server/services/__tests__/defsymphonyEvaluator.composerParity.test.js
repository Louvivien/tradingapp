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

  it('computes moving-average-return as the arithmetic mean of daily returns (not compounded)', async () => {
    const barsLength = 60;
    const priceMap = {
      AAA: buildPriceResponseFromSeries(
        buildClosesWithTail({
          baseClose: 100,
          length: barsLength,
          tail: [100, 150, 75],
        })
      ),
      BBB: buildPriceResponseFromSeries(
        buildClosesWithTail({
          baseClose: 100,
          length: barsLength,
          tail: [100, 90, 81],
        })
      ),
    };

    installPriceMapMock(priceMap);

    const strategy = `
      (defsymphony "Moving Average Return Arithmetic" {}
        (filter
          (moving-average-return {:window 2})
          (select-top 1)
          [
            (asset "AAA")
            (asset "BBB")
          ]))
    `;

    const result = await evaluateDefsymphonyStrategy({ strategyText: strategy, budget: 10000 });
    expect(result.positions.map((pos) => pos.symbol)).toEqual(['AAA']);
  });

  it('computes cumulative-return as the compounded end/start return (not sum of daily returns)', async () => {
    const barsLength = 60;
    const priceMap = {
      AAA: buildPriceResponseFromSeries(
        buildClosesWithTail({
          baseClose: 100,
          length: barsLength,
          tail: [100, 110, 121],
        })
      ),
      BBB: buildPriceResponseFromSeries(
        buildClosesWithTail({
          baseClose: 100,
          length: barsLength,
          tail: [100, 110, 120],
        })
      ),
    };

    installPriceMapMock(priceMap);

    const strategy = `
      (defsymphony "Cumulative Return Formula" {}
        (if
          (> (cumulative-return "AAA" {:window 2}) 20.5)
          [(asset "AAA")]
          [(asset "BBB")]))
    `;

    const result = await evaluateDefsymphonyStrategy({ strategyText: strategy, budget: 10000 });
    expect(result.positions.map((pos) => pos.symbol)).toEqual(['AAA']);
  });

  it('uses prior session data in previous-close mode (drops the as-of-day bar even if present)', async () => {
    const buildBars = (dateKeys, closes) => ({
      bars: dateKeys.map((dateKey, index) => {
        const close = closes[index];
        return {
          t: `${dateKey}T00:00:00.000Z`,
          o: close,
          h: close,
          l: close,
          c: close,
          v: 1000,
        };
      }),
    });

    getCachedPrices.mockImplementation(async ({ symbol }) => {
      const upper = symbol.toUpperCase();
      if (upper === 'AAA') {
        return buildBars(['2020-01-01', '2020-01-02', '2020-01-03'], [10, 20, 5]);
      }
      if (upper === 'BBB') {
        return buildBars(['2020-01-01', '2020-01-02', '2020-01-03'], [10, 15, 30]);
      }
      throw new Error(`Unexpected symbol ${symbol}`);
    });

    const strategy = `
      (defsymphony "Prev Close Current Price" {}
        (filter
          (current-price)
          (select-top 1)
          [
            (asset "AAA")
            (asset "BBB")
          ]))
    `;

    const result = await evaluateDefsymphonyStrategy({
      strategyText: strategy,
      budget: 10000,
      asOfDate: '2020-01-03',
      asOfMode: 'previous-close',
    });

    // If the evaluator included the 2020-01-03 bar, BBB would win (30 vs 5).
    // Composer previous-close semantics evaluate at the prior session close (2020-01-02), so AAA wins (20 vs 15).
    expect(result.positions.map((pos) => pos.symbol)).toEqual(['AAA']);
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

  it('stabilizes near-ties in select-bottom (avoids cross-provider flips)', async () => {
    const barsLength = 120;
    const uproCloses = buildClosesFromReturnPattern({
      start: 100,
      pattern: [0.01, -0.01],
      length: barsLength,
    });
    const spxlCloses = buildClosesFromReturnPattern({
      start: 100,
      pattern: [0.0099999, -0.0099999],
      length: barsLength,
    });

    installPriceMapMock({
      UPRO: buildPriceResponseFromSeries(uproCloses),
      SPXL: buildPriceResponseFromSeries(spxlCloses),
    });

    const strategy = `
      (defsymphony "Near Tie Selection" {}
        (filter
          (stdev-return {:window 80})
          (select-bottom 1)
          [
            (asset "UPRO")
            (asset "SPXL")
          ]))
    `;

    const result = await evaluateDefsymphonyStrategy({ strategyText: strategy, budget: 10000 });
    expect(result.positions.map((pos) => pos.symbol)).toEqual(['UPRO']);
  });
});
