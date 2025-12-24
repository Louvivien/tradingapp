const mongoose = require('mongoose');

const barSchema = new mongoose.Schema(
  {
    t: { type: Date, required: true },
    o: { type: Number, required: true },
    h: { type: Number, required: true },
    l: { type: Number, required: true },
    c: { type: Number, required: true },
    v: { type: Number, required: true },
  },
  { _id: false }
);

const priceCacheSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, uppercase: true, index: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    granularity: { type: String, default: '1Day' },
    adjustment: { type: String, default: 'raw' },
    bars: { type: [barSchema], default: [] },
    refreshedAt: { type: Date, default: Date.now },
    dataSource: { type: String, default: 'alpaca' },
  },
  {
    timestamps: true,
  }
);

priceCacheSchema.index({ symbol: 1, granularity: 1, adjustment: 1 });

const PriceCache = mongoose.model('PriceCache', priceCacheSchema);

module.exports = PriceCache;
