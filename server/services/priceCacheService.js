const Axios = require('axios');
const PriceCache = require('../models/priceCacheModel');
const { getAlpacaConfig } = require('../config/alpacaConfig');

const MAX_LOOKBACK_DAYS = 750; // roughly 3 years
const CACHE_TTL_HOURS = 24;

const normalizeAdjustment = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    return 'split';
  }
  if (['raw', 'split', 'dividend', 'all'].includes(normalized)) {
    return normalized;
  }
  return 'split';
};

const toISO = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
};

const normalizeDateRange = (startInput, endInput) => {
  const end = endInput ? new Date(endInput) : new Date();
  const start = startInput ? new Date(startInput) : new Date(end.getTime() - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  if (start > end) {
    throw new Error('Start date must be before end date.');
  }
  return { start, end };
};

const barsCoverRange = (bars = [], start, end) => {
  if (!bars.length) {
    return false;
  }
  const first = bars[0].t;
  const last = bars[bars.length - 1].t;
  return first <= start && last >= end;
};

const fetchBarsFromAlpaca = async ({ symbol, start, end, adjustment }) => {
  const alpacaConfig = await getAlpacaConfig();
  const dataKeys = alpacaConfig.getDataKeys();
  const client = dataKeys.client || Axios.create();
  const params = () => {
    const searchParams = new URLSearchParams({
      timeframe: '1Day',
      start: toISO(start),
      end: toISO(end),
      limit: '10000',
      adjustment: normalizeAdjustment(adjustment),
    });
    return searchParams.toString();
  };

  const requestBars = async (feed) => {
    const bars = [];
    let pageToken = null;
    do {
      const query = pageToken ? `${params()}&feed=${feed}&page_token=${pageToken}` : `${params()}&feed=${feed}`;
      const { data } = await client.get(`${dataKeys.apiUrl}/v2/stocks/${symbol}/bars?${query}`, {
        headers: {
          'APCA-API-KEY-ID': dataKeys.keyId,
          'APCA-API-SECRET-KEY': dataKeys.secretKey,
        },
      });
      const payload = data?.bars || [];
      payload.forEach((bar) => {
        bars.push({
          t: bar.t,
          o: bar.o,
          h: bar.h,
          l: bar.l,
          c: bar.c,
          v: bar.v,
        });
      });
      pageToken = data?.next_page_token || null;
    } while (pageToken);
    if (bars.length) {
      bars.sort((a, b) => new Date(a.t) - new Date(b.t));
    }
    return bars;
  };

  const feeds = [process.env.ALPACA_DATA_FEED || 'iex', 'sip'];
  for (const feed of feeds) {
    try {
      const bars = await requestBars(feed);
      if (bars.length) {
        return bars;
      }
    } catch (error) {
      if (feed === feeds[feeds.length - 1]) {
        throw error;
      }
    }
  }

  return [];
};

const parseYahooResponse = (data, adjustment) => {
  if (data?.chart?.error) {
    const { description, code } = data.chart.error;
    const message = description || code || 'Unknown Yahoo Finance error';
    throw new Error(message);
  }

  const result = data?.chart?.result?.[0];
  if (!result || !Array.isArray(result.timestamp) || !result.timestamp.length) {
    return [];
  }

  const quote = result.indicators?.quote?.[0] || {};
  const adjcloseSeries = result.indicators?.adjclose?.[0]?.adjclose || [];
  const timestamps = result.timestamp || [];
  const useAdjClose = normalizeAdjustment(adjustment) !== 'raw';
  const bars = timestamps
    .map((ts, idx) => {
      const open = quote.open?.[idx];
      const high = quote.high?.[idx];
      const low = quote.low?.[idx];
      const close = quote.close?.[idx];
      const adjClose = adjcloseSeries?.[idx];
      const volume = quote.volume?.[idx];
      if (
        !Number.isFinite(open) ||
        !Number.isFinite(high) ||
        !Number.isFinite(low) ||
        !Number.isFinite(close) ||
        !Number.isFinite(volume)
      ) {
        return null;
      }
      const effectiveClose = useAdjClose && Number.isFinite(adjClose) ? adjClose : close;
      return {
        t: new Date(ts * 1000).toISOString(),
        o: open,
        h: high,
        l: low,
        c: effectiveClose,
        v: volume,
      };
    })
    .filter(Boolean);

  bars.sort((a, b) => new Date(a.t) - new Date(b.t));
  return bars;
};

const fetchBarsFromYahoo = async ({ symbol, start, end, adjustment }) => {
  const period1 = Math.floor(start.getTime() / 1000);
  const period2 = Math.floor(end.getTime() / 1000);

  const attempts = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?interval=1d&period1=${period1}&period2=${period2}`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?interval=1d&range=2y`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?interval=1d&range=1y`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?interval=1d&range=6mo`,
  ];

  let lastError = null;
  for (const url of attempts) {
    try {
      const { data } = await Axios.get(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36',
        },
      });
      const bars = parseYahooResponse(data, adjustment);
      if (bars.length) {
        return bars;
      }
    } catch (error) {
      lastError = error;
      const recoverable =
        typeof error?.message === 'string' &&
        /Data doesn't exist|will be available/i.test(error.message);
      if (!recoverable) {
        throw error;
      }
      // If recoverable, continue to next attempt with shorter range.
    }
  }

  if (lastError) {
    throw lastError;
  }

  return [];
};

const fetchBarsWithFallback = async ({ symbol, start, end, adjustment }) => {
  try {
    const alpacaBars = await fetchBarsFromAlpaca({ symbol, start, end, adjustment });
    if (alpacaBars.length) {
      return { bars: alpacaBars, dataSource: 'alpaca' };
    }
  } catch (error) {
    console.warn(`[PriceCache] Alpaca data fetch failed for ${symbol}: ${error.message}`);
  }

  try {
    const yahooBars = await fetchBarsFromYahoo({ symbol, start, end, adjustment });
    if (yahooBars.length) {
      return { bars: yahooBars, dataSource: 'yahoo' };
    }
  } catch (error) {
    console.warn(`[PriceCache] Yahoo fallback failed for ${symbol}: ${error.message}`);
  }

  throw new Error(`No market data returned for ${symbol}.`);
};

const getCachedPrices = async ({ symbol, startDate, endDate, adjustment }) => {
  const uppercaseSymbol = symbol?.toUpperCase?.();
  if (!uppercaseSymbol) {
    throw new Error('Symbol is required.');
  }
  const { start, end } = normalizeDateRange(startDate, endDate);
  const resolvedAdjustment = normalizeAdjustment(adjustment ?? process.env.ALPACA_DATA_ADJUSTMENT);

  const baseQuery = { symbol: uppercaseSymbol, granularity: '1Day' };
  const cacheQuery =
    resolvedAdjustment === 'raw'
      ? { ...baseQuery, $or: [{ adjustment: 'raw' }, { adjustment: { $exists: false } }] }
      : { ...baseQuery, adjustment: resolvedAdjustment };

  let cache = await PriceCache.findOne(cacheQuery);
  const isFresh =
    cache &&
    cache.refreshedAt &&
    (Date.now() - new Date(cache.refreshedAt).getTime()) / (1000 * 60 * 60) < CACHE_TTL_HOURS &&
    barsCoverRange(cache.bars, start, end);

  if (!isFresh) {
    const { bars, dataSource } = await fetchBarsWithFallback({
      symbol: uppercaseSymbol,
      start,
      end,
      adjustment: resolvedAdjustment,
    });
    cache = await PriceCache.findOneAndUpdate(
      cacheQuery,
      {
        symbol: uppercaseSymbol,
        start: bars[0].t,
        end: bars[bars.length - 1].t,
        bars,
        granularity: '1Day',
        adjustment: resolvedAdjustment,
        refreshedAt: new Date(),
        dataSource,
      },
      { new: true, upsert: true }
    );
  }

  const subset = (cache.bars || []).filter((bar) => {
    const timestamp = new Date(bar.t);
    return timestamp >= start && timestamp <= end;
  });

  if (!subset.length) {
    throw new Error(`Cached data for ${uppercaseSymbol} does not cover the requested range.`);
  }

  return {
    symbol: uppercaseSymbol,
    start: subset[0].t,
    end: subset[subset.length - 1].t,
    granularity: cache.granularity,
    refreshedAt: cache.refreshedAt,
    dataSource: cache.dataSource || 'alpaca',
    bars: subset,
  };
};

module.exports = {
  getCachedPrices,
  normalizeAdjustment,
};
