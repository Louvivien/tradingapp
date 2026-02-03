/* eslint-disable no-console */

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const normalize = (value) => String(value || '').trim();

const parseList = (value) => {
  const raw = normalize(value);
  if (!raw) return [];
  return raw
    .split(/[,\n\r\t ]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const username = normalize(process.env.WEBSHARE_PROXY_USERNAME);
const password = normalize(process.env.WEBSHARE_PROXY_PASSWORD);

const proxies = parseList(process.env.WEBSHARE_PROXY_HOSTS);
const testUrl = normalize(process.env.WEBSHARE_TEST_URL) || 'https://polymarket.com/api/geoblock';
const timeoutMs = (() => {
  const raw = Number(process.env.WEBSHARE_TIMEOUT_MS || 10000);
  if (!Number.isFinite(raw) || raw <= 0) return 10000;
  return Math.max(1000, Math.min(Math.floor(raw), 60000));
})();

if (!username || !password) {
  console.error('Missing Webshare proxy credentials.');
  console.error('Set env vars: WEBSHARE_PROXY_USERNAME and WEBSHARE_PROXY_PASSWORD');
  process.exit(1);
}

if (!proxies.length) {
  console.error('Missing proxy host list.');
  console.error('Set env var WEBSHARE_PROXY_HOSTS as a comma/newline-separated list like:');
  console.error('  WEBSHARE_PROXY_HOSTS="1.2.3.4:1234,5.6.7.8:5678"');
  process.exit(1);
}

const buildProxyUrl = (proxyHost) => {
  const user = encodeURIComponent(username);
  const pass = encodeURIComponent(password);
  return `http://${user}:${pass}@${proxyHost}`;
};

const testProxy = async (proxyHost) => {
  const agent = new HttpsProxyAgent(buildProxyUrl(proxyHost));
  try {
    const response = await axios.get(testUrl, {
      httpsAgent: agent,
      proxy: false,
      timeout: timeoutMs,
      validateStatus: () => true,
    });

    const ok = response.status >= 200 && response.status < 300;
    const country = response?.data?.country ? String(response.data.country) : 'n/a';
    const blocked = response?.data?.blocked === true;

    console.log(`${proxyHost} -> status=${response.status} ok=${ok} country=${country} blocked=${blocked}`);
    return { ok, blocked, country, status: response.status };
  } catch (error) {
    console.log(`${proxyHost} -> ERROR: ${error?.message || String(error)}`);
    return { ok: false, blocked: null, country: null, status: null };
  }
};

(async () => {
  console.log('[Webshare Proxy Test]');
  console.log(`- proxies: ${proxies.length}`);
  console.log(`- url: ${testUrl}`);
  console.log(`- timeoutMs: ${timeoutMs}`);
  console.log('');

  const working = [];

  for (const proxy of proxies) {
    // eslint-disable-next-line no-await-in-loop
    const result = await testProxy(proxy);
    if (result.ok) {
      working.push({ proxy, ...result });
    }
  }

  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`Working proxies: ${working.length}/${proxies.length}`);
  if (working.length) {
    working.slice(0, 20).forEach((entry, idx) => {
      console.log(`  ${idx + 1}. ${entry.proxy} (status=${entry.status} country=${entry.country} blocked=${entry.blocked})`);
    });
    if (working.length > 20) {
      console.log(`  ... (${working.length - 20} more)`);
    }
  }
})();
