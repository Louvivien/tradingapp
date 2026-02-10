const mongoose = require('mongoose');

const parseTtlDays = (value, defaultDays) => {
  if (value == null) {
    return defaultDays;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return defaultDays;
  }
  if (parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
};

// Expire unused price-cache docs to keep MongoDB storage bounded.
// Note: this is separate from the in-app freshness check (CACHE_TTL_HOURS in priceCacheService).
// Set PRICE_CACHE_DB_TTL_DAYS<=0 to disable TTL.
const PRICE_CACHE_DB_TTL_DAYS = parseTtlDays(process.env.PRICE_CACHE_DB_TTL_DAYS, 30);

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
if (PRICE_CACHE_DB_TTL_DAYS) {
  priceCacheSchema.index(
    { refreshedAt: 1 },
    { expireAfterSeconds: PRICE_CACHE_DB_TTL_DAYS * 24 * 60 * 60 }
  );
}

const PriceCache = mongoose.model('PriceCache', priceCacheSchema);

module.exports = PriceCache;
