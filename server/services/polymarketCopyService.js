const crypto = require('crypto');
const Axios = require('axios');
const CryptoJS = require('crypto-js');
const mongoose = require('mongoose');
const { normalizeRecurrence, computeNextRebalanceAt } = require('../utils/recurrence');
const { recordStrategyLog } = require('./strategyLogger');
const StrategyEquitySnapshot = require('../models/strategyEquitySnapshotModel');
const {
  getPolymarketExecutionMode,
  executePolymarketMarketOrder,
  getPolymarketExecutionDebugInfo,
  getPolymarketBalanceAllowance,
  getPolymarketOnchainUsdcBalance,
  getPolymarketClobBalanceAllowance,
} = require('./polymarketExecutionService');
const { getNextPolymarketProxyConfig, getPolymarketHttpsAgent, notePolymarketProxyFailure } = require('./polymarketProxyPoolService');

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
const POLYMARKET_CLOB_USER_AGENT = String(
  process.env.POLYMARKET_CLOB_USER_AGENT || process.env.POLYMARKET_HTTP_USER_AGENT || 'tradingapp/1.0'
).trim();
const POLYMARKET_CLOB_PROXY_LIST = String(
  process.env.POLYMARKET_CLOB_PROXY ||
    process.env.POLYMARKET_HTTP_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    ''
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
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
let clobProxyPoolKey = null;
let clobProxyPool = [];
let clobProxyCursor = 0;
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
const POLYMARKET_SIZE_TO_BUDGET_BOOTSTRAP_ENABLED = (() => {
  const raw = String(process.env.POLYMARKET_SIZE_TO_BUDGET_BOOTSTRAP ?? 'true').trim().toLowerCase();
  if (!raw) return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return true;
})();
const POLYMARKET_SIZE_TO_BUDGET_BOOTSTRAP_MAX_TRADES = (() => {
  const parsed = Number(process.env.POLYMARKET_SIZE_TO_BUDGET_BOOTSTRAP_MAX_TRADES);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 2000;
  }
  return Math.max(100, Math.min(Math.floor(parsed), MAX_TRADES_PER_BACKFILL));
})();
const POLYMARKET_LIVE_REBALANCE_MAX_ORDERS = (() => {
  const parsed = Number(process.env.POLYMARKET_LIVE_REBALANCE_MAX_ORDERS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 20;
  }
  return Math.max(1, Math.min(Math.floor(parsed), 200));
})();
const POLYMARKET_LIVE_REBALANCE_MIN_NOTIONAL = (() => {
  const parsed = Number(process.env.POLYMARKET_LIVE_REBALANCE_MIN_NOTIONAL);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1;
  }
  return Math.max(0.01, Math.min(parsed, 1000000));
})();

const POLYMARKET_PROXY_REQUEST_ATTEMPTS = (() => {
  const parsed = Number(process.env.POLYMARKET_PROXY_REQUEST_ATTEMPTS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 3;
  }
  return Math.max(1, Math.min(Math.floor(parsed), 10));
})();

const toNumber = (value, fallback = null) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const roundToTwo = (value) => {
  const num = toNumber(value, null);
  if (!Number.isFinite(num)) {
    return null;
  }
  return Math.round((num + Number.EPSILON) * 100) / 100;
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

const normalizeLiveHoldingsSourceSetting = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'data-api';
  if (raw === 'portfolio' || raw === 'db') return 'portfolio';
  if (raw === 'data' || raw === 'data-api' || raw === 'data_api') return 'data-api';
  return 'data-api';
};

const getTradesSourceSetting = () => normalizeTradesSourceSetting(process.env.POLYMARKET_TRADES_SOURCE || 'auto');

const normalizeExecutionModeOverride = (value) => {
  if (typeof value === 'boolean') {
    return value ? 'live' : 'paper';
  }
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'live' || raw === 'real') return 'live';
  if (raw === 'paper' || raw === 'dry' || raw === 'dry-run' || raw === 'dryrun') return 'paper';
  if (raw === 'true' || raw === '1' || raw === 'yes') return 'live';
  if (raw === 'false' || raw === '0' || raw === 'no') return 'paper';
  return null;
};

const parseBoolean = (value, fallback = false) => {
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

const computeHoldingsMarketValue = (stocks = []) => {
  if (!Array.isArray(stocks) || !stocks.length) {
    return 0;
  }
  return stocks.reduce((sum, entry) => {
    const qty = Math.max(0, toNumber(entry?.quantity, 0));
    if (!qty) {
      return sum;
    }
    const price = toNumber(entry?.currentPrice, null);
    const fallback = price !== null ? price : toNumber(entry?.avgCost, null);
    if (fallback === null) {
      return sum;
    }
    return sum + qty * fallback;
  }, 0);
};

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

const withClobUserAgent = (headers = {}) => {
  if (!POLYMARKET_CLOB_USER_AGENT) {
    return headers;
  }
  return { ...headers, 'User-Agent': POLYMARKET_CLOB_USER_AGENT };
};

const normalizeProxyUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return raw;
  return `http://${raw}`;
};

const parseProxyUrl = (value) => {
  const normalized = normalizeProxyUrl(value);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    if (!parsed.hostname || !Number.isFinite(port)) {
      return null;
    }
    const auth =
      parsed.username || parsed.password
        ? {
            username: decodeURIComponent(parsed.username || ''),
            password: decodeURIComponent(parsed.password || ''),
          }
        : undefined;
    return { host: parsed.hostname, port, ...(auth ? { auth } : {}) };
  } catch {
    return null;
  }
};

const getClobProxyPool = () => {
  const key = POLYMARKET_CLOB_PROXY_LIST.join(',');
  if (key !== clobProxyPoolKey) {
    clobProxyPoolKey = key;
    clobProxyPool = POLYMARKET_CLOB_PROXY_LIST.map(parseProxyUrl).filter(Boolean);
    clobProxyCursor = 0;
  }
  return clobProxyPool;
};

const getClobProxyConfig = () => {
  return getNextPolymarketProxyConfig();
};

const sanitizePolymarketSubdoc = (portfolio) => {
  if (!portfolio || typeof portfolio !== 'object') {
    return;
  }
  const poly = portfolio.polymarket;
  if (!poly || typeof poly !== 'object') {
    return;
  }
  const hasSizingStateKey = Object.prototype.hasOwnProperty.call(poly, 'sizingState');
  const sizingStateUndefinedViaToObject = (() => {
    if (typeof poly.toObject !== 'function') {
      return false;
    }
    try {
      return poly.toObject()?.sizingState === undefined;
    } catch {
      return false;
    }
  })();

  if (hasSizingStateKey && (poly.sizingState === undefined || sizingStateUndefinedViaToObject)) {
    // Some environments end up persisting BSON `undefined` which Mongoose will later reject at save time.
    // Coerce to an empty object so validation/casting succeeds even across schema variants.
    if (typeof portfolio.set === 'function') {
      portfolio.set('polymarket.sizingState', {});
    } else {
      poly.sizingState = {};
    }
  }
};

const snapshotPolymarket = (poly) => {
  if (!poly || typeof poly !== 'object') {
    return {};
  }
  const base = typeof poly.toObject === 'function' ? poly.toObject() : { ...poly };
  if (base.sizingState === undefined) {
    delete base.sizingState;
  }
  return base;
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

const isRetryablePolymarketProxyError = (error) => {
  const status = Number(error?.status || error?.response?.status);
  if (Number.isFinite(status) && status > 0) {
    if (status === 401) return false;
    if (status === 403 || status === 408 || status === 429) return true;
    return status >= 500;
  }
  const code = String(error?.code || '').toUpperCase();
  if (!code) return true;
  if (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'EAI_AGAIN'
  ) {
    return true;
  }
  if (code.includes('TLS') || code.includes('CERT')) {
    return true;
  }
  return true;
};

const extractCloudflareHtmlText = (payload) => {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload?.error === 'string') return payload.error;
  if (typeof payload?.message === 'string') return payload.message;
  return '';
};

const looksLikeCloudflareBlockPage = (payload) => {
  const body = extractCloudflareHtmlText(payload);
  if (!body) return false;
  const lower = body.toLowerCase();
  if (!lower.includes('cloudflare')) return false;
  return (
    lower.includes('ray id') ||
    lower.includes('cf-error-details') ||
    lower.includes('attention required') ||
    lower.includes('sorry, you have been blocked')
  );
};

const polymarketAxiosGet = async (url, config = {}) => {
  const attempts = POLYMARKET_PROXY_REQUEST_ATTEMPTS;
  let lastError = null;
  let attemptedDirect = false;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const proxy = getClobProxyConfig();
    const httpsAgent = proxy ? getPolymarketHttpsAgent(proxy) : null;
    const usingProxy = Boolean(proxy && httpsAgent);
    if (!usingProxy && attemptedDirect) {
      break;
    }

    try {
      return await axiosGet(url, {
        ...config,
        ...(usingProxy ? { httpsAgent } : {}),
      });
    } catch (error) {
      lastError = error;
      attemptedDirect = attemptedDirect || !usingProxy;
      if (usingProxy) {
        try {
          const status = Number(error?.response?.status);
          if (status === 403 && looksLikeCloudflareBlockPage(error?.response?.data)) {
            notePolymarketProxyFailure(proxy, { reason: 'cloudflare_403' });
          }
        } catch {
          // ignore
        }
      }
      if (attempt >= attempts || !isRetryablePolymarketProxyError(error)) {
        throw error;
      }
    }
  }

  throw lastError || new Error('Polymarket request failed.');
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
  const response = await polymarketAxiosGet(`${CLOB_HOST}/time`, {
    params: buildGeoParams(),
    headers: withClobUserAgent(),
  });
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
    ...withClobUserAgent(),
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

  const response = await polymarketAxiosGet(`${CLOB_HOST}${endpoint}`, {
    headers,
    params,
  });
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

const normalizeDataApiPosition = (position) => {
  if (!position || typeof position !== 'object') {
    return null;
  }
  const proxyWalletRaw = position?.proxyWallet ? String(position.proxyWallet).trim() : '';
  const proxyWallet = isValidHexAddress(proxyWalletRaw) ? proxyWalletRaw : null;
  const assetId = position?.asset ? String(position.asset).trim() : null;
  const conditionId = position?.conditionId ? String(position.conditionId).trim() : null;
  const outcome = position?.outcome ? String(position.outcome).trim() : null;
  const quantity = position?.size !== undefined && position?.size !== null ? Number(position.size) : null;
  const avgCost = position?.avgPrice !== undefined && position?.avgPrice !== null ? Number(position.avgPrice) : null;
  const currentPrice = position?.curPrice !== undefined && position?.curPrice !== null ? Number(position.curPrice) : null;
  const currentValue = position?.currentValue !== undefined && position?.currentValue !== null ? Number(position.currentValue) : null;

  if (!assetId || !conditionId || !Number.isFinite(quantity) || quantity <= 0) {
    return null;
  }

  return {
    proxyWallet,
    asset_id: assetId,
    market: conditionId,
    outcome,
    quantity,
    avgCost: Number.isFinite(avgCost) ? avgCost : null,
    currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
    currentValue: Number.isFinite(currentValue) ? currentValue : null,
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

const fetchDataApiPositionsSnapshot = async ({ userAddress }) => {
  const normalizedUser = String(userAddress || '').trim();
  if (!isValidHexAddress(normalizedUser)) {
    throw new Error('Polymarket address is missing or invalid.');
  }

  const response = await polymarketAxiosGet(`${DATA_API_HOST}/positions`, {
    headers: POLYMARKET_DATA_API_USER_AGENT ? { 'User-Agent': POLYMARKET_DATA_API_USER_AGENT } : undefined,
    params: {
      user: normalizedUser,
    },
  });

  const data = Array.isArray(response?.data) ? response.data : [];
  const normalizedPositions = [];
  const seen = new Set();
  for (const raw of data) {
    const mapped = normalizeDataApiPosition(raw);
    if (!mapped?.asset_id || seen.has(mapped.asset_id)) {
      continue;
    }
    seen.add(mapped.asset_id);
    normalizedPositions.push(mapped);
  }

  return {
    positions: normalizedPositions,
    rawCount: data.length,
    proxyWallet: normalizedPositions.find((row) => row?.proxyWallet)?.proxyWallet || null,
  };
};

const fetchDataApiTradesPage = async ({ userAddress, offset, limit, takerOnly }) => {
  const normalizedUser = String(userAddress || '').trim();
  if (!isValidHexAddress(normalizedUser)) {
    throw new Error('Polymarket address is missing or invalid.');
  }

  const cleanedOffset = Number.isFinite(Number(offset)) && Number(offset) >= 0 ? Math.floor(Number(offset)) : 0;
  const cleanedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 100;
  // The public data API appears to cap responses around ~1000 rows even if a larger limit is requested.
  // Keep our page size within that cap so offset pagination works and we don't prematurely stop backfills.
  const maxLimit = 1000;
  const finalLimit = Math.max(1, Math.min(cleanedLimit, maxLimit));

  const takerOnlyFlag = parseBooleanEnvDefault(takerOnly, false);

  const response = await polymarketAxiosGet(`${DATA_API_HOST}/trades`, {
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
  return {
    trades: normalizedTrades,
    rawCount: data.length,
    nextOffset: cleanedOffset + finalLimit,
    requestedLimit: finalLimit,
  };
};

const fetchMarket = async (conditionId) => {
  if (!conditionId) {
    return null;
  }
  const cleaned = String(conditionId).trim();
  if (!cleaned) {
    return null;
  }
  const response = await polymarketAxiosGet(`${CLOB_HOST}/markets/${cleaned}`, {
    params: buildGeoParams(),
    headers: withClobUserAgent(),
  });
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
      const trimmed = payload.trim();
      if (!trimmed) return null;
      const lower = trimmed.toLowerCase();
      if (lower.includes('cloudflare') && (lower.includes('ray id') || lower.includes('sorry, you have been blocked') || lower.includes('attention required'))) {
        return 'Cloudflare blocked request';
      }
      if (trimmed.length > 500) {
        return `${trimmed.slice(0, 500)}…`;
      }
      return trimmed;
    }
    if (payload?.error) {
      const msg = String(payload.error).trim();
      if (!msg) return null;
      if (msg.length > 500) return `${msg.slice(0, 500)}…`;
      return msg;
    }
    if (payload?.message) {
      const msg = String(payload.message).trim();
      if (!msg) return null;
      if (msg.length > 500) return `${msg.slice(0, 500)}…`;
      return msg;
    }
    try {
      const json = JSON.stringify(payload);
      if (json.length > 500) return `${json.slice(0, 500)}…`;
      return json;
    } catch (stringifyError) {
      return null;
    }
  })();
  if (Number.isFinite(status) && status > 0) {
    if ((status === 401 || status === 403) && apiMessage) {
      const hint = GEO_BLOCK_TOKEN ? '' : ' (if you are geoblocked, set POLYMARKET_GEO_BLOCK_TOKEN)';
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

  sanitizePolymarketSubdoc(portfolio);

  const poly = portfolio.polymarket || {};
  const requestedMode = String(options?.mode || '').trim().toLowerCase();

  const envExecutionMode = getPolymarketExecutionMode();
  const portfolioExecutionMode = normalizeExecutionModeOverride(poly.executionMode) || 'paper';
  const executionMode = envExecutionMode === 'live' ? portfolioExecutionMode : 'paper';
  let executionEnabled = executionMode === 'live';
  let executionDisabledReason = null;
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
  const funderEnv = String(process.env.POLYMARKET_FUNDER_ADDRESS || process.env.POLYMARKET_PROFILE_ADDRESS || '').trim();
  const funderAddressCandidate = isValidHexAddress(funderEnv) ? funderEnv : authAddress;
  const isSelfCopyLiveExecution =
    executionEnabled &&
    Boolean(address && isValidHexAddress(address)) &&
    Boolean(funderAddressCandidate && isValidHexAddress(funderAddressCandidate)) &&
    address.toLowerCase() === funderAddressCandidate.toLowerCase();

  if (isSelfCopyLiveExecution) {
    executionEnabled = false;
    executionDisabledReason =
      executionDisabledReason ||
      'Self-copy guard: maker address matches the execution wallet. Set a different maker address to copy (do not use your own funded wallet).';
    void recordStrategyLog({
      strategyId: portfolio.strategy_id,
      userId: portfolio.userId,
      strategyName: portfolio.name,
      level: 'error',
      message: 'Polymarket live execution disabled (self-copy guard)',
      details: {
        provider: 'polymarket',
        mode: requestedMode || 'auto',
        envExecutionMode,
        portfolioExecutionMode,
        makerAddress: address,
        funderAddress: funderAddressCandidate,
      },
    }).catch(() => {});
  }
  const sizeToBudget = parseBoolean(poly.sizeToBudget, parseBoolean(process.env.POLYMARKET_SIZE_TO_BUDGET, false));
  const seedFromPositions = parseBoolean(
    poly.seedFromPositions,
    parseBoolean(process.env.POLYMARKET_SIZE_TO_BUDGET_SEED_FROM_POSITIONS, false)
  );
  const liveRebalancePreflightEnabled = parseBoolean(process.env.POLYMARKET_LIVE_REBALANCE_PREFLIGHT, false);
  const liveRebalanceDebugEnabled = parseBoolean(process.env.POLYMARKET_LIVE_REBALANCE_DEBUG, false);
  const liveHoldingsSourceSetting = normalizeLiveHoldingsSourceSetting(process.env.POLYMARKET_LIVE_HOLDINGS_SOURCE);
  const liveHoldingsReconcilePortfolio = parseBooleanEnvDefault(
    process.env.POLYMARKET_LIVE_RECONCILE_PORTFOLIO,
    true
  );
  const previousLiveExecutionOk = parseBooleanEnvDefault(poly?.lastLiveExecutionOk, false);

  const makerStateMissing = (() => {
    if (!sizeToBudget) {
      return false;
    }
    const state = poly?.sizingState || null;
    const holdings = Array.isArray(state?.holdings) ? state.holdings : [];
    const makerCash = toNumber(state?.makerCash, null);
    return !Number.isFinite(makerCash) || holdings.length === 0;
  })();

  const sizingStateMissing = POLYMARKET_SIZE_TO_BUDGET_BOOTSTRAP_ENABLED && makerStateMissing;

  // Only auto-bootstrap sizing state after a user has opted into importing positions via backfill.
  // If the user created the strategy with backfill disabled, stay in incremental mode and fall back
  // to cash-capped copy sizing until a backfill is explicitly run.
  const bootstrapBackfill = sizingStateMissing && requestedMode !== 'backfill' && Boolean(poly.backfilledAt);

  const mode = requestedMode === 'backfill'
    ? 'backfill'
    : (poly.backfillPending || bootstrapBackfill)
      ? 'backfill'
      : 'incremental';

  const shouldSeedFromPositionsSnapshot =
    mode === 'incremental' && sizeToBudget === true && seedFromPositions === true && makerStateMissing === true;

  const allowLiveRebalanceDuringBackfill = parseBoolean(
    options?.allowLiveRebalanceDuringBackfill,
    parseBoolean(process.env.POLYMARKET_BACKFILL_LIVE_REBALANCE, false)
  );

  if (mode !== 'incremental') {
    const allowBackfillLiveRebalance =
      mode === 'backfill' &&
      requestedMode === 'backfill' &&
      allowLiveRebalanceDuringBackfill === true &&
      sizeToBudget === true;
    if (!allowBackfillLiveRebalance && executionEnabled) {
      executionEnabled = false;
      executionDisabledReason =
        executionDisabledReason ||
        'Backfill sync: live execution disabled (set POLYMARKET_BACKFILL_LIVE_REBALANCE=true to allow the final size-to-budget rebalance).';
    }
  }

  const resetPortfolio = mode === 'backfill' ? options?.reset !== false : false;

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

  const recordEquitySnapshotIfPossible = async ({ stocks, retainedCash } = {}) => {
    if (mongoose.connection.readyState !== 1) {
      return null;
    }
    const userId = portfolio.userId ? String(portfolio.userId) : '';
    const strategyId = portfolio.strategy_id ? String(portfolio.strategy_id) : '';
    if (!userId || !strategyId) {
      return null;
    }

    const holdingsMarketValue = roundToTwo(Math.max(0, computeHoldingsMarketValue(stocks)));
    const retainedCashValue = roundToTwo(Math.max(0, toNumber(retainedCash, 0)));
    if (holdingsMarketValue === null || retainedCashValue === null) {
      return null;
    }
    const equityValue = roundToTwo(holdingsMarketValue + retainedCashValue);
    if (equityValue === null) {
      return null;
    }

    try {
      await StrategyEquitySnapshot.create({
        strategy_id: strategyId,
        userId,
        portfolioId: portfolio?._id || null,
        strategyName: portfolio.name || null,
        equityValue,
        holdingsMarketValue,
        retainedCash: retainedCashValue,
        cashLimit: toNumber(portfolio.cashLimit, null),
        pnlValue: toNumber(portfolio.pnlValue, null),
      });
      return equityValue;
    } catch (error) {
      console.error('[Polymarket] Failed to record equity snapshot:', error.message);
      return null;
    }
  };

  const refreshHoldingsPrices = async (stocks = []) => {
    if (!Array.isArray(stocks) || !stocks.length) {
      return [];
    }

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

    for (const entry of stocks) {
      const conditionId = entry?.market ? String(entry.market) : null;
      const assetId = entry?.asset_id ? String(entry.asset_id) : null;
      if (!conditionId || !assetId) {
        continue;
      }
      const market = await ensureMarket(conditionId);
      if (!market) {
        continue;
      }
      const index = buildMarketTokenPriceIndex(market);
      const tokenInfo = index.get(assetId);
      if (tokenInfo && tokenInfo.price !== null) {
        entry.currentPrice = tokenInfo.price;
      }
      if (tokenInfo && tokenInfo.outcome && !entry.outcome) {
        entry.outcome = tokenInfo.outcome;
      }
      if (market?.question && entry?.symbol && String(entry.symbol).startsWith('PM:')) {
        const question = String(market.question).trim();
        if (question) {
          entry.symbol = `PM: ${question.slice(0, 42)}${question.length > 42 ? '…' : ''} (${entry.outcome || 'Outcome'})`;
        }
      }
    }

    return stocks;
  };

  const maxTradesBackfill = bootstrapBackfill
    ? Math.min(MAX_TRADES_PER_BACKFILL, POLYMARKET_SIZE_TO_BUDGET_BOOTSTRAP_MAX_TRADES)
    : MAX_TRADES_PER_BACKFILL;

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
        maxTrades: maxTradesBackfill,
        bootstrap: bootstrapBackfill,
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
    let noProgressPages = 0;
    const NO_PROGRESS_PAGES_LIMIT = 3;

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
	      while (nextToken !== null && pendingTrades.length < maxTradesBackfill) {
	        pagesFetched += 1;
	        const shouldLogPage = pagesFetched === 1 || pagesFetched % POLYMARKET_PROGRESS_LOG_EVERY_PAGES === 0;
	        const cursorBefore = nextToken;
          const tradesBefore = pendingTrades.length;
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
	        let rawCount = null;
	        try {
	          if (tradeSource === 'data-api') {
	            const remaining = Math.max(0, maxTradesBackfill - pendingTrades.length);
	            requestedLimit = Math.max(1, Math.min(remaining, 10000));
	            const fetched = await fetchDataApiTradesPage({
	              userAddress: address,
	              offset: cursorBefore,
	              limit: requestedLimit,
	              takerOnly: dataApiTakerOnly,
	            });
	            trades = Array.isArray(fetched?.trades) ? fetched.trades : [];
	            requestedLimit = fetched?.requestedLimit ?? requestedLimit;
	            rawCount = fetched?.rawCount !== undefined && fetched?.rawCount !== null ? Number(fetched.rawCount) : null;
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
	          if (pendingTrades.length >= maxTradesBackfill) {
	            break;
	          }
	          pushTrade(trade);
	        }
          const addedTrades = pendingTrades.length - tradesBefore;
          if (addedTrades <= 0) {
            noProgressPages += 1;
            if (noProgressPages >= NO_PROGRESS_PAGES_LIMIT) {
              await recordStrategyLog({
                strategyId: portfolio.strategy_id,
                userId: portfolio.userId,
                strategyName: portfolio.name,
                level: 'warn',
                message: 'Polymarket backfill stalled (no new trades); stopping early',
                details: {
                  provider: 'polymarket',
                  mode,
                  tradeSource,
                  page: pagesFetched,
                  cursor: tradeSource === 'data-api' ? `offset:${cursorBefore}` : cursorBefore,
                  tradesInPage: trades.length,
                  tradesCollected: pendingTrades.length,
                  noProgressPages,
                  hint: 'The data API may be repeating pages for large offsets; try lowering maxTrades or switching to CLOB L2 trades source.',
                },
              });
              nextToken = null;
            }
          } else {
            noProgressPages = 0;
          }

	        if (tradeSource === 'data-api' && requestedLimit !== null) {
	          const pageCount = Number.isFinite(rawCount) ? rawCount : trades.length;
	          if (pageCount < requestedLimit) {
	            nextToken = null;
	          }
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
	        let rawCount = null;
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
	          rawCount = fetched?.rawCount !== undefined && fetched?.rawCount !== null ? Number(fetched.rawCount) : null;
	          const nextOffset =
	            fetched?.nextOffset !== undefined && fetched?.nextOffset !== null ? Number(fetched.nextOffset) : null;
	          nextToken = Number.isFinite(nextOffset) ? nextOffset : null;
	          requestedLimit = fetched?.requestedLimit ?? requestedLimit;
	          if (requestedLimit !== null) {
	            const pageCount = Number.isFinite(rawCount) ? rawCount : trades.length;
	            if (pageCount < requestedLimit) {
	              nextToken = null;
	            }
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
    if (bootstrapBackfill) {
      void recordStrategyLog({
        strategyId: portfolio.strategy_id,
        userId: portfolio.userId,
        strategyName: portfolio.name,
        message: 'Polymarket size-to-budget bootstrap backfill started',
        details: {
          provider: 'polymarket',
          mode: 'backfill',
          address,
          reason: 'missing_sizing_state',
          maxTrades: maxTradesBackfill,
        },
      });
    }
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
      ...snapshotPolymarket(portfolio.polymarket),
      lastTradeMatchTime: anchorMatchTime,
      lastTradeId: null,
    };
  }

  if (!pendingTrades.length && !shouldSeedFromPositionsSnapshot) {
    if (mode === 'backfill') {
      portfolio.polymarket = {
        ...snapshotPolymarket(portfolio.polymarket),
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
    const currentHoldings = Array.isArray(portfolio.stocks) ? portfolio.stocks : [];
    await refreshHoldingsPrices(currentHoldings);
    portfolio.lastRebalancedAt = now;
    portfolio.nextRebalanceAt = computeNextRebalanceAt(normalizeRecurrence(portfolio.recurrence), now);
    portfolio.rebalanceCount = toNumber(portfolio.rebalanceCount, 0) + 1;
    portfolio.lastPerformanceComputedAt = now;
    sanitizePolymarketSubdoc(portfolio);
    await portfolio.save();
    await recordEquitySnapshotIfPossible({
      stocks: currentHoldings,
      retainedCash: portfolio.retainedCash,
    });
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

  const pickNumber = (value) => {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };

  const portfolioHoldingsByAssetId = new Map();
  if (!resetPortfolio) {
    (portfolio.stocks || []).forEach((stock) => {
      const assetId = stock?.asset_id ? String(stock.asset_id) : stock?.symbol ? String(stock.symbol) : null;
      if (!assetId) {
        return;
      }
      portfolioHoldingsByAssetId.set(assetId, stock);
    });
  }

  let holdingsByAssetId = portfolioHoldingsByAssetId;
  let liveHoldingsUsed = false;
  const liveHoldings = {
    enabled: executionMode === 'live' && mode === 'incremental' && liveHoldingsReconcilePortfolio === true,
    sourceSetting: liveHoldingsSourceSetting,
    previousLiveExecutionOk,
    shouldFetch: null,
    used: false,
    reconciledPortfolio: false,
    userAddress: null,
    proxyWallet: null,
    rawCount: null,
    positionsCount: null,
    holdingsValue: null,
    onchainUsdcBalance: null,
    onchainUsdcBalanceError: null,
    portfolioPositionsCount: portfolioHoldingsByAssetId.size,
    portfolioHoldingsValue: roundToTwo(
      computeHoldingsMarketValue(Array.isArray(portfolio.stocks) ? portfolio.stocks : [])
    ),
    error: null,
  };

  const shouldFetchLiveHoldings =
    liveHoldings.enabled &&
    liveHoldingsSourceSetting === 'data-api' &&
    previousLiveExecutionOk !== true;
  liveHoldings.shouldFetch = shouldFetchLiveHoldings;

  if (shouldFetchLiveHoldings) {
    const userAddress = funderAddressCandidate || authAddress;
    if (!userAddress || !isValidHexAddress(userAddress)) {
      liveHoldings.error =
        'Live holdings reconciliation enabled but no valid POLYMARKET_FUNDER_ADDRESS/POLYMARKET_AUTH_ADDRESS is available.';
    } else {
      liveHoldings.userAddress = userAddress;
      try {
        const snapshot = await fetchDataApiPositionsSnapshot({ userAddress });
        const positions = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
        liveHoldings.proxyWallet = snapshot?.proxyWallet || null;
        liveHoldings.rawCount = toNumber(snapshot?.rawCount, null);

        const liveStocks = positions
          .map((pos) => {
            const market = pos?.market ? String(pos.market) : null;
            const asset_id = pos?.asset_id ? String(pos.asset_id) : null;
            if (!asset_id) return null;
            const outcome = pos?.outcome ? String(pos.outcome) : null;
            const quantity = roundToDecimals(Math.max(0, toNumber(pos?.quantity, 0)), 6) ?? 0;
            if (!quantity) return null;
            const currentPrice = toNumber(pos?.currentPrice, null);
            const avgCost = toNumber(pos?.avgCost, null);
            const symbol = market ? `PM:${String(market).slice(0, 10)}:${outcome || 'OUTCOME'}` : `PM:${asset_id}`;
            return {
              symbol,
              market,
              asset_id,
              outcome,
              quantity,
              avgCost: avgCost !== null ? avgCost : currentPrice,
              currentPrice,
            };
          })
          .filter(Boolean);

        const liveHoldingsByAssetId = new Map();
        liveStocks.forEach((row) => {
          const assetId = row?.asset_id ? String(row.asset_id) : null;
          if (!assetId) return;
          liveHoldingsByAssetId.set(assetId, row);
        });

        holdingsByAssetId = liveHoldingsByAssetId;
        liveHoldingsUsed = true;
        liveHoldings.used = true;
        liveHoldings.positionsCount = liveStocks.length;
        liveHoldings.holdingsValue = roundToTwo(computeHoldingsMarketValue(liveStocks));

        if (liveHoldingsReconcilePortfolio) {
          portfolio.stocks = liveStocks;
          liveHoldings.reconciledPortfolio = true;

          try {
            const usdc = await getPolymarketOnchainUsdcBalance(userAddress);
            liveHoldings.onchainUsdcBalance = roundToDecimals(Math.max(0, toNumber(usdc?.balance, 0)), 6);
            const cap =
              pickNumber(portfolio.cashLimit) ?? pickNumber(portfolio.budget) ?? pickNumber(portfolio.initialInvestment);
            const nextCash =
              liveHoldings.onchainUsdcBalance !== null && cap !== null
                ? Math.min(liveHoldings.onchainUsdcBalance, Math.max(0, cap))
                : liveHoldings.onchainUsdcBalance;
            if (nextCash !== null) {
              portfolio.retainedCash = nextCash;
              portfolio.cashBuffer = nextCash;
            }
          } catch (error) {
            liveHoldings.onchainUsdcBalanceError = formatAxiosError(error);
          }

          portfolio.polymarket = {
            ...snapshotPolymarket(portfolio.polymarket),
            lastLiveHoldingsSyncAt: now.toISOString(),
            lastLiveHoldingsSource: 'data-api',
            lastLiveHoldingsUserAddress: userAddress,
            lastLiveHoldingsProxyWallet: liveHoldings.proxyWallet,
          };
        }
      } catch (error) {
        liveHoldings.error = formatAxiosError(error);
      }
    }
  }

  const makerStateEnabled = sizeToBudget === true;
  const makerHoldingsByAssetId = new Map();
  let makerCash = 0;
  let makerStateAvailable = false;
  if (makerStateEnabled) {
    if (!resetPortfolio) {
      const state = poly?.sizingState || {};
      const holdings = Array.isArray(state.holdings) ? state.holdings : [];
      const storedCash = toNumber(state.makerCash, null);
      if (Number.isFinite(storedCash) && holdings.length) {
        makerCash = storedCash;
        holdings.forEach((row) => {
          const assetId = row?.asset_id ? String(row.asset_id) : null;
          if (!assetId) {
            return;
          }
          makerHoldingsByAssetId.set(assetId, {
            market: row?.market ? String(row.market) : null,
            asset_id: assetId,
            outcome: row?.outcome ? String(row.outcome) : null,
            quantity: toNumber(row?.quantity, 0),
            avgCost: toNumber(row?.avgCost, null),
            currentPrice: toNumber(row?.currentPrice, null),
          });
        });
        makerStateAvailable = true;
      }
    }
    if (resetPortfolio) {
      makerStateAvailable = true;
    }
  }

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
  let sizingMeta = null;
  let tradeScale = null;
  let seededFromPositionsSnapshot = false;

  const fetchMakerValueSnapshot = async () => {
    const positionsSnapshot = await fetchDataApiPositionsSnapshot({ userAddress: address });
    const proxyWallet = positionsSnapshot?.proxyWallet || address;
    const cashSnapshot = await getPolymarketOnchainUsdcBalance(proxyWallet);
    const makerCashValue = Math.max(0, toNumber(cashSnapshot?.balance, 0));
    const holdingsValue = (positionsSnapshot?.positions || []).reduce((sum, pos) => {
      const currentValue = toNumber(pos?.currentValue, null);
      if (currentValue !== null) {
        return sum + Math.max(0, currentValue);
      }
      const qty = Math.max(0, toNumber(pos?.quantity, 0));
      const px = toNumber(pos?.currentPrice, null);
      if (!qty || px === null) {
        return sum;
      }
      return sum + qty * px;
    }, 0);

    return {
      positions: Array.isArray(positionsSnapshot?.positions) ? positionsSnapshot.positions : [],
      proxyWallet,
      chainId: cashSnapshot?.chainId ?? null,
      makerCash: makerCashValue,
      makerHoldingsValue: holdingsValue,
      makerValue: makerCashValue + holdingsValue,
      positionsCount: Array.isArray(positionsSnapshot?.positions) ? positionsSnapshot.positions.length : 0,
      source: 'data-api+onchain',
    };
  };

  if (makerStateEnabled && !makerStateAvailable && seedFromPositions && mode === 'incremental') {
    const sizingBudget = (() => {
      const cashLimit = pickNumber(portfolio.cashLimit);
      if (cashLimit !== null) {
        return Math.max(0, cashLimit);
      }
      const budget = pickNumber(portfolio.budget);
      if (budget !== null) {
        return Math.max(0, budget);
      }
      const initialInvestment = pickNumber(portfolio.initialInvestment);
      if (initialInvestment !== null) {
        return Math.max(0, initialInvestment);
      }
      return Math.max(0, toNumber(startingCash, 0));
    })();

    try {
      const snapshot = await fetchMakerValueSnapshot();
      const makerValue = toNumber(snapshot?.makerValue, null);
      const scale = makerValue && makerValue > 0 ? sizingBudget / makerValue : 0;

      const positions = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
      const shouldSeedHoldings = positions.length > 0 || processedTrades.length === 0;

      if (shouldSeedHoldings) {
        makerCash = Math.max(0, toNumber(snapshot?.makerCash, 0));
        makerHoldingsByAssetId.clear();
        positions.forEach((pos) => {
          const assetId = pos?.asset_id ? String(pos.asset_id) : null;
          if (!assetId) {
            return;
          }
          makerHoldingsByAssetId.set(assetId, {
            market: pos?.market ? String(pos.market) : null,
            asset_id: assetId,
            outcome: pos?.outcome ? String(pos.outcome) : null,
            quantity: toNumber(pos?.quantity, 0),
            avgCost: toNumber(pos?.avgCost, null),
            currentPrice: toNumber(pos?.currentPrice, null),
          });
        });
        makerStateAvailable = true;
        seededFromPositionsSnapshot = true;
      } else if (Number.isFinite(scale) && scale > 0) {
        tradeScale = scale;
      }

      sizingMeta = {
        method: seededFromPositionsSnapshot ? 'positions-snapshot' : 'trade-scale',
        source: snapshot?.source || null,
        proxyWallet: snapshot?.proxyWallet || null,
        chainId: snapshot?.chainId ?? null,
        makerValue,
        makerCash: snapshot?.makerCash ?? null,
        makerHoldingsValue: snapshot?.makerHoldingsValue ?? null,
        positionsCount: snapshot?.positionsCount ?? null,
        sizingBudget,
        scale,
      };
    } catch (error) {
      sizingMeta = {
        method: 'positions-snapshot',
        source: 'data-api+onchain',
        sizingBudget,
        error: formatAxiosError(error),
      };
      tradeScale = null;
    }
  }
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
    rebalance: [],
  };

  if (makerStateEnabled && !makerStateAvailable) {
    void recordStrategyLog({
      strategyId: portfolio.strategy_id,
      userId: portfolio.userId,
      strategyName: portfolio.name,
      level: 'warn',
      message: 'Polymarket size-to-budget enabled but sizing state is missing; falling back to cash-capped copy',
      details: {
        provider: 'polymarket',
        mode,
        address,
        hint: 'Run a backfill with reset to seed sizing state from full trade history.',
      },
    });
  }

  const extractOrderMeta = (result) => {
    const response = result?.response;
    if (!response || typeof response !== 'object') {
      return { orderId: null, status: null, txHashes: null, success: null, error: null };
    }
    const orderId = response.orderID || response.orderId || response.order_id || response.id || null;
    const status = response.status || null;
    const success = response.success !== undefined ? Boolean(response.success) : null;
    const error = (() => {
      const raw = response.errorMsg || response.error || response.message || null;
      if (!raw) return null;
      if (typeof raw === 'string') return raw.trim() || null;
      try {
        const json = JSON.stringify(raw);
        return json.length > 500 ? `${json.slice(0, 500)}…` : json;
      } catch {
        return String(raw);
      }
    })();
    const txHashes = Array.isArray(response.transactionsHashes)
      ? response.transactionsHashes
      : Array.isArray(response.transactions)
        ? response.transactions
        : null;
    return { orderId, status, txHashes, success, error };
  };

		  const isRetryableExecutionError = (error) => {
		    const msg = String(formatAxiosError(error) || '').toLowerCase();
		    // "No match" typically means there's no liquidity to fill the market order; it's not transient.
	    if (msg.includes('no match')) {
	      return false;
	    }
	    const status = Number(error?.status || error?.response?.status);
	    if (!Number.isFinite(status) || status <= 0) {
	      return true;
	    }
    if (status === 408 || status === 429) {
      return true;
    }
    return status >= 500;
  };

  const isExecutionConfigError = (error) => {
    const status = Number(error?.status || error?.response?.status);
    if (status === 401 || status === 403) {
      return true;
    }
    const msg = String(error?.message || '').toLowerCase();
    return (
      msg.includes('polymarket execution is in paper mode') ||
      msg.includes('missing polymarket') ||
      msg.includes('missing pol') ||
      msg.includes('private key') ||
      msg.includes('private_key') ||
      msg.includes('does not match polymarket_private_key') ||
      msg.includes('private_key is invalid') ||
      msg.includes('polymarket_private_key is invalid') ||
      msg.includes('invalid polymarket') ||
      msg.includes('missing polymarket_* clob credentials') ||
      msg.includes('encrypted polymarket')
    );
  };

  let lastProcessedTrade = null;
  let processedCount = 0;
  let ignoredTradesCount = 0;
  let liveExecutionAbort = null;
  let liveExecutionConfigLogged = false;

  if (seededFromPositionsSnapshot) {
    ignoredTradesCount = processedTrades.length;
    if (processedTrades.length) {
      lastProcessedTrade = processedTrades[processedTrades.length - 1];
    }
  } else for (const trade of processedTrades) {
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
      if (tradeId) {
        lastProcessedTrade = trade;
        processedCount += 1;
      }
      continue;
    }

    const price = Math.max(0, Math.min(1, rawPrice));
    let size = Math.max(0, rawSize);
    if (!size) {
      tradeSummary.skipped.push({
        id: tradeId,
        reason: 'zero_size',
      });
      lastProcessedTrade = trade;
      processedCount += 1;
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
      if (makerStateEnabled && makerStateAvailable) {
        const cost = roundToDecimals(size * price, 6);
        makerCash = roundToDecimals(makerCash - (cost ?? 0), 6);

        const makerExisting = makerHoldingsByAssetId.get(assetId) || null;
        const makerQty = makerExisting ? toNumber(makerExisting.quantity, 0) : 0;
        const makerAvgCost = makerExisting && makerExisting.avgCost !== undefined && makerExisting.avgCost !== null
          ? toNumber(makerExisting.avgCost, null)
          : null;
        const newMakerQty = roundToDecimals(makerQty + size, 6);
        const newMakerAvgCost = (() => {
          if (!makerQty || makerAvgCost === null) {
            return price;
          }
          const totalCost = makerQty * makerAvgCost + size * price;
          return newMakerQty ? totalCost / newMakerQty : price;
        })();
        const makerEntry = makerExisting || {
          market: conditionId,
          asset_id: assetId,
          outcome,
          quantity: 0,
          currentPrice: price,
        };
        makerEntry.market = makerEntry.market || conditionId;
        makerEntry.asset_id = makerEntry.asset_id || assetId;
        makerEntry.outcome = makerEntry.outcome || outcome;
        makerEntry.currentPrice = toNumber(makerEntry.currentPrice, null) ?? price;
        makerEntry.quantity = newMakerQty;
        makerEntry.avgCost = roundToDecimals(newMakerAvgCost, 6);
        makerHoldingsByAssetId.set(assetId, makerEntry);

        tradeSummary.buys.push({
          id: tradeId,
          symbol,
          assetId,
          outcome,
          size,
          price,
          cost,
        });
        lastProcessedTrade = trade;
        processedCount += 1;
        continue;
      }

      if (tradeScale !== null && Number.isFinite(tradeScale) && tradeScale > 0) {
        size = Math.max(0, size * tradeScale);
      }

      const maxAffordable = price > 0 ? cash / price : 0;
      if (maxAffordable <= 0) {
        tradeSummary.skipped.push({
          id: tradeId,
          side,
          assetId,
          reason: 'insufficient_cash',
        });
        lastProcessedTrade = trade;
        processedCount += 1;
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
        lastProcessedTrade = trade;
        processedCount += 1;
        continue;
      }

      const cost = roundToDecimals(size * price, 6);

      let execution = null;
      if (executionEnabled) {
        try {
          execution = await executePolymarketMarketOrder({
            tokenID: assetId,
            side: 'BUY',
            amount: cost,
          });
        } catch (error) {
          if (isExecutionConfigError(error)) {
            executionEnabled = false;
            executionDisabledReason = formatAxiosError(error);
            if (!liveExecutionConfigLogged) {
              liveExecutionConfigLogged = true;
              await recordStrategyLog({
                strategyId: portfolio.strategy_id,
                userId: portfolio.userId,
                strategyName: portfolio.name,
                level: 'error',
                message: 'Polymarket live execution failed (configuration/auth error)',
                details: {
                  provider: 'polymarket',
                  mode,
                  error: executionDisabledReason,
                },
              });
            }
            liveExecutionAbort = executionDisabledReason;
            break;
          } else if (isRetryableExecutionError(error)) {
            liveExecutionAbort = String(formatAxiosError(error));
            tradeSummary.skipped.push({
              id: tradeId,
              side,
              assetId,
              reason: 'execution_retryable_error',
              error: liveExecutionAbort,
            });
            break;
          } else {
            tradeSummary.skipped.push({
              id: tradeId,
              side,
              assetId,
              reason: 'execution_failed',
              error: String(formatAxiosError(error)),
            });
            lastProcessedTrade = trade;
            processedCount += 1;
            continue;
          }
        }
      }

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
      if (execution) {
        const meta = extractOrderMeta(execution);
        tradeSummary.buys.push({
          id: tradeId,
          symbol,
          assetId,
          outcome,
          size,
          price,
          cost: roundToDecimals(cost, 6),
          execution: {
            mode: execution.mode,
            dryRun: execution.dryRun,
            orderId: meta.orderId,
            status: meta.status,
            txHashes: meta.txHashes,
          },
        });
      } else {
      tradeSummary.buys.push({
        id: tradeId,
        symbol,
        assetId,
        outcome,
        size,
        price,
        cost,
      });
      }
      lastProcessedTrade = trade;
      processedCount += 1;
    } else if (side === 'SELL') {
      if (makerStateEnabled && makerStateAvailable) {
        const makerExisting = makerHoldingsByAssetId.get(assetId) || null;
        const makerAvailable = makerExisting ? toNumber(makerExisting.quantity, 0) : 0;
        if (!makerAvailable || makerAvailable <= 0) {
          tradeSummary.skipped.push({
            id: tradeId,
            side,
            assetId,
            reason: 'no_maker_position',
          });
          lastProcessedTrade = trade;
          processedCount += 1;
          continue;
        }
        if (size > makerAvailable) {
          size = makerAvailable;
        }

        size = roundToDecimals(size, 6);
        if (!size || size <= 0) {
          tradeSummary.skipped.push({
            id: tradeId,
            side,
            assetId,
            reason: 'no_maker_position',
          });
          lastProcessedTrade = trade;
          processedCount += 1;
          continue;
        }

        const proceeds = roundToDecimals(size * price, 6);
        makerCash = roundToDecimals(makerCash + (proceeds ?? 0), 6);

        const newMakerQty = roundToDecimals(makerAvailable - size, 6);
        if (newMakerQty > 0) {
          makerExisting.quantity = newMakerQty;
          makerExisting.market = makerExisting.market || conditionId;
          makerExisting.asset_id = makerExisting.asset_id || assetId;
          makerExisting.outcome = makerExisting.outcome || outcome;
          makerExisting.currentPrice = toNumber(makerExisting.currentPrice, null) ?? price;
          makerHoldingsByAssetId.set(assetId, makerExisting);
        } else {
          makerHoldingsByAssetId.delete(assetId);
        }

        tradeSummary.sells.push({
          id: tradeId,
          symbol,
          assetId,
          outcome,
          size,
          price,
          proceeds,
        });
        lastProcessedTrade = trade;
        processedCount += 1;
        continue;
      }

      if (tradeScale !== null && Number.isFinite(tradeScale) && tradeScale > 0) {
        size = Math.max(0, size * tradeScale);
      }

      const available = currentQty;
      if (!available || available <= 0) {
        tradeSummary.skipped.push({
          id: tradeId,
          side,
          assetId,
          reason: 'no_position',
        });
        lastProcessedTrade = trade;
        processedCount += 1;
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
        lastProcessedTrade = trade;
        processedCount += 1;
        continue;
      }

      const proceeds = roundToDecimals(size * price, 6);

      let execution = null;
      if (executionEnabled) {
        try {
          execution = await executePolymarketMarketOrder({
            tokenID: assetId,
            side: 'SELL',
            amount: size,
          });
        } catch (error) {
          if (isExecutionConfigError(error)) {
            executionEnabled = false;
            executionDisabledReason = formatAxiosError(error);
            if (!liveExecutionConfigLogged) {
              liveExecutionConfigLogged = true;
              await recordStrategyLog({
                strategyId: portfolio.strategy_id,
                userId: portfolio.userId,
                strategyName: portfolio.name,
                level: 'error',
                message: 'Polymarket live execution failed (configuration/auth error)',
                details: {
                  provider: 'polymarket',
                  mode,
                  error: executionDisabledReason,
                },
              });
            }
            liveExecutionAbort = executionDisabledReason;
            break;
          } else if (isRetryableExecutionError(error)) {
            liveExecutionAbort = String(formatAxiosError(error));
            tradeSummary.skipped.push({
              id: tradeId,
              side,
              assetId,
              reason: 'execution_retryable_error',
              error: liveExecutionAbort,
            });
            break;
          } else {
            tradeSummary.skipped.push({
              id: tradeId,
              side,
              assetId,
              reason: 'execution_failed',
              error: String(formatAxiosError(error)),
            });
            lastProcessedTrade = trade;
            processedCount += 1;
            continue;
          }
        }
      }

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

      if (execution) {
        const meta = extractOrderMeta(execution);
        tradeSummary.sells.push({
          id: tradeId,
          symbol,
          assetId,
          outcome,
          size,
          price,
          proceeds: roundToDecimals(proceeds, 6),
          execution: {
            mode: execution.mode,
            dryRun: execution.dryRun,
            orderId: meta.orderId,
            status: meta.status,
            txHashes: meta.txHashes,
          },
        });
      } else {
      tradeSummary.sells.push({
        id: tradeId,
        symbol,
        assetId,
        outcome,
        size,
        price,
        proceeds,
      });
      }
      lastProcessedTrade = trade;
      processedCount += 1;
    } else {
      tradeSummary.skipped.push({
        id: tradeId,
        side,
        assetId,
        reason: 'unknown_side',
      });
      lastProcessedTrade = trade;
      processedCount += 1;
    }
  }

  let updatedStocks = [];
  let rebalancePlan = null;
  let executionPreflight = null;

  const applySizing = async () => {
    if (!makerStateEnabled || !makerStateAvailable) {
      return false;
    }

    // Refresh current prices for maker holdings.
    for (const [assetId, entry] of makerHoldingsByAssetId.entries()) {
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
    }

    const makerHoldings = Array.from(makerHoldingsByAssetId.values());
    const makerCashValue = Math.max(0, toNumber(makerCash, 0));
    const makerHoldingsValue = makerHoldings.reduce((acc, pos) => {
      const qty = Math.max(0, toNumber(pos.quantity, 0));
      const price = toNumber(pos.currentPrice, null);
      if (!qty || price === null) {
        return acc;
      }
      return acc + qty * price;
    }, 0);
    const makerValue = makerCashValue + makerHoldingsValue;
    const sizingBudget = (() => {
      const cashLimit = pickNumber(portfolio.cashLimit);
      if (cashLimit !== null) {
        return Math.max(0, cashLimit);
      }
      const budget = pickNumber(portfolio.budget);
      if (budget !== null) {
        return Math.max(0, budget);
      }
      const initialInvestment = pickNumber(portfolio.initialInvestment);
      if (initialInvestment !== null) {
        return Math.max(0, initialInvestment);
      }
      return Math.max(0, toNumber(startingCash, 0));
    })();
    const existingSizingState =
      poly?.sizingState && typeof poly.sizingState === 'object' ? poly.sizingState : {};
    const storedScale = toNumber(existingSizingState?.scale, null);
    const storedScaleBudget = toNumber(existingSizingState?.scaleBudget, null);
    const shouldResetScale =
      !Number.isFinite(storedScale) ||
      storedScale <= 0 ||
      storedScaleBudget === null ||
      Math.abs(storedScaleBudget - sizingBudget) > 1e-9;
    const computedScale = makerValue > 0 ? sizingBudget / makerValue : 0;
    const scale = shouldResetScale ? computedScale : storedScale;

    if (!Number.isFinite(scale) || scale <= 0) {
      sizingMeta = { makerValue, sizingBudget, scale };
      return false;
    }

    sizingMeta = { makerValue, sizingBudget, scale };
    cash = roundToDecimals(makerCashValue * scale, 6) ?? 0;

    updatedStocks = makerHoldings
      .map((pos) => {
        const market = pos.market ? String(pos.market) : null;
        const asset_id = pos.asset_id ? String(pos.asset_id) : null;
        const outcome = pos.outcome ? String(pos.outcome) : null;
        const avgCost = toNumber(pos.avgCost, null);
        const currentPrice = toNumber(pos.currentPrice, null);
        const quantity = roundToDecimals(Math.max(0, toNumber(pos.quantity, 0)) * scale, 6) ?? 0;
        if (!quantity || quantity <= 0) {
          return null;
        }
        const symbol = `PM:${String(market || '').slice(0, 10)}:${outcome || 'OUTCOME'}`;
        return {
          symbol,
          market,
          asset_id,
          outcome,
          avgCost: avgCost !== null ? avgCost : currentPrice,
          quantity,
          currentPrice,
          orderID: `poly-size-${String(asset_id || '').slice(-10)}`,
        };
      })
      .filter(Boolean);

    portfolio.polymarket = {
      ...snapshotPolymarket(portfolio.polymarket),
      sizingState: {
        makerCash: makerCashValue,
	        holdings: makerHoldings.map((pos) => ({
	          market: pos.market ? String(pos.market) : null,
	          asset_id: pos.asset_id ? String(pos.asset_id) : null,
	          outcome: pos.outcome ? String(pos.outcome) : null,
	          quantity: toNumber(pos.quantity, 0),
	          avgCost: toNumber(pos.avgCost, null),
	          currentPrice: toNumber(pos.currentPrice, null),
	        })),
        scale,
        scaleBudget: shouldResetScale ? sizingBudget : storedScaleBudget,
        scaleMakerValue: shouldResetScale ? makerValue : toNumber(existingSizingState?.scaleMakerValue, null),
        scaleSetAt: shouldResetScale
          ? now.toISOString()
          : existingSizingState?.scaleSetAt
            ? String(existingSizingState.scaleSetAt)
            : null,
        lastUpdatedAt: now.toISOString(),
      },
    };

    return true;
  };

  const didSize = await applySizing();

  if (!didSize) {
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

    updatedStocks = Array.from(holdingsByAssetId.values())
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
  }

  const executeSizeToBudgetRebalance = async () => {
    rebalancePlan = {
      minNotional: POLYMARKET_LIVE_REBALANCE_MIN_NOTIONAL,
      maxOrders: POLYMARKET_LIVE_REBALANCE_MAX_ORDERS,
      totalAssets: 0,
      nonZeroDeltas: 0,
      missingPrice: 0,
      belowMinNotional: 0,
      eligibleCandidates: 0,
      candidatesTrimmed: 0,
      plannedOrders: 0,
      attemptedOrders: 0,
      successfulOrders: 0,
      failedOrders: 0,
      reason: null,
      largestBelowMinNotional: null,
    };

    if (!executionEnabled || !makerStateEnabled || !didSize || liveExecutionAbort) {
      rebalancePlan.reason = 'execution_disabled_or_not_sized';
      return;
    }
    if (!updatedStocks.length && !holdingsByAssetId.size) {
      rebalancePlan.reason = 'no_positions';
      return;
    }

    if (liveRebalancePreflightEnabled) {
      const preflight = {
        ok: false,
        primary: null,
        source: null,
        chainId: null,
        address: null,
        collateral: null,
        spender: null,
        balance: null,
        allowance: null,
        onchain: null,
        clob: null,
      };

      try {
        const info = await getPolymarketBalanceAllowance();
        const onchain = {
          ok: true,
          source: info?.source || null,
          chainId: info?.chainId ?? null,
          address: info?.address ?? null,
          funderAddress: info?.funderAddress ?? null,
          authAddress: info?.authAddress ?? null,
          collateral: info?.collateral ?? null,
          spender: info?.spender ?? null,
          balance: info?.balance ?? null,
          allowance: info?.allowance ?? null,
        };
        preflight.onchain = onchain;
        preflight.ok = true;
        preflight.primary = 'onchain';
        preflight.source = onchain.source;
        preflight.chainId = onchain.chainId;
        preflight.address = onchain.address;
        preflight.collateral = onchain.collateral;
        preflight.spender = onchain.spender;
        preflight.balance = onchain.balance;
        preflight.allowance = onchain.allowance;
      } catch (error) {
        preflight.onchain = {
          ok: false,
          error: formatAxiosError(error),
        };
      }

      if (typeof getPolymarketClobBalanceAllowance === 'function') {
        try {
          const info = await getPolymarketClobBalanceAllowance();
          preflight.clob = {
            ok: true,
            source: info?.source || 'clob-l2',
            host: info?.host ?? null,
            chainId: info?.chainId ?? null,
            signatureType: info?.signatureType ?? null,
            funderAddress: info?.funderAddress ?? null,
            authAddress: info?.authAddress ?? null,
            geoTokenSet: info?.geoTokenSet ?? null,
            balance: info?.balance ?? null,
            allowance: info?.allowance ?? null,
            raw: info?.raw ?? null,
          };
          if (!preflight.ok) {
            preflight.ok = true;
            preflight.primary = 'clob';
            preflight.source = preflight.clob.source;
            preflight.chainId = preflight.clob.chainId;
            preflight.balance = preflight.clob.balance;
            preflight.allowance = preflight.clob.allowance;
          }
        } catch (error) {
          preflight.clob = {
            ok: false,
            error: formatAxiosError(error),
          };
        }
      }

      executionPreflight = preflight;
    }

    const targetByAssetId = new Map(
      updatedStocks
        .map((row) => {
          const assetId = row?.asset_id ? String(row.asset_id) : null;
          if (!assetId) {
            return null;
          }
          return [assetId, row];
        })
        .filter(Boolean)
    );

    const candidates = [];
    const assetIds = new Set([...holdingsByAssetId.keys(), ...targetByAssetId.keys()]);
    rebalancePlan.totalAssets = assetIds.size;
    for (const assetId of assetIds) {
      const current = holdingsByAssetId.get(assetId) || null;
      const target = targetByAssetId.get(assetId) || null;
      const currentQty = Math.max(0, toNumber(current?.quantity, 0));
      const targetQty = Math.max(0, toNumber(target?.quantity, 0));
      const deltaQty = roundToDecimals(targetQty - currentQty, 6) ?? 0;
      if (!deltaQty) {
        continue;
      }

      const price = toNumber(target?.currentPrice, null) ?? toNumber(current?.currentPrice, null);
      rebalancePlan.nonZeroDeltas += 1;
      if (price === null) {
        rebalancePlan.missingPrice += 1;
        continue;
      }
      const notional = price !== null ? Math.abs(deltaQty) * price : null;
      if (notional === null || !Number.isFinite(notional) || notional < POLYMARKET_LIVE_REBALANCE_MIN_NOTIONAL) {
        if (notional !== null && Number.isFinite(notional)) {
          rebalancePlan.belowMinNotional += 1;
          if (
            !rebalancePlan.largestBelowMinNotional ||
            notional > toNumber(rebalancePlan.largestBelowMinNotional?.notional, 0)
          ) {
            rebalancePlan.largestBelowMinNotional = {
              assetId,
              market: target?.market || current?.market || null,
              outcome: target?.outcome || current?.outcome || null,
              price,
              deltaQty,
              notional: roundToDecimals(notional, 6),
              minNotional: POLYMARKET_LIVE_REBALANCE_MIN_NOTIONAL,
            };
          }
        }
        continue;
      }

      candidates.push({
        assetId,
        market: target?.market || current?.market || null,
        outcome: target?.outcome || current?.outcome || null,
        price,
        notional,
        deltaQty,
        side: deltaQty > 0 ? 'BUY' : 'SELL',
      });
    }

    rebalancePlan.eligibleCandidates = candidates.length;
    if (!candidates.length) {
      if (rebalancePlan.nonZeroDeltas === 0) {
        rebalancePlan.reason = 'already_in_sync';
      } else if (rebalancePlan.missingPrice > 0 && rebalancePlan.belowMinNotional > 0) {
        rebalancePlan.reason = 'missing_price_and_below_min_notional';
      } else if (rebalancePlan.missingPrice > 0) {
        rebalancePlan.reason = 'missing_price';
      } else if (rebalancePlan.belowMinNotional > 0) {
        rebalancePlan.reason = 'below_min_notional';
      } else {
        rebalancePlan.reason = 'no_candidates';
      }
      return;
    }

    candidates.sort((a, b) => {
      if (a.side !== b.side) {
        return a.side === 'SELL' ? -1 : 1;
      }
      return b.notional - a.notional;
    });

    const orders = candidates.slice(0, POLYMARKET_LIVE_REBALANCE_MAX_ORDERS);
    rebalancePlan.plannedOrders = orders.length;
    rebalancePlan.candidatesTrimmed = Math.max(0, candidates.length - orders.length);
    const symbolFor = ({ market, outcome, assetId }) =>
      market ? `PM:${String(market).slice(0, 10)}:${outcome || 'OUTCOME'}` : `PM:${String(assetId).slice(0, 10)}`;

	    for (const order of orders) {
	      const amount = order.side === 'BUY'
	        ? roundToDecimals(order.notional, 6)
	        : roundToDecimals(Math.abs(order.deltaQty), 6);
      if (!amount || amount <= 0) {
        rebalancePlan.failedOrders += 1;
        continue;
      }

	      let execution = null;
	      try {
	        rebalancePlan.attemptedOrders += 1;
	        execution = await executePolymarketMarketOrder({
	          tokenID: order.assetId,
	          side: order.side,
	          amount,
	        });
	      } catch (error) {
        if (isExecutionConfigError(error)) {
          executionEnabled = false;
          executionDisabledReason = formatAxiosError(error);
          if (!liveExecutionConfigLogged) {
            liveExecutionConfigLogged = true;
            await recordStrategyLog({
              strategyId: portfolio.strategy_id,
              userId: portfolio.userId,
              strategyName: portfolio.name,
              level: 'error',
              message: 'Polymarket live execution failed (configuration/auth error)',
              details: {
                provider: 'polymarket',
                mode,
                error: executionDisabledReason,
              },
            });
          }
          liveExecutionAbort = executionDisabledReason;
          break;
        } else if (isRetryableExecutionError(error)) {
          liveExecutionAbort = String(formatAxiosError(error));
          tradeSummary.rebalance.push({
            symbol: symbolFor(order),
            assetId: order.assetId,
            side: order.side,
            amount,
            price: order.price,
            notional: roundToDecimals(order.notional, 6),
            reason: 'execution_retryable_error',
            error: liveExecutionAbort,
          });
          rebalancePlan.failedOrders += 1;
          break;
        } else {
          const errorMessage = String(formatAxiosError(error));
          const diagnostics = liveRebalanceDebugEnabled
            ? {
              preflight: executionPreflight || null,
              orderType: String(process.env.POLYMARKET_MARKET_ORDER_TYPE || process.env.POLYMARKET_ORDER_TYPE || 'fak')
                .trim()
                .toLowerCase() || 'fak',
              orderbook: null,
            }
            : null;

	          if (
	            diagnostics &&
	            (errorMessage.toLowerCase().includes('no match') || errorMessage.toLowerCase().includes('no orderbook'))
	          ) {
	            try {
	              const orderbookResponse = await polymarketAxiosGet(`${CLOB_HOST}/book`, {
	                params: buildGeoParams({ token_id: order.assetId }),
	                headers: withClobUserAgent(),
	              });
	              const book = orderbookResponse?.data || null;
	              const bidsRaw = Array.isArray(book?.bids) ? book.bids : [];
	              const asksRaw = Array.isArray(book?.asks) ? book.asks : [];
	              const toLevel = (row) => {
                const price = toNumber(row?.price, null);
                const size = toNumber(row?.size, null);
                if (price === null || size === null) return null;
                return { price, size };
              };
              const bids = bidsRaw.map(toLevel).filter(Boolean);
              const asks = asksRaw.map(toLevel).filter(Boolean);
              const bestBid = bids.length ? bids.reduce((best, cur) => (cur.price > best.price ? cur : best)) : null;
              const bestAsk = asks.length ? asks.reduce((best, cur) => (cur.price < best.price ? cur : best)) : null;
              const topBids = [...bids].sort((a, b) => b.price - a.price).slice(0, 3);
              const topAsks = [...asks].sort((a, b) => a.price - b.price).slice(0, 3);
              diagnostics.orderbook = {
                ok: true,
                market: book?.market ?? null,
                assetId: book?.asset_id ?? null,
                timestamp: book?.timestamp ?? null,
                bidCount: bids.length,
                askCount: asks.length,
                bestBid,
                bestAsk,
                topBids,
                topAsks,
                minOrderSize: book?.min_order_size ?? null,
                tickSize: book?.tick_size ?? null,
                negRisk: book?.neg_risk ?? null,
              };
            } catch (orderbookError) {
              const status = Number(orderbookError?.response?.status);
              const payload = orderbookError?.response?.data;
              const apiError = (() => {
                if (!payload) return null;
                if (typeof payload === 'string') return payload.trim() || null;
                if (payload?.error) return String(payload.error).trim() || null;
                if (payload?.message) return String(payload.message).trim() || null;
                return null;
              })();
              diagnostics.orderbook = {
                ok: false,
                status: Number.isFinite(status) && status > 0 ? status : null,
                error: formatAxiosError(orderbookError),
                apiError,
              };
            }
          }

          tradeSummary.rebalance.push({
            symbol: symbolFor(order),
            assetId: order.assetId,
            side: order.side,
            amount,
            price: order.price,
            notional: roundToDecimals(order.notional, 6),
            reason: 'execution_failed',
            error: errorMessage,
            ...(diagnostics ? { diagnostics } : {}),
          });
          rebalancePlan.failedOrders += 1;
          continue;
	        }
	      }

	      const meta = extractOrderMeta(execution);
	      const statusCode = (() => {
	        const parsed = Number(meta.status);
	        return Number.isFinite(parsed) && parsed >= 100 ? parsed : null;
	      })();
	      const hasReceipt = Boolean(meta.orderId) || (Array.isArray(meta.txHashes) && meta.txHashes.length > 0);
	      const looksRejected = meta.success === false || (statusCode !== null && statusCode >= 400) || !hasReceipt;

	      if (looksRejected) {
	        const errorMessage = meta.error || (statusCode !== null ? `Order rejected (status ${statusCode})` : 'Order rejected');
	        tradeSummary.rebalance.push({
	          symbol: symbolFor(order),
	          assetId: order.assetId,
	          side: order.side,
	          amount,
	          price: order.price,
	          notional: roundToDecimals(order.notional, 6),
	          reason: 'execution_failed',
	          error: errorMessage,
	          execution: {
	            mode: execution?.mode ?? executionMode,
	            dryRun: execution?.dryRun ?? false,
	            orderId: meta.orderId,
	            status: meta.status,
	            txHashes: meta.txHashes,
	            error: meta.error,
	            success: meta.success,
	          },
	        });
	        rebalancePlan.failedOrders += 1;

	        if (statusCode === 401 || statusCode === 403) {
	          executionEnabled = false;
	          executionDisabledReason = errorMessage;
	          liveExecutionAbort = errorMessage;
	          break;
	        }
	        continue;
	      }
	      tradeSummary.rebalance.push({
	        symbol: symbolFor(order),
	        assetId: order.assetId,
	        side: order.side,
	        amount,
	        price: order.price,
	        notional: roundToDecimals(order.notional, 6),
	        execution: {
	          mode: execution.mode,
	          dryRun: execution.dryRun,
	          orderId: meta.orderId,
	          status: meta.status,
	          txHashes: meta.txHashes,
	          error: meta.error,
	          success: meta.success,
	        },
	      });
	      rebalancePlan.successfulOrders += 1;
	    }

    if (!rebalancePlan.reason) {
      rebalancePlan.reason = 'orders_planned';
    }
  };

  await executeSizeToBudgetRebalance();

  if (lastProcessedTrade?.id) {
    portfolio.polymarket = {
      ...snapshotPolymarket(portfolio.polymarket),
      lastTradeId: String(lastProcessedTrade.id),
      lastTradeMatchTime: lastProcessedTrade.match_time ? String(lastProcessedTrade.match_time) : null,
      backfillPending: mode === 'backfill' ? false : Boolean(portfolio.polymarket?.backfillPending),
      backfilledAt: mode === 'backfill' ? now.toISOString() : (portfolio.polymarket?.backfilledAt || null),
    };
	  } else if (mode === 'backfill') {
	    portfolio.polymarket = {
	      ...snapshotPolymarket(portfolio.polymarket),
	      backfillPending: false,
	      backfilledAt: now.toISOString(),
	    };
	  }

  const shouldApplyPortfolioUpdate = (() => {
    if (executionMode !== 'live') {
      return true;
    }
    if (mode === 'backfill') {
	      return true;
	    }
	    if (!makerStateEnabled || !didSize) {
	      return true;
	    }
	    if (!rebalancePlan) {
	      return false;
	    }
	    if (!executionEnabled) {
	      return false;
	    }
	    if (rebalancePlan.attemptedOrders <= 0) {
	      return false;
	    }
    if (rebalancePlan.failedOrders > 0 || liveExecutionAbort) {
      return false;
    }
    return true;
  })();

  if (executionMode === 'live' && mode === 'incremental') {
    const nextLiveExecutionOk = (() => {
      if (liveExecutionAbort) {
        return false;
      }
      if (rebalancePlan && rebalancePlan.failedOrders > 0) {
        return false;
      }
      if (rebalancePlan && rebalancePlan.attemptedOrders > 0) {
        return true;
      }
      if (liveHoldingsUsed) {
        return true;
      }
      return previousLiveExecutionOk === true;
    })();

    portfolio.polymarket = {
      ...snapshotPolymarket(portfolio.polymarket),
      lastLiveExecutionAt: now.toISOString(),
      lastLiveExecutionOk: nextLiveExecutionOk,
      lastLiveExecutionAbort: liveExecutionAbort,
      lastLiveExecutionDisabledReason: executionDisabledReason,
    };
  }

  if (shouldApplyPortfolioUpdate) {
    portfolio.stocks = updatedStocks;
    portfolio.retainedCash = toNumber(cash, 0);
    portfolio.cashBuffer = toNumber(cash, 0);
  }
	  portfolio.lastRebalancedAt = now;
	  portfolio.nextRebalanceAt = computeNextRebalanceAt(normalizeRecurrence(portfolio.recurrence), now);
	  portfolio.rebalanceCount = toNumber(portfolio.rebalanceCount, 0) + 1;
	  portfolio.lastPerformanceComputedAt = now;
  sanitizePolymarketSubdoc(portfolio);
  await portfolio.save();

  const savedStocks = Array.isArray(portfolio.stocks) ? portfolio.stocks : [];

  await recordEquitySnapshotIfPossible({
    stocks: savedStocks,
    retainedCash: portfolio.retainedCash,
  });

	  const maxLogTrades = mode === 'backfill' ? 200 : 500;
    const maxLogPositions = 200;
    const serializePosition = (pos) => ({
      market: pos.market,
      asset_id: pos.asset_id,
      outcome: pos.outcome,
      quantity: pos.quantity,
      avgCost: pos.avgCost,
      currentPrice: pos.currentPrice,
    });
    const positionsTrimmed = Math.max(0, savedStocks.length - Math.min(savedStocks.length, maxLogPositions));
    const targetPositionsTrimmed = Math.max(0, updatedStocks.length - Math.min(updatedStocks.length, maxLogPositions));
	  const summaryMessage = mode === 'backfill'
	    ? 'Polymarket copy-trader backfilled'
	    : liveExecutionAbort
	      ? 'Polymarket copy-trader live execution failed'
	      : seededFromPositionsSnapshot
	        ? 'Polymarket copy-trader seeded from positions snapshot'
	        : 'Polymarket copy-trader synced';

  const executionDebug = (() => {
    if (typeof getPolymarketExecutionDebugInfo !== 'function') {
      return null;
    }
    try {
      const info = getPolymarketExecutionDebugInfo();
      return {
        mode: info?.mode ?? null,
        host: info?.host ?? null,
        chainId: info?.chainId ?? null,
        signatureType: info?.signatureType ?? null,
        geoTokenSet: info?.geoTokenSet ?? null,
        proxyConfigured: info?.proxy?.configured ?? null,
        proxyCount: info?.proxy?.count ?? null,
        proxyHost: info?.proxy?.host ?? null,
        proxyPort: info?.proxy?.port ?? null,
        proxyAuthPresent: info?.proxy?.authPresent ?? null,
        useServerTime: info?.useServerTime ?? null,
        authAddressPresent: info?.authAddressPresent ?? null,
        authAddressValid: info?.authAddressValid ?? null,
        authMatchesPrivateKey: info?.authMatchesPrivateKey ?? null,
        derivedAddress: info?.privateKey?.derivedAddress ?? null,
        privateKeyPresent: info?.privateKey?.rawPresent ?? null,
        privateKeyLooksHex: info?.privateKey?.looksHex ?? null,
        funderAddressPresent: info?.funderAddressPresent ?? null,
        l2CredsPresent: info?.l2CredsPresent ?? null,
        decryptError: info?.decryptError ?? null,
      };
    } catch (error) {
      return { error: String(error?.message || error) };
    }
  })();

		  await recordStrategyLog({
		    strategyId: portfolio.strategy_id,
		    userId: portfolio.userId,
		    strategyName: portfolio.name,
		    level: liveExecutionAbort ? 'warn' : 'info',
	    message: summaryMessage,
		    details: {
		      provider: 'polymarket',
		      mode,
		      tradeSource: tradeSourceUsed,
		      tradesSourceSetting,
	        envExecutionMode,
	        portfolioExecutionMode,
		      executionMode,
		      executionEnabled,
		      executionDisabledReason,
			      executionAbort: liveExecutionAbort,
	          portfolioUpdated: shouldApplyPortfolioUpdate,
			      hasClobCredentials,
			      clobAuthCooldown: getClobAuthCooldownStatus(),
				      sizeToBudget: makerStateEnabled,
				      sizedToBudget: didSize,
	            seedFromPositions,
            seededFromPositionsSnapshot,
            ignoredTrades: ignoredTradesCount,
			      sizing: sizingMeta,
            liveRebalanceConfig: {
              minNotional: POLYMARKET_LIVE_REBALANCE_MIN_NOTIONAL,
              maxOrders: POLYMARKET_LIVE_REBALANCE_MAX_ORDERS,
              preflightEnabled: liveRebalancePreflightEnabled,
            },
            liveRebalancePlan: rebalancePlan,
            liveRebalancePreflight: executionPreflight,
            executionDebug,
            liveHoldings,
            holdingsSource: liveHoldingsUsed ? 'data-api' : 'portfolio',
			      address,
            authAddress,
			      pagesFetched,
			      startingCash,
		      processedTrades: processedCount,
	      buys: tradeSummary.buys.slice(0, maxLogTrades),
	      sells: tradeSummary.sells.slice(0, maxLogTrades),
	      rebalance: tradeSummary.rebalance.slice(0, maxLogTrades),
	      skipped: tradeSummary.skipped.slice(0, 50),
      buyCount: tradeSummary.buys.length,
      sellCount: tradeSummary.sells.length,
      rebalanceCount: tradeSummary.rebalance.length,
      skippedCount: tradeSummary.skipped.length,
      cash: portfolio.retainedCash,
      targetCash: roundToDecimals(cash, 6),
      positionsCount: savedStocks.length,
      targetPositionsCount: updatedStocks.length,
      positions: savedStocks.slice(0, maxLogPositions).map(serializePosition),
      targetPositions: updatedStocks.slice(0, maxLogPositions).map(serializePosition),
      positionsTrimmed: positionsTrimmed || null,
      targetPositionsTrimmed: targetPositionsTrimmed || null,
    },
  });

	  return {
	    processed: processedCount,
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
