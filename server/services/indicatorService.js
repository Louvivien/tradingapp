const { getCachedPrices } = require('./priceCacheService');

const LOOKBACK_DAYS = 420;
const MIN_CLOSES_FOR_SMA = 100;
const MIN_RETURNS_FOR_MA10 = 10;
const MIN_RETURNS_FOR_STD63 = 63;

const average = (values = []) => {
  if (!values.length) {
    throw new Error('Cannot compute average of an empty series.');
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const standardDeviation = (values = []) => {
  if (!values.length) {
    throw new Error('Cannot compute deviation of an empty series.');
  }
  const mean = average(values);
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

const computeReturns = (closes = []) => {
  const returns = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const current = closes[i];
    if (!Number.isFinite(prev) || !Number.isFinite(current) || prev === 0) {
      continue;
    }
    returns.push((current - prev) / prev);
  }
  return returns;
};

const sliceFromEnd = (series, count) => {
  if (series.length < count) {
    throw new Error(`Series requires at least ${count} points.`);
  }
  return series.slice(series.length - count);
};

const fetchCloses = async (symbol) => {
  const uppercaseSymbol = String(symbol || '').trim().toUpperCase();
  if (!uppercaseSymbol) {
    throw new Error('Ticker symbol is required.');
  }
  const end = new Date();
  const start = new Date(end.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const cache = await getCachedPrices({
    symbol: uppercaseSymbol,
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  });
  const closes = (cache.bars || [])
    .map((bar) => Number(bar.c))
    .filter((value) => Number.isFinite(value));

  if (closes.length < MIN_CLOSES_FOR_SMA + 1) {
    throw new Error('Not enough historical closes to compute indicators.');
  }

  return {
    symbol: uppercaseSymbol,
    closes,
    meta: {
      rangeStart: cache.start,
      rangeEnd: cache.end,
      lookbackDays: LOOKBACK_DAYS,
      granularity: cache.granularity,
      refreshedAt: cache.refreshedAt,
    },
  };
};

const computeWorkflowIndicators = async (symbol) => {
  const { symbol: uppercaseSymbol, closes, meta } = await fetchCloses(symbol);
  const returns = computeReturns(closes);

  if (returns.length < Math.max(MIN_RETURNS_FOR_MA10, MIN_RETURNS_FOR_STD63)) {
    throw new Error('Not enough historical returns to compute indicators.');
  }

  const ma100 = average(sliceFromEnd(closes, MIN_CLOSES_FOR_SMA));
  const ma10Return = average(sliceFromEnd(returns, MIN_RETURNS_FOR_MA10));
  const stdev63 = standardDeviation(sliceFromEnd(returns, MIN_RETURNS_FOR_STD63));

  return {
    symbol: uppercaseSymbol,
    ma10_return: ma10Return,
    stdev63_return: stdev63,
    ma100_close: ma100,
    data_source: 'alpaca-cache',
    meta,
  };
};

module.exports = {
  computeWorkflowIndicators,
};
