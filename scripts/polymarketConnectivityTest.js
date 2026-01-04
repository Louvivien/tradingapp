#!/usr/bin/env node

const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');

const serverRequire = createRequire(path.resolve(__dirname, '../server/package.json'));
const dotenv = serverRequire('dotenv');
const Axios = serverRequire('axios');
const HttpsProxyAgentImport = serverRequire('https-proxy-agent');

const HttpsProxyAgent = HttpsProxyAgentImport?.HttpsProxyAgent || HttpsProxyAgentImport;

dotenv.config({ path: path.resolve(__dirname, '../server/config/.env') });

const CLOB_HOST = String(process.env.POLYMARKET_CLOB_HOST || process.env.CLOB_API_URL || 'https://clob.polymarket.com')
  .trim()
  .replace(/\/+$/, '');

const GEO_BLOCK_TOKEN =
  (process.env.POLYMARKET_GEO_BLOCK_TOKEN || process.env.GEO_BLOCK_TOKEN || '').trim() || null;

const PROXY_URLS_RAW = (() => {
  const values = [];
  const pushValue = (value) => {
    const raw = String(value || '').trim();
    if (raw) {
      values.push(raw);
    }
  };

  pushValue(process.env.POLYMARKET_PROXY_URLS);
  pushValue(process.env.POLYMARKET_PROXY_URL);
  pushValue(process.env.POLYMARKET_HTTP_PROXY);
  pushValue(process.env.POLYMARKET_PROXY);

  const numbered = Object.keys(process.env || {})
    .filter((key) => /^POLYMARKET_PROXY_URL_\d+$/.test(key))
    .sort((a, b) => Number(a.split('_').pop()) - Number(b.split('_').pop()))
    .map((key) => process.env[key]);
  numbered.forEach(pushValue);

  return values.join(',');
})();

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

const splitProxyList = (raw) => {
  const input = String(raw || '').trim();
  if (!input) {
    return [];
  }
  return input
    .split(/[\s,]+/)
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
};

const normalizeProxyUrl = (proxyUrl) => {
  const raw = String(proxyUrl || '').trim();
  if (!raw) {
    return null;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    return raw;
  }
  return `http://${raw}`;
};

const parseProxyUrl = (proxyUrl) => {
  const raw = String(proxyUrl || '').trim();
  if (!raw) return null;

  let parsed;
  try {
    parsed = new URL(normalizeProxyUrl(raw));
  } catch (error) {
    throw new Error('Polymarket proxy entry is invalid. Expected format: host:port or http://user:pass@host:port');
  }

  const protocol = String(parsed.protocol || '').replace(':', '');
  if (protocol !== 'http' && protocol !== 'https') {
    throw new Error('Polymarket proxy must use http:// or https://');
  }

  const host = String(parsed.hostname || '').trim();
  if (!host) {
    throw new Error('Polymarket proxy must include a hostname.');
  }

  const port = parsed.port ? Number(parsed.port) : protocol === 'https' ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('Polymarket proxy port is invalid.');
  }

  const normalized = new URL(parsed.toString());
  normalized.protocol = `${protocol}:`;
  normalized.hostname = host;
  normalized.port = String(port);
  normalized.pathname = '/';
  normalized.search = '';
  normalized.hash = '';
  return normalized.toString();
};

const buildProxyPool = () => {
  const rawEntries = splitProxyList(PROXY_URLS_RAW);
  const pool = [];
  const seen = new Set();
  rawEntries.forEach((entry) => {
    try {
      const proxyUrl = parseProxyUrl(entry);
      if (!proxyUrl || seen.has(proxyUrl)) {
        return;
      }
      seen.add(proxyUrl);
      pool.push({
        url: proxyUrl,
        agent: new HttpsProxyAgent(proxyUrl),
      });
    } catch (error) {
      // ignore invalid proxy entries
    }
  });
  return pool;
};

const PROXY_POOL = buildProxyPool();
let activeProxyIndex = 0;

const formatProxyForLog = (proxy) => {
  if (!proxy) return 'no';
  const raw = String(proxy.url || '').trim();
  if (!raw) return 'no';
  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch (error) {
    return raw;
  }
};

const buildProxyAttemptOrder = (count) => {
  if (!count) return [];
  const start = ((activeProxyIndex % count) + count) % count;
  return Array.from({ length: count }, (_, offset) => (start + offset) % count);
};

const shouldRetryWithAnotherProxy = (error) => {
  const status = Number(error?.response?.status);
  if (!Number.isFinite(status) || status <= 0) {
    return true;
  }
  if (status === 403 || status === 407) {
    return true;
  }
  if (status === 429) {
    return true;
  }
  if (status >= 500 && status <= 599) {
    return true;
  }
  return false;
};

const axiosGetWithProxyFallback = async (url, config = {}) => {
  const timeout = config.timeout ? config.timeout : POLYMARKET_HTTP_TIMEOUT_MS;

  const axiosGetWithHardTimeout = async (requestConfig) => {
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
        ...requestConfig,
        timeout,
        ...(controller ? { signal: controller.signal } : {}),
      });
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  if (!PROXY_POOL.length) {
    return { response: await axiosGetWithHardTimeout({ ...config, proxy: false }), proxy: null };
  }

  const attemptDirect = async () => ({
    response: await axiosGetWithHardTimeout({ ...config, proxy: false }),
    proxy: null,
  });

  const attemptProxies = async () => {
    const order = buildProxyAttemptOrder(PROXY_POOL.length);
    let lastError = null;
    for (const idx of order) {
      const proxy = PROXY_POOL[idx];
      try {
        const response = await axiosGetWithHardTimeout({
          ...config,
          proxy: false,
          httpAgent: proxy.agent,
          httpsAgent: proxy.agent,
        });
        activeProxyIndex = idx;
        return { response, proxy };
      } catch (error) {
        lastError = error;
        if (!shouldRetryWithAnotherProxy(error)) {
          throw error;
        }
      }
    }
    if (lastError) {
      throw lastError;
    }
    throw new Error('Polymarket request failed.');
  };

  try {
    return await attemptProxies();
  } catch (error) {
    if (!shouldRetryWithAnotherProxy(error)) {
      throw error;
    }
  }

  return attemptDirect();
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
  const { response, proxy } = await axiosGetWithProxyFallback(`${CLOB_HOST}/time`, {
    params: buildGeoParams(),
  });
  console.log('[Polymarket Test] /time via:', proxy ? `proxy ${formatProxyForLog(proxy)}` : 'direct');
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

  console.log('[Polymarket Test] Host:', CLOB_HOST);
  console.log('[Polymarket Test] Geo token set:', GEO_BLOCK_TOKEN ? 'yes' : 'no');
  console.log('[Polymarket Test] Proxy pool:', PROXY_POOL.length ? `${PROXY_POOL.length} configured (first=${formatProxyForLog(PROXY_POOL[0])})` : 'no');
  console.log('[Polymarket Test] Timeout:', `${POLYMARKET_HTTP_TIMEOUT_MS}ms`);
  console.log('[Polymarket Test] Maker address:', maker);

  const timeTs = await fetchClobServerTime();
  console.log('[Polymarket Test] /time OK:', timeTs);

  const safeRequest = async ({ label, endpoint, params }) => {
    const headers = await createL2Headers({ method: 'GET', requestPath: endpoint });
    try {
      const { response, proxy: usedProxy } = await axiosGetWithProxyFallback(`${CLOB_HOST}${endpoint}`, {
        headers,
        params: buildGeoParams(params),
      });
      console.log(`[Polymarket Test] ${label} via:`, usedProxy ? `proxy ${formatProxyForLog(usedProxy)}` : 'direct');
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
