const mongoose = require('mongoose');

const { Schema } = mongoose;

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

// Keep equity snapshots bounded to avoid filling up small MongoDB tiers.
// Set STRATEGY_EQUITY_SNAPSHOT_TTL_DAYS<=0 to disable TTL.
const STRATEGY_EQUITY_SNAPSHOT_TTL_DAYS = parseTtlDays(
  process.env.STRATEGY_EQUITY_SNAPSHOT_TTL_DAYS,
  180
);

const strategyEquitySnapshotSchema = new Schema(
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
    portfolioId: {
      type: Schema.Types.ObjectId,
      ref: 'Portfolio',
      required: false,
    },
    strategyName: {
      type: String,
      required: false,
    },
    equityValue: {
      type: Number,
      required: true,
    },
    holdingsMarketValue: {
      type: Number,
      required: true,
    },
    retainedCash: {
      type: Number,
      required: true,
    },
    cashLimit: {
      type: Number,
      required: false,
      default: null,
    },
    pnlValue: {
      type: Number,
      required: false,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

strategyEquitySnapshotSchema.index({ strategy_id: 1, createdAt: -1 });
strategyEquitySnapshotSchema.index({ userId: 1, createdAt: -1 });
if (STRATEGY_EQUITY_SNAPSHOT_TTL_DAYS) {
  strategyEquitySnapshotSchema.index(
    { createdAt: 1 },
    { expireAfterSeconds: STRATEGY_EQUITY_SNAPSHOT_TTL_DAYS * 24 * 60 * 60 }
  );
}

const StrategyEquitySnapshot = mongoose.model('StrategyEquitySnapshot', strategyEquitySnapshotSchema);

module.exports = StrategyEquitySnapshot;
