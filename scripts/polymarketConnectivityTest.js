#!/usr/bin/env node

const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');

const serverRequire = createRequire(path.resolve(__dirname, '../server/package.json'));
const dotenv = serverRequire('dotenv');
const Axios = serverRequire('axios');

dotenv.config({ path: path.resolve(__dirname, '../server/config/.env') });

const CLOB_HOST = String(process.env.POLYMARKET_CLOB_HOST || process.env.CLOB_API_URL || 'https://clob.polymarket.com')
  .trim()
  .replace(/\/+$/, '');

const GEO_BLOCK_TOKEN =
  (process.env.POLYMARKET_GEO_BLOCK_TOKEN || process.env.GEO_BLOCK_TOKEN || '').trim() || null;

const PROXY_URL = String(
  process.env.POLYMARKET_PROXY_URL ||
  process.env.POLYMARKET_HTTP_PROXY ||
  process.env.POLYMARKET_PROXY ||
  ''
).trim() || null;

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

const parseAxiosProxyConfig = (proxyUrl) => {
  const raw = String(proxyUrl || '').trim();
  if (!raw) return null;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new Error('POLYMARKET_PROXY_URL is invalid. Expected format: http://user:pass@host:port');
  }

  const protocol = String(parsed.protocol || '').replace(':', '');
  if (protocol !== 'http' && protocol !== 'https') {
    throw new Error('POLYMARKET_PROXY_URL must use http:// or https://');
  }

  const host = String(parsed.hostname || '').trim();
  if (!host) {
    throw new Error('POLYMARKET_PROXY_URL must include a hostname.');
  }

  const port = parsed.port ? Number(parsed.port) : protocol === 'https' ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('POLYMARKET_PROXY_URL port is invalid.');
  }

  const username = parsed.username ? decodeURIComponent(parsed.username) : null;
  const password = parsed.password ? decodeURIComponent(parsed.password) : null;
  const auth = username ? { username, password: password || '' } : undefined;
  return { protocol, host, port, auth };
};

const getAxiosProxyConfig = () => parseAxiosProxyConfig(PROXY_URL);

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
  const proxy = getAxiosProxyConfig();
  const response = await Axios.get(`${CLOB_HOST}/time`, {
    params: buildGeoParams(),
    ...(proxy ? { proxy } : {}),
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

  const proxy = getAxiosProxyConfig();
  console.log('[Polymarket Test] Host:', CLOB_HOST);
  console.log('[Polymarket Test] Geo token set:', GEO_BLOCK_TOKEN ? 'yes' : 'no');
  console.log('[Polymarket Test] Proxy set:', proxy ? `${proxy.protocol}://${proxy.host}:${proxy.port}` : 'no');
  console.log('[Polymarket Test] Maker address:', maker);

  const timeTs = await fetchClobServerTime();
  console.log('[Polymarket Test] /time OK:', timeTs);

  const safeRequest = async ({ label, endpoint, params }) => {
    const headers = await createL2Headers({ method: 'GET', requestPath: endpoint });
    try {
      const response = await Axios.get(`${CLOB_HOST}${endpoint}`, {
        headers,
        params: buildGeoParams(params),
        ...(proxy ? { proxy } : {}),
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

  // 1) Validate creds are accepted (do NOT print response body; it may include key metadata)
  const keysResp = await safeRequest({ label: 'GET /auth/api-keys', endpoint: '/auth/api-keys', params: {} });
  if (keysResp.ok) {
    console.log('[Polymarket Test] /auth/api-keys OK:', keysResp.status);
  }

  // 2) Test trades endpoint for maker address (print only counts)
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
