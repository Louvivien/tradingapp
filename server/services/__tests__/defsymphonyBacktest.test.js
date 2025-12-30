jest.mock('../priceCacheService', () => ({
  getCachedPrices: jest.fn(),
  normalizeAdjustment: (value) => value,
  fetchLatestPrice: jest.fn(),
}));

const fs = require('fs');
const path = require('path');

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

  it('parity: BB-XM ends with TQQQ allocation', async () => {
    const strategy = fs.readFileSync(path.join(__dirname, 'fixtures/bb_xm_strategy.edn'), 'utf8');

    const bars = 400;
    const constant = Array.from({ length: bars }, () => 100);

    const spy = (() => {
      const series = Array.from({ length: bars }, () => 100);
      // Construct a regime where:
      // - SPY current < MA(2)
      // - RSI(3) < RSI(21)
      // by having strong gains over the last ~21 sessions, then 3 consecutive losses.
      const start = bars - 25;
      let value = 100;
      for (let idx = start; idx < bars - 4; idx += 1) {
        value += 1;
        series[idx] = value;
      }
      series[bars - 4] = value; // flat day
      series[bars - 3] = value - 2;
      series[bars - 2] = value - 4;
      series[bars - 1] = value - 6;
      return series;
    })();

    installPriceMapMock({
      BIL: buildPriceResponseFromSeries(constant),
      SOXX: buildPriceResponseFromSeries(constant),
      SPY: buildPriceResponseFromSeries(spy),
      SOXL: buildPriceResponseFromSeries(constant),
      SOXS: buildPriceResponseFromSeries(constant),
      SPXU: buildPriceResponseFromSeries(constant),
      UPRO: buildPriceResponseFromSeries(constant),
      SQQQ: buildPriceResponseFromSeries(constant),
      TQQQ: buildPriceResponseFromSeries(constant),
      UVXY: buildPriceResponseFromSeries(constant),
      VIXY: buildPriceResponseFromSeries(constant),
    });

    const result = await backtestDefsymphonyStrategy({
      strategyText: strategy,
      startDate: '2020-10-01',
      endDate: '2021-02-04',
      initialCapital: 10000,
      includeBenchmark: false,
      rsiMethod: 'wilder',
      dataAdjustment: 'split',
      asOfMode: 'previous-close',
    });

    expect(result.finalAllocation).toEqual([{ symbol: 'TQQQ', weight: 1, rationale: 'Selected by asset node.' }]);
  });

  it('parity: Animal Crackers ends with BFLY/PETS/WOLF weights', async () => {
    const strategy = fs.readFileSync(path.join(__dirname, 'fixtures/animal_crackers_strategy.edn'), 'utf8');

    const bars = 250;
    const constant = Array.from({ length: bars }, () => 100);

    const makeBfly = () => {
      const series = Array.from({ length: bars }, () => 100);
      let value = 100;
      for (let idx = bars - 110; idx < bars; idx += 1) {
        value += 2;
        series[idx] = value;
      }
      return series;
    };

    const makePets = () => {
      const series = Array.from({ length: bars }, () => 100);
      let value = 100;
      for (let idx = bars - 80; idx < bars - 10; idx += 1) {
        value += idx % 2 === 0 ? 10 : -10; // high volatility, near-zero drift
        series[idx] = value;
      }
      for (let idx = bars - 10; idx < bars; idx += 1) {
        value += idx % 2 === 0 ? 10 : -8; // keep MA(10) positive near the end
        series[idx] = value;
      }
      return series;
    };

    const makeWolf = () => {
      const series = Array.from({ length: bars }, () => 100);
      let value = 100;
      for (let idx = bars - 120; idx < bars - 10; idx += 1) {
        value += 1;
        series[idx] = value;
      }
      for (let idx = bars - 10; idx < bars; idx += 1) {
        value -= 2;
        series[idx] = value;
      }
      return series;
    };

    const tickers = [
      'CAT',
      'PETS',
      'TIGR',
      'DOG',
      'DOGZ',
      'BIRD',
      'BUCK',
      'DUK',
      'COWS',
      'COWZ',
      'BEEZ',
      'BUL',
      'BULZ',
      'FROG',
      'HOG',
      'MOO',
      'HKND',
      'OWL',
      'GOOS',
      'SNAL',
      'PAWZ',
      'BUG',
      'ZBRA',
      'WOOF',
      'WOLF',
      'BFLY',
      'CALF',
    ];

    const priceMap = {};
    tickers.forEach((ticker) => {
      priceMap[ticker] = buildPriceResponseFromSeries(constant);
    });
    priceMap.BFLY = buildPriceResponseFromSeries(makeBfly());
    priceMap.PETS = buildPriceResponseFromSeries(makePets());
    priceMap.WOLF = buildPriceResponseFromSeries(makeWolf());

    installPriceMapMock(priceMap);

    const result = await backtestDefsymphonyStrategy({
      strategyText: strategy,
      startDate: '2020-05-01',
      endDate: '2020-09-06',
      initialCapital: 10000,
      includeBenchmark: false,
      dataAdjustment: 'split',
      asOfMode: 'previous-close',
    });

    expect(result.finalAllocation).toHaveLength(3);
    const weightBySymbol = new Map(
      result.finalAllocation.map((pos) => [pos.symbol, Number(pos.weight)])
    );
    expect(Array.from(weightBySymbol.keys()).sort()).toEqual(['BFLY', 'PETS', 'WOLF']);
    expect(weightBySymbol.get('BFLY')).toBeCloseTo(1 / 3, 8);
    expect(weightBySymbol.get('PETS')).toBeCloseTo(1 / 2, 8);
    expect(weightBySymbol.get('WOLF')).toBeCloseTo(1 / 6, 8);
  });
});
