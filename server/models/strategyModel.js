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
});


const Strategy = mongoose.model("Strategy", strategySchema);
module.exports = Strategy;
