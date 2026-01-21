/* eslint-disable no-console */
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config({ path: path.resolve(__dirname, '../config/.env') });

const CLOB_HOST = String(process.env.POLYMARKET_CLOB_HOST || 'https://clob.polymarket.com').replace(/\/+$/, '');
const DATA_API_HOST = String(process.env.POLYMARKET_DATA_API_HOST || 'https://data-api.polymarket.com').replace(
  /\/+$/,
  ''
);
const POLYMARKET_CLOB_USER_AGENT = String(
  process.env.POLYMARKET_CLOB_USER_AGENT || process.env.POLYMARKET_HTTP_USER_AGENT || 'tradingapp/1.0'
).trim();
const POLYMARKET_CLOB_PROXY = String(
  process.env.POLYMARKET_CLOB_PROXY ||
    process.env.POLYMARKET_HTTP_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    ''
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)[0] || null;

const defaultUser = '0xd218e474776403a330142299f7796e8ba32eb5c9'; // public, active address for quick verification
const user = String(process.env.POLYMARKET_TEST_ADDRESS || process.argv[2] || defaultUser).trim();

const apiKey = String(process.env.POLYMARKET_API_KEY || '').trim();
const secret = String(process.env.POLYMARKET_SECRET || '').trim();
const passphrase = String(process.env.POLYMARKET_PASSPHRASE || '').trim();
const authAddress = String(process.env.POLYMARKET_AUTH_ADDRESS || '').trim();

const request = async (url, config = {}) =>
  axios.get(url, {
    timeout: 8000,
    proxy: false,
    validateStatus: () => true,
    ...config,
  });

const getClobProxyConfig = () => {
  if (!POLYMARKET_CLOB_PROXY) {
    return null;
  }
  try {
    const parsed = new URL(POLYMARKET_CLOB_PROXY);
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
  console.log('- env creds present:', Boolean(apiKey && secret && passphrase && authAddress));

  const timeRes = await request(`${CLOB_HOST}/time`, {
    headers: POLYMARKET_CLOB_USER_AGENT ? { 'User-Agent': POLYMARKET_CLOB_USER_AGENT } : undefined,
    proxy: getClobProxyConfig() || false,
  });
  console.log('- CLOB /time:', timeRes.status, String(timeRes.data).trim());
  const ts = Number(timeRes.data);

  if (apiKey && secret && passphrase && authAddress && Number.isFinite(ts)) {
    const endpoint = '/data/trades';
    const sig = sign({ ts, method: 'GET', requestPath: endpoint });
    const tradesRes = await request(`${CLOB_HOST}${endpoint}`, {
      headers: {
        ...(POLYMARKET_CLOB_USER_AGENT ? { 'User-Agent': POLYMARKET_CLOB_USER_AGENT } : {}),
        POLY_ADDRESS: authAddress,
        POLY_SIGNATURE: sig,
        POLY_TIMESTAMP: String(ts),
        POLY_API_KEY: apiKey,
        POLY_PASSPHRASE: passphrase,
      },
      proxy: getClobProxyConfig() || false,
      params: {
        next_cursor: 'MA==',
        maker_address: user,
      },
    });

    console.log('- CLOB /data/trades:', tradesRes.status, tradesRes.data?.error || '(ok)');
  } else {
    console.log('- CLOB /data/trades: skipped (missing env creds or /time failed)');
  }

  const takerOnly = String(process.env.POLYMARKET_DATA_API_TAKER_ONLY ?? 'false').trim().toLowerCase() === 'true';
  const dataTradesRes = await request(`${DATA_API_HOST}/trades`, {
    headers: { 'User-Agent': process.env.POLYMARKET_DATA_API_USER_AGENT || 'tradingapp/1.0' },
    params: { user, limit: 5, offset: 0, takerOnly },
  });
  const dataCount = Array.isArray(dataTradesRes.data) ? dataTradesRes.data.length : null;
  console.log('- data-api /trades:', dataTradesRes.status, `count=${dataCount ?? 'n/a'}`);
};

main().catch((err) => {
  console.error('[Polymarket Smoke Test] Failed:', err?.message || err);
  process.exitCode = 1;
});
