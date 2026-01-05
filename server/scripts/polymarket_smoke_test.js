/* eslint-disable no-console */
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const axios = require('axios');
const HttpsProxyAgentImport = require('https-proxy-agent');

const HttpsProxyAgent = HttpsProxyAgentImport?.HttpsProxyAgent || HttpsProxyAgentImport;

dotenv.config({ path: path.resolve(__dirname, '../config/.env') });

const CLOB_HOST = String(process.env.POLYMARKET_CLOB_HOST || 'https://clob.polymarket.com').replace(/\/+$/, '');
const DATA_API_HOST = String(process.env.POLYMARKET_DATA_API_HOST || 'https://data-api.polymarket.com').replace(
  /\/+$/,
  ''
);

const defaultUser = '0xd218e474776403a330142299f7796e8ba32eb5c9'; // public, active address for quick verification
const user = String(process.env.POLYMARKET_TEST_ADDRESS || process.argv[2] || defaultUser).trim();

const apiKey = String(process.env.POLYMARKET_API_KEY || '').trim();
const secret = String(process.env.POLYMARKET_SECRET || '').trim();
const passphrase = String(process.env.POLYMARKET_PASSPHRASE || '').trim();
const authAddress = String(process.env.POLYMARKET_AUTH_ADDRESS || '').trim();

const toBool = (value, fallback) => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return fallback;
};

const splitProxyList = (raw) =>
  String(raw || '')
    .trim()
    .split(/[\s,]+/)
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);

const normalizeProxyUrl = (proxyUrl) => {
  const raw = String(proxyUrl || '').trim();
  if (!raw) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return raw;
  return `http://${raw}`;
};

const proxyMode = String(process.env.POLYMARKET_PROXY_MODE || 'always').trim().toLowerCase();
const proxyEntries = splitProxyList(
  process.env.POLYMARKET_PROXY_URLS || process.env.POLYMARKET_PROXY_URL || process.env.POLYMARKET_HTTP_PROXY
)
  .map(normalizeProxyUrl)
  .filter(Boolean);
const proxyPool = proxyEntries.map((url) => ({ url, agent: new HttpsProxyAgent(url) }));
const smokeTestProxyFirst = toBool(process.env.POLYMARKET_SMOKE_TEST_PROXY_FIRST ?? '', false);

const requestWithProxyFallback = async (url, config = {}) => {
  const attempts = [];
  const addDirect = () => attempts.push({ type: 'direct', url: null, agent: null });
  const addProxies = () => proxyPool.forEach((proxy) => attempts.push({ type: 'proxy', ...proxy }));

  const normalizedMode = proxyMode;
  const canUseProxy = proxyPool.length > 0 && normalizedMode !== 'off' && normalizedMode !== 'direct';

  if (!canUseProxy) {
    addDirect();
  } else {
    // For smoke tests, prefer direct first (faster with flaky proxy lists) unless explicitly requested.
    if (smokeTestProxyFirst) {
      addProxies();
      addDirect();
    } else {
      addDirect();
      addProxies();
    }
  }

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const res = await axios.get(url, {
        timeout: 8000,
        proxy: false,
        validateStatus: () => true,
        ...config,
        ...(attempt.agent ? { httpAgent: attempt.agent, httpsAgent: attempt.agent } : {}),
      });
      return { res, via: attempt.type, proxy: attempt.url || null };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Request failed');
};

const sanitizeBase64Secret = (value) =>
  String(value || '')
    .trim()
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/[^A-Za-z0-9+/=]/g, '');

const decodeBase64Secret = (value) => Buffer.from(sanitizeBase64Secret(value), 'base64');

const makeUrlSafeBase64 = (base64) => String(base64 || '').replace(/\+/g, '-').replace(/\//g, '_');

const sign = ({ ts, method, requestPath, body }) => {
  const message = `${ts}${String(method).toUpperCase()}${requestPath}${body ?? ''}`;
  const key = decodeBase64Secret(secret);
  const signature = crypto.createHmac('sha256', key).update(message).digest('base64');
  return makeUrlSafeBase64(signature);
};

const main = async () => {
  console.log('[Polymarket Smoke Test]');
  console.log('- user:', user);
  console.log('- proxyMode:', proxyMode);
  console.log('- proxies:', proxyPool.length ? proxyPool.length : '(none)');
  console.log('- env creds present:', Boolean(apiKey && secret && passphrase && authAddress));

  const timeAttempt = await requestWithProxyFallback(`${CLOB_HOST}/time`);
  console.log(
    '- CLOB /time:',
    timeAttempt.res.status,
    String(timeAttempt.res.data).trim(),
    `via=${timeAttempt.via}${timeAttempt.proxy ? `(${timeAttempt.proxy})` : ''}`
  );
  const ts = Number(timeAttempt.res.data);

  if (apiKey && secret && passphrase && authAddress && Number.isFinite(ts)) {
    const endpoint = '/data/trades';
    const sig = sign({ ts, method: 'GET', requestPath: endpoint });
    const tradesAttempt = await requestWithProxyFallback(`${CLOB_HOST}${endpoint}`, {
      headers: {
        POLY_ADDRESS: authAddress,
        POLY_SIGNATURE: sig,
        POLY_TIMESTAMP: String(ts),
        POLY_API_KEY: apiKey,
        POLY_PASSPHRASE: passphrase,
      },
      params: {
        next_cursor: 'MA==',
        maker_address: user,
      },
    });

    console.log(
      '- CLOB /data/trades:',
      tradesAttempt.res.status,
      tradesAttempt.res.data?.error || '(ok)',
      `via=${tradesAttempt.via}${tradesAttempt.proxy ? `(${tradesAttempt.proxy})` : ''}`
    );
  } else {
    console.log('- CLOB /data/trades: skipped (missing env creds or /time failed)');
  }

  const takerOnly = toBool(process.env.POLYMARKET_DATA_API_TAKER_ONLY ?? 'false', false);
  const dataTradesAttempt = await requestWithProxyFallback(`${DATA_API_HOST}/trades`, {
    headers: { 'User-Agent': process.env.POLYMARKET_DATA_API_USER_AGENT || 'tradingapp/1.0' },
    params: { user, limit: 5, offset: 0, takerOnly },
  });
  const dataCount = Array.isArray(dataTradesAttempt.res.data) ? dataTradesAttempt.res.data.length : null;
  console.log(
    '- data-api /trades:',
    dataTradesAttempt.res.status,
    `count=${dataCount ?? 'n/a'}`,
    `via=${dataTradesAttempt.via}${dataTradesAttempt.proxy ? `(${dataTradesAttempt.proxy})` : ''}`
  );
};

main().catch((err) => {
  console.error('[Polymarket Smoke Test] Failed:', err?.message || err);
  process.exitCode = 1;
});
