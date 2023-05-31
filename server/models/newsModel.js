const mongoose = require('mongoose');

const newsSchema = new mongoose.Schema({
    newsId: {
        type: String,
        required: true,
        unique: true
      },
    title: {
        type: String,
        required: true
    },
    date: {
        type: Date,
        required: true
    },
    category: String,
    tickers: [String],
    sentiment: String,
    source: {
        type: String,
        required: true
    }
});

module.exports = mongoose.model('News', newsSchema);
