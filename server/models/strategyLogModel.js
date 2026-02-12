const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const parseTtlDays = (value, defaultDays) => {
  if (value == null) {
    return defaultDays;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return defaultDays;
  }
  if (parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
};

// Keep strategy logs bounded to avoid filling up small MongoDB tiers (ex: Atlas M0 512MB).
// Set STRATEGY_LOG_TTL_DAYS<=0 to disable TTL (not recommended).
const STRATEGY_LOG_TTL_DAYS = parseTtlDays(process.env.STRATEGY_LOG_TTL_DAYS, 14);

const strategyLogSchema = new Schema(
  {
    strategy_id: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    strategyName: {
      type: String,
      required: false,
    },
    level: {
      type: String,
      enum: ['info', 'warn', 'error'],
      default: 'info',
    },
    message: {
      type: String,
      required: true,
    },
    details: {
      type: Schema.Types.Mixed,
      required: false,
    },
  },
  {
    timestamps: true,
  }
);

strategyLogSchema.index({ userId: 1, strategy_id: 1, createdAt: -1 });
strategyLogSchema.index({ userId: 1, createdAt: -1 });
if (STRATEGY_LOG_TTL_DAYS) {
  strategyLogSchema.index(
    { createdAt: 1 },
    { expireAfterSeconds: STRATEGY_LOG_TTL_DAYS * 24 * 60 * 60 }
  );
}

const StrategyLog = mongoose.model('StrategyLog', strategyLogSchema);
module.exports = StrategyLog;
