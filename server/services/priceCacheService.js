const Axios = require('axios');
const PriceCache = require('../models/priceCacheModel');
const { getAlpacaConfig } = require('../config/alpacaConfig');

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

const DEFAULT_MAX_LOOKBACK_DAYS = 5000; // ~20 years (calendar days)
const MAX_LOOKBACK_DAYS = (() => {
  const parsed = Number(process.env.PRICE_MAX_LOOKBACK_DAYS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_LOOKBACK_DAYS;
})();
const CACHE_TTL_HOURS = 24;
const SKIP_DB_CACHE = normalizeBoolean(process.env.PRICE_CACHE_SKIP_DB) === true;
const toISO = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
};

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const parseStartDateInput = (value) => {
  if (typeof value === 'string' && DATE_KEY_RE.test(value.trim())) {
    return new Date(`${value.trim()}T00:00:00.000Z`);
  }
  return value ? new Date(value) : null;
};

const parseEndDateInput = (value) => {
  if (typeof value === 'string' && DATE_KEY_RE.test(value.trim())) {
    return new Date(`${value.trim()}T23:59:59.999Z`);
  }
  return value ? new Date(value) : null;
};

const normalizeDateRange = (startInput, endInput) => {
  const end = parseEndDateInput(endInput) || new Date();
  const start =
    parseStartDateInput(startInput) ||
    new Date(end.getTime() - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  if (start > end) {
    throw new Error('Start date must be before end date.');
  }
  return { start, end };
};

const barsCoverRange = (bars = [], start, end) => {
  if (!bars.length) {
    return false;
  }
  const firstKey = toISODateKey(bars[0].t);
  const lastKey = toISODateKey(bars[bars.length - 1].t);
  const startKey = toISODateKey(start);
  const endKey = toISODateKey(end);
  if (!firstKey || !lastKey || !startKey || !endKey) {
    return false;
  }
  return firstKey <= startKey && lastKey >= endKey;
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

let tiingoTokenCursor = 0;
const tiingoTokenNextAllowedAt = new Map();
const tiingoTokenHourlyUsage = new Map();

const ONE_HOUR_MS = 60 * 60 * 1000;

const getTiingoMinIntervalMs = () => {
  const minIntervalMsRaw = Number(process.env.TIINGO_MIN_REQUEST_INTERVAL_MS);
  return Number.isFinite(minIntervalMsRaw) ? Math.max(0, Math.floor(minIntervalMsRaw)) : 250;
};

const bumpTiingoTokenNextAllowedAt = (token, nextAtMs) => {
  if (!token) {
    return;
  }
  const current = tiingoTokenNextAllowedAt.get(token) || 0;
  const desired = Number(nextAtMs) || 0;
  if (desired > current) {
    tiingoTokenNextAllowedAt.set(token, desired);
  }
};

const getTiingoHourlyLimit = () => {
  const raw = Number(process.env.TIINGO_MAX_REQUESTS_PER_HOUR);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return 50;
};

const getTiingoTokenUsage = (token, nowMs) => {
  const current = tiingoTokenHourlyUsage.get(token);
  if (!current || !Number.isFinite(current.windowStartMs) || nowMs - current.windowStartMs >= ONE_HOUR_MS) {
    const fresh = { windowStartMs: nowMs, count: 0 };
    tiingoTokenHourlyUsage.set(token, fresh);
    return fresh;
  }
  return current;
};

const consumeTiingoHourlyBudget = (token) => {
  const limit = getTiingoHourlyLimit();
  const nowMs = Date.now();
  const usage = getTiingoTokenUsage(token, nowMs);
  if (usage.count >= limit) {
    const retryAfterMs = Math.max(0, usage.windowStartMs + ONE_HOUR_MS - nowMs);
    const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
    const error = new Error(
      `Tiingo hourly request limit reached for this API key (${limit}/hour). Try again in ~${retryAfterSeconds}s or switch price source.`
    );
    error.code = 'TIINGO_HOURLY_LIMIT';
    error.retryAfterSeconds = retryAfterSeconds;
    throw error;
  }
  usage.count += 1;
  tiingoTokenHourlyUsage.set(token, usage);
};

const waitForTiingoSlot = async (token, { maxWaitMs } = {}) => {
  const minIntervalMs = getTiingoMinIntervalMs();
  if (!minIntervalMs) {
    return;
  }
  const now = Date.now();
  const nextAt = tiingoTokenNextAllowedAt.get(token) || 0;
  const waitMs = nextAt > now ? nextAt - now : 0;
  const resolvedMaxWaitMs = Number.isFinite(Number(maxWaitMs)) ? Math.max(0, Math.floor(Number(maxWaitMs))) : null;
  if (resolvedMaxWaitMs != null && waitMs > resolvedMaxWaitMs) {
    const retryAfterSeconds = Math.ceil(waitMs / 1000);
    const error = new Error(
      `Tiingo key temporarily rate-limited (retry after ~${retryAfterSeconds}s).`
    );
    error.code = 'TIINGO_TOKEN_COOLDOWN';
    error.retryAfterSeconds = retryAfterSeconds;
    throw error;
  }
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  bumpTiingoTokenNextAllowedAt(token, Date.now() + minIntervalMs);
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

  const startIndex = (() => {
    if (tokens.length <= 1) {
      return 0;
    }
    const idx = tiingoTokenCursor % tokens.length;
    tiingoTokenCursor += 1;
    return idx;
  })();

  let lastError = null;
  for (let attempt = 0; attempt < tokens.length; attempt += 1) {
    const token = tokens[(startIndex + attempt) % tokens.length];
    const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(symbol)}/prices`;
    try {
      try {
        // Only wait briefly for per-key pacing; if a key is in a longer cooldown window,
        // skip it and allow fallback sources (Yahoo/Stooq/Alpaca) to proceed quickly.
        await waitForTiingoSlot(token, { maxWaitMs: 2000 });
      } catch (cooldownError) {
        lastError = cooldownError;
        if (cooldownError?.code === 'TIINGO_TOKEN_COOLDOWN') {
          continue;
        }
        throw cooldownError;
      }
      try {
        consumeTiingoHourlyBudget(token);
      } catch (budgetError) {
        lastError = budgetError;
        if (budgetError?.code === 'TIINGO_HOURLY_LIMIT') {
          const retryAfterMs = Math.max(0, Number(budgetError.retryAfterSeconds || 0) * 1000);
          bumpTiingoTokenNextAllowedAt(token, Date.now() + retryAfterMs);
          continue;
        }
        throw budgetError;
      }
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

          // Prefer Tiingo-provided adjClose for split adjustment; if missing, invert splitFactor.
          let ratio = 1;
          if (resolvedAdjustment === 'split') {
            if (Number.isFinite(adjClose) && adjClose > 0) {
              ratio = adjClose / close;
            } else if (Number.isFinite(splitFactor) && splitFactor > 0) {
              ratio = 1 / splitFactor;
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
      if (error?.code === 'TIINGO_HOURLY_LIMIT') {
        continue;
      }
      const status = Number(error?.response?.status);
      const shouldRotate = status === 429 || status === 403;
      if (!shouldRotate) {
        throw error;
      }
      const retryAfter = Number(error?.response?.headers?.['retry-after']);
      const retryAfterMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(5 * 60_000, Math.floor(retryAfter * 1000))
          : null;
      // Avoid blocking on Tiingo backoffs; record a cooldown for this key and fall through to the next.
      const cooldownMs =
        retryAfterMs ??
        (status === 403 ? 30 * 60_000 : Math.min(60_000, 2_000 + attempt * 750));
      bumpTiingoTokenNextAllowedAt(token, Date.now() + cooldownMs);
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
        timeout: 15000,
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

const fetchLatestPriceFromYahooChart = async ({ symbol }) => {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=1m&range=1d`;
  const { data } = await Axios.get(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36',
    },
  });
  const result = data?.chart?.result?.[0];

  const metaPrice = Number(
    result?.meta?.regularMarketPrice ??
      result?.meta?.postMarketPrice ??
      result?.meta?.preMarketPrice ??
      result?.meta?.chartPreviousClose
  );
  if (Number.isFinite(metaPrice) && metaPrice > 0) {
    return metaPrice;
  }

  const closes = result?.indicators?.quote?.[0]?.close;
  if (Array.isArray(closes) && closes.length) {
    for (let idx = closes.length - 1; idx >= 0; idx -= 1) {
      const value = Number(closes[idx]);
      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    }
  }

  return null;
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
    try {
      const price = await fetchLatestPriceFromYahooChart({ symbol });
      if (price) {
        return price;
      }
    } catch (error) {
      console.warn(
        `[PriceCache] Yahoo chart latest price failed for ${symbol}: ${error.message}`
      );
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

  try {
    const price = await fetchLatestPriceFromYahooChart({ symbol });
    if (price) {
      return price;
    }
  } catch (error) {
    console.warn(
      `[PriceCache] Yahoo chart latest price fallback failed for ${symbol}: ${error.message}`
    );
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
  // Stooq can refuse TLS on port 443; use HTTP to improve reachability.
  const url = `http://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&i=d`;
  const { data } = await Axios.get(url, { timeout: 10000 });
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

// Lightweight fallback: pull normalized daily history from Testfol.io when Tiingo is rate-limited.
const fetchBarsFromTestfolio = async ({ symbol, start, end }) => {
  const startKey = toISODateKey(start) || '';
  const endKey = toISODateKey(end) || '';
  const body = {
    name: 'STRATEGY',
    start_date: startKey,
    end_date: endKey,
    start_val: 1_000_000,
    trading_cost: 0,
    rolling_window: 60,
    signals: [],
    trading_freq: 'Daily',
    allocations: [
      {
        name: symbol,
        signals: [],
        ops: [],
        nots: [],
        tickers: [{ ticker: symbol, percent: 100 }],
        drag: 0,
      },
    ],
  };

  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const { data } = await Axios.post('https://testfol.io/api/tactical', body, {
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'tradingapp/priceCache',
        },
      });
      const history = data?.charts?.history;
      if (!Array.isArray(history) || !history.length) {
        return [];
      }

      const dates =
        history[0]?.map?.((epoch) => {
          const d = new Date(Number(epoch) * 1000);
          return Number.isNaN(d.getTime()) ? null : d;
        }) || [];

      const stats = Array.isArray(data?.stats) ? data.stats : [];
      const idx =
        stats.findIndex(
          (s) => String(s?.name || s?.ticker || s?.symbol || '').toUpperCase() === symbol.toUpperCase()
        ) + 1;
      const priceIdx = idx > 0 && history[idx] ? idx : 1;
      const prices = Array.isArray(history[priceIdx]) ? history[priceIdx] : [];

      const bars = [];
      for (let i = 0; i < prices.length && i < dates.length; i += 1) {
        const p = Number(prices[i]);
        const d = dates[i];
        if (!Number.isFinite(p) || p <= 0 || !d) continue;
        const iso = d.toISOString();
        bars.push({ t: iso, o: p, h: p, l: p, c: p, v: 0 });
      }
      bars.sort((a, b) => new Date(a.t) - new Date(b.t));
      return bars;
    } catch (error) {
      lastError = error;
      const status = Number(error?.response?.status);
      const isTimeout =
        error?.code === 'ETIMEDOUT' ||
        error?.code === 'ENETUNREACH' ||
        /timeout/i.test(String(error?.message || ''));
      // If Testfolio is unreachable, allow fallback to the next provider (e.g., Alpaca).
      if (!isTimeout && status !== 429) {
        break;
      }
      await sleep(1000 + attempt * 500);
    }
  }

  if (lastError) {
    throw lastError;
  }
  return [];
};

const fetchBarsWithFallback = async ({ symbol, start, end, adjustment, source, minBars }) => {
  const normalizedSource = String(source ?? '').trim().toLowerCase();
  const normalizedAdjustment = normalizeAdjustment(adjustment);
  const wantsDividendAdjustment =
    normalizedAdjustment === 'all' || normalizedAdjustment === 'dividend';
  const minBarsNeeded = Number.isFinite(Number(minBars)) ? Math.max(0, Math.floor(Number(minBars))) : 0;
  const endKey = toISODateKey(end);
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
      // Composer-style: Tiingo first, then Stooq, then Yahoo.
      return wantsDividendAdjustment ? ['tiingo', 'yahoo', 'stooq', 'alpaca'] : ['tiingo', 'stooq', 'yahoo', 'alpaca'];
    }
    if (preferred === 'alpaca') {
      // Alpaca's daily data is not dividend-adjusted; for parity with Composer-style "all"/"dividend" adjustments,
      // prefer Tiingo/Yahoo first when requested.
      return wantsDividendAdjustment ? ['tiingo', 'yahoo', 'alpaca', 'stooq'] : ['alpaca', 'tiingo', 'stooq', 'yahoo'];
    }
    if (preferred === 'stooq') {
      // Stooq daily bars are not dividend-adjusted; if the caller asked for dividend-adjusted data,
      // prefer sources that support that adjustment first.
      return wantsDividendAdjustment ? ['tiingo', 'yahoo', 'stooq', 'alpaca'] : ['stooq', 'tiingo', 'yahoo', 'alpaca'];
    }
    // Default: Tiingo -> Stooq -> Yahoo -> Alpaca.
    return wantsDividendAdjustment ? ['tiingo', 'yahoo', 'stooq', 'alpaca'] : ['tiingo', 'stooq', 'yahoo', 'alpaca'];
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
  let bestCoversEnd = false;
  const coversEndDate = (bars = []) => {
    if (!Array.isArray(bars) || !bars.length || !endKey) {
      return false;
    }
    const lastKey = toISODateKey(bars[bars.length - 1]?.t);
    return Boolean(lastKey && lastKey >= endKey);
  };
  for (const candidate of attemptOrder) {
    try {
      const result = await attempt(candidate);
      if (Array.isArray(result.bars) && result.bars.length) {
        const resultCoversEnd = coversEndDate(result.bars);
        if (
          !bestResult ||
          (resultCoversEnd && !bestCoversEnd) ||
          (resultCoversEnd === bestCoversEnd && result.bars.length > bestResult.bars.length)
        ) {
          bestResult = result;
          bestCoversEnd = resultCoversEnd;
        }
        // Only early-return when we have enough bars AND they reach the requested end date.
        // Some providers can return long histories that stop early (e.g. delisted/sparse tickers),
        // and we still want to try alternate sources that might have up-to-date data.
        if ((!minBarsNeeded || result.bars.length >= minBarsNeeded) && resultCoversEnd) {
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
  const cacheQueryBase =
    resolvedAdjustment === 'raw'
      ? { ...baseQuery, $or: [{ adjustment: 'raw' }, { adjustment: { $exists: false } }] }
      : { ...baseQuery, adjustment: resolvedAdjustment };

  const preferredSource =
    resolvedSource === 'yahoo' || resolvedSource === 'alpaca' || resolvedSource === 'tiingo' || resolvedSource === 'stooq'
      ? resolvedSource
      : null;

  // If DB cache is disabled, fetch fresh data and skip any Mongo operations.
  if (SKIP_DB_CACHE) {
    const { bars, dataSource } = await fetchBarsWithFallback({
      symbol: uppercaseSymbol,
      start,
      end,
      adjustment: resolvedAdjustment,
      source: resolvedSource,
      minBars: minBarsNeeded,
    });
    const subset = (bars || []).filter((bar) => {
      const timestamp = new Date(bar.t);
      return timestamp >= start && timestamp <= end;
    });
    if (!subset.length) {
      throw new Error(`Fetched data for ${uppercaseSymbol} does not cover the requested range.`);
    }
    return {
      symbol: uppercaseSymbol,
      start: subset[0].t,
      end: subset[subset.length - 1].t,
      granularity: '1Day',
      refreshedAt: new Date(),
      adjustment: resolvedAdjustment,
      dataSource,
      bars: subset,
    };
  }

  let cache = null;
  if (preferredSource) {
    cache = await PriceCache.findOne({ ...cacheQueryBase, dataSource: preferredSource }).sort({ refreshedAt: -1 });
  }
  if (!cache) {
    cache = await PriceCache.findOne({ ...cacheQueryBase, dataSource: { $ne: 'testfolio' } }).sort({ refreshedAt: -1 });
  }

  const subsetBars = (bars = []) =>
    (Array.isArray(bars) ? bars : []).filter((bar) => {
      const timestamp = new Date(bar.t);
      return timestamp >= start && timestamp <= end;
    });

  const relaxedCoverageOk = (bars = []) => {
    if (!minBarsNeeded) {
      return false;
    }
    if (!Array.isArray(bars) || bars.length < minBarsNeeded) {
      return false;
    }
    const lastKey = toISODateKey(bars[bars.length - 1]?.t);
    const endKey = toISODateKey(end);
    return Boolean(lastKey && endKey && lastKey >= endKey);
  };
  let subset = cache ? subsetBars(cache.bars || []) : [];
  const cacheUsable =
    cache && subset.length > 0 && (barsCoverRange(subset, start, end) || relaxedCoverageOk(subset));
  const isFresh =
    !resolvedForceRefresh &&
    cache &&
    cache.refreshedAt &&
    (Date.now() - new Date(cache.refreshedAt).getTime()) / (1000 * 60 * 60) < CACHE_TTL_HOURS &&
    cacheUsable;

  // Cache-only mode should still enforce minimum history requirements, otherwise long-window
  // indicators can silently drop branches and drift from Composer holdings.
  const cacheOnlyOk = resolvedCacheOnly && cacheUsable;

  if (!isFresh && !cacheOnlyOk) {
    const { bars, dataSource } = await fetchBarsWithFallback({
      symbol: uppercaseSymbol,
      start,
      end,
      adjustment: resolvedAdjustment,
      source: resolvedSource,
      minBars: minBarsNeeded,
    });
    const writeQuery =
      resolvedAdjustment === 'raw'
        ? { ...baseQuery, dataSource, $or: [{ adjustment: 'raw' }, { adjustment: { $exists: false } }] }
        : { ...baseQuery, dataSource, adjustment: resolvedAdjustment };
    cache = await PriceCache.findOneAndUpdate(
      writeQuery,
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
    subset = subsetBars(cache.bars || []);
  }

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
