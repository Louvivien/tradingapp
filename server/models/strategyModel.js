const mongoose = require('mongoose');
const Schema = mongoose.Schema;


const strategySchema = new Schema(
  {
    userId: {
      type: String,
      index: true,
      default: null,
    },
    provider: {
      type: String,
      index: true,
      default: 'alpaca',
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
    strategy_id: {
      type: String,
      required: true,
    },
    summary: {
      type: String,
      default: '',
      trim: true,
    },
    decisions: {
      type: [Schema.Types.Mixed],
      default: [],
    },
    recurrence: {
      type: String,
      enum: [
        'every_minute',
        'every_5_minutes',
        'every_15_minutes',
        'hourly',
        'daily',
        'weekly',
        'monthly',
      ],
      default: 'daily',
    },
    symphonyUrl: {
      type: String,
      default: null,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

strategySchema.index(
  { userId: 1, name: 1 },
  {
    unique: true,
    partialFilterExpression: { userId: { $exists: true, $ne: null } },
  }
);


const Strategy = mongoose.model("Strategy", strategySchema);
module.exports = Strategy;
