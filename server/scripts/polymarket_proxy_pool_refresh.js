/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../config/.env') });

const normalize = (value) => String(value || '').trim();

const parseIntArg = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const floored = Math.floor(parsed);
  return floored > 0 ? floored : null;
};

const parseArgs = (argv) => {
  const args = {
    help: false,
    urls: null,
    show: 10,
    maxTests: null,
    maxGood: null,
    concurrency: null,
    timeoutMs: null,
    targetTest: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token === '--urls' || token === '--proxy-urls') {
      args.urls = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--show') {
      args.show = parseIntArg(argv[i + 1]) ?? args.show;
      i += 1;
      continue;
    }
    if (token === '--max-tests') {
      args.maxTests = parseIntArg(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--max-good') {
      args.maxGood = parseIntArg(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--concurrency') {
      args.concurrency = parseIntArg(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--timeout-ms') {
      args.timeoutMs = parseIntArg(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--target-test') {
      args.targetTest = normalize(argv[i + 1]).toLowerCase() !== 'false';
      i += 1;
      continue;
    }
    if (token === '--no-target-test') {
      args.targetTest = false;
      continue;
    }
  }

  return args;
};

const usage = () => {
  console.log('Usage:');
  console.log('  node scripts/polymarket_proxy_pool_refresh.js --urls "<url1>,<url2>,..."');
  console.log('');
  console.log('Optional flags:');
  console.log('  --show 10             Number of accepted proxies to display');
  console.log('  --max-tests 500       Max candidates to test per refresh');
  console.log('  --max-good 200        Stop after collecting this many good proxies');
  console.log('  --concurrency 20      Parallel proxy tests');
  console.log('  --timeout-ms 8000     Per-proxy test timeout');
  console.log('  --no-target-test      Disable CLOB /time target test');
  console.log('');
  console.log('Environment:');
  console.log('- You can also set POLYMARKET_PROXY_LIST_URLS in tradingapp/server/config/.env');
  console.log('- Proxy selection is filtered by POLYMARKET_PROXY_COUNTRY_DENYLIST/ALLOWLIST');
  console.log('');
  console.log('Security warning:');
  console.log('- Public proxies are untrusted. Avoid routing authenticated trading traffic through random proxies.');
};

const resolveCachePath = () => {
  const configured = normalize(process.env.POLYMARKET_PROXY_CACHE_PATH);
  if (configured) return configured;
  return path.resolve(__dirname, '..', 'data', 'polymarketProxyPool.json');
};

const readCache = (cachePath) => {
  if (!cachePath) return null;
  let raw;
  try {
    raw = fs.readFileSync(cachePath, 'utf8');
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const summarizeProxy = (proxy) => {
  if (!proxy || !proxy.host || !proxy.port) return null;
  return {
    host: String(proxy.host),
    port: Number(proxy.port),
    country: proxy.country ? String(proxy.country) : null,
    exitIp: proxy.exitIp ? String(proxy.exitIp) : null,
    latencyMs: proxy.latencyMs === null || proxy.latencyMs === undefined ? null : Number(proxy.latencyMs),
    checkedAt: proxy.checkedAt ? String(proxy.checkedAt) : null,
  };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  if (args.urls) {
    process.env.POLYMARKET_PROXY_LIST_URLS = normalize(args.urls);
  }
  if (args.maxTests !== null) {
    process.env.POLYMARKET_PROXY_MAX_TESTS = String(args.maxTests);
  }
  if (args.maxGood !== null) {
    process.env.POLYMARKET_PROXY_MAX_GOOD = String(args.maxGood);
  }
  if (args.concurrency !== null) {
    process.env.POLYMARKET_PROXY_TEST_CONCURRENCY = String(args.concurrency);
  }
  if (args.timeoutMs !== null) {
    process.env.POLYMARKET_PROXY_TEST_TIMEOUT_MS = String(args.timeoutMs);
  }
  if (args.targetTest !== null) {
    process.env.POLYMARKET_PROXY_TARGET_TEST_ENABLED = args.targetTest ? 'true' : 'false';
  }

  const urls = normalize(process.env.POLYMARKET_PROXY_LIST_URLS || process.env.POLYMARKET_PROXY_LIST_URL) || '(default)';
  console.log('[Polymarket Proxy Pool Refresh]');
  console.log('- urls:', urls);

  const { refreshPolymarketProxyPool, getPolymarketProxyDebugInfo } = require('../services/polymarketProxyPoolService');
  const result = await refreshPolymarketProxyPool({ force: true, reason: 'manual' });
  console.log('- refresh:', result?.ok ? 'ok' : 'failed', result?.skipped ? '(skipped)' : '');
  if (result?.error) {
    console.log('- error:', String(result.error).slice(0, 240));
  }
  console.log('- accepted proxies:', Number(result?.proxies ?? 0));
  if (result?.stats) {
    console.log('- stats:', JSON.stringify(result.stats));
  }

  const debug = getPolymarketProxyDebugInfo();
  if (debug?.dynamic?.lastError) {
    console.log('- lastError:', String(debug.dynamic.lastError).slice(0, 240));
  }

  const cachePath = resolveCachePath();
  const cache = readCache(cachePath);
  const proxies = Array.isArray(cache?.proxies) ? cache.proxies.map(summarizeProxy).filter(Boolean) : [];

  console.log('- cachePath:', cachePath);
  if (Array.isArray(cache?.sourceUrls) && cache.sourceUrls.length) {
    console.log('- sources:', cache.sourceUrls.join(', '));
  }

  if (!proxies.length) {
    console.log('- proxies: none');
    return;
  }

  const sorted = [...proxies].sort((a, b) => {
    const aLatency = a.latencyMs === null ? Number.POSITIVE_INFINITY : a.latencyMs;
    const bLatency = b.latencyMs === null ? Number.POSITIVE_INFINITY : b.latencyMs;
    return aLatency - bLatency;
  });

  const limit = Math.max(1, Math.min(args.show || 10, sorted.length));
  console.log(`- top proxies (n=${limit}):`);
  for (const entry of sorted.slice(0, limit)) {
    console.log(
      `  - ${entry.host}:${entry.port} country=${entry.country ?? 'n/a'} latencyMs=${entry.latencyMs ?? 'n/a'} exitIp=${entry.exitIp ?? 'n/a'}`
    );
  }
};

main().catch((err) => {
  console.error('[Polymarket Proxy Pool Refresh] Failed:', err?.message || err);
  process.exitCode = 1;
});

