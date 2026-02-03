const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../config/.env') });

// Force live mode
process.env.POLYMARKET_EXECUTION_MODE = 'live';
process.env.POLYMARKET_PROXY_LIST_ENABLED = 'false';

const main = async () => {
  console.log('[Polymarket Simple Trade]');
  console.log('');

  const { executePolymarketMarketOrder, getPolymarketExecutionDebugInfo } = require('../services/polymarketExecutionService');

  const debug = getPolymarketExecutionDebugInfo();
  console.log('Config:');
  console.log('  L2 Creds:', debug.l2CredsPresent ? 'YES' : 'NO');
  console.log('  Auth Match:', debug.authMatchesPrivateKey ? 'YES' : 'NO');
  console.log('  Proxy:', debug.proxy?.configured ? debug.proxy.host + ':' + debug.proxy.port : 'NONE');
  console.log('');

  const tokenID = '101676997363687199724245607342877036148401850938023978421879460310389391082353';

  console.log('Executing trade...');
  console.log('  Market: Will Trump deport less than 250,000?');
  console.log('  Outcome: Yes');
  console.log('  Side: BUY');
  console.log('  Amount: 0.25 USDC');
  console.log('');

  try {
    const result = await executePolymarketMarketOrder({
      tokenID,
      side: 'BUY',
      amount: 0.25
    });

    if (result.dryRun) {
      console.log('Result: DRY-RUN (not submitted)');
      return;
    }

    const orderId = result?.response?.orderID || result?.response?.orderId || result?.response?.id;
    console.log('✓ SUCCESS!');
    console.log('  Order ID:', orderId || 'unknown');
    console.log('');
    console.log('Check your account at: https://polymarket.com/');
  } catch (error) {
    console.log('✗ FAILED:', error.message || 'Unknown error');
    console.log('');

    // Log error details without circular refs
    if (error.code) console.log('  Error Code:', error.code);
    if (error.status) console.log('  Status:', error.status);
  }
};

main().catch((err) => {
  console.error('Fatal error:', err.message || String(err));
  process.exitCode = 1;
});
