#!/usr/bin/env node

const path = require('path');
const mongoose = require('mongoose');
const StrategyLog = require('../server/models/strategyLogModel');
const StrategyEquitySnapshot = require('../server/models/strategyEquitySnapshotModel');
const Portfolio = require('../server/models/portfolioModel');
require('dotenv').config({ path: path.resolve(__dirname, '../server/config/.env') });

const MONGO_URI = process.env.MONGO_URI || process.env.DB || process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error('Missing Mongo connection string (MONGO_URI/DB/MONGODB_URI).');
  process.exit(1);
}

const roundToTwo = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  return Math.round((num + Number.EPSILON) * 100) / 100;
};

const sumCurrentValues = (adjustments = []) => {
  return adjustments.reduce((sum, entry) => {
    const value = Number(entry?.currentValue);
    if (Number.isFinite(value) && value > 0) {
      return sum + value;
    }
    return sum;
  }, 0);
};

const getRetainedCash = (details = {}) => {
  const direct = Number(details?.cashBuffer);
  if (Number.isFinite(direct)) {
    return direct;
  }
  const summary = Number(details?.thoughtProcess?.cashSummary?.cashBuffer);
  if (Number.isFinite(summary)) {
    return summary;
  }
  return 0;
};

const main = async () => {
  await mongoose.connect(MONGO_URI, { autoIndex: false });
  console.log('[Backfill] Connected to Mongo');

  const portfolios = await Portfolio.find({}, { strategy_id: 1, cashLimit: 1 }).lean();
  const strategyLimitMap = new Map();
  portfolios.forEach((portfolio) => {
    if (portfolio?.strategy_id) {
      strategyLimitMap.set(String(portfolio.strategy_id), Number(portfolio.cashLimit) || null);
    }
  });

  const cursor = StrategyLog.find({ message: 'Portfolio rebalanced' })
    .sort({ createdAt: 1 })
    .cursor();

  let createdCount = 0;
  let skippedCount = 0;

  for await (const log of cursor) {
    const strategyId = String(log.strategy_id || '');
    const userId = String(log.userId || '');
    if (!strategyId || !userId) {
      skippedCount += 1;
      continue;
    }

    const existing = await StrategyEquitySnapshot.findOne({
      strategy_id: strategyId,
      userId,
      createdAt: log.createdAt,
    }).lean();

    if (existing) {
      skippedCount += 1;
      continue;
    }

    const details = log.details || {};
    const adjustments = details?.thoughtProcess?.adjustments || [];
    let holdingsValue = sumCurrentValues(adjustments);

    if (!holdingsValue && Number.isFinite(details?.budget)) {
      holdingsValue = Number(details.budget);
    }

    if (!Number.isFinite(holdingsValue) || holdingsValue <= 0) {
      skippedCount += 1;
      continue;
    }

    const retainedCash = getRetainedCash(details);
    const holdingsRounded = roundToTwo(holdingsValue) || 0;
    const retainedRounded = Math.max(0, roundToTwo(retainedCash) || 0);
    const equityValue = roundToTwo(holdingsRounded + retainedRounded);

    if (!Number.isFinite(equityValue)) {
      skippedCount += 1;
      continue;
    }

    const snapshot = new StrategyEquitySnapshot({
      strategy_id: strategyId,
      userId,
      portfolioId: log.portfolioId || null,
      strategyName: log.strategyName || null,
      equityValue,
      holdingsMarketValue: holdingsRounded,
      retainedCash: retainedRounded,
      cashLimit: strategyLimitMap.get(strategyId) || null,
      pnlValue: details?.pnlValue != null ? Number(details.pnlValue) : null,
      createdAt: log.createdAt,
      updatedAt: log.createdAt,
    });

    await snapshot.save();
    createdCount += 1;
  }

  console.log(`[Backfill] Created ${createdCount} snapshots, skipped ${skippedCount}.`);
  await mongoose.disconnect();
  console.log('[Backfill] Done.');
};

main().catch((error) => {
  console.error('[Backfill] Failed:', error);
  mongoose.disconnect().finally(() => process.exit(1));
});
