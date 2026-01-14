jest.mock('../../services/priceCacheService', () => ({
  getCachedPrices: jest.fn(),
  normalizeAdjustment: jest.fn((value) => value),
}));

const { getCachedPrices } = require('../../services/priceCacheService');
const { computeComposerHoldingsWeights } = require('../composerHoldingsWeights');

describe('computeComposerHoldingsWeights', () => {
  beforeEach(() => {
    getCachedPrices.mockReset();
  });

  it('uses the latest close on or before the effective date key', async () => {
    getCachedPrices.mockImplementation(async ({ symbol }) => {
      if (symbol === 'AAA') {
        return {
          dataSource: 'mock',
          bars: [{ t: '2020-01-03T00:00:00.000Z', c: 100 }],
        };
      }
      if (symbol === 'BBB') {
        return {
          dataSource: 'mock',
          bars: [{ t: '2020-01-03T00:00:00.000Z', c: 300 }],
        };
      }
      throw new Error(`Unexpected symbol ${symbol}`);
    });

    const result = await computeComposerHoldingsWeights({
      holdingsObject: { AAA: 1, BBB: 1 },
      effectiveAsOfDateKey: '2020-01-05', // Sunday
      lastBacktestValue: 1000,
      priceSource: 'yahoo',
      dataAdjustment: 'split',
      cacheOnly: true,
      forceRefresh: false,
    });

    expect(result.holdings).toEqual([
      { symbol: 'AAA', weight: 0.25 },
      { symbol: 'BBB', weight: 0.75 },
    ]);
    expect(result.meta.units).toBe('quantity');
    expect(result.meta.pricedBy).toBe('yahoo');
    expect(result.meta.priceDateKeys).toEqual({
      AAA: '2020-01-03',
      BBB: '2020-01-03',
    });
  });
});

