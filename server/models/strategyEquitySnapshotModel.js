const mongoose = require('mongoose');

const { Schema } = mongoose;

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

const StrategyEquitySnapshot = mongoose.model('StrategyEquitySnapshot', strategyEquitySnapshotSchema);

module.exports = StrategyEquitySnapshot;
