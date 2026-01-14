jest.mock('../priceCacheService', () => ({
  getCachedPrices: jest.fn(),
  normalizeAdjustment: (value) => value,
  fetchLatestPrice: jest.fn(),
}));

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

const installPriceMapMock = (priceMap) => {
  getCachedPrices.mockImplementation(async ({ symbol }) => {
    const entry = priceMap[String(symbol || '').toUpperCase()];
    if (!entry) {
      throw new Error(`Missing mock price data for ${symbol}`);
    }
    return entry;
  });
};

describe('evaluateDefsymphonyStrategy simulatedHoldings', () => {
  beforeEach(() => {
    getCachedPrices.mockReset();
  });

  it('returns drifted simulatedHoldings for rebalance-threshold strategies while keeping positions as targets', async () => {
    const barsLength = 30;
    const aaa = [];
    const bbb = [];
    let aaaPrice = 100;
    for (let idx = 0; idx < barsLength; idx += 1) {
      aaa.push(aaaPrice);
      bbb.push(100);
      aaaPrice *= 1.01;
    }

    installPriceMapMock({
      AAA: buildPriceResponseFromSeries(aaa),
      BBB: buildPriceResponseFromSeries(bbb),
    });

    const strategy = `
      (defsymphony "Threshold Drift" {:rebalance-threshold 0.9}
        (weight-equal
          [
            (asset "AAA")
            (asset "BBB")
          ]))
    `;

    const result = await evaluateDefsymphonyStrategy({
      strategyText: strategy,
      budget: 10000,
      simulateHoldings: true,
    });

    const positionWeights = Object.fromEntries(result.positions.map((pos) => [pos.symbol, pos.weight]));
    expect(positionWeights.AAA).toBeCloseTo(0.5, 10);
    expect(positionWeights.BBB).toBeCloseTo(0.5, 10);

    const simulatedWeights = Object.fromEntries(
      (result.simulatedHoldings || []).map((row) => [row.symbol, row.weight])
    );
    expect(simulatedWeights.AAA).toBeGreaterThan(0.55);
    expect(simulatedWeights.BBB).toBeLessThan(0.45);
    expect(result.simulatedHoldingsMeta).toMatchObject({ mode: 'threshold' });
  });
});

