describe('priceCacheService (dividend-adjusted cache selection)', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.PRICE_CACHE_SKIP_DB = 'false';
    process.env.TIINGO_API_KEYS = 'test-token';
    delete process.env.TIINGO_MIN_REQUEST_INTERVAL_MS;
    delete process.env.TIINGO_MAX_REQUESTS_PER_HOUR;
  });

  it('does not use a fresh Stooq cache when adjustment=all and source=tiingo', async () => {
    jest.doMock('axios', () => ({ get: jest.fn(), create: jest.fn(() => ({ get: jest.fn() })) }));
    jest.doMock('../../models/priceCacheModel', () => ({
      find: jest.fn(),
      findOneAndUpdate: jest.fn(),
    }));

    const Axios = require('axios');
    const PriceCache = require('../../models/priceCacheModel');

    const stooqBars = Array.from({ length: 8 }, (_, idx) => {
      const day = String(idx + 1).padStart(2, '0');
      const t = `2026-01-${day}T00:00:00.000Z`;
      const c = idx + 1;
      return { t, o: c, h: c, l: c, c, v: 0 };
    });

    const stooqCacheDoc = {
      symbol: 'BIL',
      granularity: '1Day',
      adjustment: 'all',
      dataSource: 'stooq',
      refreshedAt: new Date(),
      bars: stooqBars,
    };

    PriceCache.find.mockImplementation(async (query) => {
      const match = query?.dataSource?.$in;
      if (Array.isArray(match)) {
        return match.includes('stooq') ? [stooqCacheDoc] : [];
      }
      if (query?.dataSource?.$ne) {
        return [stooqCacheDoc];
      }
      return [];
    });

    Axios.get.mockImplementation(async (url) => {
      if (String(url).includes('api.tiingo.com/tiingo/daily/')) {
        return {
          data: [
            {
              date: '2026-01-06T00:00:00.000Z',
              close: 100,
              adjClose: 101,
              open: 100,
              high: 100,
              low: 100,
              volume: 1,
            },
            {
              date: '2026-01-07T00:00:00.000Z',
              close: 100,
              adjClose: 102,
              open: 100,
              high: 100,
              low: 100,
              volume: 1,
            },
            {
              date: '2026-01-08T00:00:00.000Z',
              close: 100,
              adjClose: 103,
              open: 100,
              high: 100,
              low: 100,
              volume: 1,
            },
          ],
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    PriceCache.findOneAndUpdate.mockImplementation(async (_query, update) => ({
      symbol: update.symbol,
      granularity: update.granularity,
      adjustment: update.adjustment,
      refreshedAt: update.refreshedAt,
      dataSource: update.dataSource,
      bars: update.bars,
    }));

    const { getCachedPrices } = require('../priceCacheService');

    const response = await getCachedPrices({
      symbol: 'BIL',
      startDate: '2026-01-01',
      endDate: '2026-01-08',
      adjustment: 'all',
      source: 'tiingo',
      forceRefresh: false,
      minBars: 0,
      cacheOnly: false,
    });

    expect(response.dataSource).toBe('tiingo');
    expect((response.bars || []).length).toBeGreaterThan(0);
  });
});

