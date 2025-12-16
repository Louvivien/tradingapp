const mongoose = require('mongoose');
const Schema = mongoose.Schema;


const portfolioSchema = new Schema({
  userId: {
    type: String,
    index: true,
    required: false,
  },
  name: {
    type: String,
    required: true,
  },
  strategy_id: {
    type: String,
    ref: 'Strategy',
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
      'monthly'
    ],
    default: 'daily',
  },
  initialInvestment: {
    type: Number,
    default: 0,
  },
  cashBuffer: {
    type: Number,
    default: 0,
  },
  retainedCash: {
    type: Number,
    default: 0,
  },
  lastRebalancedAt: {
    type: Date,
    default: null,
  },
  nextRebalanceAt: {
    type: Date,
    default: null,
    index: true,
  },
  targetPositions: {
    type: [{
      symbol: {
        type: String,
        required: true,
      },
      targetQuantity: {
        type: Number,
        default: null,
      },
      targetValue: {
        type: Number,
        default: null,
      },
      targetWeight: {
        type: Number,
        default: null,
      },
    }],
    default: [],
  },
  stocks: {
    type: [{
      symbol: {
        type: String,
        required: true,
      },
      orderID: {
        type: String,
        required: true,
      },
      avgCost: {
        type: Number,
        default: null,
      },
      quantity: {
        type: Number,
        required: true,
      },
      currentPrice: {
        type: Number,
        default: null,
      },
    }],
    default: [],
  },
  budget: {
    type: Number,
    required: false,
  },
  cashLimit: {
    type: Number,
    required: false,
    default: null,
  },
  rebalanceCount: {
    type: Number,
    default: 0,
  },
  pnlValue: {
    type: Number,
    default: 0,
  },
  pnlPercent: {
    type: Number,
    default: 0,
  },
  realizedPnlValue: {
    type: Number,
    default: 0,
  },
  lastPerformanceComputedAt: {
    type: Date,
    default: null,
  },
});

const Portfolio = mongoose.model("Portfolio", portfolioSchema);
module.exports = Portfolio;
