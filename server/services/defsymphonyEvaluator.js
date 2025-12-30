const {
  parseComposerScript,
  collectTickersFromAst,
  buildEvaluationBlueprint,
  describeMetricNode,
  describeSelectionNode,
  describeCondition,
} = require('../utils/composerDslParser');
const { getCachedPrices, normalizeAdjustment, fetchLatestPrice } = require('./priceCacheService');

const DEFAULT_LOOKBACK_BARS = 250;
const MAX_CALENDAR_LOOKBACK_DAYS = 750;
const TRADING_DAYS_PER_YEAR = 252;
const CALENDAR_DAYS_PER_YEAR = 365;
const ENABLE_FRACTIONAL_ORDERS =
  String(process.env.ALPACA_ENABLE_FRACTIONAL ?? 'true').toLowerCase() !== 'false';
const FRACTIONAL_QTY_DECIMALS = 6;
const ENABLE_INDICATOR_DEBUG =
  String(process.env.COMPOSER_DEBUG_INDICATORS ?? 'true').toLowerCase() === 'true';

const METRIC_DEFAULT_WINDOWS = {
  rsi: 14,
  'moving-average-price': 20,
  'exponential-moving-average-price': 20,
  'moving-average-return': 20,
  'cumulative-return': 20,
  'stdev-return': 20,
  'stdev-return%': 20,
  'max-drawdown': 30,
};

const getSeriesValuesForContext = (series, ctx) => {
  if (!series || !Array.isArray(series.closes)) {
    return [];
  }
  if (ctx?.priceIndex == null) {
    return series.closes;
  }
  const offset = Number(series.offset) || 0;
  const relativeIndex = ctx.priceIndex - offset;
  if (relativeIndex < 0) {
    return [];
  }
  const limit = Math.min(Math.max(relativeIndex + 1, 0), series.closes.length);
  return series.closes.slice(0, limit);
};

const getIndicatorValuesForContext = (series, ctx) => {
  const values = getSeriesValuesForContext(series, ctx);
  if (!values.length) {
    return values;
  }
  if (ctx?.usePreviousBarForIndicators && values.length > 1) {
    return values.slice(0, -1);
  }
  return values;
};

const getLatestValueForContext = (series, ctx) => {
  if (!series || !Array.isArray(series.closes) || !series.closes.length) {
    return null;
  }
  if (ctx?.priceIndex == null) {
    return series.closes[series.closes.length - 1];
  }
  const offset = Number(series.offset) || 0;
  const relativeIndex = ctx.priceIndex - offset;
  if (relativeIndex < 0) {
    return null;
  }
  const idx = Math.min(relativeIndex, series.closes.length - 1);
  return series.closes[idx];
};

const inferMetricWindow = (expr) => {
  if (!Array.isArray(expr)) {
    return null;
  }
  const head = expr[0];
  if (typeof head !== 'string') {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(METRIC_DEFAULT_WINDOWS, head)) {
    return null;
  }
  const options = (expr[2] && typeof expr[2] === 'object' ? expr[2] : expr[1]) || {};
  const configured = Number(getKeyword(options, ':window') || getKeyword(options, 'window'));
  const defaultWindow = METRIC_DEFAULT_WINDOWS[head] || 0;
  const window = Number.isFinite(configured) ? configured : defaultWindow;
  return Number.isFinite(window) ? window : null;
};

const collectAstStats = (
  node,
  stats = {
    hasGroup: false,
    hasGroupFilter: false,
    groupFilterMaxWindow: 0,
    needsNodeSeries: false,
    nodeMetricMaxWindow: 0,
    maxWindow: 0,
    maxRsiWindow: 0,
  }
) => {
  if (!node) {
    return stats;
  }
  if (Array.isArray(node)) {
    const head = node[0];
    if (typeof head === 'string') {
      if (head === 'group') {
        stats.hasGroup = true;
      }
      if (head === 'filter') {
        const assets = node[3] || [];
        const hasNonAssetCandidate =
          Array.isArray(assets) &&
          assets.some((child) => Array.isArray(child) && String(child[0]) !== 'asset');
        const hasGroupCandidate =
          Array.isArray(assets) && assets.some((child) => Array.isArray(child) && child[0] === 'group');
        if (hasNonAssetCandidate) {
          stats.needsNodeSeries = true;
          const metricWindow = inferMetricWindow(node[1]);
          if (Number.isFinite(metricWindow) && metricWindow > stats.nodeMetricMaxWindow) {
            stats.nodeMetricMaxWindow = metricWindow;
          }
        }
        if (hasGroupCandidate) {
          stats.hasGroupFilter = true;
          const metricWindow = inferMetricWindow(node[1]);
          if (Number.isFinite(metricWindow) && metricWindow > stats.groupFilterMaxWindow) {
            stats.groupFilterMaxWindow = metricWindow;
          }
        }
      }
      if (head === 'weight-inverse-volatility') {
        const maybeWindow = Number(node[1]);
        const hasWindow = Number.isFinite(maybeWindow) && maybeWindow > 0;
        const window = hasWindow ? maybeWindow : METRIC_DEFAULT_WINDOWS['stdev-return'];
        const childStart = hasWindow ? 2 : 1;
        const children =
          node.length === childStart + 1 && Array.isArray(node[childStart])
            ? node[childStart]
            : node.slice(childStart);
        const hasNonAssetChild =
          Array.isArray(children) &&
          children.some((child) => Array.isArray(child) && String(child[0]) !== 'asset');
        if (hasNonAssetChild) {
          stats.needsNodeSeries = true;
          if (Number.isFinite(window) && window > stats.nodeMetricMaxWindow) {
            stats.nodeMetricMaxWindow = window;
          }
        }
        if (Number.isFinite(window) && window > stats.maxWindow) {
          stats.maxWindow = window;
        }
      }
      if (
        head === 'rsi' ||
        head === 'moving-average-price' ||
        head === 'exponential-moving-average-price' ||
        head === 'moving-average-return' ||
        head === 'cumulative-return' ||
        head === 'stdev-return' ||
        head === 'stdev-return%' ||
        head === 'max-drawdown'
      ) {
        const options = (node[2] && typeof node[2] === 'object' ? node[2] : node[1]) || {};
        const configured = Number(getKeyword(options, ':window') || getKeyword(options, 'window'));
        const defaultWindow = METRIC_DEFAULT_WINDOWS[head] || 0;
        const window = Number.isFinite(configured) ? configured : defaultWindow;
        if (Number.isFinite(window) && window > stats.maxWindow) {
          stats.maxWindow = window;
        }
        if (head === 'rsi' && Number.isFinite(window) && window > stats.maxRsiWindow) {
          stats.maxRsiWindow = window;
        }
      }
      node.slice(1).forEach((child) => collectAstStats(child, stats));
      return stats;
    }
    node.forEach((child) => collectAstStats(child, stats));
    return stats;
  }
  if (typeof node === 'object') {
    Object.values(node).forEach((value) => collectAstStats(value, stats));
  }
  return stats;
};

const alignPriceHistory = (priceData, lookbackBars = DEFAULT_LOOKBACK_BARS) => {
  const target = Math.max(1, Number(lookbackBars) || DEFAULT_LOOKBACK_BARS);
  let minLength = Infinity;

  priceData.forEach((series) => {
    if (!Array.isArray(series?.closes) || !series.closes.length) {
      return;
    }
    if (series.closes.length > target) {
      series.closes = series.closes.slice(-target);
    }
    if (Array.isArray(series.bars) && series.bars.length > target) {
      series.bars = series.bars.slice(-target);
    }
    series.latest = series.closes[series.closes.length - 1];
    minLength = Math.min(minLength, series.closes.length);
  });

  if (!Number.isFinite(minLength) || minLength <= 0) {
    return 0;
  }
  return minLength;
};

const gatherGroupNodes = (node, acc = []) => {
  if (!node) {
    return acc;
  }
  if (Array.isArray(node)) {
    const head = node[0];
    if (typeof head === 'string') {
      if (head === 'group') {
        acc.push(node);
      }
      node.slice(1).forEach((child) => gatherGroupNodes(child, acc));
      return acc;
    }
    node.forEach((child) => gatherGroupNodes(child, acc));
    return acc;
  }
  if (typeof node === 'object') {
    Object.values(node).forEach((child) => gatherGroupNodes(child, acc));
  }
  return acc;
};

const safeNormalizePositions = (positions = []) => {
  try {
    return normalizePositions(positions);
  } catch (error) {
    return [];
  }
};

const assignNodeIds = (node, map = new WeakMap()) => {
  let counter = 1;
  const traverse = (current) => {
    if (!current) {
      return;
    }
    if (Array.isArray(current)) {
      if (!map.has(current)) {
        map.set(current, counter);
        counter += 1;
      }
      current.forEach((child) => traverse(child));
    } else if (typeof current === 'object') {
      Object.values(current).forEach((child) => traverse(child));
    }
  };
  traverse(node);
  return map;
};

const computePortfolioReturn = (positions = [], priceData, priceIndex) => {
  if (!positions.length || priceIndex <= 0) {
    return 0;
  }
  let total = 0;
  positions.forEach((pos) => {
    const symbol = pos.symbol?.toUpperCase?.();
    if (!symbol) {
      return;
    }
    const series = priceData.get(symbol);
    if (!series || !Array.isArray(series.closes)) {
      return;
    }
    const offset = Number(series.offset) || 0;
    const relIdx = priceIndex - offset;
    const prevRelIdx = relIdx - 1;
    if (prevRelIdx < 0) {
      return;
    }
    if (!series.closes.length) {
      return;
    }
    const prev = series.closes[Math.min(prevRelIdx, series.closes.length - 1)];
    const curr = series.closes[Math.min(Math.max(relIdx, 0), series.closes.length - 1)];
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || !prev) {
      return;
    }
    total += pos.weight * ((curr - prev) / prev);
  });
  return total;
};

const pickDateAxis = (mapsBySymbol, preferredSymbol, desiredStartKey = null) => {
  if (!mapsBySymbol || typeof mapsBySymbol.get !== 'function') {
    return [];
  }

  const resolveMinKey = (map) => {
    let min = null;
    if (!map || typeof map.keys !== 'function') {
      return null;
    }
    for (const key of map.keys()) {
      if (!min || key < min) {
        min = key;
      }
    }
    return min;
  };

  const preferred = preferredSymbol?.toUpperCase?.();
  const preferredMap = preferred ? mapsBySymbol.get(preferred) : null;
  const preferredMinKey = preferredMap ? resolveMinKey(preferredMap) : null;
  const preferredEligible =
    preferredMap && preferredMap.size && (!desiredStartKey || (preferredMinKey && preferredMinKey <= desiredStartKey));
  if (preferredEligible) {
    return Array.from(preferredMap.keys()).sort();
  }

  let best = null;
  let bestMinKey = null;
  mapsBySymbol.forEach((map, symbol) => {
    if (!map?.size) {
      return;
    }
    const minKey = resolveMinKey(map);
    if (desiredStartKey && (!minKey || minKey > desiredStartKey)) {
      return;
    }
    if (!best) {
      best = { symbol, map };
      bestMinKey = minKey;
      return;
    }

    if (minKey && bestMinKey && minKey < bestMinKey) {
      best = { symbol, map };
      bestMinKey = minKey;
      return;
    }
    if (minKey === bestMinKey && map.size > best.map.size) {
      best = { symbol, map };
      bestMinKey = minKey;
    }
  });
  if (best) {
    return Array.from(best.map.keys()).sort();
  }

  // If no map covers the desired warmup period, fall back to "largest series" selection.
  let fallback = null;
  mapsBySymbol.forEach((map, symbol) => {
    if (!map?.size) {
      return;
    }
    if (!fallback || map.size > fallback.map.size) {
      fallback = { symbol, map };
    }
  });
  return fallback ? Array.from(fallback.map.keys()).sort() : [];
};

const buildAlignedSeriesForAxis = (symbol, barMap, axisKeys) => {
  if (!barMap?.size || !Array.isArray(axisKeys) || !axisKeys.length) {
    return null;
  }
  const keys = Array.from(barMap.keys()).sort();
  const firstKey = keys[0];
  const offset = axisKeys.findIndex((key) => key >= firstKey);
  if (offset < 0) {
    return null;
  }

  let pointer = 0;
  let lastClose = null;
  const seedKey = axisKeys[offset];
  while (pointer < keys.length && keys[pointer] <= seedKey) {
    const entry = barMap.get(keys[pointer]);
    const close = Number(entry?.close);
    if (Number.isFinite(close)) {
      lastClose = close;
    }
    pointer += 1;
  }
  if (!Number.isFinite(lastClose)) {
    return null;
  }

  const closes = [];
  const bars = [];
  for (let idx = offset; idx < axisKeys.length; idx += 1) {
    const dateKey = axisKeys[idx];
    while (pointer < keys.length && keys[pointer] <= dateKey) {
      const entry = barMap.get(keys[pointer]);
      const close = Number(entry?.close);
      if (Number.isFinite(close)) {
        lastClose = close;
      }
      pointer += 1;
    }
    closes.push(lastClose);
    bars.push({ t: `${dateKey}T00:00:00.000Z`, c: lastClose });
  }

  return {
    symbol: symbol.toUpperCase(),
    offset,
    closes,
    latest: closes.length ? closes[closes.length - 1] : null,
    bars,
  };
};

const simulateNodeSeries = (node, ctx, options) => {
  const { startIndex, priceLength } = options;
  if (!node || startIndex >= priceLength) {
    return { closes: [], offset: startIndex };
  }
  const values = [];
  let nav = 1;
  const simCtx = {
    ...ctx,
    reasoning: null,
    previewStack: null,
  };
  const previousIndex = ctx.priceIndex;
  // Avoid lookahead bias: choose allocations using information available at (idx - 1),
  // then apply the return from (idx - 1) -> idx.
  for (let idx = startIndex; idx < priceLength; idx += 1) {
    const decisionIndex = idx - 1;
    simCtx.priceIndex = decisionIndex;
    let rawPositions = [];
    try {
      rawPositions = evaluateNode(node, 1, simCtx);
    } catch (error) {
      rawPositions = [];
    }
    const normalized = safeNormalizePositions(rawPositions);
    const periodReturn = computePortfolioReturn(normalized, ctx.priceData, idx);
    nav *= 1 + periodReturn;
    values.push(nav);
  }
  ctx.priceIndex = previousIndex;
  return { closes: values, offset: startIndex };
};

const computeGroupSeriesMeta = (stats, priceLength) => {
  const usableHistory = Number.isFinite(priceLength) ? priceLength : 0;
  if (usableHistory < 2) {
    throw new Error('Not enough synchronized history to evaluate group metrics.');
  }
  const requiredWindow = Math.max(stats?.nodeMetricMaxWindow || stats?.groupFilterMaxWindow || 1, 1);
  const padding = 5;
  const requiredNavPoints = Math.max(requiredWindow + 1 + padding, 2);
  const startIndex = Math.max(1, usableHistory - requiredNavPoints);
  return { startIndex: Math.min(startIndex, usableHistory - 1), priceLength: usableHistory };
};

const buildGroupSeriesCache = (ast, ctx, stats, priceLength) => {
  const meta = computeGroupSeriesMeta(stats, priceLength);
  const nodeSeries = ctx.nodeSeries || new Map();
  ctx.nodeSeries = nodeSeries;
  ctx.groupSeriesMeta = meta;
  ctx.enableGroupMetrics = true;
  return meta;
};

const ensureGroupSeriesForNode = (node, ctx) => {
  if (!node || !ctx?.groupSeriesMeta || !ctx?.nodeIdMap) {
    return null;
  }
  const nodeId = ctx.nodeIdMap.get(node);
  if (!nodeId) {
    return null;
  }
  if (!ctx.nodeSeries) {
    ctx.nodeSeries = new Map();
  }
  if (ctx.nodeSeries.has(nodeId)) {
    return ctx.nodeSeries.get(nodeId);
  }
  const record = simulateNodeSeries(node, { ...ctx, nodeSeries: ctx.nodeSeries }, ctx.groupSeriesMeta);
  ctx.nodeSeries.set(nodeId, record);
  return record;
};

const toISODate = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
};

const now = () => new Date();

const normalizeAsOfDate = (value) => {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const date = new Date(`${trimmed}T23:59:59.999Z`);
      return Number.isNaN(date.getTime()) ? null : date;
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
};

const normalizeDateKeyInput = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
};

const formatDateKeyInTimeZone = (value, timeZone) => {
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch (error) {
    return null;
  }
};

const getTimePartsInTimeZone = (value, timeZone) => {
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    return { hour, minute };
  } catch (error) {
    return null;
  }
};

const isAfterUsMarketClose = (date, { dateKeyOverride } = {}) => {
  if (dateKeyOverride) {
    return true;
  }
  const parts = getTimePartsInTimeZone(date, 'America/New_York');
  if (!parts) {
    return false;
  }
  return parts.hour > 16 || (parts.hour === 16 && parts.minute >= 0);
};

const formatDateForLog = (value) => {
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value);
    }
    return date.toISOString().split('T')[0];
  } catch (error) {
    return String(value);
  }
};

const normalizeRsiMethod = (value) => {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized || null;
};

const normalizeBoolean = (value) => {
  if (value == null) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n'].includes(normalized)) {
    return false;
  }
  return null;
};

const normalizeAsOfMode = (value) => {
  if (!value) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['previous-close', 'prev', 'previous', 'prior', 'prior-close', 'last-close'].includes(normalized)) {
    return 'previous-close';
  }
  if (['current', 'latest', 'now', 'intraday', 'live'].includes(normalized)) {
    return 'current';
  }
  return null;
};

const toISODateKey = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
};

const normalizePriceSource = (value) => {
  if (!value) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'yahoo' || normalized === 'alpaca' || normalized === 'tiingo') {
    return normalized;
  }
  return null;
};

const hasTiingoToken = () =>
  Boolean(
    process.env.TIINGO_API_KEYS ||
      process.env.TIINGO_TOKEN ||
      process.env.TIINGO_API_KEY ||
      process.env.TIINGO_API_KEY1
  );

const normalizePriceRefresh = (value) => {
  const normalized = normalizeBoolean(value);
  if (normalized !== null) {
    return normalized;
  }
  return null;
};

const normalizeAppendLivePrice = (value) => {
  const normalized = normalizeBoolean(value);
  if (normalized !== null) {
    return normalized;
  }
  return null;
};

const runWithConcurrency = async (items, limit, handler) => {
  const queue = [...items];
  const workerCount = Math.max(1, Math.min(limit, queue.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) {
        return;
      }
      await handler(item);
    }
  });
  await Promise.all(workers);
};

const isArray = Array.isArray;
const isObj = (val) => val && typeof val === 'object' && !Array.isArray(val);

const getKeyword = (obj, key) => {
  if (!obj) {
    return undefined;
  }
  return obj[key] ?? obj[`:${key}`];
};

const flattenChildren = (node, startIndex = 1) => {
  if (!isArray(node)) {
    return [];
  }
  if (node.length === startIndex + 1 && isArray(node[startIndex])) {
    return node[startIndex];
  }
  return node.slice(startIndex);
};

const getNodeType = (node) => {
  if (!isArray(node) || !node.length) {
    return null;
  }
  return String(node[0]);
};

const isAssetNode = (node) => getNodeType(node) === 'asset';

const sumWeights = (positions = []) =>
  positions.reduce((sum, pos) => sum + (Number(pos.weight) || 0), 0);

const roundQuantity = (qty, decimals = FRACTIONAL_QTY_DECIMALS) => {
  const num = Number(qty);
  if (!Number.isFinite(num)) {
    return 0;
  }
  const places = Math.max(0, Math.min(12, Number(decimals) || 0));
  const factor = 10 ** places;
  return Math.round((num + Number.EPSILON) * factor) / factor;
};

const mergePositions = (positions = []) => {
  const map = new Map();
  positions.forEach((pos) => {
    if (!pos || !pos.symbol || !Number.isFinite(pos.weight)) {
      return;
    }
    const symbol = pos.symbol.toUpperCase();
    const current = map.get(symbol) || { symbol, weight: 0, rationale: pos.rationale };
    current.weight += pos.weight;
    map.set(symbol, current);
  });
  return Array.from(map.values());
};

const pushReasoning = (ctx, message) => {
  if (ctx?.reasoning && message) {
    ctx.reasoning.push(message);
  }
};

const formatIndicatorValue = (value) => {
  if (value == null) {
    return 'n/a';
  }
  if (typeof value !== 'number') {
    return String(value);
  }
  if (!Number.isFinite(value)) {
    return String(value);
  }
  const absValue = Math.abs(value);
  if (absValue >= 100) {
    return value.toFixed(2);
  }
  if (absValue >= 10) {
    return value.toFixed(3);
  }
  return value.toFixed(4);
};

const describePositionPlan = (positions = []) => {
  if (!positions.length) {
    return 'No tradable positions were derived.';
  }
  return positions
    .map((pos) => {
      const weightPct = Number.isFinite(pos.weight)
        ? `${(pos.weight * 100).toFixed(1)}%`
        : 'weight n/a';
      const qtyLabel = Number.isFinite(pos.quantity)
        ? `${pos.quantity} shares`
        : 'quantity pending';
      return `${pos.symbol} (${qtyLabel}, target weight ${weightPct})`;
    })
    .join('; ');
};

const multiplyPositions = (positions = [], factor = 1) =>
  positions.map((pos) => ({
    ...pos,
    weight: pos.weight * factor,
  }));

const ensureArray = (value) => (isArray(value) ? value : [value]);

const extractSymbolFromAssetNode = (node) => {
  if (!isArray(node)) {
    return null;
  }
  return node[1] ? String(node[1]).trim().toUpperCase() : null;
};

const tail = (arr, count) => arr.slice(-count);

const getRsiMethod = () => String(process.env.RSI_METHOD ?? 'wilder').trim().toLowerCase();

const isSimpleRsiMethod = (method) => {
  const normalized = String(method || '').trim().toLowerCase();
  return normalized === 'simple' || normalized === 'cutler' || normalized === 'sma';
};

const computeRSI = (series, window, method = getRsiMethod()) => {
  if (!Array.isArray(series) || series.length < window + 1) {
    return null;
  }

  if (isSimpleRsiMethod(method)) {
    let gains = 0;
    let losses = 0;
    for (let i = series.length - window; i < series.length; i += 1) {
      const diff = series[i] - series[i - 1];
      if (diff > 0) {
        gains += diff;
      } else if (diff < 0) {
        losses += Math.abs(diff);
      }
    }
    const avgGain = gains / window;
    const avgLoss = losses / window;
    if (avgLoss === 0 && avgGain === 0) {
      return 50;
    }
    if (avgLoss === 0) {
      return 100;
    }
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  // Wilder-smoothed RSI (standard definition used by most charting platforms).
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= window; i += 1) {
    const diff = series[i] - series[i - 1];
    if (diff > 0) {
      avgGain += diff;
    } else if (diff < 0) {
      avgLoss += Math.abs(diff);
    }
  }

  avgGain /= window;
  avgLoss /= window;

  for (let i = window + 1; i < series.length; i += 1) {
    const diff = series[i] - series[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (window - 1) + gain) / window;
    avgLoss = (avgLoss * (window - 1) + loss) / window;
  }

  if (avgLoss === 0 && avgGain === 0) {
    return 50;
  }
  if (avgLoss === 0) {
    return 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
};

const computeSMA = (series, window) => {
  if (!Array.isArray(series) || series.length < window) {
    return null;
  }
  const subset = tail(series, window);
  return subset.reduce((sum, value) => sum + value, 0) / window;
};

const computeEMA = (series, window) => {
  if (!Array.isArray(series) || series.length < window) {
    return null;
  }
  const alpha = 2 / (window + 1);
  let ema = series[series.length - window];
  for (let i = series.length - window + 1; i < series.length; i += 1) {
    ema = alpha * series[i] + (1 - alpha) * ema;
  }
  return ema;
};

const computeReturns = (series, window) => {
  if (!Array.isArray(series) || series.length < window + 1) {
    return null;
  }
  const returns = [];
  for (let i = series.length - window; i < series.length; i += 1) {
    const prev = series[i - 1];
    if (!prev) {
      continue;
    }
    returns.push((series[i] - prev) / prev);
  }
  return returns.length ? returns : null;
};

const computeMovingAverageReturn = (series, window) => {
  const returns = computeReturns(series, window);
  if (!returns || !returns.length) {
    return null;
  }
  return returns.reduce((sum, value) => sum + value, 0) / returns.length;
};

const computeCumulativeReturn = (series, window) => {
  if (!Array.isArray(series) || series.length < window + 1) {
    return null;
  }
  const latest = series[series.length - 1];
  const prior = series[series.length - 1 - window];
  if (!Number.isFinite(latest) || !Number.isFinite(prior) || prior === 0) {
    return null;
  }
  return (latest - prior) / prior;
};

const computeStdDevReturn = (series, window) => {
  const returns = computeReturns(series, window);
  if (!returns || !returns.length) {
    return null;
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    returns.length;
  return Math.sqrt(variance);
};

const computeMaxDrawdown = (series, window) => {
  if (!Array.isArray(series) || series.length < window) {
    return null;
  }
  const subset = tail(series, window);
  let peak = subset[0];
  let maxDd = 0;
  subset.forEach((price) => {
    if (price > peak) {
      peak = price;
    }
    const dd = (price - peak) / peak;
    if (dd < maxDd) {
      maxDd = dd;
    }
  });
  return Math.abs(maxDd);
};

const TICKER_PATTERN = /^[A-Z][A-Z0-9\.\-]{0,9}$/;

const noteMissingPriceData = (ctx, symbol, reason = 'missing price data') => {
  if (!ctx || typeof symbol !== 'string') {
    return;
  }
  const upper = symbol.toUpperCase();
  if (!TICKER_PATTERN.test(upper)) {
    return;
  }
  if (!ctx.missingSymbols) {
    ctx.missingSymbols = new Map();
  }
  if (!ctx.missingSymbols.has(upper)) {
    ctx.missingSymbols.set(upper, reason);
  }
};

const resolveMetricSeries = (symbolInput, ctx) => {
  if (ctx?.metricSeries) {
    return ctx.metricSeries;
  }
  const fallbackSymbol = ctx?.metricSymbol;
  const symbol = symbolInput || fallbackSymbol;
  if (!symbol || !ctx?.priceData) {
    return null;
  }
  const upper = symbol.toUpperCase();
  if (!ctx.priceData.has(upper)) {
    noteMissingPriceData(ctx, upper);
    return null;
  }
  return ctx.priceData.get(upper);
};

const getSeriesForMetric = (symbol, ctx, missingMessage) => {
  if (ctx?.metricSeries) {
    return ctx.metricSeries;
  }
  const finalSymbol = symbol || ctx?.metricSymbol;
  if (!finalSymbol) {
    throw new Error(missingMessage);
  }
  return resolveMetricSeries(finalSymbol, ctx);
};

const getMetricCacheForSeries = (ctx, series) => {
  if (!ctx || !series || typeof series !== 'object') {
    return null;
  }
  if (!ctx.metricCache) {
    ctx.metricCache = new WeakMap();
  }
  const store = ctx.metricCache.get(series);
  if (store) {
    return store;
  }
  const nextStore = new Map();
  ctx.metricCache.set(series, nextStore);
  return nextStore;
};

const buildMetricCacheKey = (type, window, method, ctx) => {
  const index = ctx?.priceIndex == null ? 'latest' : ctx.priceIndex;
  const windowKey = window == null ? 'na' : window;
  const methodKey = method ? String(method).trim().toLowerCase() : 'none';
  return `${type}|${windowKey}|${methodKey}|${index}`;
};

const readCachedMetric = (ctx, series, key, compute) => {
  const store = getMetricCacheForSeries(ctx, series);
  if (!store) {
    return compute();
  }
  if (store.has(key)) {
    return store.get(key);
  }
  const value = compute();
  store.set(key, value);
  return value;
};

const evaluateCondition = (node, ctx) => {
  if (!isArray(node)) {
    return Boolean(node);
  }
  const operator = String(node[0]);
  const left = evaluateExpression(node[1], ctx);
  const right = evaluateExpression(node[2], ctx);
  if (ctx?.reasoning && ctx?.debugIndicators) {
    const conditionLabel = describeCondition(node);
    ctx.reasoning.push(
      `Indicator debug: ${conditionLabel}. Left=${formatIndicatorValue(left)}; Right=${formatIndicatorValue(right)}.`
    );
  }
  if (
    left == null ||
    right == null ||
    Number.isNaN(left) ||
    Number.isNaN(right)
  ) {
    return false;
  }
  switch (operator) {
    case '<':
      return left < right;
    case '>':
      return left > right;
    case '<=':
      return left <= right;
    case '>=':
      return left >= right;
    case '=':
    case '==':
      return left === right;
    default:
      throw new Error(`Unsupported operator ${operator}`);
  }
};

const evaluateExpression = (node, ctx) => {
  if (node == null) {
    return null;
  }
  if (typeof node === 'number') {
    return node;
  }
  if (typeof node === 'string') {
    const parsed = Number(node);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  if (!isArray(node)) {
    return node;
  }
  const type = String(node[0]);
  switch (type) {
    case 'rsi': {
      const symbolNode = node[1];
      let symbol = ctx.metricSymbol || null;
      let options = node[2] || {};
      if (typeof symbolNode === 'string') {
        symbol = symbolNode.toUpperCase();
      } else if (isObj(symbolNode)) {
        options = symbolNode;
      }
      const window =
        Number(getKeyword(options, ':window') || getKeyword(options, 'window')) ||
        METRIC_DEFAULT_WINDOWS.rsi;
      const series = getSeriesForMetric(symbol, ctx, 'Metric symbol context missing for RSI');
      if (!series) {
        return null;
      }
      const method = ctx?.rsiMethod || getRsiMethod();
      const cacheKey = buildMetricCacheKey('rsi', window, method, ctx);
      return readCachedMetric(ctx, series, cacheKey, () => {
        const closes = getIndicatorValuesForContext(series, ctx);
        return computeRSI(closes, window, method);
      });
    }
    case 'moving-average-price': {
      const symbolNode = node[1];
      let symbol = ctx.metricSymbol || null;
      let options = node[2] || {};
      if (typeof symbolNode === 'string') {
        symbol = symbolNode.toUpperCase();
      } else if (isObj(symbolNode)) {
        options = symbolNode;
      }
      const window =
        Number(getKeyword(options, ':window') || getKeyword(options, 'window')) ||
        METRIC_DEFAULT_WINDOWS['moving-average-price'];
      const series = getSeriesForMetric(
        symbol,
        ctx,
        'Metric symbol context missing for moving-average-price'
      );
      if (!series) {
        return null;
      }
      const cacheKey = buildMetricCacheKey('moving-average-price', window, null, ctx);
      return readCachedMetric(ctx, series, cacheKey, () => {
        const closes = getIndicatorValuesForContext(series, ctx);
        return computeSMA(closes, window);
      });
    }
    case 'exponential-moving-average-price': {
      const symbolNode = node[1];
      let symbol = ctx.metricSymbol || null;
      let options = node[2] || {};
      if (typeof symbolNode === 'string') {
        symbol = symbolNode.toUpperCase();
      } else if (isObj(symbolNode)) {
        options = symbolNode;
      }
      const window =
        Number(getKeyword(options, ':window') || getKeyword(options, 'window')) ||
        METRIC_DEFAULT_WINDOWS['exponential-moving-average-price'];
      const series = getSeriesForMetric(
        symbol,
        ctx,
        'Metric symbol context missing for exponential-moving-average-price'
      );
      if (!series) {
        return null;
      }
      const cacheKey = buildMetricCacheKey('exponential-moving-average-price', window, null, ctx);
      return readCachedMetric(ctx, series, cacheKey, () => {
        const closes = getIndicatorValuesForContext(series, ctx);
        return computeEMA(closes, window);
      });
    }
    case 'current-price': {
      const symbolNode = node[1];
      let symbol = ctx.metricSymbol || null;
      if (typeof symbolNode === 'string') {
        symbol = symbolNode.toUpperCase();
      }
      const series = getSeriesForMetric(symbol, ctx, 'Metric symbol context missing for current-price');
      if (!series) {
        return null;
      }
      const cacheKey = buildMetricCacheKey('current-price', null, null, ctx);
      return readCachedMetric(ctx, series, cacheKey, () => getLatestValueForContext(series, ctx));
    }
    case 'moving-average-return': {
      const symbolNode = node[1];
      let options = node[2] || {};
      let symbol = ctx.metricSymbol || null;
      if (typeof symbolNode === 'string') {
        symbol = symbolNode.toUpperCase();
      } else if (isObj(symbolNode)) {
        options = symbolNode;
      }
      const window =
        Number(getKeyword(options, ':window') || getKeyword(options, 'window')) ||
        METRIC_DEFAULT_WINDOWS['moving-average-return'];
      const series = getSeriesForMetric(
        symbol,
        ctx,
        'Metric symbol context missing for moving-average-return'
      );
      if (!series) {
        return null;
      }
      const cacheKey = buildMetricCacheKey('moving-average-return', window, null, ctx);
      return readCachedMetric(ctx, series, cacheKey, () => {
        const closes = getIndicatorValuesForContext(series, ctx);
        return computeMovingAverageReturn(closes, window);
      });
    }
    case 'cumulative-return': {
      const symbolNode = node[1];
      let symbol = ctx.metricSymbol || null;
      let options = node[2] || {};
      if (typeof symbolNode === 'string') {
        symbol = symbolNode.toUpperCase();
      } else if (isObj(symbolNode)) {
        options = symbolNode;
      }
      const window =
        Number(getKeyword(options, ':window') || getKeyword(options, 'window')) ||
        METRIC_DEFAULT_WINDOWS['cumulative-return'];
      const series = getSeriesForMetric(
        symbol,
        ctx,
        'Metric symbol context missing for cumulative-return'
      );
      if (!series) {
        return null;
      }
      const cacheKey = buildMetricCacheKey('cumulative-return', window, null, ctx);
      return readCachedMetric(ctx, series, cacheKey, () => {
        const closes = getIndicatorValuesForContext(series, ctx);
        return computeCumulativeReturn(closes, window);
      });
    }
    case 'stdev-return':
    case 'stdev-return%': {
      const symbolNode = node[1];
      let symbol = ctx.metricSymbol || null;
      let options = node[2] || {};
      if (typeof symbolNode === 'string') {
        symbol = symbolNode.toUpperCase();
      } else if (isObj(symbolNode)) {
        options = symbolNode;
      }
      const window =
        Number(getKeyword(options, ':window') || getKeyword(options, 'window')) ||
        METRIC_DEFAULT_WINDOWS['stdev-return'];
      const series = getSeriesForMetric(
        symbol,
        ctx,
        'Metric symbol context missing for stdev-return'
      );
      if (!series) {
        return null;
      }
      const cacheKey = buildMetricCacheKey(type, window, null, ctx);
      return readCachedMetric(ctx, series, cacheKey, () => {
        const closes = getIndicatorValuesForContext(series, ctx);
        return computeStdDevReturn(closes, window);
      });
    }
    case 'max-drawdown': {
      const optionsNode = node[1];
      let symbol = ctx.metricSymbol || null;
      let options =
        (optionsNode && typeof optionsNode === 'object' && !Array.isArray(optionsNode)
          ? optionsNode
          : {}) || {};
      if (typeof node[1] === 'string') {
        symbol = node[1].toUpperCase();
        options = node[2] && typeof node[2] === 'object' ? node[2] : {};
      }
      const window =
        Number(getKeyword(options, ':window') || getKeyword(options, 'window')) ||
        METRIC_DEFAULT_WINDOWS['max-drawdown'];
      const series = getSeriesForMetric(
        symbol,
        ctx,
        'Metric symbol context missing for max-drawdown'
      );
      if (!series) {
        return null;
      }
      const cacheKey = buildMetricCacheKey('max-drawdown', window, null, ctx);
      return readCachedMetric(ctx, series, cacheKey, () => {
        const closes = getIndicatorValuesForContext(series, ctx);
        return computeMaxDrawdown(closes, window);
      });
    }
    default:
      throw new Error(`Unsupported expression type ${type}`);
  }
};

const evaluateMetricForCandidate = (metricNode, candidate, ctx) => {
  if (!metricNode || !candidate) {
    return 0;
  }
  if (typeof metricNode === 'number') {
    return metricNode;
  }
  if (!isArray(metricNode)) {
    return Number(metricNode) || 0;
  }
  const metricCtx = { ...ctx };
  if (candidate.type === 'node') {
    let series = ctx?.nodeSeries?.get(candidate.nodeId);
    if (!series) {
      series = ensureGroupSeriesForNode(candidate.node, ctx);
    }
    if (!series) {
      return null;
    }
    metricCtx.metricSeries = series;
    metricCtx.metricSymbol = candidate.label || `node-${candidate.nodeId}`;
  } else if (candidate.type === 'asset') {
    metricCtx.metricSymbol = candidate.symbol;
    metricCtx.metricSeries = null;
  }
  try {
    const value = evaluateExpression(metricNode, metricCtx);
    return Number.isFinite(value) ? value : null;
  } catch (error) {
    const symbol = candidate.type === 'asset' ? candidate.symbol : metricCtx.metricSymbol;
    noteMissingPriceData(metricCtx, symbol, error?.message || 'Indicator computation failed.');
    return null;
  }
};

const applySelector = (selectorNode, scoredAssets) => {
  if (!selectorNode || !isArray(selectorNode)) {
    return scoredAssets;
  }
  const type = String(selectorNode[0]);
  const count = Number(selectorNode[1] || 1);
  const sorted = [...scoredAssets];
  if (type === 'select-top') {
    sorted.sort((a, b) => b.value - a.value);
    return sorted.slice(0, count);
  }
  if (type === 'select-bottom') {
    sorted.sort((a, b) => a.value - b.value);
    return sorted.slice(0, count);
  }
  return scoredAssets;
};

const cloneMissingSymbols = (map) => {
  if (!map) {
    return new Map();
  }
  return new Map(map);
};

const previewNodePositions = (node, ctx) => {
  if (!node) {
    return [];
  }
  const previewStack = (ctx && ctx.previewStack) || new Set();
  if (previewStack.has(node)) {
    return [];
  }
  const nextStack = new Set(previewStack);
  nextStack.add(node);
  const previewCtx = {
    ...ctx,
    reasoning: null,
    previewStack: nextStack,
    missingSymbols: cloneMissingSymbols(ctx?.missingSymbols),
  };
  try {
    return evaluateNode(node, 1, previewCtx);
  } catch (error) {
    return [];
  } finally {
    nextStack.delete(node);
  }
};

const selectRepresentativeSymbol = (positions = []) => {
  if (!positions.length) {
    return null;
  }
  const sorted = [...positions].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  return sorted[0]?.symbol || null;
};

function evaluateFilterNode(node, parentWeight, ctx) {
  const metricNode = node[1];
  const selectorNode = node[2];
  const assets = node[3] || [];
  const metricSummary = describeMetricNode(metricNode);
  const selectionSummary = describeSelectionNode(selectorNode);
  const describeCandidate = (entry) => entry?.symbol || entry?.label || (entry?.nodeId ? `node-${entry.nodeId}` : 'candidate');
  const candidates = assets
    .map((child) => {
      if (isAssetNode(child)) {
        const symbol = extractSymbolFromAssetNode(child);
        return symbol ? { type: 'asset', symbol, node: child } : null;
      }
      const childType = getNodeType(child);
      if (ctx.enableGroupMetrics || ctx.groupSeriesMeta) {
        const nodeId = ctx.nodeIdMap?.get(child);
        if (nodeId) {
          const label =
            childType === 'group' && typeof child[1] === 'string'
              ? String(child[1])
              : `${childType || 'node'}-${nodeId}`;
          return { type: 'node', node: child, nodeId, label };
        }
      }
      const previewPositions = previewNodePositions(child, ctx);
      const representative = selectRepresentativeSymbol(previewPositions);
      if (!representative) {
        return null;
      }
      return { type: 'asset', symbol: representative, node: child };
    })
    .filter(Boolean);

  const scored = candidates
    .map((entry) => {
      const value = evaluateMetricForCandidate(metricNode, entry, ctx);
      if (!Number.isFinite(value)) {
        return null;
      }
      return { ...entry, value };
    })
    .filter(Boolean);
  const selected = applySelector(selectorNode, scored);
  if (!selected.length) {
    if (ctx?.reasoning) {
      ctx.reasoning.push(
        `Filter evaluation: ${metricSummary}. No instruments produced a valid score; skipping branch.`
      );
    }
    return [];
  }
  if (ctx?.reasoning) {
    const formatValue = (value) => {
      if (value == null || Number.isNaN(value)) {
        return 'n/a';
      }
      if (Math.abs(value) >= 100) {
        return value.toFixed(2);
      }
      return value.toFixed(4);
    };
    const scoreboard = scored.map((entry) => `${describeCandidate(entry)}: ${formatValue(entry.value)}`);
    const preview = scoreboard.slice(0, 10).join(', ');
    const extra = scoreboard.length > 10 ? `, … (+${scoreboard.length - 10} more)` : '';
    const winners = selected.map((entry) => describeCandidate(entry)).join(', ') || 'none';
    ctx.reasoning.push(
      `Filter evaluation: ${metricSummary} -> ${preview}${extra}. Applied ${selectionSummary}, selecting ${winners}.`
    );
  }
  const weightEach = parentWeight / selected.length;
  const positions = selected.flatMap((entry) => {
    if (entry.type === 'asset') {
      return [{
        symbol: entry.symbol,
        weight: weightEach,
        rationale: `Selected by filter (${Number.isFinite(entry.value) ? entry.value.toFixed(4) : 'n/a'})`,
      }];
    }
    return evaluateNode(entry.node, weightEach, ctx);
  });
  return mergePositions(positions);
}

function evaluateNode(node, parentWeight, ctx) {
  if (!node) {
    return [];
  }
  if (!isArray(node)) {
    return [];
  }
  const type = String(node[0]);
  switch (type) {
    case 'defsymphony': {
      const body = node[3];
      pushReasoning(ctx, `Evaluating defsymphony body for strategy "${node[1] || ''}".`);
      return evaluateNode(body, parentWeight, ctx);
    }
    case 'group': {
      const children = flattenChildren(node, 2);
      const groupName = node[1] || 'Unnamed group';
      pushReasoning(ctx, `Entering group "${groupName}" with parent weight ${(parentWeight * 100).toFixed(2)}%.`);
      const positions = children.flatMap((child) =>
        evaluateNode(child, parentWeight, ctx)
      );
      return mergePositions(positions);
    }
    case 'weight-equal': {
      const children = flattenChildren(node);
      if (!children.length) {
        return [];
      }
       pushReasoning(
        ctx,
        `Applying weight-equal across ${children.length} child nodes (each receives ${(parentWeight / children.length * 100).toFixed(2)}% weight).`
      );
      const weightShare = parentWeight / children.length;
      const positions = children.flatMap((child) =>
        evaluateNode(child, weightShare, ctx)
      );
      return mergePositions(positions);
    }
    case 'weight-inverse-volatility': {
      const maybeWindow = Number(node[1]);
      const hasWindow = Number.isFinite(maybeWindow) && maybeWindow > 0;
      const window = hasWindow ? maybeWindow : METRIC_DEFAULT_WINDOWS['stdev-return'];
      const children = flattenChildren(node, hasWindow ? 2 : 1);
      if (!children.length) {
        return [];
      }
      pushReasoning(
        ctx,
        `Applying weight-inverse-volatility (window=${window}) across ${children.length} child nodes.`
      );

      const candidates = children
        .map((child) => {
          if (isAssetNode(child)) {
            const symbol = extractSymbolFromAssetNode(child);
            return symbol ? { type: 'asset', symbol, node: child } : null;
          }
          const childType = getNodeType(child);
          if (ctx.enableGroupMetrics || ctx.groupSeriesMeta) {
            const nodeId = ctx.nodeIdMap?.get(child);
            if (nodeId) {
              const label =
                childType === 'group' && typeof child[1] === 'string'
                  ? String(child[1])
                  : `${childType || 'node'}-${nodeId}`;
              return { type: 'node', node: child, nodeId, label };
            }
          }
          const previewPositions = previewNodePositions(child, ctx);
          const representative = selectRepresentativeSymbol(previewPositions);
          if (!representative) {
            return null;
          }
          return { type: 'asset', symbol: representative, node: child };
        })
        .filter(Boolean);

      if (!candidates.length) {
        return [];
      }

      const metricNode = ['stdev-return', { window }];
      const scored = candidates
        .map((entry) => {
          const value = evaluateMetricForCandidate(metricNode, entry, ctx);
          if (!Number.isFinite(value) || value <= 0) {
            return null;
          }
          return { ...entry, value };
        })
        .filter(Boolean);

      if (!scored.length) {
        pushReasoning(
          ctx,
          `Inverse-volatility metrics unavailable; falling back to equal-weight across ${children.length} child nodes.`
        );
        const fallbackWeight = parentWeight / children.length;
        const fallbackPositions = children.flatMap((child) =>
          evaluateNode(child, fallbackWeight, ctx)
        );
        return mergePositions(fallbackPositions);
      }

      if (scored.length < candidates.length) {
        pushReasoning(
          ctx,
          `Inverse-volatility metrics available for ${scored.length}/${candidates.length} child nodes; weighting only those with data.`
        );
      }

      const inverseValues = scored.map((entry) => 1 / entry.value);
      const inverseTotal = inverseValues.reduce((sum, value) => sum + value, 0);
      if (!Number.isFinite(inverseTotal) || inverseTotal <= 0) {
        pushReasoning(
          ctx,
          `Inverse-volatility sum invalid; falling back to equal-weight across ${children.length} child nodes.`
        );
        const fallbackWeight = parentWeight / children.length;
        const fallbackPositions = children.flatMap((child) =>
          evaluateNode(child, fallbackWeight, ctx)
        );
        return mergePositions(fallbackPositions);
      }

      const positions = scored.flatMap((entry, index) => {
        const weightShare = parentWeight * (inverseValues[index] / inverseTotal);
        if (entry.type === 'asset') {
          return [
            {
              symbol: entry.symbol,
              weight: weightShare,
              rationale: `Inverse-volatility (${window}d)`,
            },
          ];
        }
        return evaluateNode(entry.node, weightShare, ctx);
      });
      return mergePositions(positions);
    }
    case 'weight-specified': {
      const clones = node.slice(1);
      const positions = [];
      for (let i = 0; i < clones.length; i += 2) {
        const weight = Number(clones[i]);
        const child = clones[i + 1];
        if (!Number.isFinite(weight) || !child) {
          continue;
        }
        const childWeight = parentWeight * weight;
        pushReasoning(
          ctx,
          `Applying specified weight ${(weight * 100).toFixed(2)}% (absolute ${(childWeight * 100).toFixed(2)}%) to child node ${Math.floor(i / 2) + 1}.`
        );
        positions.push(...evaluateNode(child, childWeight, ctx));
      }
      return mergePositions(positions);
    }
    case 'if': {
      const condition = node[1];
      const trueBranch = node[2];
      const falseBranch = node[3];
      const conditionResult = evaluateCondition(condition, ctx);
      if (ctx?.reasoning) {
        const conditionLabel = describeCondition(condition);
        ctx.reasoning.push(
          `Conditional evaluation: ${conditionLabel} => ${conditionResult ? 'TRUE' : 'FALSE'}.`
        );
        const branchNodes = conditionResult ? ensureArray(trueBranch) : ensureArray(falseBranch);
        const branchLabel = conditionResult ? 'true branch actions' : 'false branch actions';
        pushReasoning(ctx, `→ Executing ${branchLabel}:`);
        const branchPositions = branchNodes.flatMap((child) =>
          evaluateNode(child, parentWeight, ctx)
        );
        return mergePositions(branchPositions);
      }
      const evaluated = conditionResult ? ensureArray(trueBranch) : ensureArray(falseBranch);
      const positions = evaluated.flatMap((child) =>
        evaluateNode(child, parentWeight, ctx)
      );
      return mergePositions(positions);
    }
    case 'asset': {
      const symbol = extractSymbolFromAssetNode(node);
      if (!symbol) {
        return [];
      }
      pushReasoning(ctx, `Asset node reached: allocating ${(parentWeight * 100).toFixed(2)}% to ${symbol}.`);
      if (!ctx.priceData.has(symbol)) {
        noteMissingPriceData(ctx, symbol);
        return [];
      }
      return [
        {
          symbol,
          weight: parentWeight,
          rationale: 'Selected by asset node.',
        },
      ];
    }
    case 'filter': {
      return evaluateFilterNode(node, parentWeight, ctx);
    }
    default: {
      const children = flattenChildren(node);
      const positions = children.flatMap((child) =>
        evaluateNode(child, parentWeight, ctx)
      );
      return mergePositions(positions);
    }
  }
}

const normalizePositions = (positions = []) => {
  const merged = mergePositions(positions);
  const total = sumWeights(merged);
  if (!total) {
    throw new Error('No positions generated by evaluator.');
  }
  return merged.map((pos) => ({
    ...pos,
    weight: pos.weight / total,
  }));
};

const loadPriceData = async (
  symbols = [],
  calendarLookbackDays = DEFAULT_LOOKBACK_BARS,
  options = {}
) => {
  const boundedLookback = Math.min(
    Math.max(1, Number(calendarLookbackDays) || DEFAULT_LOOKBACK_BARS),
    MAX_CALENDAR_LOOKBACK_DAYS
  );
  const asOfDateKeyOverride = normalizeDateKeyInput(options.asOfDate);
  const asOfDate = asOfDateKeyOverride
    ? new Date(`${asOfDateKeyOverride}T23:59:59.999Z`)
    : normalizeAsOfDate(options.asOfDate) || now();
  const start = new Date(asOfDate.getTime() - boundedLookback * 24 * 60 * 60 * 1000);
  const end = asOfDate;
  const adjustment = options.dataAdjustment;
  const asOfMode = normalizeAsOfMode(options.asOfMode) || 'previous-close';
  const appendLivePrice =
    normalizeAppendLivePrice(options.appendLivePrice ?? process.env.COMPOSER_APPEND_LIVE_PRICE) ??
    asOfMode === 'current';
  const priceSource = normalizePriceSource(options.priceSource);
  const forceRefresh = normalizePriceRefresh(options.forceRefresh);
  const cacheOnly =
    normalizeBoolean(options.cacheOnly) ??
    (asOfMode === 'previous-close' && forceRefresh === false);
  const minBars = Number.isFinite(Number(options.minBars)) ? Math.max(0, Math.floor(Number(options.minBars))) : 0;
  const map = new Map();
  const missing = [];
  const handleSymbol = async (symbol) => {
    const upper = symbol.toUpperCase();
    try {
      const response = await getCachedPrices({
        symbol: upper,
        startDate: start,
        endDate: end,
        adjustment,
        source: priceSource,
        forceRefresh,
        minBars,
        cacheOnly,
      });
      let bars = response.bars || [];
      if (asOfMode === 'previous-close' && bars.length > 1) {
        // Use a consistent day-key basis across the evaluator:
        // - stale-series detection uses `toISODateKey()` (UTC-based)
        // - some data sources timestamp daily bars at 00:00Z for the labeled session date
        // So we compute the intraday-drop keys using `toISODateKey()` as well.
        const asOfDayKey = asOfDateKeyOverride ? asOfDateKeyOverride : toISODateKey(asOfDate);
        const lastBar = bars[bars.length - 1];
        const lastDayKey = lastBar?.t ? toISODateKey(lastBar.t) : null;
        const nowDate = now();
        const nowDayKey = toISODateKey(nowDate);
        const isAsOfToday = Boolean(asOfDayKey && nowDayKey && asOfDayKey === nowDayKey);
        // Treat the current trading day as incomplete until the real-time market close, even when
        // the requested as-of date is expressed as an end-of-day timestamp (e.g. YYYY-MM-DD).
        const marketClosedForAsOfDay = isAsOfToday ? isAfterUsMarketClose(nowDate) : true;
        const shouldDropIntradayBar =
          asOfDayKey &&
          lastDayKey &&
          lastDayKey === asOfDayKey &&
          !marketClosedForAsOfDay;
        if (shouldDropIntradayBar) {
          bars = bars.slice(0, -1);
        }
      }
      if (appendLivePrice) {
        const livePrice = await fetchLatestPrice({ symbol: upper, source: priceSource });
        if (Number.isFinite(livePrice) && livePrice > 0) {
          const todayKey = toISODateKey(new Date());
          const lastBar = bars.length ? bars[bars.length - 1] : null;
          const lastDateKey = lastBar?.t ? toISODateKey(lastBar.t) : null;
          if (lastBar && lastDateKey === todayKey) {
            lastBar.c = livePrice;
            if (Number.isFinite(lastBar.h)) {
              lastBar.h = Math.max(lastBar.h, livePrice);
            } else {
              lastBar.h = livePrice;
            }
            if (Number.isFinite(lastBar.l)) {
              lastBar.l = Math.min(lastBar.l, livePrice);
            } else {
              lastBar.l = livePrice;
            }
            if (!Number.isFinite(lastBar.o)) {
              lastBar.o = livePrice;
            }
          } else {
            bars = [
              ...bars,
              {
                t: new Date().toISOString(),
                o: livePrice,
                h: livePrice,
                l: livePrice,
                c: livePrice,
                v: 0,
              },
            ];
          }
        }
      }
      const closes = bars.map((bar) => Number(bar.c));
      if (!closes.length) {
        throw new Error('No close prices returned.');
      }
      map.set(upper, {
        closes,
        latest: closes[closes.length - 1],
        bars,
      });
    } catch (error) {
      missing.push({
        symbol: upper,
        reason: error?.message || 'Unknown pricing error.',
      });
    }
  };

  if (priceSource === 'yahoo') {
    await runWithConcurrency(symbols, 4, handleSymbol);
  } else {
    await Promise.all(symbols.map(handleSymbol));
  }
  let asOfDateUsed = null;
  map.forEach((series) => {
    const lastBar = Array.isArray(series.bars) && series.bars.length
      ? series.bars[series.bars.length - 1]
      : null;
    const timestamp = lastBar?.t;
    if (!timestamp) {
      return;
    }
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      return;
    }
    if (!asOfDateUsed || date > asOfDateUsed) {
      asOfDateUsed = date;
    }
  });

  return { map, missing, asOfDate: asOfDateUsed, asOfMode, appendLivePrice };
};

const evaluateDefsymphonyStrategy = async ({
  strategyText,
  budget = 1000,
  asOfDate = null,
  rsiMethod = null,
  dataAdjustment = null,
  debugIndicators = null,
  asOfMode = null,
  priceSource = null,
  priceRefresh = null,
}) => {
  const ast = parseComposerScript(strategyText);
  if (!ast) {
    throw new Error('Failed to parse defsymphony script.');
  }
  const astStats = collectAstStats(ast);
  const tickers = Array.from(collectTickersFromAst(ast)).sort();
  if (!tickers.length) {
    throw new Error('No tickers found in defsymphony script.');
  }
  const blueprint = buildEvaluationBlueprint(ast) || [];
  const nodeIdMap = assignNodeIds(ast);

  const rsiWindow = Math.max(0, Number(astStats.maxRsiWindow) || 0);
  const rsiHistoryBuffer = rsiWindow ? 250 : 0;

  const resolvedAsOfDate = normalizeAsOfDate(asOfDate) || now();
  const resolvedRsiMethod =
    normalizeRsiMethod(rsiMethod) || normalizeRsiMethod(process.env.RSI_METHOD) || 'wilder';
  const resolvedAdjustment = normalizeAdjustment(
    dataAdjustment ??
      process.env.COMPOSER_DATA_ADJUSTMENT ??
      process.env.ALPACA_DATA_ADJUSTMENT ??
      'all'
  );
  const resolvedAsOfMode =
    normalizeAsOfMode(asOfMode) || normalizeAsOfMode(process.env.COMPOSER_ASOF_MODE) || 'previous-close';
  const resolvedPriceSource =
    normalizePriceSource(priceSource) ||
    normalizePriceSource(process.env.COMPOSER_PRICE_SOURCE) ||
    normalizePriceSource(process.env.PRICE_DATA_SOURCE) ||
    (hasTiingoToken() ? 'tiingo' : 'yahoo');
  const resolvedPriceRefresh =
    normalizePriceRefresh(priceRefresh) ??
    normalizePriceRefresh(process.env.PRICE_DATA_FORCE_REFRESH) ??
    resolvedPriceSource === 'yahoo';
  const resolvedDebugIndicators =
    normalizeBoolean(debugIndicators) ?? ENABLE_INDICATOR_DEBUG;

  const requiredBars = Math.max(
    Math.max(0, Number(astStats.maxWindow) || 0) + 5,
    rsiWindow + rsiHistoryBuffer,
    30
  );
  const calendarLookbackDays = Math.min(
    MAX_CALENDAR_LOOKBACK_DAYS,
    Math.ceil((requiredBars * CALENDAR_DAYS_PER_YEAR) / TRADING_DAYS_PER_YEAR) + 7
  );

  const {
    map: priceData,
    missing: missingFromCacheRaw,
    asOfDate: dataAsOfDate,
    asOfMode: resolvedDataAsOfMode,
    appendLivePrice,
  } = await loadPriceData(
    tickers,
    calendarLookbackDays,
    {
      asOfDate: resolvedAsOfDate,
      dataAdjustment: resolvedAdjustment,
      asOfMode: resolvedAsOfMode,
      priceSource: resolvedPriceSource,
      forceRefresh: resolvedPriceRefresh,
      minBars: requiredBars,
    }
  );
  const missingFromCache = Array.isArray(missingFromCacheRaw) ? [...missingFromCacheRaw] : [];
  const effectiveAsOfDate = dataAsOfDate || resolvedAsOfDate;

  // If a subset of symbols returned stale series (e.g., delisted tickers or sparse Yahoo coverage),
  // exclude them rather than forcing the entire evaluation to rewind to the oldest available date.
  const effectiveDayKey = toISODateKey(effectiveAsOfDate);
  if (effectiveDayKey) {
    const stale = [];
    priceData.forEach((series, symbol) => {
      const lastBar = Array.isArray(series?.bars) && series.bars.length ? series.bars[series.bars.length - 1] : null;
      const lastKey = lastBar?.t ? toISODateKey(lastBar.t) : null;
      if (lastKey && lastKey < effectiveDayKey) {
        stale.push({ symbol, lastKey });
      }
    });
    stale.forEach(({ symbol, lastKey }) => {
      priceData.delete(symbol);
      missingFromCache.push({
        symbol,
        reason: `Stale price history (last bar ${lastKey}, expected ${effectiveDayKey}).`,
      });
    });
  }

  const usableHistory = alignPriceHistory(priceData, requiredBars);
  if (!usableHistory) {
    throw new Error('Unable to align price history for the requested lookback window.');
  }
  const requestedAsOfLabel = formatDateForLog(resolvedAsOfDate);
  const effectiveAsOfLabel = formatDateForLog(effectiveAsOfDate);
  const asOfLabel =
    requestedAsOfLabel && effectiveAsOfLabel && requestedAsOfLabel !== effectiveAsOfLabel
      ? `, requested ${requestedAsOfLabel}, effective ${effectiveAsOfLabel}`
      : `, as of ${effectiveAsOfLabel}`;
  const context = {
    priceData,
    metricCache: new WeakMap(),
    missingSymbols: new Map(),
    nodeIdMap,
    enableGroupMetrics: false,
    debugIndicators: resolvedDebugIndicators,
    rsiMethod: resolvedRsiMethod,
    // `loadPriceData()` already enforces "previous-close" semantics by dropping today's unfinished
    // daily bar when needed. Only drop the latest bar from indicator calculations when we explicitly
    // appended a live quote on top of the previous-close history.
    usePreviousBarForIndicators:
      (resolvedDataAsOfMode || resolvedAsOfMode) === 'previous-close' && Boolean(appendLivePrice),
    asOfDate: effectiveAsOfDate,
    dataAdjustment: resolvedAdjustment,
    reasoning: [
      `Step 1: Loaded ${priceData.size} of ${tickers.length} tickers from local price cache (source ${resolvedPriceSource}, refresh ${resolvedPriceRefresh ? 'forced' : 'cached'}, calendar lookback ${calendarLookbackDays} days, usable ${usableHistory} bars${asOfLabel}).`,
    ],
  };
  if (missingFromCache.length) {
    context.reasoning.push(
      `Step 1a: Missing cached data for ${missingFromCache
        .map((entry) => `${entry.symbol}${entry.reason ? ` (${entry.reason})` : ''}`)
        .join(', ')}.`
    );
    missingFromCache.forEach((entry) => {
      context.missingSymbols.set(entry.symbol, entry.reason);
    });
  }

  if (astStats.needsNodeSeries) {
    const meta = buildGroupSeriesCache(ast, context, astStats, usableHistory);
    if (!meta) {
      throw new Error('Unable to simulate portfolio NAV series for the provided strategy.');
    }
    context.reasoning.push(
      `Step 1b: Enabled node-metric evaluation (portfolio NAV series simulated on-demand for non-asset candidates).`
    );
  }

  let rawPositions = evaluateNode(ast, 1, context);
  if (!rawPositions.length) {
    const fallbackSymbols = tickers.filter((symbol) => context.priceData.has(symbol));
    if (fallbackSymbols.length) {
      context.reasoning.push(
        `Step 2a: Primary evaluation returned no tradable allocations. Applying equal-weight fallback across ${fallbackSymbols.length} tickers that have price data.`
      );
      const equalWeight = 1 / fallbackSymbols.length;
      rawPositions = fallbackSymbols.map((symbol) => ({
        symbol,
        weight: equalWeight,
        rationale: 'Fallback equal-weight allocation due to empty evaluator result.',
      }));
    }
  }
  context.reasoning.push(
    `Step 2: Evaluated defsymphony tree and gathered ${rawPositions.length} raw allocation slices.`,
  );

  const positions = normalizePositions(rawPositions);
  context.reasoning.push(
    `Step 3: Normalized to ${positions.length} unique tickers with weights summing to 1.`,
  );

  const pricedPositions = positions.filter((pos) => priceData.has(pos.symbol));
  const droppedSymbols = positions
    .filter((pos) => !priceData.has(pos.symbol))
    .map((pos) => pos.symbol);
  if (droppedSymbols.length) {
    droppedSymbols.forEach((symbol) => {
      if (!context.missingSymbols.has(symbol)) {
        context.missingSymbols.set(symbol, 'price data unavailable during sizing');
      }
    });
    throw new Error(
      `Unable to size positions because market data was missing for: ${droppedSymbols.join(', ')}.`
    );
  }
  const normalizedPriced = normalizePositions(pricedPositions);

  const withPricing = normalizedPriced.map((pos) => {
    const series = priceData.get(pos.symbol);
    const price = series.latest;
    const targetValue = budget * pos.weight;
    const rawQty = price > 0 ? targetValue / price : 0;
    const quantity = ENABLE_FRACTIONAL_ORDERS
      ? Math.max(roundQuantity(rawQty), 0)
      : Math.max(Math.floor(rawQty), 0);
    return {
      symbol: pos.symbol,
      weight: pos.weight,
      quantity,
      estimated_cost: quantity * price,
      rationale: pos.rationale || 'Selected via local defsymphony evaluation.',
    };
  });

  context.reasoning.push(
    `Step 4: Sized allocations for a $${budget.toFixed(2)} budget using latest closes.`,
  );
  if (context.missingSymbols?.size) {
    const entries = Array.from(context.missingSymbols.entries());
    const formatted = entries.slice(0, 10).map(([symbol, reason]) =>
      reason ? `${symbol} (${reason})` : symbol
    );
    const extra = entries.length > 10 ? ` and ${entries.length - 10} more` : '';
    context.reasoning.push(
      `Step 5: Local cache covered ${priceData.size}/${tickers.length} tickers; ${entries.length} still need live prices via Alpaca -> Yahoo -> Massive. Pending tickers: ${formatted.join(', ')}${extra}.`
    );
  } else {
    context.reasoning.push(
      `Step 5: Local cache covered all ${tickers.length} tickers, so no live price fallback was needed.`
    );
  }
  context.reasoning.push(
    `Step 6: Final tradable allocation -> ${describePositionPlan(withPricing)}.`
  );

  const summaryLines = [
    `Local defsymphony evaluation completed with ${withPricing.length} positions.`,
    `Budget allocated: $${budget.toFixed(2)}.`,
  ];
  summaryLines.push(`As-of date: ${formatDateForLog(effectiveAsOfDate)}.`);
  const missingCount = context.missingSymbols?.size || 0;
  if (missingCount) {
    summaryLines.push(
      `Local cache coverage: ${priceData.size}/${tickers.length} tickers. Remaining ${missingCount} tickers will be fetched live (Alpaca -> Yahoo -> Massive) during order sizing.`
    );
  } else {
    summaryLines.push(
      `Local cache coverage: ${tickers.length}/${tickers.length} tickers; no additional live data fetch required.`
    );
  }
  summaryLines.push(`Final tradable allocation: ${describePositionPlan(withPricing)}.`);

  return {
    summary: summaryLines.join(' '),
    reasoning: context.reasoning,
    positions: withPricing,
    data_source: 'local-cache',
    meta: {
      engine: 'local',
      localEvaluator: {
        used: true,
        tickers,
        blueprint,
        lookbackDays: calendarLookbackDays,
        historyLength: usableHistory,
        groupSimulation: Boolean(context.enableGroupMetrics),
        groupSeriesMeta: context.groupSeriesMeta || null,
        asOfDate: effectiveAsOfDate.toISOString(),
        rsiMethod: resolvedRsiMethod,
        dataAdjustment: resolvedAdjustment,
        debugIndicators: resolvedDebugIndicators,
        asOfMode: resolvedDataAsOfMode || resolvedAsOfMode,
        usePreviousBarForIndicators: context.usePreviousBarForIndicators,
        appendLivePrice,
        priceSource: resolvedPriceSource,
        priceRefresh: resolvedPriceRefresh,
        missingData: context.missingSymbols
          ? Array.from(context.missingSymbols.entries()).map(([symbol, reason]) => ({ symbol, reason }))
          : [],
      },
    },
  };
};

const BACKTEST_MAX_DAYS = Math.max(30, Math.min(10000, Number(process.env.COMPOSER_BACKTEST_MAX_DAYS) || 2500));

const findFirstIndex = (items, predicate) => {
  for (let idx = 0; idx < items.length; idx += 1) {
    if (predicate(items[idx], idx)) {
      return idx;
    }
  }
  return -1;
};

const findLastIndex = (items, predicate) => {
  for (let idx = items.length - 1; idx >= 0; idx -= 1) {
    if (predicate(items[idx], idx)) {
      return idx;
    }
  }
  return -1;
};

const normalizeBacktestStartDate = (value, label) => {
  if (!value) {
    throw new Error(`${label} is required (YYYY-MM-DD).`);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const date = new Date(`${trimmed}T00:00:00.000Z`);
      if (Number.isNaN(date.getTime())) {
        throw new Error(`${label} is invalid; expected YYYY-MM-DD.`);
      }
      return date;
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} is invalid; expected YYYY-MM-DD.`);
  }
  return date;
};

const normalizeBacktestEndDate = (value, label) => {
  if (!value) {
    throw new Error(`${label} is required (YYYY-MM-DD).`);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const date = new Date(`${trimmed}T23:59:59.999Z`);
      if (Number.isNaN(date.getTime())) {
        throw new Error(`${label} is invalid; expected YYYY-MM-DD.`);
      }
      return date;
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} is invalid; expected YYYY-MM-DD.`);
  }
  return date;
};

const normalizeBps = (value, fallback = 0) => {
  if (value == null || value === '') {
    return fallback;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(0, Math.min(1000, num));
};

const buildBarsByDateKey = (bars = []) => {
  const map = new Map();
  if (!Array.isArray(bars)) {
    return map;
  }
  bars.forEach((bar) => {
    const dateKey = bar?.t ? toISODateKey(bar.t) : null;
    const close = Number(bar?.c);
    if (!dateKey || !Number.isFinite(close)) {
      return;
    }
    map.set(dateKey, { close, timestamp: bar.t });
  });
  return map;
};

const intersectDateKeys = (mapsBySymbol) => {
  const entries = Array.from(mapsBySymbol.entries())
    .map(([symbol, map]) => ({ symbol, map, size: map.size }))
    .sort((a, b) => a.size - b.size);
  if (!entries.length) {
    return [];
  }
  const common = new Set(entries[0].map.keys());
  for (let idx = 1; idx < entries.length; idx += 1) {
    const current = entries[idx].map;
    Array.from(common).forEach((key) => {
      if (!current.has(key)) {
        common.delete(key);
      }
    });
    if (!common.size) {
      break;
    }
  }
  return Array.from(common).sort();
};

const computeTurnover = (prevWeights, nextWeights) => {
  if (!prevWeights) {
    return 0;
  }
  const union = new Set([...prevWeights.keys(), ...nextWeights.keys()]);
  let sumAbs = 0;
  union.forEach((symbol) => {
    sumAbs += Math.abs((nextWeights.get(symbol) || 0) - (prevWeights.get(symbol) || 0));
  });
  return sumAbs / 2;
};

const extractDefsymphonyOptions = (node) => {
  if (!Array.isArray(node)) {
    return null;
  }
  if (node[0] !== 'defsymphony') {
    return null;
  }
  const options = node[2];
  return options && typeof options === 'object' && !Array.isArray(options) ? options : null;
};

const normalizeRebalanceFrequency = (value) => {
  if (!value) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  const stripped = normalized.startsWith(':') ? normalized.slice(1) : normalized;
  if (['daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'none', 'threshold'].includes(stripped)) {
    return stripped;
  }
  return null;
};

const extractRebalanceConfig = (ast) => {
  const options = extractDefsymphonyOptions(ast);
  const thresholdRaw = options ? options[':rebalance-threshold'] : null;
  const threshold = Number(thresholdRaw);
  if (Number.isFinite(threshold) && threshold > 0) {
    return { mode: 'threshold', threshold };
  }

  const freqRaw = options ? options[':rebalance-frequency'] : null;
  const freq = normalizeRebalanceFrequency(freqRaw) || 'daily';
  if (freq === 'threshold') {
    return { mode: 'threshold', threshold: 0 };
  }
  return { mode: freq, threshold: 0 };
};

const shouldRebalanceOnDate = (mode, currentDateKey, previousDateKey) => {
  if (!mode || mode === 'daily') {
    return true;
  }
  if (mode === 'none') {
    return false;
  }
  if (!currentDateKey || !previousDateKey) {
    return true;
  }
  if (mode === 'weekly') {
    // Rebalance on the first trading day after a week boundary.
    const prevDate = new Date(`${previousDateKey}T00:00:00.000Z`);
    const currentDate = new Date(`${currentDateKey}T00:00:00.000Z`);
    const prevWeek = Math.floor(prevDate.getTime() / (7 * 24 * 60 * 60 * 1000));
    const currentWeek = Math.floor(currentDate.getTime() / (7 * 24 * 60 * 60 * 1000));
    return currentWeek !== prevWeek;
  }
  if (mode === 'monthly') {
    return currentDateKey.slice(0, 7) !== previousDateKey.slice(0, 7);
  }
  if (mode === 'quarterly') {
    const quarter = (key) => {
      const month = Number(key.slice(5, 7));
      return `${key.slice(0, 4)}-Q${Math.floor((month - 1) / 3) + 1}`;
    };
    return quarter(currentDateKey) !== quarter(previousDateKey);
  }
  if (mode === 'yearly') {
    return currentDateKey.slice(0, 4) !== previousDateKey.slice(0, 4);
  }
  return true;
};

const computeBacktestMetrics = ({ navSeries, dailyReturns, turnoverSeries }) => {
  const totalDays = dailyReturns.length;
  const endingNav = navSeries.length ? navSeries[navSeries.length - 1] : 1;
  const totalReturn = endingNav - 1;
  const avgDailyReturn =
    totalDays > 0 ? dailyReturns.reduce((sum, value) => sum + value, 0) / totalDays : 0;
  const annualizedMeanReturn = avgDailyReturn * TRADING_DAYS_PER_YEAR;
  // Composer metrics assume a zero risk-free rate and use a population standard deviation
  // of daily returns, annualized by sqrt(252).
  const volatility =
    totalDays > 0
      ? (() => {
          const mean = avgDailyReturn;
          const variance =
            dailyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / totalDays;
          return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
        })()
      : 0;
  const cagr = totalDays > 0 ? (endingNav ** (TRADING_DAYS_PER_YEAR / totalDays) - 1) : 0;

  let peak = 1;
  let minDrawdown = 0;
  navSeries.forEach((nav) => {
    if (nav > peak) {
      peak = nav;
    }
    const dd = (nav - peak) / peak;
    if (dd < minDrawdown) {
      minDrawdown = dd;
    }
  });
  const maxDrawdown = Math.abs(minDrawdown);
  const sharpe = volatility > 0 ? annualizedMeanReturn / volatility : 0;
  const calmar = maxDrawdown > 0 ? cagr / maxDrawdown : 0;
  const winRate = totalDays > 0 ? dailyReturns.filter((value) => value > 0).length / totalDays : 0;
  const avgTurnover =
    turnoverSeries.length > 0 ? turnoverSeries.reduce((sum, value) => sum + value, 0) / turnoverSeries.length : 0;

  return {
    totalDays,
    totalReturn,
    cagr,
    volatility,
    sharpe,
    maxDrawdown,
    calmar,
    winRate,
    avgDailyReturn,
    annualizedMeanReturn,
    avgTurnover,
  };
};

const computeBetaStats = ({ strategyReturns, benchmarkReturns }) => {
  if (!Array.isArray(strategyReturns) || !Array.isArray(benchmarkReturns)) {
    return { beta: null, r2: null, correlation: null };
  }
  const count = Math.min(strategyReturns.length, benchmarkReturns.length);
  const xs = [];
  const ys = [];
  for (let i = 0; i < count; i += 1) {
    const x = Number(benchmarkReturns[i]);
    const y = Number(strategyReturns[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    xs.push(x);
    ys.push(y);
  }
  if (xs.length < 2) {
    return { beta: null, r2: null, correlation: null };
  }

  const mean = (arr) => arr.reduce((sum, v) => sum + v, 0) / arr.length;
  const meanX = mean(xs);
  const meanY = mean(ys);
  let varX = 0;
  let varY = 0;
  let covXY = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    varX += dx * dx;
    varY += dy * dy;
    covXY += dx * dy;
  }
  varX /= xs.length;
  varY /= xs.length;
  covXY /= xs.length;

  if (!Number.isFinite(varX) || varX <= 0 || !Number.isFinite(varY) || varY <= 0) {
    return { beta: null, r2: null, correlation: null };
  }
  const beta = covXY / varX;
  const correlation = covXY / Math.sqrt(varX * varY);
  const r2 = correlation * correlation;
  return {
    beta: Number.isFinite(beta) ? beta : null,
    correlation: Number.isFinite(correlation) ? correlation : null,
    r2: Number.isFinite(r2) ? r2 : null,
  };
};

const backtestDefsymphonyStrategy = async ({
  strategyText,
  startDate,
  endDate,
  initialCapital = 10000,
  transactionCostBps = 0,
  rsiMethod = null,
  dataAdjustment = null,
  asOfMode = 'previous-close',
  priceSource = null,
  priceRefresh = null,
  benchmarkSymbol = 'SPY',
  includeBenchmark = true,
}) => {
  const ast = parseComposerScript(strategyText);
  if (!ast) {
    throw new Error('Failed to parse defsymphony script.');
  }
  const astStats = collectAstStats(ast);
  const tickers = Array.from(collectTickersFromAst(ast)).sort();
  if (!tickers.length) {
    throw new Error('No tickers found in defsymphony script.');
  }

  const resolvedStart = normalizeBacktestStartDate(startDate, 'startDate');
  const resolvedEnd = normalizeBacktestEndDate(endDate, 'endDate');
  if (resolvedStart >= resolvedEnd) {
    throw new Error('startDate must be before endDate.');
  }

  const resolvedCapital = Number.isFinite(Number(initialCapital)) && Number(initialCapital) > 0 ? Number(initialCapital) : 10000;
  const resolvedCostBps = normalizeBps(transactionCostBps, 0);

  const rsiWindow = Math.max(0, Number(astStats.maxRsiWindow) || 0);
  const rsiHistoryBuffer = rsiWindow ? 250 : 0;
  const requiredBars = Math.max(
    Math.max(0, Number(astStats.maxWindow) || 0) + 5,
    rsiWindow + rsiHistoryBuffer,
    10
  );
  const warmupCalendarDays = Math.ceil((requiredBars * CALENDAR_DAYS_PER_YEAR) / TRADING_DAYS_PER_YEAR) + 14;
  const dataStart = new Date(resolvedStart.getTime() - warmupCalendarDays * 24 * 60 * 60 * 1000);
  const requestedCalendarDays = Math.max(1, Math.ceil((resolvedEnd.getTime() - dataStart.getTime()) / (24 * 60 * 60 * 1000)));
  const minBarsForRange = Math.max(
    requiredBars + 5,
    Math.ceil((requestedCalendarDays * TRADING_DAYS_PER_YEAR) / CALENDAR_DAYS_PER_YEAR) + 5
  );

  const resolvedRsiMethod =
    normalizeRsiMethod(rsiMethod) || normalizeRsiMethod(process.env.RSI_METHOD) || 'wilder';
  const resolvedAdjustment = normalizeAdjustment(
    dataAdjustment ??
      process.env.COMPOSER_DATA_ADJUSTMENT ??
      process.env.ALPACA_DATA_ADJUSTMENT ??
      'all'
  );
  const resolvedPriceSource =
    normalizePriceSource(priceSource) ||
    normalizePriceSource(process.env.COMPOSER_PRICE_SOURCE) ||
    normalizePriceSource(process.env.PRICE_DATA_SOURCE) ||
    (hasTiingoToken() ? 'tiingo' : null);
  const resolvedPriceRefresh =
    normalizePriceRefresh(priceRefresh) ??
    normalizePriceRefresh(process.env.PRICE_DATA_FORCE_REFRESH) ??
    resolvedPriceSource === 'yahoo';
  const resolvedAsOfMode = normalizeAsOfMode(asOfMode) || 'previous-close';

  const calendarSymbol = String(
    includeBenchmark && benchmarkSymbol ? benchmarkSymbol : tickers[0]
  )
    .trim()
    .toUpperCase();

  const rebalanceConfig = extractRebalanceConfig(ast);

  const priceBarsBySymbol = new Map();
  const fetchSymbol = async (symbol) => {
    const response = await getCachedPrices({
      symbol,
      startDate: dataStart,
      endDate: resolvedEnd,
      adjustment: resolvedAdjustment,
      source: resolvedPriceSource,
      forceRefresh: resolvedPriceRefresh,
      minBars: requiredBars,
    });
    const bars = response.bars || [];
    priceBarsBySymbol.set(symbol, buildBarsByDateKey(bars));
  };

  const symbolsToFetch = Array.from(new Set([...tickers.map((t) => t.toUpperCase()), calendarSymbol]));
  if (resolvedPriceSource === 'yahoo' || resolvedPriceSource == null) {
    await runWithConcurrency(symbolsToFetch, 4, async (ticker) => fetchSymbol(ticker.toUpperCase()));
  } else {
    await Promise.all(symbolsToFetch.map((ticker) => fetchSymbol(ticker.toUpperCase())));
  }

  // If the requested end date is "today" and the daily bar isn't published yet, Composer's UI commonly
  // shows holdings using the latest available quote. To match that behavior, append a synthetic bar
  // for `endKey` using the latest quote (when available).
  const endKey = toISODateKey(resolvedEnd);
  const todayKey = toISODateKey(new Date());
  let appendedLivePriceBar = false;
  if (endKey && todayKey && endKey === todayKey) {
    const calendarMap = priceBarsBySymbol.get(calendarSymbol);
    const calendarLastKey = calendarMap?.size ? Array.from(calendarMap.keys()).sort().slice(-1)[0] : null;
    if (calendarLastKey && calendarLastKey < endKey) {
      appendedLivePriceBar = true;
      const attachLatest = async (symbol) => {
        try {
          const latest = await fetchLatestPrice({ symbol, source: resolvedPriceSource });
          if (!Number.isFinite(latest) || latest <= 0) {
            return;
          }
          if (!priceBarsBySymbol.has(symbol)) {
            priceBarsBySymbol.set(symbol, new Map());
          }
          priceBarsBySymbol.get(symbol).set(endKey, {
            close: latest,
            timestamp: `${endKey}T00:00:00.000Z`,
          });
        } catch (error) {
          // best-effort only
        }
      };

      await runWithConcurrency(symbolsToFetch, 3, async (ticker) => attachLatest(ticker.toUpperCase()));
    }
  }

  const desiredAxisStartKey = toISODateKey(dataStart);
  const axisDates = pickDateAxis(priceBarsBySymbol, calendarSymbol, desiredAxisStartKey);
  if (axisDates.length < requiredBars + 2) {
    throw new Error(
      `Not enough trading days available to backtest (need at least ${requiredBars + 2}, have ${axisDates.length}).`
    );
  }

  const startKey = toISODateKey(resolvedStart);
  const endKeyResolved = toISODateKey(resolvedEnd);
  const requestedStartIdx = findFirstIndex(axisDates, (key) => key >= startKey);
  const requestedEndIdx = findLastIndex(axisDates, (key) => key <= endKeyResolved);
  if (requestedStartIdx === -1 || requestedEndIdx === -1 || requestedEndIdx <= 0) {
    throw new Error('No overlapping trading days found for the requested date range.');
  }

  const alignedSeries = new Map();
  tickers.forEach((ticker) => {
    const map = priceBarsBySymbol.get(ticker);
    const series = buildAlignedSeriesForAxis(ticker, map, axisDates);
    if (series) {
      alignedSeries.set(ticker, series);
    }
  });

  const missingAligned = tickers.filter((ticker) => !alignedSeries.has(ticker));
  if (missingAligned.length) {
    throw new Error(`Unable to align price history for: ${missingAligned.join(', ')}`);
  }

  const offsets = tickers.map((ticker) => Number(alignedSeries.get(ticker)?.offset) || 0);
  const minExecutionIndex = Math.max(1, ...offsets.map((offset) => offset + requiredBars + 1));
  const executionStartIdx = Math.max(requestedStartIdx, minExecutionIndex);
  if (executionStartIdx > requestedEndIdx) {
    const earliestKey = axisDates[Math.min(minExecutionIndex, axisDates.length - 1)];
    const axisStart = axisDates[0];
    const axisEnd = axisDates[axisDates.length - 1];
    throw new Error(
      [
        'Requested range is too early; not enough warmup history for indicators.',
        `Need at least ${requiredBars} warmup bars before the first evaluation day.`,
        `Earliest startDate for this strategy is ${earliestKey} (based on available data ${axisStart}..${axisEnd}).`,
        'Try a later startDate, reduce indicator windows, or ensure your data source has more history (e.g. PRICE_DATA_SOURCE=tiingo).',
      ].join(' ')
    );
  }

  const backtestDays = requestedEndIdx - executionStartIdx + 1;
  if (backtestDays > BACKTEST_MAX_DAYS) {
    throw new Error(
      `Backtest range too large (${backtestDays} trading days). Limit is ${BACKTEST_MAX_DAYS} (COMPOSER_BACKTEST_MAX_DAYS).`
    );
  }

  const priceData = new Map();
  tickers.forEach((ticker) => {
    const series = alignedSeries.get(ticker);
    const closes = series?.closes || [];
    const bars = series?.bars || [];
    priceData.set(ticker, {
      closes,
      latest: closes.length ? closes[closes.length - 1] : null,
      bars,
      offset: series?.offset || 0,
    });
  });

  const blueprint = buildEvaluationBlueprint(ast) || [];
  const nodeIdMap = assignNodeIds(ast);

  const baseCtx = {
    priceData,
    missingSymbols: new Map(),
    nodeIdMap,
    nodeSeries: new Map(),
    enableGroupMetrics: Boolean(astStats.hasGroupFilter),
    groupSeriesMeta: Boolean(astStats.hasGroupFilter)
      ? { startIndex: 1, priceLength: axisDates.length }
      : null,
    debugIndicators: false,
    rsiMethod: resolvedRsiMethod,
  };

  const navSeries = [];
  const dailyReturns = [];
  const turnoverSeries = [];
  let nav = 1;
  let heldWeights = null;
  let finalAllocation = [];

  for (let idx = executionStartIdx; idx <= requestedEndIdx; idx += 1) {
    const decisionIndex = idx - 1;
    const ctx = {
      ...baseCtx,
      priceIndex: decisionIndex,
      metricCache: new WeakMap(),
      reasoning: null,
      previewStack: null,
    };

    let targetPositions = [];
    try {
      const raw = evaluateNode(ast, 1, ctx);
      targetPositions = safeNormalizePositions(raw);
    } catch (error) {
      targetPositions = [];
    }

    const targetWeights = new Map();
    targetPositions.forEach((pos) => {
      if (pos?.symbol) {
        targetWeights.set(pos.symbol, Number(pos.weight) || 0);
      }
    });

    const dateKey = axisDates[idx];
    const prevDateKey = idx > 0 ? axisDates[idx - 1] : null;
    const scheduledRebalance =
      !heldWeights ||
      (rebalanceConfig.mode !== 'threshold' &&
        shouldRebalanceOnDate(rebalanceConfig.mode, dateKey, prevDateKey));

    const currentWeights = heldWeights ? new Map(heldWeights) : new Map();
    const turnoverToTarget = heldWeights ? computeTurnover(currentWeights, targetWeights) : 0;
    const shouldRebalance =
      !heldWeights ||
      (rebalanceConfig.mode === 'threshold'
        ? turnoverToTarget > (rebalanceConfig.threshold || 0)
        : scheduledRebalance);

    const startWeights = shouldRebalance ? targetWeights : currentWeights;
    const turnover = shouldRebalance ? turnoverToTarget : 0;
    const startPositions = Array.from(startWeights.entries()).map(([symbol, weight]) => ({
      symbol,
      weight,
      rationale: shouldRebalance ? 'Rebalanced to target weights.' : 'Held due to rebalance schedule/threshold.',
    }));

    const grossReturn = startPositions.length ? computePortfolioReturn(startPositions, priceData, idx) : 0;
    const costs = resolvedCostBps ? turnover * (resolvedCostBps / 10000) : 0;
    const netReturn = grossReturn - costs;

    nav *= 1 + netReturn;
    navSeries.push(nav);
    dailyReturns.push(netReturn);
    turnoverSeries.push(turnover);

    // Drift weights forward using each asset's realized return for the period.
    const drifted = new Map();
    let driftTotal = 0;
    startWeights.forEach((weight, symbol) => {
      const series = priceData.get(symbol.toUpperCase());
      if (!series || !Array.isArray(series.closes)) {
        return;
      }
      const offset = Number(series.offset) || 0;
      const relIdx = idx - offset;
      const prevRelIdx = relIdx - 1;
      if (prevRelIdx < 0) {
        return;
      }
      const prev = series.closes[Math.min(prevRelIdx, series.closes.length - 1)];
      const curr = series.closes[Math.min(Math.max(relIdx, 0), series.closes.length - 1)];
      if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0) {
        return;
      }
      const assetReturn = (curr - prev) / prev;
      const driftedWeight = Number(weight) * (1 + assetReturn);
      if (!Number.isFinite(driftedWeight) || driftedWeight <= 0) {
        return;
      }
      drifted.set(symbol, driftedWeight);
      driftTotal += driftedWeight;
    });

    if (driftTotal > 0) {
      drifted.forEach((weight, symbol) => {
        drifted.set(symbol, weight / driftTotal);
      });
      heldWeights = drifted;
    } else {
      heldWeights = startWeights;
    }
  }

  // Composer's "Simulated Holdings" view is most comparable to a final allocation computed using
  // information available at the last completed bar (i.e., an as-of allocation for the next session),
  // not the drifted weights at the last close.
  const asOfCtx = {
    ...baseCtx,
    priceIndex: requestedEndIdx,
    usePreviousBarForIndicators:
      resolvedAsOfMode === 'previous-close' && appendedLivePriceBar,
    metricCache: new WeakMap(),
    reasoning: null,
    previewStack: null,
  };
  let asOfPositions = [];
  try {
    const raw = evaluateNode(ast, 1, asOfCtx);
    asOfPositions = safeNormalizePositions(raw);
  } catch (error) {
    asOfPositions = [];
  }
  finalAllocation = asOfPositions;

  const series = navSeries.map((navValue, offset) => {
    const idx = executionStartIdx + offset;
    const dateKey = axisDates[idx];
    return {
      date: dateKey,
      nav: navValue,
      value: navValue * resolvedCapital,
      dailyReturn: dailyReturns[offset],
      turnover: turnoverSeries[offset],
    };
  });

  const finalDateKey = series.length ? series[series.length - 1]?.date : null;
  const finalValue = series.length ? series[series.length - 1]?.value : resolvedCapital;
  const finalHoldings = (finalAllocation || [])
    .filter((pos) => pos?.symbol && Number.isFinite(Number(pos.weight)) && Number(pos.weight) > 0)
    .map((pos) => {
      const symbol = pos.symbol.toUpperCase();
      const record = priceData.get(symbol);
      const offset = Number(record?.offset) || 0;
      const relIdx = requestedEndIdx - offset;
      const close = Array.isArray(record?.closes) && relIdx >= 0 ? record.closes[Math.min(relIdx, record.closes.length - 1)] : null;
      const weight = Number(pos.weight) || 0;
      const value = finalValue * weight;
      const quantity = Number.isFinite(close) && close > 0 ? value / close : 0;
      return {
        symbol,
        weight,
        close,
        quantity,
        value,
      };
    })
    .sort((a, b) => (b.weight || 0) - (a.weight || 0));

  let benchmark = null;
  let betaStats = null;
  if (includeBenchmark && benchmarkSymbol) {
    try {
      const normalizedBenchmark = String(benchmarkSymbol).trim().toUpperCase();
      let benchMap = priceBarsBySymbol.get(normalizedBenchmark);
      if (!benchMap?.size) {
        const benchResp = await getCachedPrices({
          symbol: normalizedBenchmark,
          startDate: dataStart,
          endDate: resolvedEnd,
          adjustment: resolvedAdjustment,
          source: resolvedPriceSource,
          forceRefresh: resolvedPriceRefresh,
        });
        benchMap = buildBarsByDateKey(benchResp.bars || []);
      }

      const benchSeries = buildAlignedSeriesForAxis(normalizedBenchmark, benchMap, axisDates);
      if (!benchSeries) {
        throw new Error('Unable to align benchmark history.');
      }
      const benchNavSeries = [];
      const benchReturns = [];
      let benchNav = 1;
      for (let idx = executionStartIdx; idx <= requestedEndIdx; idx += 1) {
        const relIdx = idx - benchSeries.offset;
        const prevRelIdx = relIdx - 1;
        if (prevRelIdx < 0) {
          benchNavSeries.push(benchNav);
          benchReturns.push(0);
          continue;
        }
        const prev = benchSeries.closes[Math.min(prevRelIdx, benchSeries.closes.length - 1)];
        const curr = benchSeries.closes[Math.min(Math.max(relIdx, 0), benchSeries.closes.length - 1)];
        if (!Number.isFinite(curr) || !Number.isFinite(prev) || prev <= 0) {
          benchNavSeries.push(benchNav);
          benchReturns.push(0);
          continue;
        }
        const daily = (curr - prev) / prev;
        benchNav *= 1 + daily;
        benchNavSeries.push(benchNav);
        benchReturns.push(daily);
      }
      benchmark = {
        symbol: normalizedBenchmark,
        series: benchNavSeries.map((navValue, offset) => ({
          date: axisDates[executionStartIdx + offset],
          nav: navValue,
          value: navValue * resolvedCapital,
          dailyReturn: benchReturns[offset],
        })),
        metrics: computeBacktestMetrics({
          navSeries: benchNavSeries,
          dailyReturns: benchReturns,
          turnoverSeries: Array.from({ length: benchReturns.length }, () => 0),
        }),
      };
      betaStats = computeBetaStats({ strategyReturns: dailyReturns, benchmarkReturns: benchReturns });
    } catch (error) {
      benchmark = null;
      betaStats = null;
    }
  }

  const metrics = computeBacktestMetrics({ navSeries, dailyReturns, turnoverSeries });
  if (betaStats) {
    metrics.beta = betaStats.beta;
    metrics.r2 = betaStats.r2;
    metrics.correlation = betaStats.correlation;
    metrics.benchmarkSymbol = benchmark?.symbol || null;
  } else {
    metrics.beta = null;
    metrics.r2 = null;
    metrics.correlation = null;
    metrics.benchmarkSymbol = null;
  }

  return {
    summary: `Backtest completed for ${series.length} trading days from ${series[0]?.date} to ${series[series.length - 1]?.date}.`,
    meta: {
      engine: 'local',
      tickers,
      blueprint,
      requiredBars,
      warmupCalendarDays,
      minBarsForRange,
      executionStart: series[0]?.date || null,
      executionEnd: series[series.length - 1]?.date || null,
      initialCapital: resolvedCapital,
      transactionCostBps: resolvedCostBps,
      priceSource: resolvedPriceSource,
      priceRefresh: resolvedPriceRefresh,
      dataAdjustment: resolvedAdjustment,
      asOfMode: resolvedAsOfMode,
      rsiMethod: resolvedRsiMethod,
      groupSimulation: Boolean(astStats.hasGroupFilter),
    },
    metrics,
    series,
    finalAllocation: finalAllocation || [],
    finalDate: finalDateKey,
    finalValue,
    finalHoldings,
    benchmark,
  };
};

module.exports = {
  evaluateDefsymphonyStrategy,
  backtestDefsymphonyStrategy,
};
