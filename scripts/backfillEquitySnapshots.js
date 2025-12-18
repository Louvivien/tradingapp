#!/usr/bin/env node

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(__dirname, '../server/config/.env') });

const { runEquityBackfill } = require('../server/services/equityBackfillService');

const MONGO_URI = process.env.MONGO_URI || process.env.DB || process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error('Missing Mongo connection string (MONGO_URI/DB/MONGODB_URI).');
  process.exit(1);
}

const force = process.argv.includes('--force');

const main = async () => {
  await mongoose.connect(MONGO_URI, { autoIndex: false });
  console.log('[Backfill CLI] Connected to Mongo');

  try {
    const result = await runEquityBackfill({ initiatedBy: 'cli-script', force });
    console.log('[Backfill CLI] Result:', result);
  } catch (error) {
    console.error('[Backfill CLI] Failed:', error);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log('[Backfill CLI] Disconnected from Mongo');
  }
};

main().catch(() => process.exit(1));
