#!/usr/bin/env node

const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');

const serverRequire = createRequire(path.resolve(__dirname, '../server/package.json'));
const dotenv = serverRequire('dotenv');
const axios = serverRequire('axios');

dotenv.config({ path: path.resolve(__dirname, '../server/config/.env') });

const CLOB_HOST = String(process.env.POLYMARKET_CLOB_HOST || process.env.CLOB_API_URL || 'https://clob.polymarket.com')
  .trim()
  .replace(/\/+$/, '');

const GEO_BLOCK_TOKEN =
  (process.env.POLYMARKET_GEO_BLOCK_TOKEN || process.env.GEO_BLOCK_TOKEN || '').trim() || null;
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
let clobProxyPoolKey = null;
let clobProxyPool = [];
let clobProxyCursor = 0;

const POLYMARKET_HTTP_TIMEOUT_MS = (() => {
  const raw = Number(process.env.POLYMARKET_HTTP_TIMEOUT_MS || process.env.POLYMARKET_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 15000;
  }
  return Math.max(1000, Math.min(Math.floor(raw), 120000));
})();

const API_KEY = String(process.env.POLYMARKET_API_KEY || process.env.CLOB_API_KEY || '').trim();
const SECRET = String(process.env.POLYMARKET_SECRET || process.env.CLOB_SECRET || '').trim();
const PASSPHRASE = String(process.env.POLYMARKET_PASSPHRASE || process.env.CLOB_PASS_PHRASE || '').trim();
const AUTH_ADDRESS = String(
  process.env.POLYMARKET_AUTH_ADDRESS || process.env.POLYMARKET_ADDRESS || ''
).trim();

const INITIAL_CURSOR = 'MA==';

const isValidHexAddress = (value) => /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim());

const buildGeoParams = (params = {}) => {
  if (!GEO_BLOCK_TOKEN) return params;
  return { ...params, geo_block_token: GEO_BLOCK_TOKEN };
};

const normalizeProxyUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return raw;
  return `http://${raw}`;
};

const getClobProxyConfig = () => {
  const key = POLYMARKET_CLOB_PROXY_LIST.join(',');
  if (key !== clobProxyPoolKey) {
    clobProxyPoolKey = key;
    clobProxyPool = POLYMARKET_CLOB_PROXY_LIST.map((entry) => {
      const normalized = normalizeProxyUrl(entry);
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
    }).filter(Boolean);
    clobProxyCursor = 0;
  }
  if (!clobProxyPool.length) {
    return null;
  }
  const idx = clobProxyCursor % clobProxyPool.length;
  clobProxyCursor = (clobProxyCursor + 1) % clobProxyPool.length;
  return clobProxyPool[idx];
};

const axiosGet = async (url, config = {}) => {
  const timeout = config.timeout ? config.timeout : POLYMARKET_HTTP_TIMEOUT_MS;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }, timeout)
    : null;

  try {
    return await axios.get(url, {
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
  const cleaned = String(secret || '')
    .trim()
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/[^A-Za-z0-9+/=]/g, '');

  const pad = cleaned.length % 4;
  if (!pad) return cleaned;
  return cleaned + '='.repeat(4 - pad);
};

const decodeBase64Secret = (secret) => Buffer.from(sanitizeBase64Secret(secret), 'base64');

const makeUrlSafeBase64 = (base64) => String(base64 || '').replace(/\+/g, '-').replace(/\//g, '_');

const buildPolyHmacSignature = ({ secret, timestamp, method, requestPath, body }) => {
  const ts = Math.floor(Number(timestamp));
  if (!Number.isFinite(ts) || ts <= 0) {
    throw new Error('Invalid timestamp for signature.');
  }

  const msg = `${ts}${String(method || '').toUpperCase()}${requestPath}${body ?? ''}`;
  const key = decodeBase64Secret(secret);
  const signature = crypto.createHmac('sha256', key).update(msg).digest('base64');
  return makeUrlSafeBase64(signature);
};

const fetchClobServerTime = async () => {
  const response = await axiosGet(`${CLOB_HOST}/time`, {
    params: buildGeoParams(),
    headers: POLYMARKET_CLOB_USER_AGENT ? { 'User-Agent': POLYMARKET_CLOB_USER_AGENT } : undefined,
    proxy: getClobProxyConfig() || false,
  });
  const ts = Math.floor(Number(response?.data));
  if (!Number.isFinite(ts) || ts <= 0) {
    throw new Error('Unable to parse /time response.');
  }
  return ts;
};

const createL2Headers = async ({ method, requestPath, body }) => {
  const ts = await fetchClobServerTime().catch(() => Math.floor(Date.now() / 1000));
  const signature = buildPolyHmacSignature({
    secret: SECRET,
    timestamp: ts,
    method,
    requestPath,
    body,
  });

  return {
    ...(POLYMARKET_CLOB_USER_AGENT ? { 'User-Agent': POLYMARKET_CLOB_USER_AGENT } : {}),
    POLY_ADDRESS: AUTH_ADDRESS,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: `${ts}`,
    POLY_API_KEY: API_KEY,
    POLY_PASSPHRASE: PASSPHRASE,
  };
};

const main = async () => {
  const args = process.argv.slice(2);
  const makerArgIdx = args.findIndex((arg) => arg === '--maker');
  const makerAddress = makerArgIdx >= 0 ? String(args[makerArgIdx + 1] || '').trim() : '';
  const maker = makerAddress || String(process.env.POLYMARKET_TEST_MAKER_ADDRESS || AUTH_ADDRESS || '').trim();

  if (!API_KEY || !SECRET || !PASSPHRASE) {
    console.error('[Polymarket Test] Missing env creds (POLYMARKET_API_KEY, POLYMARKET_SECRET, POLYMARKET_PASSPHRASE).');
    process.exit(1);
  }

  if (!isValidHexAddress(AUTH_ADDRESS)) {
    console.error('[Polymarket Test] Missing/invalid POLYMARKET_AUTH_ADDRESS (0x…).');
    process.exit(1);
  }

  if (!isValidHexAddress(maker)) {
    console.error('[Polymarket Test] Missing/invalid maker address. Provide --maker 0x… or set POLYMARKET_TEST_MAKER_ADDRESS.');
    process.exit(1);
  }

  console.log('[Polymarket Test] Host:', CLOB_HOST);
  console.log('[Polymarket Test] Geo token set:', GEO_BLOCK_TOKEN ? 'yes' : 'no');
  console.log('[Polymarket Test] Timeout:', `${POLYMARKET_HTTP_TIMEOUT_MS}ms`);
  console.log('[Polymarket Test] Maker address:', maker);

  const timeTs = await fetchClobServerTime();
  console.log('[Polymarket Test] /time OK:', timeTs);

  const safeRequest = async ({ label, endpoint, params }) => {
    const headers = await createL2Headers({ method: 'GET', requestPath: endpoint });
    try {
      const response = await axiosGet(`${CLOB_HOST}${endpoint}`, {
        headers,
        params: buildGeoParams(params),
        proxy: getClobProxyConfig() || false,
      });
      return { ok: true, status: response.status, data: response.data };
    } catch (error) {
      const status = Number(error?.response?.status);
      const message = (() => {
        const payload = error?.response?.data;
        if (!payload) return String(error?.message || 'Request failed');
        if (typeof payload === 'string') return payload;
        if (payload?.error) return String(payload.error);
        if (payload?.message) return String(payload.message);
        return String(error?.message || 'Request failed');
      })();
      console.error(`[Polymarket Test] ${label} failed:`, Number.isFinite(status) ? `${status} ${message}` : message);
      return { ok: false, status: Number.isFinite(status) ? status : null, data: null };
    }
  };

  const keysResp = await safeRequest({ label: 'GET /auth/api-keys', endpoint: '/auth/api-keys', params: {} });
  if (keysResp.ok) {
    console.log('[Polymarket Test] /auth/api-keys OK:', keysResp.status);
  }

  const tradesResp = await safeRequest({
    label: 'GET /data/trades',
    endpoint: '/data/trades',
    params: { maker_address: maker, next_cursor: INITIAL_CURSOR },
  });
  if (tradesResp.ok) {
    const trades = Array.isArray(tradesResp.data?.data) ? tradesResp.data.data : [];
    const nextCursor = tradesResp.data?.next_cursor ? String(tradesResp.data.next_cursor) : null;
    console.log('[Polymarket Test] /data/trades OK:', tradesResp.status, `trades=${trades.length}`, `next_cursor=${nextCursor || 'n/a'}`);
  }

  process.exit(keysResp.ok && tradesResp.ok ? 0 : 2);
};

main().catch((error) => {
  console.error('[Polymarket Test] Unexpected error:', error?.message || error);
  process.exit(1);
});
