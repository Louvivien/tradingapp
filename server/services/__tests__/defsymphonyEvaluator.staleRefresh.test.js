jest.mock('../priceCacheService', () => ({
  getCachedPrices: jest.fn(),
  normalizeAdjustment: (value) => value,
  fetchLatestPrice: jest.fn(),
}));

const { evaluateDefsymphonyStrategy } = require('../defsymphonyEvaluator');
const { getCachedPrices } = require('../priceCacheService');

const buildBarsEndingOn = ({ endDayKey, length, startPrice, dailyReturn }) => {
  const end = new Date(`${endDayKey}T00:00:00.000Z`);
  const millisPerDay = 24 * 60 * 60 * 1000;
  const bars = [];
  let price = startPrice;
  for (let idx = 0; idx < length; idx += 1) {
    const date = new Date(end.getTime() - (length - 1 - idx) * millisPerDay);
    const rounded = Number(price.toFixed(8));
    bars.push({
      t: date.toISOString(),
      o: rounded,
      h: rounded,
      l: rounded,
      c: rounded,
      v: 1000,
    });
    price *= 1 + dailyReturn;
  }
  return { bars };
};

describe('evaluateDefsymphonyStrategy (stale cache refresh)', () => {
  beforeEach(() => {
    getCachedPrices.mockReset();
  });

  it('force-refreshes stale cached series to match as-of holdings decisions', async () => {
    // Strategy selects the top performer by 20d moving-average return.
    const strategy = `
      (defsymphony "Stale Refresh Test" {}
        (filter
          (moving-average-return {:window 20})
          (select-top 1)
          [
            (asset "QLD")
            (asset "TECL")
          ]))
    `;

    // When cache is stale, QLD "wins"; when refreshed, TECL "wins".
    getCachedPrices.mockImplementation(async ({ symbol, forceRefresh }) => {
      const upper = String(symbol || '').toUpperCase();
      const isRefreshed = forceRefresh === true;

      if (upper === 'QLD') {
        return buildBarsEndingOn({
          endDayKey: isRefreshed ? '2026-01-05' : '2025-12-30',
          length: 80,
          startPrice: 100,
          dailyReturn: isRefreshed ? -0.001 : 0.001,
        });
      }

      if (upper === 'TECL') {
        return buildBarsEndingOn({
          endDayKey: isRefreshed ? '2026-01-05' : '2025-12-30',
          length: 80,
          startPrice: 100,
          dailyReturn: isRefreshed ? 0.002 : -0.002,
        });
      }

      throw new Error(`Unexpected symbol ${symbol}`);
    });

    const result = await evaluateDefsymphonyStrategy({
      strategyText: strategy,
      budget: 10000,
      asOfDate: '2026-01-06',
      asOfMode: 'previous-close',
      priceSource: 'tiingo',
      dataAdjustment: 'all',
      priceRefresh: false,
    });

    expect(result.positions.map((pos) => pos.symbol)).toEqual(['TECL']);

    const calls = getCachedPrices.mock.calls.map(([arg]) => arg);
    const qldCalls = calls.filter((call) => call.symbol === 'QLD');
    const teclCalls = calls.filter((call) => call.symbol === 'TECL');

    expect(qldCalls.some((call) => call.forceRefresh === false && call.cacheOnly === true)).toBe(true);
    expect(qldCalls.some((call) => call.forceRefresh === true && call.cacheOnly === false)).toBe(true);

    expect(teclCalls.some((call) => call.forceRefresh === false && call.cacheOnly === true)).toBe(true);
    expect(teclCalls.some((call) => call.forceRefresh === true && call.cacheOnly === false)).toBe(true);
  });
});

