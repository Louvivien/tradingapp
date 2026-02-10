#!/usr/bin/env node
/**
 * Test script for Polymarket auto-redeem functionality
 * Usage: node scripts/test_auto_redeem.js
 */

require('dotenv').config({ path: './config/.env' });

const { redeemPolymarketWinnings, getPolymarketExecutionDebugInfo } = require('../services/polymarketExecutionService');

async function main() {
  console.log('\n=== Polymarket Auto-Redeem Test ===\n');

  // Show current config
  const debugInfo = getPolymarketExecutionDebugInfo();
  console.log('Execution mode:', debugInfo.mode);
  console.log('Chain ID:', debugInfo.chainId);
  console.log('RPC configured:', debugInfo.host ? 'yes' : 'no');
  console.log('Private key present:', debugInfo.privateKey?.rawPresent ? 'yes' : 'no');
  console.log('Signer address:', debugInfo.privateKey?.derivedAddress || 'N/A');
  console.log('Auto-redeem enabled:', process.env.POLYMARKET_AUTO_REDEEM === 'true' ? 'yes' : 'no');
  console.log('');

  if (debugInfo.mode !== 'live') {
    console.log('⚠️  Not in live mode. Set POLYMARKET_EXECUTION_MODE=live to test actual redemptions.');
    console.log('   Running in dry-run mode...\n');
  }

  // Mock positions for testing - you can replace with real condition IDs
  // These are example resolved markets (you'd need real ones for actual redemption)
  const mockPositions = [
    // Add your actual position data here if you have any
    // { market: '0x...conditionId', outcome: 'Yes', quantity: 10 }
  ];

  console.log('Testing redeemPolymarketWinnings with', mockPositions.length, 'positions...\n');

  try {
    const result = await redeemPolymarketWinnings(mockPositions, { enabled: true });
    console.log('Result:', JSON.stringify(result, null, 2));

    if (result.ok && result.txHash) {
      console.log('\n✅ Success! Transaction:', `https://polygonscan.com/tx/${result.txHash}`);
    } else if (result.skipped) {
      console.log('\n⏭️  Skipped:', result.reason);
    } else if (result.redeemed === 0) {
      console.log('\nℹ️  No positions to redeem:', result.reason);
    }
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.message.includes('gas')) {
      console.log('\n   Gas-related error. Check POLYMARKET_REDEEM_MAX_FEE_GWEI settings.');
    }
  }
}

main().catch(console.error);
