jest.mock('../priceCacheService', () => ({
  getCachedPrices: jest.fn(),
  normalizeAdjustment: (value) => value,
  fetchLatestPrice: jest.fn(),
}));

const { evaluateDefsymphonyStrategy } = require('../defsymphonyEvaluator');
const { getCachedPrices } = require('../priceCacheService');

const buildPriceResponseFromSeries = (closes, { startDay = 1 } = {}) => ({
  bars: closes.map((close, index) => {
    const value = Number(Number(close).toFixed(8));
    const timestamp = new Date(2020, 0, startDay + index).toISOString();
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

describe('evaluateDefsymphonyStrategy axis alignment', () => {
  beforeEach(() => {
    getCachedPrices.mockReset();
  });

  it('does not drop late-start tickers when aligning to the calendar symbol axis', async () => {
    installPriceMapMock({
      CAL: buildPriceResponseFromSeries([100, 101, 102, 103, 104, 105, 106, 107, 108, 109], { startDay: 1 }),
      NEW: buildPriceResponseFromSeries([200, 201, 202, 203, 204], { startDay: 6 }),
    });

    const strategy = `
      (defsymphony "Axis Alignment" {:rebalance-frequency daily}
        (if (< (current-price "CAL") 1000000)
          (asset "NEW")
          (asset "CAL")))
    `;

    const result = await evaluateDefsymphonyStrategy({
      strategyText: strategy,
      budget: 1000,
    });

    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].symbol).toBe('NEW');
  });
});

