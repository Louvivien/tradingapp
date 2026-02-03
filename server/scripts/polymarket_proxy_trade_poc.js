/* eslint-disable no-console */
/**
 * Polymarket Proxy Trade POC
 *
 * This script demonstrates:
 * 1. Fetching proxies from multiple public proxy list URLs
 * 2. Testing proxies to find working ones
 * 3. Using a working proxy to connect to Polymarket
 * 4. Executing a test trade through the proxy
 *
 * Usage:
 *   node scripts/polymarket_proxy_trade_poc.js
 *   node scripts/polymarket_proxy_trade_poc.js --slug <market-slug> --outcome Yes --side buy --amount 1
 *   node scripts/polymarket_proxy_trade_poc.js --confirm (for live trade)
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const Axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

dotenv.config({ path: path.resolve(__dirname, '../config/.env') });

// Default proxy list URLs (can be overridden via env or CLI)
const DEFAULT_PROXY_URLS = [
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/refs/heads/master/http.txt',
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/refs/heads/main/proxies/protocols/http/data.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/refs/heads/main/proxies/http.txt',
  'https://raw.githubusercontent.com/jetkai/proxy-list/refs/heads/main/online-proxies/txt/proxies-https.txt',
];

const CLOUDFLARE_TEST_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
const POLYMARKET_CLOB_URL = 'https://clob.polymarket.com/time';
const POLYMARKET_GAMMA_URL = 'https://gamma-api.polymarket.com';
const POLYMARKET_GEO_URL = 'https://polymarket.com/api/geoblock';

// Proxy test settings
const PROXY_TEST_TIMEOUT_MS = 8000;
const PROXY_TEST_CONCURRENCY = 20;
const MAX_PROXIES_TO_TEST = 500;
const MAX_GOOD_PROXIES = 10;

// Polymarket geoblocked countries
const BLOCKED_COUNTRIES = new Set([
  'US', 'CA', 'GB', 'AU', 'SG', 'TH', 'TW', 'UA', 'BY', 'CU', 'IR', 'IQ',
  'KP', 'SY', 'RU', 'VE', 'YE', 'ZW', 'LY', 'SO', 'SS', 'SD', 'MM', 'BI',
  'CF', 'CD', 'ET', 'LB', 'NI', 'BE', 'DE', 'FR', 'IT', 'PL'
]);

const normalize = (value) => String(value || '').trim();

const parseArgs = (argv) => {
  const args = {
    help: false,
    proxyUrls: null,
    slug: null,
    marketId: null,
    outcome: null,
    side: 'buy',
    amount: 1,
    price: null,
    confirm: false,
    maxTests: MAX_PROXIES_TO_TEST,
    maxGood: MAX_GOOD_PROXIES,
    skipProxyFetch: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token === '--proxy-urls') {
      args.proxyUrls = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--slug') {
      args.slug = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--market-id' || token === '--id') {
      args.marketId = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--outcome') {
      args.outcome = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--side') {
      args.side = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--amount') {
      args.amount = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--price') {
      args.price = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--confirm') {
      args.confirm = true;
      continue;
    }
    if (token === '--max-tests') {
      args.maxTests = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--max-good') {
      args.maxGood = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--skip-proxy-fetch') {
      args.skipProxyFetch = true;
      continue;
    }
  }

  return args;
};

const usage = () => {
  console.log('Polymarket Proxy Trade POC');
  console.log('');
  console.log('Usage:');
  console.log('  node scripts/polymarket_proxy_trade_poc.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --proxy-urls "<url1>,<url2>,..."  Comma-separated proxy list URLs');
  console.log('  --slug <market-slug>              Market slug to trade');
  console.log('  --outcome <Yes|No>                Outcome to trade');
  console.log('  --side <buy|sell>                 Side of the trade (default: buy)');
  console.log('  --amount <N>                      Amount in USDC (buy) or shares (sell)');
  console.log('  --price <0.xx>                    Optional limit price');
  console.log('  --confirm                         Execute live trade (default: paper mode)');
  console.log('  --max-tests <N>                   Max proxies to test (default: 500)');
  console.log('  --max-good <N>                    Stop after finding N good proxies (default: 10)');
  console.log('  --skip-proxy-fetch                Skip proxy fetching, use existing pool');
  console.log('');
  console.log('Example:');
  console.log('  node scripts/polymarket_proxy_trade_poc.js \\');
  console.log('    --slug will-btc-be-above-100k-on-jan-1-2026 \\');
  console.log('    --outcome Yes --side buy --amount 1');
};

/**
 * Fetch proxy list from a URL
 */
const fetchProxyList = async (url) => {
  try {
    const response = await Axios.get(url, {
      timeout: 15000,
      proxy: false,
      validateStatus: () => true,
    });

    if (response.status !== 200) {
      console.log(`  [WARN] ${url}: HTTP ${response.status}`);
      return [];
    }

    const content = String(response.data || '');
    const lines = content.split(/[\r\n]+/).map(line => line.trim()).filter(Boolean);

    // Parse proxy addresses (format: host:port or http://host:port)
    const proxies = [];
    for (const line of lines) {
      if (line.startsWith('#') || line.startsWith('//')) continue;

      const match = line.match(/^(?:https?:\/\/)?([^:@\s]+):(\d+)/);
      if (match) {
        proxies.push({ host: match[1], port: Number(match[2]) });
      }
    }

    return proxies;
  } catch (error) {
    console.log(`  [ERROR] ${url}: ${error.message}`);
    return [];
  }
};

/**
 * Test if a proxy is working
 */
const testProxy = async (proxy) => {
  const proxyUrl = `http://${proxy.host}:${proxy.port}`;
  const agent = new HttpsProxyAgent(proxyUrl);

  try {
    const startTime = Date.now();

    // Test 1: Basic connectivity via Cloudflare
    const cfResponse = await Axios.get(CLOUDFLARE_TEST_URL, {
      timeout: PROXY_TEST_TIMEOUT_MS,
      httpsAgent: agent,
      proxy: false,
      validateStatus: () => true,
    });

    if (cfResponse.status !== 200) {
      return { ok: false, error: `Cloudflare test failed: ${cfResponse.status}` };
    }

    // Parse Cloudflare response to get country
    const cfText = String(cfResponse.data || '');
    const locMatch = cfText.match(/loc=([A-Z]{2})/);
    const country = locMatch ? locMatch[1] : null;
    const ipMatch = cfText.match(/ip=([^\s]+)/);
    const exitIp = ipMatch ? ipMatch[1] : null;

    // Check if country is blocked
    if (country && BLOCKED_COUNTRIES.has(country)) {
      return { ok: false, error: `Blocked country: ${country}` };
    }

    // Test 2: Polymarket CLOB connectivity
    const clobResponse = await Axios.get(POLYMARKET_CLOB_URL, {
      timeout: PROXY_TEST_TIMEOUT_MS,
      httpsAgent: agent,
      proxy: false,
      validateStatus: () => true,
    });

    if (clobResponse.status !== 200) {
      return { ok: false, error: `CLOB test failed: ${clobResponse.status}` };
    }

    const latencyMs = Date.now() - startTime;

    return {
      ok: true,
      country,
      exitIp,
      latencyMs,
      clobTime: clobResponse.data?.time || null,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
};

/**
 * Test multiple proxies concurrently
 */
const testProxiesConcurrently = async (proxies, options = {}) => {
  const { maxTests = MAX_PROXIES_TO_TEST, maxGood = MAX_GOOD_PROXIES, concurrency = PROXY_TEST_CONCURRENCY } = options;

  const toTest = proxies.slice(0, maxTests);
  const goodProxies = [];
  const results = { total: toTest.length, tested: 0, good: 0, failed: 0 };

  console.log(`Testing ${toTest.length} proxies (concurrency: ${concurrency}, max good: ${maxGood})...`);

  const testBatch = async (batch) => {
    const promises = batch.map(async (proxy) => {
      const result = await testProxy(proxy);
      results.tested += 1;

      if (result.ok) {
        results.good += 1;
        goodProxies.push({ ...proxy, ...result });
        console.log(`  ✓ ${proxy.host}:${proxy.port} [${result.country || 'unknown'}] ${result.latencyMs}ms`);
        return true;
      } else {
        results.failed += 1;
        return false;
      }
    });

    await Promise.all(promises);
  };

  // Process in batches
  for (let i = 0; i < toTest.length && goodProxies.length < maxGood; i += concurrency) {
    const batch = toTest.slice(i, i + concurrency);
    await testBatch(batch);

    if (goodProxies.length >= maxGood) {
      console.log(`Reached max good proxies (${maxGood}), stopping tests.`);
      break;
    }
  }

  console.log(`Testing complete: ${results.good} good, ${results.failed} failed, ${results.tested} tested`);
  return { proxies: goodProxies, results };
};

/**
 * Check Polymarket geoblock status without proxy
 */
const checkGeoblockStatus = async () => {
  try {
    const response = await Axios.get(POLYMARKET_GEO_URL, {
      timeout: 10000,
      proxy: false,
      validateStatus: () => true,
    });

    if (response.status !== 200) {
      return { ok: false, status: response.status, data: null };
    }

    return { ok: true, status: response.status, data: response.data };
  } catch (error) {
    return { ok: false, error: error.message, data: null };
  }
};

/**
 * Fetch market info from Gamma API
 */
const fetchMarketInfo = async (args) => {
  const params = {};
  if (args.slug) params.slug = args.slug;
  if (args.marketId) params.id = args.marketId;

  if (!params.slug && !params.id) {
    throw new Error('Either --slug or --market-id is required');
  }

  const response = await Axios.get(`${POLYMARKET_GAMMA_URL}/markets`, {
    params,
    timeout: 15000,
    proxy: false,
    validateStatus: () => true,
  });

  if (response.status !== 200) {
    throw new Error(`Gamma API failed: ${response.status}`);
  }

  if (!Array.isArray(response.data) || !response.data.length) {
    throw new Error('No market found');
  }

  return response.data[0];
};

/**
 * Parse JSON array string (handles both arrays and stringified arrays)
 */
const parseJsonArrayString = (value) => {
  if (Array.isArray(value)) return value;
  const raw = normalize(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/**
 * Pick token ID from market outcomes
 */
const pickTokenId = (market, outcomeInput) => {
  const outcomes = parseJsonArrayString(market?.outcomes).map(entry => String(entry || '').trim());
  const tokenIds = parseJsonArrayString(market?.clobTokenIds).map(entry => String(entry || '').trim());

  if (!outcomes.length || !tokenIds.length || outcomes.length !== tokenIds.length) {
    throw new Error('Market has invalid outcomes/tokenIds');
  }

  if (!outcomeInput) {
    return { outcome: outcomes[0], tokenId: tokenIds[0] };
  }

  const normalized = normalize(outcomeInput).toLowerCase();
  const idx = outcomes.findIndex(o => String(o).toLowerCase() === normalized);

  if (idx < 0) {
    throw new Error(`Outcome "${outcomeInput}" not found. Available: ${outcomes.join(', ')}`);
  }

  return { outcome: outcomes[idx], tokenId: tokenIds[idx] };
};

/**
 * Execute a test trade using proxy
 */
const executeTestTrade = async (proxy, tradeParams) => {
  console.log('');
  console.log('=== Executing Test Trade ===');
  console.log(`Using proxy: ${proxy.host}:${proxy.port} [${proxy.country || 'unknown'}]`);

  // Set the proxy environment variable for the execution service
  const proxyUrl = `http://${proxy.host}:${proxy.port}`;
  process.env.POLYMARKET_CLOB_PROXY = proxyUrl;

  // Import the execution service (will pick up the proxy env var)
  const { executePolymarketMarketOrder, getPolymarketExecutionDebugInfo } = require('../services/polymarketExecutionService');

  const debug = getPolymarketExecutionDebugInfo();
  console.log('Execution service config:');
  console.log(`  - L2 creds present: ${debug.l2CredsPresent || false}`);
  console.log(`  - Auth matches private key: ${debug.authMatchesPrivateKey || false}`);
  console.log(`  - Proxy configured: ${debug.proxy?.configured || false}`);
  if (debug.proxy?.configured) {
    console.log(`  - Proxy: ${debug.proxy.host}:${debug.proxy.port}`);
  }

  try {
    const result = await executePolymarketMarketOrder(tradeParams);

    if (result.dryRun) {
      console.log('✓ Trade built successfully (dry-run mode, not submitted)');
      return { ok: true, dryRun: true, result };
    }

    const orderId = result?.response?.orderID || result?.response?.orderId || result?.response?.id || null;
    console.log('✓ Trade submitted successfully');
    if (orderId) {
      console.log(`  Order ID: ${orderId}`);
    }

    return { ok: true, dryRun: false, orderId, result };
  } catch (error) {
    console.log(`✗ Trade failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
};

/**
 * Main POC flow
 */
const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    usage();
    return;
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          Polymarket Proxy Trade POC                          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // Step 1: Check current IP geoblock status
  console.log('[Step 1] Checking current IP geoblock status...');
  const geoStatus = await checkGeoblockStatus();
  if (geoStatus.ok) {
    const blocked = geoStatus.data?.blocked === true;
    const country = geoStatus.data?.country || 'unknown';
    console.log(`  Current IP: ${blocked ? 'BLOCKED' : 'ALLOWED'} (country: ${country})`);
    if (!blocked) {
      console.log('  ℹ Your current IP is not blocked. Proxy may not be necessary.');
    }
  } else {
    console.log(`  Could not check geoblock status: ${geoStatus.error || geoStatus.status}`);
  }
  console.log('');

  // Step 2: Fetch and test proxies
  let goodProxies = [];

  if (!args.skipProxyFetch) {
    console.log('[Step 2] Fetching proxies from sources...');
    const proxyUrls = args.proxyUrls
      ? args.proxyUrls.split(',').map(u => u.trim())
      : DEFAULT_PROXY_URLS;

    console.log(`  Fetching from ${proxyUrls.length} source(s)...`);

    const allProxies = [];
    for (const url of proxyUrls) {
      console.log(`  - ${url}`);
      const proxies = await fetchProxyList(url);
      console.log(`    Fetched ${proxies.length} proxies`);
      allProxies.push(...proxies);
    }

    // Deduplicate
    const seen = new Set();
    const uniqueProxies = allProxies.filter(p => {
      const key = `${p.host}:${p.port}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`  Total unique proxies: ${uniqueProxies.length}`);
    console.log('');

    // Step 3: Test proxies
    console.log('[Step 3] Testing proxies...');
    const testResult = await testProxiesConcurrently(uniqueProxies, {
      maxTests: args.maxTests,
      maxGood: args.maxGood,
      concurrency: PROXY_TEST_CONCURRENCY,
    });

    goodProxies = testResult.proxies;
    console.log('');

    if (!goodProxies.length) {
      throw new Error('No working proxies found. Cannot proceed with trade test.');
    }

    // Sort by latency
    goodProxies.sort((a, b) => (a.latencyMs || 999999) - (b.latencyMs || 999999));
  } else {
    console.log('[Step 2-3] Skipped (--skip-proxy-fetch)');
    console.log('');
  }

  // Step 4: Prepare trade parameters
  console.log('[Step 4] Preparing trade parameters...');

  if (!args.slug && !args.marketId) {
    console.log('  No market specified. Use --slug or --market-id to test an actual trade.');
    console.log('');
    console.log('POC Complete! Summary:');
    console.log(`  - Working proxies found: ${goodProxies.length}`);
    console.log(`  - Best proxy: ${goodProxies[0]?.host}:${goodProxies[0]?.port} (${goodProxies[0]?.latencyMs}ms)`);
    console.log('');
    console.log('To test an actual trade, run:');
    console.log('  node scripts/polymarket_proxy_trade_poc.js --slug <market-slug> --outcome Yes --side buy --amount 1');
    return;
  }

  const market = await fetchMarketInfo(args);
  const { outcome, tokenId } = pickTokenId(market, args.outcome);

  const side = normalize(args.side).toLowerCase();
  if (side !== 'buy' && side !== 'sell') {
    throw new Error('Invalid --side (expected buy or sell)');
  }

  const amount = Number(args.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid --amount');
  }

  const price = args.price ? Number(args.price) : null;
  if (price !== null && (!Number.isFinite(price) || price <= 0 || price >= 1)) {
    throw new Error('Invalid --price (expected 0 < price < 1)');
  }

  console.log('  Market: ' + (market.question || 'Unknown'));
  console.log(`  Outcome: ${outcome}`);
  console.log(`  Token ID: ${tokenId}`);
  console.log(`  Side: ${side.toUpperCase()}`);
  console.log(`  Amount: ${amount} ${side === 'buy' ? 'USDC' : 'shares'}`);
  if (price !== null) console.log(`  Price: ${price}`);
  console.log(`  Mode: ${args.confirm ? 'LIVE' : 'PAPER (dry-run)'}`);
  console.log('');

  // Set execution mode
  process.env.POLYMARKET_EXECUTION_MODE = args.confirm ? 'live' : 'paper';

  // Step 5: Execute trade through proxy
  console.log('[Step 5] Testing trade execution through proxy...');

  const bestProxy = goodProxies[0];
  const tradeParams = {
    tokenID: tokenId,
    side: side.toUpperCase(),
    amount,
    ...(price !== null ? { price } : {}),
  };

  const tradeResult = await executeTestTrade(bestProxy, tradeParams);
  console.log('');

  // Summary
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    POC Complete!                             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Summary:');
  console.log(`  ✓ Working proxies found: ${goodProxies.length}`);
  console.log(`  ✓ Best proxy: ${bestProxy.host}:${bestProxy.port} [${bestProxy.country}] (${bestProxy.latencyMs}ms)`);
  console.log(`  ${tradeResult.ok ? '✓' : '✗'} Trade execution: ${tradeResult.ok ? 'SUCCESS' : 'FAILED'}`);
  if (tradeResult.dryRun) {
    console.log('    (Dry-run mode - no actual order submitted)');
  }
  if (tradeResult.orderId) {
    console.log(`    Order ID: ${tradeResult.orderId}`);
  }
  console.log('');
  console.log('Next steps:');
  console.log('  - To execute a live trade, add --confirm flag');
  console.log('  - Configure POLYMARKET_PRIVATE_KEY and L2 creds in .env for live trading');
  console.log('');
};

// Run the POC
main().catch((error) => {
  console.error('');
  console.error('╔══════════════════════════════════════════════════════════════╗');
  console.error('║                      POC Failed                              ║');
  console.error('╚══════════════════════════════════════════════════════════════╝');
  console.error('');
  console.error('Error:', error.message);
  console.error('');
  process.exitCode = 1;
});
