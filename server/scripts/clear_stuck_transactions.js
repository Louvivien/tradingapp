#!/usr/bin/env node
/**
 * Clear stuck pending transactions by replacing them with 0-value self-transfers
 * Usage: cd tradingapp/server && node scripts/clear_stuck_transactions.js
 */

require('dotenv').config({ path: __dirname + '/../config/.env' });

const { Wallet, providers, utils } = require('ethers');
const fs = require('fs');

const rpc = process.env.POLYMARKET_RPC_URL || 'https://polygon-rpc.com';

// Support both POLYMARKET_PRIVATE_KEY and POLYMARKET_PRIVATE_KEY_FILE
let pk = process.env.POLYMARKET_PRIVATE_KEY;

if (!pk && process.env.POLYMARKET_PRIVATE_KEY_FILE) {
  const keyFile = process.env.POLYMARKET_PRIVATE_KEY_FILE;
  try {
    const content = fs.readFileSync(keyFile, 'utf8');
    pk = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0];
    console.log('Loaded private key from file:', keyFile);
  } catch (e) {
    console.error('ERROR: Could not read POLYMARKET_PRIVATE_KEY_FILE:', keyFile);
    console.error(e.message);
    process.exit(1);
  }
}

if (!pk) {
  console.error('ERROR: Neither POLYMARKET_PRIVATE_KEY nor POLYMARKET_PRIVATE_KEY_FILE is set in config/.env');
  process.exit(1);
}

// Normalize private key format
if (pk && !pk.startsWith('0x') && /^[a-fA-F0-9]{64}$/.test(pk)) {
  pk = '0x' + pk;
}

const provider = new providers.JsonRpcProvider(rpc, 137);
const wallet = new Wallet(pk, provider);

console.log('\n=== Clear Stuck Transactions ===\n');
console.log('Wallet:', wallet.address);
console.log('RPC:', rpc.replace(/\/[^\/]+$/, '/***'));
console.log('');

(async () => {
  try {
    const confirmedNonce = await provider.getTransactionCount(wallet.address, 'latest');
    const pendingNonce = await provider.getTransactionCount(wallet.address, 'pending');
    const stuckCount = pendingNonce - confirmedNonce;

    console.log('Confirmed nonce:', confirmedNonce);
    console.log('Pending nonce:', pendingNonce);
    console.log('Stuck transactions:', stuckCount);
    console.log('');

    if (stuckCount === 0) {
      console.log('No stuck transactions. Queue is clear!');
      return;
    }

    console.log(`Replacing ${stuckCount} stuck transactions with 300 gwei gas...\n`);

    const txHashes = [];
    for (let nonce = confirmedNonce; nonce < pendingNonce; nonce++) {
      process.stdout.write(`Nonce ${nonce}: `);
      try {
        const tx = await wallet.sendTransaction({
          to: wallet.address,
          value: 0,
          nonce: nonce,
          maxFeePerGas: utils.parseUnits('300', 'gwei'),
          maxPriorityFeePerGas: utils.parseUnits('150', 'gwei'),
          gasLimit: 21000,
        });
        console.log(`sent ${tx.hash}`);
        txHashes.push({ nonce, hash: tx.hash });
      } catch (e) {
        const msg = e.message || String(e);
        if (msg.includes('nonce has already been used') || msg.includes('already known')) {
          console.log('already processed or pending');
        } else if (msg.includes('replacement fee too low')) {
          console.log('replacement fee too low - need higher gas');
        } else {
          console.log('error:', msg.slice(0, 100));
        }
      }
    }

    if (txHashes.length > 0) {
      console.log('\nWaiting for confirmations (30s timeout each)...\n');
      for (const { nonce, hash } of txHashes) {
        process.stdout.write(`Nonce ${nonce}: `);
        try {
          const receipt = await Promise.race([
            provider.waitForTransaction(hash, 1),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000))
          ]);
          console.log(`confirmed (block ${receipt.blockNumber})`);
        } catch (e) {
          console.log(`pending - check https://polygonscan.com/tx/${hash}`);
        }
      }
    }

    console.log('\nDone! Checking final state...');
    const finalConfirmed = await provider.getTransactionCount(wallet.address, 'latest');
    const finalPending = await provider.getTransactionCount(wallet.address, 'pending');
    console.log('Confirmed nonce:', finalConfirmed);
    console.log('Pending nonce:', finalPending);
    console.log('Remaining stuck:', finalPending - finalConfirmed);

  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
