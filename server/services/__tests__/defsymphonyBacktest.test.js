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

const dropBarForDate = (priceResponse, dateKey) => {
  const bars = (priceResponse?.bars || []).filter((bar) => {
    const key = new Date(bar.t).toISOString().slice(0, 10);
    return key !== dateKey;
  });
  return { ...priceResponse, bars };
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

  it('keeps the requested date range even if a symbol misses an intermediate bar', async () => {
    const aaa = buildPriceResponseFromSeries(Array.from({ length: 45 }, (_, i) => 100 + i));
    const bbb = dropBarForDate(
      buildPriceResponseFromSeries(Array.from({ length: 45 }, (_, i) => 200 + i)),
      '2020-01-20'
    );
    const spy = buildPriceResponseFromSeries(Array.from({ length: 45 }, (_, i) => 300 + i));

    installPriceMapMock({
      AAA: aaa,
      BBB: bbb,
      SPY: spy,
    });

    const strategy = `
      (defsymphony "Equal Weight Missing Day" {}
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

    const expectedDays = Math.floor((new Date('2020-02-09').getTime() - new Date('2020-01-15').getTime()) / (24 * 60 * 60 * 1000)) + 1;
    expect(result.series.length).toBe(expectedDays);
    expect(result.series.some((point) => point.date === '2020-01-20')).toBe(true);
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
