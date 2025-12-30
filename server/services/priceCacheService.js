const Axios = require('axios');
const PriceCache = require('../models/priceCacheModel');
const { getAlpacaConfig } = require('../config/alpacaConfig');

const DEFAULT_MAX_LOOKBACK_DAYS = 5000; // ~20 years (calendar days)
const MAX_LOOKBACK_DAYS = (() => {
  const parsed = Number(process.env.PRICE_MAX_LOOKBACK_DAYS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_LOOKBACK_DAYS;
})();
const CACHE_TTL_HOURS = 24;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const normalizeBoolean = (value) => {
  if (value == null) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n'].includes(normalized)) {
    return false;
  }
  return null;
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

const toISODateKey = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
};

const getTiingoTokens = () => {
  const tokens = [];
  const fromList = String(
    process.env.TIINGO_API_KEYS ??
      process.env.TIINGO_TOKEN ??
      process.env.TIINGO_API_KEY ??
      ''
  )
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  tokens.push(...fromList);

  for (let idx = 1; idx <= 10; idx += 1) {
    const value = process.env[`TIINGO_API_KEY${idx}`];
    if (value) {
      tokens.push(String(value).trim());
    }
  }

  return Array.from(new Set(tokens.filter(Boolean)));
};

const fetchBarsFromTiingo = async ({ symbol, start, end, adjustment }) => {
  const tokens = getTiingoTokens();
  if (!tokens.length) {
    throw new Error('Missing Tiingo token (set TIINGO_API_KEYS or TIINGO_API_KEY1...).');
  }

  const startKey = toISODateKey(start);
  const endKey = toISODateKey(end);
  if (!startKey || !endKey) {
    throw new Error('Invalid date range for Tiingo request.');
  }

  const resolvedAdjustment = normalizeAdjustment(adjustment);
  const useAdjusted = resolvedAdjustment !== 'raw';

  let lastError = null;
  for (let attempt = 0; attempt < tokens.length; attempt += 1) {
    const token = tokens[attempt];
    const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(symbol)}/prices`;
    try {
      const { data } = await Axios.get(url, {
        params: {
          startDate: startKey,
          endDate: endKey,
          token,
        },
      });

      const rows = Array.isArray(data) ? data : [];
      const bars = rows
        .map((row) => {
          const close = Number(row?.close);
          const adjClose = Number(row?.adjClose);
          const open = Number(row?.open);
          const high = Number(row?.high);
          const low = Number(row?.low);
          const splitFactor = Number(row?.splitFactor);
          const volume = Number(row?.volume ?? row?.adjVolume ?? 0);
          const timestamp = row?.date;
          const date = timestamp ? new Date(timestamp) : null;
          if (!date || Number.isNaN(date.getTime())) {
            return null;
          }

          const hasClose = Number.isFinite(close) && close > 0;
          if (!hasClose) {
            return null;
          }

          let ratio = 1;
          if (resolvedAdjustment === 'split') {
            if (Number.isFinite(splitFactor) && splitFactor > 0) {
              ratio = splitFactor;
            } else if (Number.isFinite(adjClose) && adjClose > 0) {
              // Fallback: Tiingo adjClose includes dividends; still preferable to missing data.
              ratio = adjClose / close;
            }
          } else if (useAdjusted && Number.isFinite(adjClose) && adjClose > 0) {
            ratio = adjClose / close;
          }

          const effectiveClose =
            resolvedAdjustment === 'raw'
              ? close
              : Number.isFinite(ratio) && ratio > 0
                ? close * ratio
                : close;
          const effectiveOpen = Number.isFinite(open) ? open * ratio : effectiveClose;
          const effectiveHigh = Number.isFinite(high) ? high * ratio : effectiveClose;
          const effectiveLow = Number.isFinite(low) ? low * ratio : effectiveClose;
          if (
            !Number.isFinite(effectiveClose) ||
            !Number.isFinite(effectiveOpen) ||
            !Number.isFinite(effectiveHigh) ||
            !Number.isFinite(effectiveLow)
          ) {
            return null;
          }

          return {
            t: date.toISOString(),
            o: effectiveOpen,
            h: effectiveHigh,
            l: effectiveLow,
            c: effectiveClose,
            v: Number.isFinite(volume) ? volume : 0,
          };
        })
        .filter(Boolean);

      bars.sort((a, b) => new Date(a.t) - new Date(b.t));
      if (bars.length) {
        return bars;
      }
    } catch (error) {
      lastError = error;
      const status = Number(error?.response?.status);
      const shouldRotate = status === 429 || status === 403;
      if (!shouldRotate) {
        throw error;
      }
      const backoffMs = 500 + attempt * 250;
      await sleep(backoffMs);
    }
  }

  if (lastError) {
    throw lastError;
  }
  return [];
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
  const resolvedAdjustment = normalizeAdjustment(adjustment);

  const rawBars = timestamps
    .map((ts, idx) => {
      const close = quote.close?.[idx];
      if (!Number.isFinite(close)) {
        return null;
      }
      const open = Number.isFinite(quote.open?.[idx]) ? quote.open[idx] : close;
      const high = Number.isFinite(quote.high?.[idx]) ? quote.high[idx] : close;
      const low = Number.isFinite(quote.low?.[idx]) ? quote.low[idx] : close;
      const volume = Number.isFinite(quote.volume?.[idx]) ? quote.volume[idx] : 0;
      const adjClose = adjcloseSeries?.[idx];

      return {
        t: new Date(ts * 1000).toISOString(),
        o: open,
        h: high,
        l: low,
        c: close,
        adjClose: Number.isFinite(adjClose) ? adjClose : null,
        v: volume,
      };
    })
    .filter(Boolean);

  rawBars.sort((a, b) => new Date(a.t) - new Date(b.t));

  if (resolvedAdjustment === 'raw') {
    return rawBars.map(({ adjClose, ...bar }) => bar);
  }

  if (resolvedAdjustment === 'split') {
    const splits = Object.values(result.events?.splits || {})
      .map((entry) => {
        const numerator = Number(entry?.numerator);
        const denominator = Number(entry?.denominator);
        const seconds = Number(entry?.date);
        if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) {
          return null;
        }
        if (!Number.isFinite(seconds)) {
          return null;
        }
        const dateKey = new Date(seconds * 1000).toISOString().slice(0, 10);
        return { dateKey, numerator, denominator };
      })
      .filter(Boolean)
      .sort((a, b) => b.dateKey.localeCompare(a.dateKey));

    let factor = 1;
    let splitIdx = 0;
    const adjusted = rawBars.map((bar) => ({ ...bar }));

    for (let idx = adjusted.length - 1; idx >= 0; idx -= 1) {
      const barKey = adjusted[idx].t.slice(0, 10);
      while (splitIdx < splits.length && splits[splitIdx].dateKey > barKey) {
        factor *= splits[splitIdx].denominator / splits[splitIdx].numerator;
        splitIdx += 1;
      }
      adjusted[idx].o *= factor;
      adjusted[idx].h *= factor;
      adjusted[idx].l *= factor;
      adjusted[idx].c *= factor;
      adjusted[idx].v = factor ? adjusted[idx].v / factor : adjusted[idx].v;
    }

    return adjusted.map(({ adjClose, ...bar }) => bar);
  }

  // "dividend" and "all" are approximated with Yahoo's adjclose series (which includes dividends + splits).
  return rawBars.map(({ adjClose, ...bar }) => {
    if (!Number.isFinite(adjClose) || !Number.isFinite(bar.c) || bar.c === 0) {
      return bar;
    }
    const ratio = adjClose / bar.c;
    return {
      ...bar,
      o: bar.o * ratio,
      h: bar.h * ratio,
      l: bar.l * ratio,
      c: adjClose,
      v: ratio ? bar.v / ratio : bar.v,
    };
  });
};

const fetchLatestPriceFromAlpaca = async ({ symbol }) => {
  const alpacaConfig = await getAlpacaConfig();
  const dataKeys = alpacaConfig.getDataKeys();
  const client = dataKeys.client || Axios.create();
  const { data } = await client.get(`${dataKeys.apiUrl}/v2/stocks/${symbol}/trades/latest`, {
    headers: {
      'APCA-API-KEY-ID': dataKeys.keyId,
      'APCA-API-SECRET-KEY': dataKeys.secretKey,
    },
  });
  const price = Number(data?.trade?.p);
  return Number.isFinite(price) && price > 0 ? price : null;
};

const fetchLatestPriceFromYahoo = async ({ symbol }) => {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  const { data } = await Axios.get(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36',
    },
  });
  const quote = data?.quoteResponse?.result?.[0];
  const price = Number(quote?.regularMarketPrice ?? quote?.postMarketPrice ?? quote?.preMarketPrice);
  return Number.isFinite(price) && price > 0 ? price : null;
};

const fetchLatestPrice = async ({ symbol, source } = {}) => {
  const normalizedSource = String(source ?? '').trim().toLowerCase();
  if (!symbol) {
    throw new Error('Symbol is required.');
  }
  if (normalizedSource === 'yahoo') {
    try {
      const price = await fetchLatestPriceFromYahoo({ symbol });
      if (price) {
        return price;
      }
    } catch (error) {
      console.warn(`[PriceCache] Yahoo latest price failed for ${symbol}: ${error.message}`);
    }
  } else if (normalizedSource === 'alpaca') {
    try {
      const price = await fetchLatestPriceFromAlpaca({ symbol });
      if (price) {
        return price;
      }
    } catch (error) {
      console.warn(`[PriceCache] Alpaca latest price failed for ${symbol}: ${error.message}`);
    }
  }

  try {
    const price = await fetchLatestPriceFromAlpaca({ symbol });
    if (price) {
      return price;
    }
  } catch (error) {
    console.warn(`[PriceCache] Alpaca latest price fallback failed for ${symbol}: ${error.message}`);
  }

  try {
    const price = await fetchLatestPriceFromYahoo({ symbol });
    if (price) {
      return price;
    }
  } catch (error) {
    console.warn(`[PriceCache] Yahoo latest price fallback failed for ${symbol}: ${error.message}`);
  }

  return null;
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

const fetchBarsFromStooq = async ({ symbol }) => {
  if (!symbol) {
    throw new Error('Symbol is required.');
  }
  const normalized = String(symbol).trim().toLowerCase();
  if (!normalized) {
    throw new Error('Symbol is required.');
  }
  const stooqSymbol = normalized.endsWith('.us') ? normalized : `${normalized}.us`;
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&i=d`;
  const { data } = await Axios.get(url, { timeout: 30000 });
  const text = typeof data === 'string' ? data : '';
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) {
    return [];
  }
  const bars = [];
  for (let idx = 1; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const [date, open, high, low, close, volume] = line.split(',');
    if (!date || date === 'Date') {
      continue;
    }
    const c = Number(close);
    if (!Number.isFinite(c)) {
      continue;
    }
    const o = Number(open);
    const h = Number(high);
    const l = Number(low);
    const v = Number(volume);
    bars.push({
      t: `${date}T00:00:00.000Z`,
      o: Number.isFinite(o) ? o : c,
      h: Number.isFinite(h) ? h : c,
      l: Number.isFinite(l) ? l : c,
      c,
      v: Number.isFinite(v) ? v : 0,
    });
  }
  bars.sort((a, b) => new Date(a.t) - new Date(b.t));
  return bars;
};

const fetchBarsWithFallback = async ({ symbol, start, end, adjustment, source, minBars }) => {
  const normalizedSource = String(source ?? '').trim().toLowerCase();
  const minBarsNeeded = Number.isFinite(Number(minBars)) ? Math.max(0, Math.floor(Number(minBars))) : 0;
  const preferred =
    normalizedSource === 'yahoo' ||
    normalizedSource === 'alpaca' ||
    normalizedSource === 'tiingo' ||
    normalizedSource === 'stooq'
      ? normalizedSource
      : null;
  const attemptOrder = (() => {
    if (preferred === 'yahoo') {
      return ['yahoo', 'tiingo', 'stooq', 'alpaca'];
    }
    if (preferred === 'tiingo') {
      return ['tiingo', 'yahoo', 'stooq', 'alpaca'];
    }
    if (preferred === 'alpaca') {
      return ['alpaca', 'tiingo', 'yahoo', 'stooq'];
    }
    if (preferred === 'stooq') {
      return ['stooq', 'tiingo', 'yahoo', 'alpaca'];
    }
    return ['yahoo', 'tiingo', 'stooq', 'alpaca'];
  })();

  const attempt = async (candidate) => {
    switch (candidate) {
      case 'yahoo': {
        const bars = await fetchBarsFromYahoo({ symbol, start, end, adjustment });
        return { bars, dataSource: 'yahoo' };
      }
      case 'tiingo': {
        const bars = await fetchBarsFromTiingo({ symbol, start, end, adjustment });
        return { bars, dataSource: 'tiingo' };
      }
      case 'stooq': {
        const bars = await fetchBarsFromStooq({ symbol, start, end, adjustment });
        return { bars, dataSource: 'stooq' };
      }
      default: {
        const bars = await fetchBarsFromAlpaca({ symbol, start, end, adjustment });
        return { bars, dataSource: 'alpaca' };
      }
    }
  };

  let lastError = null;
  let bestResult = null;
  for (const candidate of attemptOrder) {
    try {
      const result = await attempt(candidate);
      if (Array.isArray(result.bars) && result.bars.length) {
        if (!bestResult || result.bars.length > bestResult.bars.length) {
          bestResult = result;
        }
        if (!minBarsNeeded || result.bars.length >= minBarsNeeded) {
          return result;
        }
      }
    } catch (error) {
      lastError = error;
      const label =
        candidate === 'alpaca'
          ? 'Alpaca'
          : candidate === 'tiingo'
            ? 'Tiingo'
            : candidate === 'stooq'
              ? 'Stooq'
              : 'Yahoo';
      console.warn(`[PriceCache] ${label} data fetch failed for ${symbol}: ${error.message}`);
    }
  }

  if (bestResult) {
    return bestResult;
  }

  throw lastError || new Error(`No market data returned for ${symbol}.`);
};

const getCachedPrices = async ({
  symbol,
  startDate,
  endDate,
  adjustment,
  source,
  forceRefresh,
  minBars,
  cacheOnly,
}) => {
  const uppercaseSymbol = symbol?.toUpperCase?.();
  if (!uppercaseSymbol) {
    throw new Error('Symbol is required.');
  }
  const { start, end } = normalizeDateRange(startDate, endDate);
  const resolvedAdjustment = normalizeAdjustment(adjustment ?? process.env.ALPACA_DATA_ADJUSTMENT);
  const resolvedSource = String(source ?? process.env.PRICE_DATA_SOURCE ?? '').trim().toLowerCase();
  const resolvedForceRefresh =
    normalizeBoolean(forceRefresh) ?? normalizeBoolean(process.env.PRICE_DATA_FORCE_REFRESH) ?? false;
  const minBarsNeeded = Number.isFinite(Number(minBars)) ? Math.max(0, Math.floor(Number(minBars))) : 0;
  const resolvedCacheOnly = normalizeBoolean(cacheOnly) ?? false;

  const baseQuery = { symbol: uppercaseSymbol, granularity: '1Day' };
  const sourceQuery =
    resolvedSource === 'yahoo' || resolvedSource === 'alpaca' || resolvedSource === 'tiingo'
      ? { dataSource: resolvedSource }
      : {};
  const cacheQuery =
    resolvedAdjustment === 'raw'
      ? { ...baseQuery, ...sourceQuery, $or: [{ adjustment: 'raw' }, { adjustment: { $exists: false } }] }
      : { ...baseQuery, ...sourceQuery, adjustment: resolvedAdjustment };

  let cache = await PriceCache.findOne(cacheQuery);
  const relaxedCoverageOk = (bars = []) => {
    if (!minBarsNeeded) {
      return false;
    }
    if (!Array.isArray(bars) || bars.length < minBarsNeeded) {
      return false;
    }
    const last = bars[bars.length - 1]?.t;
    return last instanceof Date && last >= end;
  };
  const isFresh =
    !resolvedForceRefresh &&
    cache &&
    cache.refreshedAt &&
    (Date.now() - new Date(cache.refreshedAt).getTime()) / (1000 * 60 * 60) < CACHE_TTL_HOURS &&
    (barsCoverRange(cache.bars, start, end) || relaxedCoverageOk(cache.bars));

  if (!isFresh && !(resolvedCacheOnly && cache && Array.isArray(cache.bars) && cache.bars.length)) {
    const { bars, dataSource } = await fetchBarsWithFallback({
      symbol: uppercaseSymbol,
      start,
      end,
      adjustment: resolvedAdjustment,
      source: resolvedSource,
      minBars: minBarsNeeded,
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
  fetchBarsFromYahoo,
  fetchLatestPrice,
};
