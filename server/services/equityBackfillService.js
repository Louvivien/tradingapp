const StrategyLog = require('../models/strategyLogModel');
const StrategyEquitySnapshot = require('../models/strategyEquitySnapshotModel');
const MaintenanceTask = require('../models/maintenanceTaskModel');
const Portfolio = require('../models/portfolioModel');

const TASK_NAME = 'strategy_equity_backfill';

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
  const summaryValue = Number(details?.thoughtProcess?.cashSummary?.cashBuffer);
  if (Number.isFinite(summaryValue)) {
    return summaryValue;
  }
  return 0;
};

const runEquityBackfill = async ({ initiatedBy = null, force = false } = {}) => {
  const now = new Date();
  const existingTask = await MaintenanceTask.findOne({ taskName: TASK_NAME });

  if (existingTask && existingTask.status === 'running' && !force) {
    return {
      status: 'skipped',
      reason: 'already_running',
      message: 'Equity backfill is already in progress.',
    };
  }

  if (existingTask && existingTask.status === 'completed' && !force) {
    return {
      status: 'skipped',
      reason: 'already_completed',
      message: 'Equity backfill already completed.',
      summary: existingTask.metadata || null,
    };
  }

  await MaintenanceTask.findOneAndUpdate(
    { taskName: TASK_NAME },
    {
      taskName: TASK_NAME,
      status: 'running',
      initiatedBy,
      startedAt: now,
      completedAt: null,
      lastError: null,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

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

  try {
    for await (const log of cursor) {
      const strategyId = String(log.strategy_id || '');
      const userId = String(log.userId || '');
      if (!strategyId || !userId) {
        skippedCount += 1;
        continue;
      }

      const existingSnapshot = await StrategyEquitySnapshot.findOne({
        strategy_id: strategyId,
        userId,
        createdAt: log.createdAt,
      }).lean();

      if (existingSnapshot) {
        skippedCount += 1;
        continue;
      }

      const details = log.details || {};
      const adjustments = details?.thoughtProcess?.adjustments || [];
      let holdingsValue = sumCurrentValues(adjustments);

      if ((!holdingsValue || holdingsValue <= 0) && Number.isFinite(details?.budget)) {
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

    await MaintenanceTask.findOneAndUpdate(
      { taskName: TASK_NAME },
      {
        status: 'completed',
        completedAt: new Date(),
        metadata: { createdCount, skippedCount },
        lastError: null,
      }
    );

    return {
      status: 'completed',
      createdCount,
      skippedCount,
    };
  } catch (error) {
    await MaintenanceTask.findOneAndUpdate(
      { taskName: TASK_NAME },
      {
        status: 'failed',
        completedAt: new Date(),
        lastError: error.message,
      }
    );
    throw error;
  }
};

module.exports = {
  runEquityBackfill,
  TASK_NAME,
};
