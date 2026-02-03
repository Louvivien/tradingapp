/* eslint-disable no-console */
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config({ path: path.resolve(__dirname, '../config/.env') });

const DEFAULT_GAMMA_HOST = 'https://gamma-api.polymarket.com';
const DEFAULT_GEO_HOST = 'https://polymarket.com';

const normalize = (value) => String(value || '').trim();

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

const parseArgs = (argv) => {
  const args = {
    help: false,
    token: null,
    slug: null,
    marketId: null,
    outcome: null,
    side: 'buy',
    amount: 1,
    price: null,
    confirm: false,
    proxyUrls: null,
    refreshProxies: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token === '--proxy-urls' || token === '--proxy-url-list') {
      args.proxyUrls = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--refresh-proxies') {
      args.refreshProxies = true;
      continue;
    }
    if (token === '--token' || token === '-t') {
      args.token = argv[i + 1];
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
  }

  return args;
};

const usage = () => {
  console.log('Usage:');
  console.log('  node scripts/polymarket_test_trade.js --slug <market-slug> --outcome <Yes|No> [--side buy|sell] [--amount N] [--price 0.xx] [--confirm]');
  console.log('  node scripts/polymarket_test_trade.js --market-id <id> --outcome <Yes|No> [--side buy|sell] [--amount N] [--price 0.xx] [--confirm]');
  console.log('  node scripts/polymarket_test_trade.js --token <clobTokenId> --side buy|sell --amount N [--price 0.xx] [--confirm]');
  console.log('');
  console.log('Proxy pool (optional):');
  console.log('  --proxy-urls "<url1>,<url2>,..."   Set POLYMARKET_PROXY_LIST_URLS for this run');
  console.log('  --refresh-proxies                 Force a proxy pool refresh before running');
  console.log('');
  console.log('Notes:');
  console.log('- Without --confirm, this forces POLYMARKET_EXECUTION_MODE=paper (dry-run only).');
  console.log('- With --confirm, this forces POLYMARKET_EXECUTION_MODE=live, but will abort if Polymarket geoblocks the current IP.');
  console.log('- BUY amount is in USDC (collateral). SELL amount is in shares.');
};

const httpGetJson = async (url, config = {}) => {
  return await axios.get(url, {
    timeout: 15000,
    proxy: false,
    validateStatus: () => true,
    ...config,
  });
};

const fetchGeoblock = async () => {
  const res = await httpGetJson(`${DEFAULT_GEO_HOST}/api/geoblock`);
  if (!res || typeof res.status !== 'number') {
    return { ok: false, status: null, data: null };
  }
  if (res.status < 200 || res.status >= 300 || !res.data || typeof res.data !== 'object') {
    return { ok: false, status: res.status, data: res.data };
  }
  return { ok: true, status: res.status, data: res.data };
};

const fetchGammaMarket = async ({ slug, id }) => {
  const params = {};
  if (slug) params.slug = slug;
  if (id) params.id = id;
  if (!params.slug && !params.id) {
    throw new Error('Missing --slug or --market-id for Gamma lookup.');
  }
  const res = await httpGetJson(`${DEFAULT_GAMMA_HOST}/markets`, { params });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Gamma API request failed (status ${res.status}).`);
  }
  if (!Array.isArray(res.data) || !res.data.length) {
    throw new Error('Gamma API returned no market matches.');
  }
  return res.data[0];
};

const pickTokenIdFromMarket = (market, outcomeRaw) => {
  const outcomes = parseJsonArrayString(market?.outcomes).map((entry) => String(entry || '').trim());
  const tokenIds = parseJsonArrayString(market?.clobTokenIds).map((entry) => String(entry || '').trim());
  if (!outcomes.length || !tokenIds.length || outcomes.length !== tokenIds.length) {
    throw new Error('Market is missing outcomes/clobTokenIds (or counts mismatch).');
  }

  const normalizedOutcome = normalize(outcomeRaw);
  if (!normalizedOutcome) {
    return { outcome: outcomes[0], tokenID: tokenIds[0] };
  }

  const indexFromNumber = (() => {
    if (!/^\d+$/.test(normalizedOutcome)) return null;
    const idx = Number(normalizedOutcome);
    return Number.isFinite(idx) ? idx : null;
  })();
  if (indexFromNumber !== null) {
    if (indexFromNumber < 0 || indexFromNumber >= tokenIds.length) {
      throw new Error(`Outcome index out of range (0-${tokenIds.length - 1}).`);
    }
    return { outcome: outcomes[indexFromNumber], tokenID: tokenIds[indexFromNumber] };
  }

  const idx = outcomes.findIndex((entry) => entry.toLowerCase() === normalizedOutcome.toLowerCase());
  if (idx < 0) {
    throw new Error(`Outcome not found. Available: ${outcomes.join(', ')}`);
  }
  return { outcome: outcomes[idx], tokenID: tokenIds[idx] };
};

const formatGeoblockSummary = (payload) => {
  if (!payload || typeof payload !== 'object') return '(unknown)';
  const blocked = payload.blocked === true ? 'blocked' : payload.blocked === false ? 'allowed' : 'unknown';
  const country = payload.country ? String(payload.country) : 'n/a';
  const region = payload.region ? String(payload.region) : 'n/a';
  const ip = payload.ip ? String(payload.ip) : 'n/a';
  return `${blocked} country=${country} region=${region} ip=${ip}`;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  if (args.proxyUrls) {
    process.env.POLYMARKET_PROXY_LIST_URLS = normalize(args.proxyUrls);
  }

  const side = normalize(args.side).toLowerCase();
  if (side !== 'buy' && side !== 'sell') {
    throw new Error('Invalid --side (expected buy|sell).');
  }

  const amount = Number(args.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid --amount (expected a positive number).');
  }

  const price = args.price === null || args.price === undefined || args.price === '' ? null : Number(args.price);
  if (price !== null && (!Number.isFinite(price) || price <= 0 || price >= 1)) {
    throw new Error('Invalid --price (expected a number between 0 and 1).');
  }

  const willSubmit = args.confirm === true;
  process.env.POLYMARKET_EXECUTION_MODE = willSubmit ? 'live' : 'paper';

  if (args.refreshProxies) {
    const { refreshPolymarketProxyPool, getPolymarketProxyDebugInfo } = require('../services/polymarketProxyPoolService');
    const refreshResult = await refreshPolymarketProxyPool({ force: true, reason: 'manual' });
    const debug = getPolymarketProxyDebugInfo();
    console.log('- proxyPool refresh:', refreshResult?.ok ? 'ok' : 'failed', `proxies=${refreshResult?.proxies ?? 0}`);
    if (debug?.dynamic?.lastError) {
      console.log('- proxyPool lastError:', String(debug.dynamic.lastError).slice(0, 240));
    }
  }

  const marketInfo = { question: null, slug: null, id: null, outcome: null };

  let tokenID = normalize(args.token);
  if (!tokenID) {
    const slug = normalize(args.slug);
    const id = normalize(args.marketId);
    const market = await fetchGammaMarket({ slug: slug || null, id: id || null });
    marketInfo.question = market?.question ? String(market.question).trim() : null;
    marketInfo.slug = market?.slug ? String(market.slug).trim() : slug || null;
    marketInfo.id = market?.id ? String(market.id).trim() : id || null;
    const picked = pickTokenIdFromMarket(market, args.outcome);
    tokenID = picked.tokenID;
    marketInfo.outcome = picked.outcome;
  }

  console.log('[Polymarket Test Trade]');
  if (marketInfo.question) console.log('- market:', marketInfo.question);
  if (marketInfo.slug) console.log('- slug:', marketInfo.slug);
  if (marketInfo.id) console.log('- marketId:', marketInfo.id);
  if (marketInfo.outcome) console.log('- outcome:', marketInfo.outcome);
  console.log('- tokenID:', tokenID);
  console.log('- side:', side.toUpperCase());
  console.log('-', side === 'buy' ? 'amount (USDC):' : 'amount (shares):', amount);
  if (price !== null) console.log('- price:', price);
  console.log('- execution mode:', process.env.POLYMARKET_EXECUTION_MODE);

  const geo = await fetchGeoblock();
  console.log('- geoblock:', geo.ok ? formatGeoblockSummary(geo.data) : `unavailable (status ${geo.status ?? 'n/a'})`);
  if (willSubmit) {
    if (!geo.ok) {
      throw new Error('Geoblock check failed; refusing to submit a live order.');
    }
    if (geo.data?.blocked === true) {
      throw new Error('Polymarket reports this IP is geoblocked; refusing to submit a live order.');
    }
  }

  const {
    getPolymarketExecutionDebugInfo,
    getPolymarketBalanceAllowance,
    executePolymarketMarketOrder,
  } = require('../services/polymarketExecutionService');

  const debug = getPolymarketExecutionDebugInfo();
  console.log('- env: l2CredsPresent=', Boolean(debug.l2CredsPresent), 'authMatchesPrivateKey=', Boolean(debug.authMatchesPrivateKey));
  if (debug.proxy?.configured) {
    console.log('- env: proxy configured=', true, 'source=', debug.proxy.source, 'host=', debug.proxy.host, 'port=', debug.proxy.port);
  }

  try {
    const balance = await getPolymarketBalanceAllowance();
    if (balance?.balance !== null && balance?.balance !== undefined) {
      console.log('- onchain USDC balance:', balance.balance);
      console.log('- onchain USDC allowance:', balance.allowance);
    }
  } catch (error) {
    console.log('- onchain USDC balance/allowance: error', String(error?.message || error));
  }

  const result = await executePolymarketMarketOrder({
    tokenID,
    side: side.toUpperCase(),
    amount,
    ...(price !== null ? { price } : {}),
  });

  if (result.dryRun) {
    console.log('- result: dry-run (no order submitted)');
    return;
  }

  const orderId =
    result?.response?.orderID ||
    result?.response?.orderId ||
    result?.response?.order_id ||
    result?.response?.id ||
    null;
  console.log('- result: submitted');
  if (orderId) {
    console.log('- orderId:', orderId);
  }
};

main().catch((err) => {
  console.error('[Polymarket Test Trade] Failed:', err?.message || err);
  process.exitCode = 1;
});
