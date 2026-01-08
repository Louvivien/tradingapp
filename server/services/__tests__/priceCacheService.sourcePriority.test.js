describe('priceCacheService source priority', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.PRICE_CACHE_SKIP_DB = 'true';
    process.env.TIINGO_API_KEYS = 'test-token';
    delete process.env.TIINGO_MIN_REQUEST_INTERVAL_MS;
    delete process.env.TIINGO_MAX_REQUESTS_PER_HOUR;
  });

  it('prefers dividend-adjustable sources over Stooq when adjustment=all', async () => {
    jest.doMock('axios', () => ({ get: jest.fn(), create: jest.fn(() => ({ get: jest.fn() })) }));
    const Axios = require('axios');

    Axios.get.mockImplementation(async (url) => {
      if (String(url).includes('api.tiingo.com/tiingo/daily/')) {
        return {
          data: [
            { date: '2026-01-06T00:00:00.000Z', close: 100, adjClose: 101, open: 100, high: 100, low: 100, volume: 1 },
            { date: '2026-01-07T00:00:00.000Z', close: 100, adjClose: 102, open: 100, high: 100, low: 100, volume: 1 },
            { date: '2026-01-08T00:00:00.000Z', close: 100, adjClose: 103, open: 100, high: 100, low: 100, volume: 1 },
          ],
        };
      }
      if (String(url).includes('stooq.com/q/d/l/')) {
        throw new Error('stooq should not be queried first for adjustment=all');
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const { getCachedPrices } = require('../priceCacheService');

    const response = await getCachedPrices({
      symbol: 'BIL',
      startDate: '2026-01-01',
      endDate: '2026-01-08',
      adjustment: 'all',
      source: 'stooq',
      forceRefresh: true,
      minBars: 0,
      cacheOnly: true,
    });

    expect(response.dataSource).toBe('tiingo');
    expect((response.bars || []).length).toBeGreaterThan(0);
    const urls = Axios.get.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.includes('api.tiingo.com/tiingo/daily/'))).toBe(true);
    expect(urls.some((u) => u.includes('stooq.com/q/d/l/'))).toBe(false);
  });

  it('falls back to Alpaca before Stooq when adjustment=all and upstream sources fail', async () => {
    jest.doMock('axios', () => ({ get: jest.fn(), create: jest.fn(() => ({ get: jest.fn() })) }));
    jest.doMock('../../config/alpacaConfig', () => ({ getAlpacaConfig: jest.fn() }));

    const Axios = require('axios');
    const { getAlpacaConfig } = require('../../config/alpacaConfig');

    const alpacaGet = jest.fn().mockResolvedValue({
      data: {
        bars: [
          { t: '2026-01-06T05:00:00.000Z', o: 1, h: 1, l: 1, c: 1, v: 0 },
          { t: '2026-01-07T05:00:00.000Z', o: 1.01, h: 1.01, l: 1.01, c: 1.01, v: 0 },
          { t: '2026-01-08T05:00:00.000Z', o: 1.02, h: 1.02, l: 1.02, c: 1.02, v: 0 },
        ],
        next_page_token: null,
      },
    });

    getAlpacaConfig.mockResolvedValue({
      getDataKeys: () => ({
        apiUrl: 'https://alpaca.test',
        keyId: 'test-key',
        secretKey: 'test-secret',
        client: { get: alpacaGet },
      }),
    });

    Axios.get.mockImplementation(async (url) => {
      if (String(url).includes('api.tiingo.com/tiingo/daily/')) {
        throw new Error('tiingo unavailable');
      }
      if (String(url).includes('query1.finance.yahoo.com/v8/finance/chart/')) {
        throw new Error('yahoo unavailable');
      }
      if (String(url).includes('stooq.com/q/d/l/')) {
        throw new Error('stooq should not be needed when Alpaca can satisfy adjustment=all');
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const { getCachedPrices } = require('../priceCacheService');

    const response = await getCachedPrices({
      symbol: 'BIL',
      startDate: '2026-01-01',
      endDate: '2026-01-08',
      adjustment: 'all',
      source: 'stooq',
      forceRefresh: true,
      minBars: 0,
      cacheOnly: true,
    });

    expect(response.dataSource).toBe('alpaca');
    expect((response.bars || []).length).toBeGreaterThan(0);
    expect(alpacaGet).toHaveBeenCalled();
    const urls = Axios.get.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.includes('stooq.com/q/d/l/'))).toBe(false);
  });

  it('keeps Stooq first when adjustment=raw', async () => {
    jest.doMock('axios', () => ({ get: jest.fn(), create: jest.fn(() => ({ get: jest.fn() })) }));
    const Axios = require('axios');

    Axios.get.mockImplementation(async (url) => {
      if (String(url).includes('stooq.com/q/d/l/')) {
        return { data: 'Date,Open,High,Low,Close,Volume\n2026-01-06,1,1,1,1,0\n2026-01-07,2,2,2,2,0\n2026-01-08,3,3,3,3,0\n' };
      }
      if (String(url).includes('api.tiingo.com/tiingo/daily/')) {
        throw new Error('tiingo should not be needed for adjustment=raw when stooq works');
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const { getCachedPrices } = require('../priceCacheService');

    const response = await getCachedPrices({
      symbol: 'SOXX',
      startDate: '2026-01-01',
      endDate: '2026-01-08',
      adjustment: 'raw',
      source: 'stooq',
      forceRefresh: true,
      minBars: 0,
      cacheOnly: true,
    });

    expect(response.dataSource).toBe('stooq');
    const urls = Axios.get.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.includes('stooq.com/q/d/l/'))).toBe(true);
  });
});
