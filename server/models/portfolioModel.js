const mongoose = require('mongoose');
const Schema = mongoose.Schema;


const portfolioSchema = new Schema({
  userId: {
    type: String,
    required: false,
    index: true,
  },
  budget: {
    type: Number,
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
  stocks: [{
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
      required: false,
      default: null, 
    },
    quantity: {
      type: Number,
      required: true,
    },
  }],
});

const Portfolio = mongoose.model("Portfolio", portfolioSchema);
module.exports = Portfolio;
