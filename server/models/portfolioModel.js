const mongoose = require('mongoose');
const Schema = mongoose.Schema;


const portfolioSchema = new Schema({
  name: {
    type: String,
    required: true,
  },
  strategy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Strategy',
  },
  stocks: [{
    symbol: {
      type: String,
      required: true,
    },
    avgCost: {
      type: Number,
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
    },
  }],
});

const Portfolio = mongoose.model("Portfolio", portfolioSchema);
module.exports = Portfolio;


