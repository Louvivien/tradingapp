const mongoose = require('mongoose');
const Schema = mongoose.Schema;

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

const StrategyLog = mongoose.model('StrategyLog', strategyLogSchema);
module.exports = StrategyLog;
