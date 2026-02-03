/* eslint-disable no-console */
/**
 * Force trade execution (bypasses geoblock check)
 *
 * WARNING: This script bypasses geoblock safety checks.
 * Use only when you know a working proxy is configured.
 *
 * Usage:
 *   node scripts/polymarket_force_trade.js --slug <market-slug> --outcome <Yes|No> --side <buy|sell> --amount <N>
 */

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../config/.env') });

const normalize = (value) => String(value || '').trim();

const parseArgs = (argv) => {
  const args = {
    slug: null,
    outcome: null,
    side: 'buy',
    amount: 1,
    price: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--slug') {
      args.slug = argv[i + 1];
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
  }

  return args;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  console.log('[Polymarket Force Trade]');
  console.log('WARNING: Bypassing geoblock check - ensure proxy is configured!');
  console.log('');

  // Force live mode
  process.env.POLYMARKET_EXECUTION_MODE = 'live';

  const { executePolymarketMarketOrder, getPolymarketExecutionDebugInfo } = require('../services/polymarketExecutionService');
  const axios = require('axios');

  // Fetch market info
  console.log('- Fetching market info...');
  const marketRes = await axios.get('https://gamma-api.polymarket.com/markets', {
    params: { slug: args.slug },
    timeout: 15000,
  });

  if (!marketRes.data || !marketRes.data.length) {
    throw new Error('Market not found');
  }

  const market = marketRes.data[0];

  // Parse outcomes and token IDs
  const outcomes = JSON.parse(market.outcomes || '[]');
  const tokenIds = JSON.parse(market.clobTokenIds || '[]');

  const outcomeIndex = outcomes.findIndex(o => o.toLowerCase() === args.outcome.toLowerCase());
  if (outcomeIndex < 0) {
    throw new Error(`Outcome "${args.outcome}" not found. Available: ${outcomes.join(', ')}`);
  }

  const tokenID = tokenIds[outcomeIndex];
  const outcome = outcomes[outcomeIndex];

  console.log('- Market:', market.question);
  console.log('- Outcome:', outcome);
  console.log('- Token ID:', tokenID);
  console.log('- Side:', args.side.toUpperCase());
  console.log('- Amount:', args.amount, args.side === 'buy' ? 'USDC' : 'shares');
  if (args.price) console.log('- Price:', args.price);

  const debug = getPolymarketExecutionDebugInfo();
  console.log('- L2 Creds Present:', debug.l2CredsPresent || false);
  console.log('- Auth Matches Private Key:', debug.authMatchesPrivateKey || false);
  console.log('- Proxy Configured:', debug.proxy?.configured || false);
  if (debug.proxy?.configured) {
    console.log('- Proxy:', `${debug.proxy.host}:${debug.proxy.port}`);
  }
  console.log('');

  console.log('Executing trade...');
  const result = await executePolymarketMarketOrder({
    tokenID,
    side: args.side.toUpperCase(),
    amount: Number(args.amount),
    ...(args.price ? { price: Number(args.price) } : {}),
  });

  if (result.dryRun) {
    console.log('✗ Trade was executed in dry-run mode (not submitted)');
    return;
  }

  const orderId = result?.response?.orderID || result?.response?.orderId || result?.response?.id || null;
  console.log('✓ Trade submitted successfully!');
  if (orderId) {
    console.log('- Order ID:', orderId);
  }
  if (result.response) {
    console.log('- Response summary:', {
      orderID: result.response.orderID || result.response.orderId,
      status: result.response.status,
      type: result.response.type
    });
  }
};

main().catch((err) => {
  console.error('[Polymarket Force Trade] Failed:', err?.message || String(err));
  if (err?.response?.data) {
    try {
      console.error('API Error:', JSON.stringify(err.response.data, null, 2));
    } catch {
      console.error('API Error (cannot stringify):', err.response.status, err.response.statusText);
    }
  }
  process.exitCode = 1;
});
