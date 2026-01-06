const crypto = require('crypto');
const Axios = require('axios');
const CryptoJS = require('crypto-js');
const { normalizeRecurrence, computeNextRebalanceAt } = require('../utils/recurrence');
const { recordStrategyLog } = require('./strategyLogger');

const CLOB_HOST = String(process.env.POLYMARKET_CLOB_HOST || 'https://clob.polymarket.com').replace(/\/+$/, '');
const DATA_API_HOST = String(process.env.POLYMARKET_DATA_API_HOST || 'https://data-api.polymarket.com').replace(
  /\/+$/,
  ''
);
const GEO_BLOCK_TOKEN =
  (process.env.POLYMARKET_GEO_BLOCK_TOKEN || process.env.GEO_BLOCK_TOKEN || '').trim() || null;
const POLYMARKET_DATA_API_TAKER_ONLY_DEFAULT = String(process.env.POLYMARKET_DATA_API_TAKER_ONLY ?? 'false')
  .trim()
  .toLowerCase();
const POLYMARKET_DATA_API_USER_AGENT = String(process.env.POLYMARKET_DATA_API_USER_AGENT || 'tradingapp/1.0').trim();
const POLYMARKET_HTTP_TIMEOUT_MS = (() => {
  const raw = Number(process.env.POLYMARKET_HTTP_TIMEOUT_MS || process.env.POLYMARKET_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 15000;
  }
  return Math.max(1000, Math.min(Math.floor(raw), 120000));
})();
const POLYMARKET_PROGRESS_LOG_EVERY_TRADES = (() => {
  const raw = Number(process.env.POLYMARKET_PROGRESS_LOG_EVERY_TRADES);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 2000;
  }
  return Math.max(100, Math.min(Math.floor(raw), 20000));
})();
const POLYMARKET_PROGRESS_LOG_EVERY_PAGES = (() => {
  const raw = Number(process.env.POLYMARKET_PROGRESS_LOG_EVERY_PAGES);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 10;
  }
  return Math.max(1, Math.min(Math.floor(raw), 200));
})();
const ENCRYPTION_KEY = String(process.env.ENCRYPTION_KEY || process.env.CryptoJS_secret_key || '').trim() || null;
const POLYMARKET_CLOB_AUTH_FAILURE_COOLDOWN_MS = (() => {
  const raw = Number(process.env.POLYMARKET_CLOB_AUTH_FAILURE_COOLDOWN_MS);
  if (!Number.isFinite(raw)) {
    return 60 * 60 * 1000;
  }
  return Math.max(0, Math.min(Math.floor(raw), 24 * 60 * 60 * 1000));
})();

const INITIAL_CURSOR = 'MA==';
const END_CURSOR = 'LTE=';
const MAX_TRADES_PER_SYNC = 2500;
const MAX_TRADES_PER_BACKFILL = (() => {
  const parsed = Number(process.env.POLYMARKET_BACKFILL_MAX_TRADES);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 10000;
  }
  return Math.max(1, Math.min(Math.floor(parsed), 50000));
})();

const toNumber = (value, fallback = null) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const normalizeTradesSourceSetting = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'clob' || raw === 'l2' || raw === 'clob-l2' || raw === 'clob_l2') {
    return 'clob-l2';
  }
  if (raw === 'data' || raw === 'data-api' || raw === 'data_api') {
    return 'data-api';
  }
  return 'auto';
};

const getTradesSourceSetting = () => normalizeTradesSourceSetting(process.env.POLYMARKET_TRADES_SOURCE || 'auto');

const roundToDecimals = (value, decimals = 6) => {
  const num = toNumber(value, null);
  if (!Number.isFinite(num)) {
    return null;
  }
  const places = Math.max(0, Math.min(12, Number(decimals) || 0));
  const factor = 10 ** places;
  return Math.round((num + Number.EPSILON) * factor) / factor;
};

const buildGeoParams = (params = {}) => {
  if (!GEO_BLOCK_TOKEN) {
    return params;
  }
  return { ...params, geo_block_token: GEO_BLOCK_TOKEN };
};

const axiosGet = async (url, config = {}) => {
  const timeout = config.timeout ? config.timeout : POLYMARKET_HTTP_TIMEOUT_MS;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => {
      try {
        controller.abort();
      } catch (error) {
        // ignore
      }
    }, timeout)
    : null;

  try {
    return await Axios.get(url, {
      ...config,
      timeout,
      proxy: false,
      ...(controller ? { signal: controller.signal } : {}),
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const sanitizeBase64Secret = (secret) => {
  return String(secret || '')
    .trim()
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/[^A-Za-z0-9+/=]/g, '');
};

const decodeBase64Secret = (secret) => Buffer.from(sanitizeBase64Secret(secret), 'base64');

const makeUrlSafeBase64 = (base64) => String(base64 || '').replace(/\+/g, '-').replace(/\//g, '_');

const decryptIfEncrypted = (value) => {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (!raw.startsWith('U2Fsd')) {
    return raw;
  }
  if (!ENCRYPTION_KEY) {
    throw new Error('Encrypted Polymarket credentials provided but ENCRYPTION_KEY/CryptoJS_secret_key is not configured.');
  }
  try {
    const bytes = CryptoJS.AES.decrypt(raw, ENCRYPTION_KEY);
    const decrypted = bytes.toString(CryptoJS.enc.Utf8);
    return String(decrypted || '').trim();
  } catch (error) {
    throw new Error('Unable to decrypt Polymarket credentials.');
  }
};

const buildPolyHmacSignature = ({ secret, timestamp, method, requestPath, body }) => {
  const ts = Math.floor(toNumber(timestamp, 0));
  if (!ts) {
    throw new Error('Polymarket signature timestamp is invalid.');
  }

  const message = `${ts}${String(method || '').toUpperCase()}${requestPath}${body ?? ''}`;
  const key = decodeBase64Secret(secret);
  const signature = crypto.createHmac('sha256', key).update(message).digest('base64');
  return makeUrlSafeBase64(signature);
};

const fetchClobServerTime = async () => {
  const response = await axiosGet(`${CLOB_HOST}/time`, { params: buildGeoParams() });
  const ts = Math.floor(toNumber(response?.data, NaN));
  if (!Number.isFinite(ts) || ts <= 0) {
    throw new Error('Unable to fetch Polymarket server time.');
  }
  return ts;
};

const createL2Headers = async ({ authAddress, apiKey, secret, passphrase, method, requestPath, body }) => {
  const ts = await fetchClobServerTime().catch(() => Math.floor(Date.now() / 1000));
  const signature = buildPolyHmacSignature({
    secret,
    timestamp: ts,
    method,
    requestPath,
    body,
  });

  return {
    POLY_ADDRESS: String(authAddress || '').trim(),
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: `${ts}`,
    POLY_API_KEY: String(apiKey || '').trim(),
    POLY_PASSPHRASE: String(passphrase || '').trim(),
  };
};

const fetchTradesPage = async ({ authAddress, apiKey, secret, passphrase, makerAddress, nextCursor }) => {
  const endpoint = '/data/trades';
  const headers = await createL2Headers({
    authAddress,
    apiKey,
    secret,
    passphrase,
    method: 'GET',
    requestPath: endpoint,
  });

  const params = buildGeoParams({
    next_cursor: nextCursor || INITIAL_CURSOR,
    maker_address: makerAddress,
  });

  const response = await axiosGet(`${CLOB_HOST}${endpoint}`, { headers, params });
  return { page: response?.data || null };
};

const buildDataApiTradeId = (trade) => {
  const tx = trade?.transactionHash ? String(trade.transactionHash).trim() : '';
  const asset = trade?.asset ? String(trade.asset).trim() : '';
  const conditionId = trade?.conditionId ? String(trade.conditionId).trim() : '';
  const side = trade?.side ? String(trade.side).trim().toUpperCase() : '';
  const ts = trade?.timestamp !== undefined && trade?.timestamp !== null ? String(trade.timestamp).trim() : '';
  const price = trade?.price !== undefined && trade?.price !== null ? String(trade.price) : '';
  const size = trade?.size !== undefined && trade?.size !== null ? String(trade.size) : '';

  const parts = [tx, conditionId, asset, side, ts, price, size].filter(Boolean);
  if (!parts.length) {
    return null;
  }
  // Keep stable across calls; also de-dupes identical trades returned twice.
  return `data-api:${parts.join(':')}`;
};

const normalizeDataApiTrade = (trade) => {
  if (!trade || typeof trade !== 'object') {
    return null;
  }
  const id = buildDataApiTradeId(trade);
  const assetId = trade?.asset ? String(trade.asset).trim() : null;
  const conditionId = trade?.conditionId ? String(trade.conditionId).trim() : null;
  const side = trade?.side ? String(trade.side).trim().toUpperCase() : null;
  const outcome = trade?.outcome ? String(trade.outcome).trim() : null;
  const matchTime = trade?.timestamp !== undefined && trade?.timestamp !== null ? String(trade.timestamp).trim() : null;
  const size = trade?.size !== undefined && trade?.size !== null ? Number(trade.size) : null;
  const price = trade?.price !== undefined && trade?.price !== null ? Number(trade.price) : null;

  if (!id || !assetId || !conditionId || !side || !matchTime || !Number.isFinite(size) || !Number.isFinite(price)) {
    return null;
  }

  return {
    id,
    asset_id: assetId,
    market: conditionId,
    outcome,
    side,
    size,
    price,
    match_time: matchTime,
    _polymarketSource: 'data-api',
  };
};

const parseBooleanEnvDefault = (value, fallback = false) => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === null || value === undefined) {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return fallback;
};

const fetchDataApiTradesPage = async ({ userAddress, offset, limit, takerOnly }) => {
  const normalizedUser = String(userAddress || '').trim();
  if (!isValidHexAddress(normalizedUser)) {
    throw new Error('Polymarket address is missing or invalid.');
  }

  const cleanedOffset = Number.isFinite(Number(offset)) && Number(offset) >= 0 ? Math.floor(Number(offset)) : 0;
  const cleanedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 100;
  const maxLimit = 10000;
  const finalLimit = Math.max(1, Math.min(cleanedLimit, maxLimit));

  const takerOnlyFlag = parseBooleanEnvDefault(takerOnly, false);

  const response = await axiosGet(`${DATA_API_HOST}/trades`, {
    headers: POLYMARKET_DATA_API_USER_AGENT ? { 'User-Agent': POLYMARKET_DATA_API_USER_AGENT } : undefined,
    params: {
      user: normalizedUser,
      limit: finalLimit,
      offset: cleanedOffset,
      takerOnly: takerOnlyFlag,
    },
  });

  const data = Array.isArray(response?.data) ? response.data : [];
  const normalizedTrades = [];
  const seen = new Set();
  for (const raw of data) {
    const mapped = normalizeDataApiTrade(raw);
    if (!mapped?.id || seen.has(mapped.id)) {
      continue;
    }
    seen.add(mapped.id);
    normalizedTrades.push(mapped);
  }
  return { trades: normalizedTrades, nextOffset: cleanedOffset + finalLimit, requestedLimit: finalLimit };
};

const fetchMarket = async (conditionId) => {
  if (!conditionId) {
    return null;
  }
  const cleaned = String(conditionId).trim();
  if (!cleaned) {
    return null;
  }
  const response = await axiosGet(`${CLOB_HOST}/markets/${cleaned}`, { params: buildGeoParams() });
  return response?.data || null;
};

const buildMarketTokenPriceIndex = (market) => {
  const tokens = Array.isArray(market?.tokens) ? market.tokens : [];
  const index = new Map();
  tokens.forEach((token) => {
    const tokenId = token?.token_id ? String(token.token_id) : '';
    if (!tokenId) {
      return;
    }
    const price = toNumber(token?.price, null);
    const outcome = token?.outcome ? String(token.outcome) : null;
    index.set(tokenId, { price, outcome });
  });
  return index;
};

const isValidHexAddress = (value) => {
  const address = String(value || '').trim();
  return /^0x[a-fA-F0-9]{40}$/.test(address);
};

const parseTimeValue = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = String(value).trim();
  if (!raw) {
    return null;
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    // Heuristic: treat 10+ digits as milliseconds when it looks like epoch time.
    if (numeric > 1e12) {
      return numeric;
    }
    if (numeric > 1e9) {
      return numeric * 1000;
    }
    return numeric;
  }
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }
  return null;
};

const isTradeAfterAnchor = (tradeTime, anchorTime) => {
  const tradeMs = parseTimeValue(tradeTime);
  const anchorMs = parseTimeValue(anchorTime);
  if (tradeMs !== null && anchorMs !== null) {
    return tradeMs > anchorMs;
  }
  if (tradeMs !== null && anchorMs === null) {
    return true;
  }
  if (tradeMs === null && anchorMs !== null) {
    return false;
  }
  return String(tradeTime || '') > String(anchorTime || '');
};

const formatAxiosError = (error) => {
  const status = Number(error?.response?.status);
  const payload = error?.response?.data;
  const apiMessage = (() => {
    if (!payload) {
      return null;
    }
    if (typeof payload === 'string') {
      return payload.trim() || null;
    }
    if (payload?.error) {
      return String(payload.error).trim() || null;
    }
    if (payload?.message) {
      return String(payload.message).trim() || null;
    }
    try {
      return JSON.stringify(payload);
    } catch (stringifyError) {
      return null;
    }
  })();
  if (Number.isFinite(status) && status > 0) {
    if (status === 401 && apiMessage && apiMessage.toLowerCase().includes('unauthorized')) {
      const hint = GEO_BLOCK_TOKEN
        ? ''
        : ' (check POLYMARKET_AUTH_ADDRESS + keys; France may require POLYMARKET_GEO_BLOCK_TOKEN)';
      return `Request failed with status code ${status} (${apiMessage})${hint}`;
    }
    return apiMessage ? `Request failed with status code ${status} (${apiMessage})` : `Request failed with status code ${status}`;
  }
  return String(error?.message || 'Request failed');
};

const isPolymarketAuthFailure = (error) => {
  const status = Number(error?.status || error?.response?.status);
  if (status === 401 || status === 403) {
    return true;
  }
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('unauthorized') || message.includes('invalid api key')) {
    return true;
  }
  const apiError = String(error?.response?.data?.error || error?.response?.data?.message || '').toLowerCase();
  if (apiError.includes('unauthorized') || apiError.includes('invalid api key')) {
    return true;
  }
  return false;
};

const clobAuthFailureState = {
  disabledUntilMs: 0,
};

const isClobAuthTemporarilyDisabled = () =>
  POLYMARKET_CLOB_AUTH_FAILURE_COOLDOWN_MS > 0 && Date.now() < clobAuthFailureState.disabledUntilMs;

const getClobAuthCooldownStatus = () => {
  const cooldownMs = POLYMARKET_CLOB_AUTH_FAILURE_COOLDOWN_MS;
  const disabledUntilMs = Number(clobAuthFailureState.disabledUntilMs) || 0;
  const now = Date.now();
  const active = cooldownMs > 0 && disabledUntilMs > now;
  const remainingMs = active ? disabledUntilMs - now : 0;
  return {
    cooldownMs,
    active,
    remainingMs,
    disabledUntilMs: active ? disabledUntilMs : 0,
    disabledUntil: active ? new Date(disabledUntilMs).toISOString() : null,
  };
};

const resetClobAuthCooldown = () => {
  clobAuthFailureState.disabledUntilMs = 0;
};

const noteClobAuthFailure = () => {
  if (POLYMARKET_CLOB_AUTH_FAILURE_COOLDOWN_MS <= 0) {
    clobAuthFailureState.disabledUntilMs = 0;
    return null;
  }
  clobAuthFailureState.disabledUntilMs = Date.now() + POLYMARKET_CLOB_AUTH_FAILURE_COOLDOWN_MS;
  return new Date(clobAuthFailureState.disabledUntilMs).toISOString();
};

const syncPolymarketPortfolioInternal = async (portfolio, options = {}) => {
  if (!portfolio) {
    throw new Error('Portfolio is required.');
  }
  const provider = String(portfolio.provider || 'alpaca');
  if (provider !== 'polymarket') {
    return { skipped: true, reason: 'not_polymarket' };
  }

  const poly = portfolio.polymarket || {};
  const requestedMode = String(options?.mode || '').trim().toLowerCase();
  const mode = requestedMode === 'backfill'
    ? 'backfill'
    : poly.backfillPending
      ? 'backfill'
      : 'incremental';
  const resetPortfolio = mode === 'backfill' ? options?.reset !== false : false;
  const address = String(poly.address || '').trim();
  const storedApiKey = decryptIfEncrypted(poly.apiKey);
  const storedSecret = decryptIfEncrypted(poly.secret);
  const storedPassphrase = decryptIfEncrypted(poly.passphrase);
  const usingStoredCreds = Boolean(storedApiKey || storedSecret || storedPassphrase);

  const apiKey = storedApiKey || decryptIfEncrypted(process.env.POLYMARKET_API_KEY || process.env.CLOB_API_KEY);
  const secret = storedSecret || decryptIfEncrypted(process.env.POLYMARKET_SECRET || process.env.CLOB_SECRET);
  const passphrase =
    storedPassphrase || decryptIfEncrypted(process.env.POLYMARKET_PASSPHRASE || process.env.CLOB_PASS_PHRASE);

  const authAddressStored = poly.authAddress ? String(poly.authAddress).trim() : '';
  const authAddressEnv = String(
    process.env.POLYMARKET_AUTH_ADDRESS || process.env.POLYMARKET_ADDRESS || ''
  ).trim();
  const authAddressCandidate = usingStoredCreds
    ? (authAddressStored || authAddressEnv || address)
    : (authAddressEnv || authAddressStored || '');
  const hasAuthAddress = Boolean(authAddressCandidate && isValidHexAddress(authAddressCandidate));
  const authAddress = hasAuthAddress ? authAddressCandidate : null;
  const hasClobCredentials = Boolean(apiKey && secret && passphrase && authAddress);

  if (!isValidHexAddress(address)) {
    throw new Error('Polymarket address is missing or invalid.');
  }
  const tradesSourceSetting = getTradesSourceSetting();
  if (tradesSourceSetting === 'clob-l2' && !hasClobCredentials) {
    throw new Error(
      'Polymarket CLOB L2 credentials are required. Set POLYMARKET_API_KEY, POLYMARKET_SECRET, POLYMARKET_PASSPHRASE, and POLYMARKET_AUTH_ADDRESS.'
    );
  }

  const lastTradeId = poly.lastTradeId ? String(poly.lastTradeId).trim() : null;
  const lastTradeMatchTime = poly.lastTradeMatchTime ? String(poly.lastTradeMatchTime).trim() : null;
  const now = new Date();
  const anchorMatchTime = !lastTradeId
    ? (lastTradeMatchTime || now.toISOString())
    : null;

  if (mode === 'backfill') {
    await recordStrategyLog({
      strategyId: portfolio.strategy_id,
      userId: portfolio.userId,
      strategyName: portfolio.name,
      message: 'Polymarket backfill started',
      details: {
        provider: 'polymarket',
        mode,
        address,
        resetPortfolio,
        timeoutMs: POLYMARKET_HTTP_TIMEOUT_MS,
        maxTrades: MAX_TRADES_PER_BACKFILL,
      },
    });
  }

  const dataApiTakerOnly = parseBooleanEnvDefault(POLYMARKET_DATA_API_TAKER_ONLY_DEFAULT, false);

  const collectTrades = async (tradeSource) => {
    const pendingTrades = [];
    const seenTradeIds = new Set();
    let pagesFetched = 0;
    let nextProgressLogAt = POLYMARKET_PROGRESS_LOG_EVERY_TRADES;
    let foundLastTrade = false;
    let foundAnchor = false;

    const pushTrade = (trade) => {
      const id = trade?.id ? String(trade.id) : null;
      if (!id || seenTradeIds.has(id)) {
        return;
      }
      seenTradeIds.add(id);
      pendingTrades.push(trade);
    };

    const fetchClobPage = async (cursor) => {
      try {
        return await fetchTradesPage({
          authAddress,
          apiKey,
          secret,
          passphrase,
          makerAddress: address,
          nextCursor: cursor,
        });
      } catch (error) {
        const wrapped = new Error(formatAxiosError(error));
        const status = Number(error?.response?.status);
        if (Number.isFinite(status)) {
          wrapped.status = status;
        }
        throw wrapped;
      }
    };

    let nextToken = tradeSource === 'data-api' ? 0 : INITIAL_CURSOR;
    if (tradeSource === 'clob-l2' && !hasClobCredentials) {
      const err = new Error(
        'Polymarket CLOB L2 credentials are missing/invalid. Set POLYMARKET_API_KEY, POLYMARKET_SECRET, POLYMARKET_PASSPHRASE, and POLYMARKET_AUTH_ADDRESS.'
      );
      err.status = 401;
      throw err;
    }

    if (mode === 'backfill') {
      while (nextToken !== null && pendingTrades.length < MAX_TRADES_PER_BACKFILL) {
        pagesFetched += 1;
        const shouldLogPage = pagesFetched === 1 || pagesFetched % POLYMARKET_PROGRESS_LOG_EVERY_PAGES === 0;
        const cursorBefore = nextToken;
        if (shouldLogPage) {
          void recordStrategyLog({
            strategyId: portfolio.strategy_id,
            userId: portfolio.userId,
            strategyName: portfolio.name,
            message: 'Polymarket backfill fetching trades page',
            details: {
              provider: 'polymarket',
              mode,
              tradeSource,
              page: pagesFetched,
              cursor: tradeSource === 'data-api' ? `offset:${cursorBefore}` : cursorBefore,
              tradesCollected: pendingTrades.length,
            },
          });
        }

        let trades = [];
        let requestedLimit = null;
        try {
          if (tradeSource === 'data-api') {
            const remaining = Math.max(0, MAX_TRADES_PER_BACKFILL - pendingTrades.length);
            requestedLimit = Math.max(1, Math.min(remaining, 10000));
            const fetched = await fetchDataApiTradesPage({
              userAddress: address,
              offset: cursorBefore,
              limit: requestedLimit,
              takerOnly: dataApiTakerOnly,
            });
            trades = Array.isArray(fetched?.trades) ? fetched.trades : [];
            requestedLimit = fetched?.requestedLimit ?? requestedLimit;
            const nextOffset =
              fetched?.nextOffset !== undefined && fetched?.nextOffset !== null ? Number(fetched.nextOffset) : null;
            nextToken = Number.isFinite(nextOffset) ? nextOffset : null;
          } else {
            const fetched = await fetchClobPage(cursorBefore);
            const page = fetched?.page;
            trades = Array.isArray(page?.data) ? page.data : [];
            const cursor = page?.next_cursor ? String(page.next_cursor) : null;
            if (!cursor || cursor === cursorBefore || cursor === END_CURSOR) {
              nextToken = null;
            } else {
              nextToken = cursor;
            }
          }
        } catch (error) {
          await recordStrategyLog({
            strategyId: portfolio.strategy_id,
            userId: portfolio.userId,
            strategyName: portfolio.name,
            level: 'warn',
            message: 'Polymarket backfill failed fetching trades page',
            details: {
              provider: 'polymarket',
              mode,
              tradeSource,
              page: pagesFetched,
              cursor: tradeSource === 'data-api' ? `offset:${cursorBefore}` : cursorBefore,
              tradesCollected: pendingTrades.length,
              error: String(error?.message || error),
            },
          });
          throw error;
        }

        if (!trades.length) {
          break;
        }
        for (const trade of trades) {
          if (pendingTrades.length >= MAX_TRADES_PER_BACKFILL) {
            break;
          }
          pushTrade(trade);
        }

        if (tradeSource === 'data-api' && requestedLimit !== null && trades.length < requestedLimit) {
          nextToken = null;
        }

        if (shouldLogPage) {
          void recordStrategyLog({
            strategyId: portfolio.strategy_id,
            userId: portfolio.userId,
            strategyName: portfolio.name,
            message: 'Polymarket backfill fetched trades page',
            details: {
              provider: 'polymarket',
              mode,
              tradeSource,
              page: pagesFetched,
              tradesInPage: trades.length,
              tradesCollected: pendingTrades.length,
              nextCursor:
                tradeSource === 'data-api'
                  ? nextToken === null
                    ? null
                    : `offset:${nextToken}`
                  : nextToken,
            },
          });
        }

        if (pendingTrades.length >= nextProgressLogAt) {
          void recordStrategyLog({
            strategyId: portfolio.strategy_id,
            userId: portfolio.userId,
            strategyName: portfolio.name,
            message: 'Polymarket backfill downloading trades',
            details: {
              provider: 'polymarket',
              mode,
              tradeSource,
              tradesCollected: pendingTrades.length,
              pagesFetched,
              nextCursor:
                tradeSource === 'data-api'
                  ? nextToken === null
                    ? null
                    : `offset:${nextToken}`
                  : nextToken,
            },
          });
          nextProgressLogAt += POLYMARKET_PROGRESS_LOG_EVERY_TRADES;
        }
      }
    } else {
      while (nextToken !== null && pendingTrades.length < MAX_TRADES_PER_SYNC && !foundLastTrade) {
        pagesFetched += 1;

        let trades = [];
        let requestedLimit = null;
        if (tradeSource === 'data-api') {
          const remaining = Math.max(0, MAX_TRADES_PER_SYNC - pendingTrades.length);
          requestedLimit = Math.max(1, Math.min(remaining, 10000));
          const fetched = await fetchDataApiTradesPage({
            userAddress: address,
            offset: nextToken,
            limit: requestedLimit,
            takerOnly: dataApiTakerOnly,
          });
          trades = Array.isArray(fetched?.trades) ? fetched.trades : [];
          const nextOffset =
            fetched?.nextOffset !== undefined && fetched?.nextOffset !== null ? Number(fetched.nextOffset) : null;
          nextToken = Number.isFinite(nextOffset) ? nextOffset : null;
          requestedLimit = fetched?.requestedLimit ?? requestedLimit;
          if (requestedLimit !== null && trades.length < requestedLimit) {
            nextToken = null;
          }
        } else {
          const fetched = await fetchClobPage(nextToken);
          const page = fetched?.page;
          trades = Array.isArray(page?.data) ? page.data : [];
          const cursor = page?.next_cursor ? String(page.next_cursor) : null;
          if (!cursor || cursor === nextToken || cursor === END_CURSOR) {
            nextToken = null;
          } else {
            nextToken = cursor;
          }
        }

        for (const trade of trades) {
          const id = trade?.id ? String(trade.id) : null;
          if (!id) {
            continue;
          }
          if (lastTradeId) {
            if (id === lastTradeId) {
              foundLastTrade = true;
              break;
            }
            pushTrade(trade);
            continue;
          }

          const matchTime = trade?.match_time ? String(trade.match_time) : null;
          if (!matchTime) {
            continue;
          }
          if (anchorMatchTime && !isTradeAfterAnchor(matchTime, anchorMatchTime)) {
            foundAnchor = true;
            break;
          }
          pushTrade(trade);
        }

        if (!lastTradeId && foundAnchor) {
          break;
        }
      }
    }

    return { pendingTrades, pagesFetched };
  };

  const initialTradeSource = (() => {
    if (tradesSourceSetting === 'data-api') {
      return 'data-api';
    }
    if (tradesSourceSetting === 'clob-l2') {
      return 'clob-l2';
    }
    if (hasClobCredentials && !isClobAuthTemporarilyDisabled()) {
      return 'clob-l2';
    }
    return 'data-api';
  })();

  let tradeSourceUsed = initialTradeSource;
  let pendingTrades = [];
  let pagesFetched = 0;
  try {
    const collected = await collectTrades(tradeSourceUsed);
    pendingTrades = collected.pendingTrades;
    pagesFetched = collected.pagesFetched;
  } catch (error) {
    if (tradesSourceSetting === 'auto' && tradeSourceUsed === 'clob-l2' && isPolymarketAuthFailure(error)) {
      tradeSourceUsed = 'data-api';
      const nextRetryAt = noteClobAuthFailure();
      await recordStrategyLog({
        strategyId: portfolio.strategy_id,
        userId: portfolio.userId,
        strategyName: portfolio.name,
        level: 'warn',
        message: 'Polymarket CLOB auth failed; falling back to data-api trades endpoint',
        details: {
          provider: 'polymarket',
          mode,
          address,
          error: String(error?.message || error),
          clobRetryAfterMs: POLYMARKET_CLOB_AUTH_FAILURE_COOLDOWN_MS || 0,
          clobNextRetryAt: nextRetryAt,
        },
      });
      const collected = await collectTrades(tradeSourceUsed);
      pendingTrades = collected.pendingTrades;
      pagesFetched = collected.pagesFetched;
    } else {
      throw error;
    }
  }

  if (mode !== 'backfill' && !lastTradeId) {
    // Persist the anchor so we can copy the first trade that happens after setup.
    portfolio.polymarket = {
      ...(portfolio.polymarket || {}),
      lastTradeMatchTime: anchorMatchTime,
      lastTradeId: null,
    };
  }

  if (!pendingTrades.length) {
    if (mode === 'backfill') {
      portfolio.polymarket = {
        ...(portfolio.polymarket || {}),
        backfillPending: false,
        backfilledAt: now.toISOString(),
      };
      await recordStrategyLog({
        strategyId: portfolio.strategy_id,
        userId: portfolio.userId,
        strategyName: portfolio.name,
        message: 'Polymarket backfill completed (no trades found)',
        details: {
          provider: 'polymarket',
          mode,
          address,
          pagesFetched,
        },
      });
    }
    portfolio.lastRebalancedAt = now;
    portfolio.nextRebalanceAt = computeNextRebalanceAt(normalizeRecurrence(portfolio.recurrence), now);
    await portfolio.save();
    return { processed: 0, mode, waitingForTrades: mode === 'incremental' ? !lastTradeId : false };
  }

  const processedTrades = pendingTrades.slice().reverse();

  if (mode === 'backfill') {
    void recordStrategyLog({
      strategyId: portfolio.strategy_id,
      userId: portfolio.userId,
      strategyName: portfolio.name,
      message: 'Polymarket backfill replaying trades',
      details: {
        provider: 'polymarket',
        mode,
        tradesCollected: pendingTrades.length,
        pagesFetched,
      },
    });
  }

  const holdingsByAssetId = new Map();
  if (!resetPortfolio) {
    (portfolio.stocks || []).forEach((stock) => {
      const assetId = stock?.asset_id ? String(stock.asset_id) : stock?.symbol ? String(stock.symbol) : null;
      if (!assetId) {
        return;
      }
      holdingsByAssetId.set(assetId, stock);
    });
  }

  const pickNumber = (value) => {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };

  const startingCash = (() => {
    const retainedCash = pickNumber(portfolio.retainedCash);
    const cashBuffer = pickNumber(portfolio.cashBuffer) ?? 0;

    if (!resetPortfolio) {
      return retainedCash ?? cashBuffer;
    }

    const cashLimit = pickNumber(portfolio.cashLimit);
    if (cashLimit !== null) {
      return cashLimit;
    }
    const budget = pickNumber(portfolio.budget);
    if (budget !== null) {
      return budget;
    }
    const initialInvestment = pickNumber(portfolio.initialInvestment);
    if (initialInvestment !== null) {
      return initialInvestment;
    }
    return retainedCash ?? cashBuffer;
  })();

  let cash = Number.isFinite(startingCash) ? startingCash : 0;
  const marketCache = new Map();
  const ensureMarket = async (conditionId) => {
    const key = String(conditionId || '').trim();
    if (!key) {
      return null;
    }
    if (marketCache.has(key)) {
      return marketCache.get(key);
    }
    try {
      const market = await fetchMarket(key);
      marketCache.set(key, market);
      return market;
    } catch (error) {
      marketCache.set(key, null);
      return null;
    }
  };

  const tradeSummary = {
    buys: [],
    sells: [],
    skipped: [],
  };

  for (const trade of processedTrades) {
    const assetId = trade?.asset_id ? String(trade.asset_id) : null;
    const conditionId = trade?.market ? String(trade.market) : null;
    const outcome = trade?.outcome ? String(trade.outcome) : null;
    const side = trade?.side ? String(trade.side).toUpperCase() : null;
    const tradeId = trade?.id ? String(trade.id) : null;
    const rawSize = toNumber(trade?.size, null);
    const rawPrice = toNumber(trade?.price, null);

    if (!tradeId || !assetId || !conditionId || !side || !rawSize || !rawPrice) {
      tradeSummary.skipped.push({
        id: tradeId,
        reason: 'invalid_trade_payload',
      });
      continue;
    }

    const price = Math.max(0, Math.min(1, rawPrice));
    let size = Math.max(0, rawSize);
    if (!size) {
      tradeSummary.skipped.push({
        id: tradeId,
        reason: 'zero_size',
      });
      continue;
    }

    const existing = holdingsByAssetId.get(assetId) || null;
    const currentQty = existing ? toNumber(existing.quantity, 0) : 0;
    const currentAvgCost = existing && existing.avgCost !== undefined && existing.avgCost !== null
      ? toNumber(existing.avgCost, null)
      : null;

    const symbol = existing?.symbol
      ? String(existing.symbol)
      : `PM:${String(conditionId).slice(0, 10)}:${outcome || 'OUTCOME'}`;

    if (side === 'BUY') {
      const maxAffordable = price > 0 ? cash / price : 0;
      if (maxAffordable <= 0) {
        tradeSummary.skipped.push({
          id: tradeId,
          side,
          assetId,
          reason: 'insufficient_cash',
        });
        continue;
      }

      if (size > maxAffordable) {
        size = maxAffordable;
      }

      size = roundToDecimals(size, 6);
      if (!size || size <= 0) {
        tradeSummary.skipped.push({
          id: tradeId,
          side,
          assetId,
          reason: 'insufficient_cash',
        });
        continue;
      }

      const cost = size * price;
      cash = roundToDecimals(cash - cost, 6);

      const newQty = roundToDecimals(currentQty + size, 6);
      const newAvgCost = (() => {
        if (!currentQty || currentAvgCost === null) {
          return price;
        }
        const totalCost = currentQty * currentAvgCost + size * price;
        return totalCost / newQty;
      })();

      const entry = existing || {
        symbol,
        market: conditionId,
        asset_id: assetId,
        outcome,
        orderID: `poly-${tradeId}`,
      };

      entry.quantity = newQty;
      entry.avgCost = roundToDecimals(newAvgCost, 6);
      entry.currentPrice = entry.currentPrice !== undefined && entry.currentPrice !== null
        ? toNumber(entry.currentPrice, null)
        : price;
      entry.market = entry.market || conditionId;
      entry.asset_id = entry.asset_id || assetId;
      entry.outcome = entry.outcome || outcome;

      holdingsByAssetId.set(assetId, entry);
      tradeSummary.buys.push({
        id: tradeId,
        symbol,
        assetId,
        outcome,
        size,
        price,
        cost: roundToDecimals(cost, 6),
      });
    } else if (side === 'SELL') {
      const available = currentQty;
      if (!available || available <= 0) {
        tradeSummary.skipped.push({
          id: tradeId,
          side,
          assetId,
          reason: 'no_position',
        });
        continue;
      }
      if (size > available) {
        size = available;
      }

      size = roundToDecimals(size, 6);
      if (!size || size <= 0) {
        tradeSummary.skipped.push({
          id: tradeId,
          side,
          assetId,
          reason: 'no_position',
        });
        continue;
      }

      const proceeds = size * price;
      cash = roundToDecimals(cash + proceeds, 6);

      const newQty = roundToDecimals(available - size, 6);
      if (existing) {
        existing.quantity = newQty;
        existing.currentPrice = existing.currentPrice !== undefined && existing.currentPrice !== null
          ? toNumber(existing.currentPrice, null)
          : price;
        existing.market = existing.market || conditionId;
        existing.asset_id = existing.asset_id || assetId;
        existing.outcome = existing.outcome || outcome;
      }

      if (existing && newQty > 0) {
        holdingsByAssetId.set(assetId, existing);
      } else {
        holdingsByAssetId.delete(assetId);
      }

      tradeSummary.sells.push({
        id: tradeId,
        symbol,
        assetId,
        outcome,
        size,
        price,
        proceeds: roundToDecimals(proceeds, 6),
      });
    } else {
      tradeSummary.skipped.push({
        id: tradeId,
        side,
        assetId,
        reason: 'unknown_side',
      });
    }
  }

  // Refresh current prices using market snapshots when possible.
  for (const [assetId, entry] of holdingsByAssetId.entries()) {
    const conditionId = entry?.market ? String(entry.market) : null;
    if (!conditionId) {
      continue;
    }
    const market = await ensureMarket(conditionId);
    if (!market) {
      continue;
    }
    const index = buildMarketTokenPriceIndex(market);
    const tokenInfo = index.get(String(assetId));
    if (tokenInfo && tokenInfo.price !== null) {
      entry.currentPrice = tokenInfo.price;
      if (!entry.outcome && tokenInfo.outcome) {
        entry.outcome = tokenInfo.outcome;
      }
    }
    if (market?.question && entry?.symbol && entry.symbol.startsWith('PM:')) {
      const question = String(market.question).trim();
      if (question) {
        entry.symbol = `PM: ${question.slice(0, 42)}${question.length > 42 ? '…' : ''} (${entry.outcome || 'Outcome'})`;
      }
    }
  }

  const updatedStocks = Array.from(holdingsByAssetId.values())
    .map((entry) => ({
      symbol: String(entry.symbol || '').trim() || `PM:${String(entry.asset_id || '').slice(-8)}`,
      market: entry.market ? String(entry.market) : null,
      asset_id: entry.asset_id ? String(entry.asset_id) : null,
      outcome: entry.outcome ? String(entry.outcome) : null,
      avgCost: toNumber(entry.avgCost, null),
      quantity: toNumber(entry.quantity, 0),
      currentPrice: toNumber(entry.currentPrice, null),
      orderID: entry.orderID ? String(entry.orderID) : `poly-${String(entry.asset_id || '').slice(-10)}`,
    }))
    .filter((row) => row.quantity > 0);

  const newest = pendingTrades[0] || null;
  if (newest?.id) {
    portfolio.polymarket = {
      ...(portfolio.polymarket || {}),
      lastTradeId: String(newest.id),
      lastTradeMatchTime: newest.match_time ? String(newest.match_time) : null,
      backfillPending: mode === 'backfill' ? false : Boolean(portfolio.polymarket?.backfillPending),
      backfilledAt: mode === 'backfill' ? now.toISOString() : (portfolio.polymarket?.backfilledAt || null),
    };
  } else if (mode === 'backfill') {
    portfolio.polymarket = {
      ...(portfolio.polymarket || {}),
      backfillPending: false,
      backfilledAt: now.toISOString(),
    };
  }

  portfolio.stocks = updatedStocks;
  portfolio.retainedCash = toNumber(cash, 0);
  portfolio.cashBuffer = toNumber(cash, 0);
  portfolio.lastRebalancedAt = now;
  portfolio.nextRebalanceAt = computeNextRebalanceAt(normalizeRecurrence(portfolio.recurrence), now);
  portfolio.rebalanceCount = toNumber(portfolio.rebalanceCount, 0) + 1;
  portfolio.lastPerformanceComputedAt = now;
  await portfolio.save();

  const maxLogTrades = mode === 'backfill' ? 200 : 500;
	  await recordStrategyLog({
	    strategyId: portfolio.strategy_id,
	    userId: portfolio.userId,
	    strategyName: portfolio.name,
	    message: mode === 'backfill' ? 'Polymarket copy-trader backfilled' : 'Polymarket copy-trader synced',
	    details: {
	      provider: 'polymarket',
	      mode,
	      tradeSource: tradeSourceUsed,
	      tradesSourceSetting,
	      hasClobCredentials,
	      clobAuthCooldown: getClobAuthCooldownStatus(),
	      address,
	      pagesFetched,
	      startingCash,
	      processedTrades: processedTrades.length,
	      buys: tradeSummary.buys.slice(0, maxLogTrades),
	      sells: tradeSummary.sells.slice(0, maxLogTrades),
	      skipped: tradeSummary.skipped.slice(0, 50),
      buyCount: tradeSummary.buys.length,
      sellCount: tradeSummary.sells.length,
      skippedCount: tradeSummary.skipped.length,
      cash: portfolio.retainedCash,
      positions: updatedStocks.map((pos) => ({
        market: pos.market,
        asset_id: pos.asset_id,
        outcome: pos.outcome,
        quantity: pos.quantity,
        avgCost: pos.avgCost,
        currentPrice: pos.currentPrice,
      })),
    },
  });

	  return {
	    processed: processedTrades.length,
	    mode,
	    tradeSource: tradeSourceUsed,
	    pagesFetched,
	    buys: tradeSummary.buys.length,
	    sells: tradeSummary.sells.length,
	    skipped: tradeSummary.skipped.length,
	  };
};

const polymarketSyncInFlight = new Map();

const syncPolymarketPortfolio = async (portfolio, options = {}) => {
  if (!portfolio) {
    return await syncPolymarketPortfolioInternal(portfolio, options);
  }
  const provider = String(portfolio.provider || 'alpaca');
  if (provider !== 'polymarket') {
    return await syncPolymarketPortfolioInternal(portfolio, options);
  }

  const lockKey = portfolio?._id
    ? String(portfolio._id)
    : `${String(portfolio.userId || '')}:${String(portfolio.strategy_id || '')}`;

  if (!lockKey) {
    return await syncPolymarketPortfolioInternal(portfolio, options);
  }

  const inFlight = polymarketSyncInFlight.get(lockKey);
  if (inFlight) {
    if (options?.skipIfLocked) {
      return { skipped: true, reason: 'sync_in_progress' };
    }
    return await inFlight;
  }

  const run = syncPolymarketPortfolioInternal(portfolio, options);
  polymarketSyncInFlight.set(lockKey, run);
  try {
    return await run;
  } finally {
    if (polymarketSyncInFlight.get(lockKey) === run) {
      polymarketSyncInFlight.delete(lockKey);
    }
  }
};

module.exports = {
  syncPolymarketPortfolio,
  isValidHexAddress,
  getClobAuthCooldownStatus,
  resetClobAuthCooldown,
  normalizeTradesSourceSetting,
};
