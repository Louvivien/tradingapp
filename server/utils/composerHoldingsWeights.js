const { getCachedPrices, normalizeAdjustment } = require('../services/priceCacheService');

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const toISODateKey = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
};

const toEndOfDayUtc = (dateKey) => new Date(`${dateKey}T23:59:59.999Z`);

const addDaysUtc = (dateKey, days) => {
  if (!DATE_KEY_RE.test(String(dateKey || ''))) {
    return null;
  }
  const base = new Date(`${dateKey}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + Number(days || 0));
  return toISODateKey(base);
};

const holdingsObjectToRows = (holdingsObject) => {
  if (!isObject(holdingsObject)) {
    return [];
  }
  return Object.entries(holdingsObject)
    .map(([rawSymbol, rawAmount]) => {
      const symbol = String(rawSymbol || '').trim().toUpperCase();
      const amount = Number(rawAmount);
      if (!symbol || !Number.isFinite(amount)) return null;
      if (symbol === '$USD' || symbol === 'USD' || symbol === 'CASH') return null;
      if (amount <= 0) return null;
      return { symbol, amount };
    })
    .filter(Boolean)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
};

const sum = (values) => values.reduce((acc, value) => acc + value, 0);

const normalizeWeights = (rows) => {
  const total = sum(rows.map((row) => row.weight).filter((w) => Number.isFinite(w)));
  if (!Number.isFinite(total) || total <= 0) {
    return [];
  }
  return rows
    .map((row) => ({ symbol: row.symbol, weight: row.weight / total }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
};

const findBarCloseForDateKey = (bars, dateKey) => {
  if (!Array.isArray(bars) || !bars.length || !dateKey) {
    return null;
  }
  for (let idx = bars.length - 1; idx >= 0; idx -= 1) {
    const bar = bars[idx];
    const barKey = bar?.t ? toISODateKey(bar.t) : null;
    if (barKey === dateKey) {
      const close = Number(bar?.c);
      return Number.isFinite(close) && close > 0 ? close : null;
    }
    if (barKey && barKey < dateKey) {
      break;
    }
  }
  return null;
};

const fetchClosePriceOnDate = async ({
  symbol,
  dateKey,
  priceSource,
  adjustment,
  cacheOnly,
  forceRefresh,
}) => {
  if (!symbol) {
    throw new Error('Symbol is required for pricing.');
  }
  if (!DATE_KEY_RE.test(String(dateKey || ''))) {
    throw new Error(`Invalid date key "${dateKey}".`);
  }
  const end = toEndOfDayUtc(dateKey);
  const startKey = addDaysUtc(dateKey, -14);
  const start = startKey ? new Date(`${startKey}T00:00:00.000Z`) : new Date(end.getTime() - 14 * 86400 * 1000);
  const response = await getCachedPrices({
    symbol,
    startDate: start,
    endDate: end,
    adjustment: normalizeAdjustment(adjustment),
    source: priceSource,
    forceRefresh,
    minBars: 1,
    cacheOnly,
  });
  const close = findBarCloseForDateKey(response?.bars || [], dateKey);
  if (!close) {
    throw new Error(`Missing close price for ${symbol} on ${dateKey}.`);
  }
  return { close, dataSource: response?.dataSource || null };
};

const inferHoldingsUnits = ({ totalAmount, lastBacktestValue }) => {
  const lastValue = Number(lastBacktestValue);
  if (!Number.isFinite(lastValue) || lastValue <= 0) {
    return 'unknown';
  }
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    return 'unknown';
  }
  const rel = Math.abs(totalAmount - lastValue) / lastValue;
  if (rel <= 0.02) {
    return 'value';
  }
  return 'quantity';
};

const computeComposerHoldingsWeights = async ({
  holdingsObject,
  effectiveAsOfDateKey,
  lastBacktestValue,
  priceSource = null,
  dataAdjustment = 'all',
  cacheOnly = true,
  forceRefresh = false,
  concurrency = 4,
}) => {
  const rows = holdingsObjectToRows(holdingsObject);
  if (!rows.length) {
    return {
      holdings: [],
      meta: {
        units: 'unknown',
        totalAmount: 0,
        totalValue: 0,
        effectiveAsOfDateKey: effectiveAsOfDateKey || null,
        lastBacktestValue: Number.isFinite(Number(lastBacktestValue)) ? Number(lastBacktestValue) : null,
        pricedBy: null,
        prices: {},
      },
    };
  }

  const dateKey = DATE_KEY_RE.test(String(effectiveAsOfDateKey || ''))
    ? String(effectiveAsOfDateKey)
    : null;
  if (!dateKey) {
    throw new Error('Missing composer effective as-of date key.');
  }

  const totalAmount = sum(rows.map((row) => row.amount));
  const units = inferHoldingsUnits({ totalAmount, lastBacktestValue });

  if (units === 'value') {
    const holdings = normalizeWeights(rows.map((row) => ({ symbol: row.symbol, weight: row.amount })));
    return {
      holdings,
      meta: {
        units,
        totalAmount,
        totalValue: totalAmount,
        effectiveAsOfDateKey: dateKey,
        lastBacktestValue: Number.isFinite(Number(lastBacktestValue)) ? Number(lastBacktestValue) : null,
        pricedBy: null,
        prices: {},
      },
    };
  }

  const prices = {};
  const dataSources = {};
  const values = {};
  const errors = [];

  const work = rows.map((row) => async () => {
    try {
      const result = await fetchClosePriceOnDate({
        symbol: row.symbol,
        dateKey,
        priceSource,
        adjustment: dataAdjustment,
        cacheOnly,
        forceRefresh,
      });
      prices[row.symbol] = result.close;
      dataSources[row.symbol] = result.dataSource;
      values[row.symbol] = row.amount * result.close;
    } catch (error) {
      errors.push({ symbol: row.symbol, error: error?.message || String(error) });
    }
  });

  const limit = Number.isFinite(Number(concurrency)) ? Math.max(1, Math.floor(Number(concurrency))) : 4;
  for (let idx = 0; idx < work.length; idx += limit) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(work.slice(idx, idx + limit).map((fn) => fn()));
  }

  if (errors.length) {
    const detail = errors.slice(0, 8).map((e) => `${e.symbol} (${e.error})`).join(', ');
    const extra = errors.length > 8 ? ` and ${errors.length - 8} more` : '';
    throw new Error(`Unable to compute Composer holdings weights (missing prices): ${detail}${extra}.`);
  }

  const totalValue = sum(Object.values(values));
  if (!Number.isFinite(totalValue) || totalValue <= 0) {
    throw new Error('Unable to compute Composer holdings weights: total value is invalid.');
  }

  const holdings = normalizeWeights(
    rows.map((row) => ({ symbol: row.symbol, weight: values[row.symbol] || 0 }))
  );

  return {
    holdings,
    meta: {
      units,
      totalAmount,
      totalValue,
      effectiveAsOfDateKey: dateKey,
      lastBacktestValue: Number.isFinite(Number(lastBacktestValue)) ? Number(lastBacktestValue) : null,
      pricedBy: priceSource || null,
      prices,
      priceDataSources: dataSources,
    },
  };
};

module.exports = {
  computeComposerHoldingsWeights,
  holdingsObjectToRows,
};

