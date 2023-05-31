const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const newsSchema = new Schema({
    newsId: {
        type: String,
        required: true,
    },
    "News headline": {
        type: String,
        required: true
    },
    Date: {
        type: Date,
        required: true
    },
    Ticker: {
        type: [String],
        required: true
    },
    "Stock name": {
        type: String,
        required: true
    },
    Source: {
        type: String,
        required: true
    }
});

const News = mongoose.model("News", newsSchema);
module.exports = News;




