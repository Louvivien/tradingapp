jest.mock('../priceCacheService', () => ({
  getCachedPrices: jest.fn(),
  normalizeAdjustment: (value) => value,
  fetchLatestPrice: jest.fn(),
}));

const { backtestDefsymphonyStrategy } = require('../defsymphonyEvaluator');
const { getCachedPrices } = require('../priceCacheService');

const buildPriceResponseFromSeries = (closes) => ({
  bars: closes.map((close, index) => {
    const value = Number(Number(close).toFixed(4));
    const timestamp = new Date(Date.UTC(2020, 0, index + 1, 12, 0, 0)).toISOString();
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
    const entry = priceMap[symbol.toUpperCase()];
    if (!entry) {
      throw new Error(`Missing mock price data for ${symbol}`);
    }
    return entry;
  });
};

describe('backtestDefsymphonyStrategy', () => {
  beforeEach(() => {
    getCachedPrices.mockReset();
  });

  it('runs a simple backtest and returns a time series with metrics', async () => {
    installPriceMapMock({
      AAA: buildPriceResponseFromSeries(Array.from({ length: 40 }, (_, i) => 100 + i)),
      BBB: buildPriceResponseFromSeries(Array.from({ length: 40 }, (_, i) => 200 + i)),
      SPY: buildPriceResponseFromSeries(Array.from({ length: 40 }, (_, i) => 300 + i)),
    });

    const strategy = `
      (defsymphony "Equal Weight" {}
        (weight-equal
          [
            (asset "AAA")
            (asset "BBB")
          ]))
    `;

    const result = await backtestDefsymphonyStrategy({
      strategyText: strategy,
      startDate: '2020-01-15',
      endDate: '2020-02-09',
      initialCapital: 10000,
      includeBenchmark: true,
    });

    expect(result.metrics.totalDays).toBe(result.series.length);
    expect(result.series[0].date).toBe('2020-01-15');
    expect(result.series[result.series.length - 1].date).toBe('2020-02-09');
    expect(result.metrics.totalReturn).toBeGreaterThan(0);
    expect(result.benchmark?.symbol).toBe('SPY');
  });

  it('applies transaction costs based on turnover for switching strategies', async () => {
    const oscillating = [100, 101, 99, 101, 99, 101, 99, 101, 99, 101, 99, 101, 99, 101, 99, 101, 99, 101, 99, 101, 99, 101];
    installPriceMapMock({
      AAA: buildPriceResponseFromSeries(oscillating),
      BBB: buildPriceResponseFromSeries(Array.from({ length: oscillating.length }, () => 100)),
    });

    const strategy = `
      (defsymphony "Switching" {}
        (if
          (> (current-price "AAA") (moving-average-price "AAA" {:window 2}))
          [(asset "AAA")]
          [(asset "BBB")]))
    `;

    const baseline = await backtestDefsymphonyStrategy({
      strategyText: strategy,
      startDate: '2020-01-10',
      endDate: '2020-01-22',
      initialCapital: 10000,
      includeBenchmark: false,
      transactionCostBps: 0,
    });

    const withCosts = await backtestDefsymphonyStrategy({
      strategyText: strategy,
      startDate: '2020-01-10',
      endDate: '2020-01-22',
      initialCapital: 10000,
      includeBenchmark: false,
      transactionCostBps: 50,
    });

    expect(withCosts.series[withCosts.series.length - 1].nav).toBeLessThan(
      baseline.series[baseline.series.length - 1].nav
    );
  });
});
