const mongoose = require('mongoose');
const { Schema } = mongoose;

const strategyTemplateSchema = new Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    strategy: {
      type: String,
      required: true,
    },
    summary: {
      type: String,
      default: '',
    },
    decisions: {
      type: [Schema.Types.Mixed],
      default: [],
    },
    recurrence: {
      type: String,
      default: 'daily',
    },
    strategyId: {
      type: String,
      default: null,
    },
    lastUsedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

strategyTemplateSchema.index(
  { userId: 1, name: 1 },
  { unique: true }
);

const StrategyTemplate = mongoose.model('StrategyTemplate', strategyTemplateSchema);

module.exports = StrategyTemplate;
