const StrategyLog = require('../models/strategyLogModel');

const recordStrategyLog = async ({
  strategyId,
  userId,
  strategyName,
  level = 'info',
  message,
  details = null,
}) => {
  if (!strategyId || !userId || !message) {
    return;
  }

  try {
    await StrategyLog.create({
      strategy_id: strategyId,
      userId: String(userId),
      strategyName,
      level,
      message,
      details,
    });
  } catch (error) {
    console.error('[StrategyLog] Failed to record log:', error.message);
  }
};

module.exports = {
  recordStrategyLog,
};
