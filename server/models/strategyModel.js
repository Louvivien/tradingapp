const mongoose = require('mongoose');
const Schema = mongoose.Schema;


const strategySchema = new Schema({
  name: {
    type: String,
    required: true,
    unique: true,
  },
  strategy: {
    type: String,
    required: true,
  },
  strategy_id: {
    type: String, 
    required: true,
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
});


const Strategy = mongoose.model("Strategy", strategySchema);
module.exports = Strategy;
