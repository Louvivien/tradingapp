const Portfolio = require('../models/portfolioModel');
const Strategy = require('../models/strategyModel');
const StrategyEquitySnapshot = require('../models/strategyEquitySnapshotModel');
const { getAlpacaConfig } = require('../config/alpacaConfig');
const { normalizeRecurrence, computeNextRebalanceAt } = require('../utils/recurrence');
const { recordStrategyLog } = require('./strategyLogger');
const { runComposerStrategy } = require('../utils/openaiComposerStrategy');
const { syncPolymarketPortfolio } = require('./polymarketCopyService');

const TOLERANCE = 0.01;
const FRACTIONAL_QTY_DECIMALS = 6;
const MIN_FRACTIONAL_NOTIONAL = (() => {
  const parsed = Number(process.env.ALPACA_MIN_FRACTIONAL_NOTIONAL);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
})();
const ENABLE_FRACTIONAL_ORDERS =
  String(process.env.ALPACA_ENABLE_FRACTIONAL ?? 'true').toLowerCase() !== 'false';

const RECURRENCE_LABELS = {
  every_minute: 'Every minute',
  every_5_minutes: 'Every 5 minutes',
  every_15_minutes: 'Every 15 minutes',
  hourly: 'Hourly',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

const toNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const roundToTwo = (value) => {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.round((value + Number.EPSILON) * 100) / 100;
};

const roundToDecimals = (value, decimals = 0) => {
  if (!Number.isFinite(value)) {
    return null;
  }
  const places = Math.max(0, Math.min(12, Number(decimals) || 0));
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

const isEffectivelyInteger = (value, epsilon = 1e-9) => {
  if (!Number.isFinite(value)) {
    return false;
  }
  return Math.abs(value - Math.round(value)) <= epsilon;
};

const normalizeQtyForOrder = (qty) => {
  const numeric = toNumber(qty, null);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return { qty: null, isFractional: false };
  }
  if (isEffectivelyInteger(numeric)) {
    const rounded = Math.max(0, Math.round(numeric));
    return { qty: rounded, isFractional: false };
  }
  const rounded = roundToDecimals(numeric, FRACTIONAL_QTY_DECIMALS);
  if (!Number.isFinite(rounded) || rounded <= 0) {
    return { qty: null, isFractional: false };
  }
  return { qty: rounded, isFractional: true };
};

const computeWholeShareQtyDiff = (currentQty, desiredQty) => {
  const currentInt = Math.max(0, Math.round(toNumber(currentQty, 0)));
  const desiredInt = Math.max(0, Math.round(toNumber(desiredQty, 0)));
  return desiredInt - currentInt;
};

const buildMarketOrderPayload = ({ symbol, side, qty, isFractional }) => {
  const tif = isFractional ? 'day' : 'gtc';
  const qtyValue = isFractional ? qty.toFixed(FRACTIONAL_QTY_DECIMALS) : String(qty);
  return {
    symbol,
    qty: qtyValue,
    side,
    type: 'market',
    time_in_force: tif,
  };
};

const shouldFallbackToWholeShares = (error) => {
  const status = Number(error?.response?.status);
  const message = String(error?.response?.data?.message || error?.message || '').toLowerCase();
  if (status !== 400 && status !== 403 && status !== 422) {
    return false;
  }
  return (
    message.includes('fractional') ||
    message.includes('fractionable') ||
    message.includes('fractional trading') ||
    message.includes('cannot be fractional') ||
    message.includes('qty must be integer') ||
    message.includes('quantity must be integer') ||
    message.includes('must be an integer') ||
    message.includes('notional')
  );
};

const formatCurrency = (value) => {
  const num = toNumber(value, null);
  if (!Number.isFinite(num)) {
    return null;
  }
  return `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const formatSharePrice = (value) => {
  const num = toNumber(value, null);
  if (!Number.isFinite(num)) {
    return null;
  }
  return `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const formatDateForLog = (value) => {
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date?.getTime())) {
      return String(value);
    }
    return date.toISOString().split('T')[0];
  } catch (error) {
    return String(value);
  }
};

const formatPercentage = (value) => {
  if (!Number.isFinite(value)) {
    return null;
  }
  return `${value.toFixed(1)}%`;
};

const normalizePercentValue = (value, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return fallback;
  }
  if (num > 1) {
    return num / 100;
  }
  return num;
};

const formatQuantity = (value) => {
  const num = toNumber(value, null);
  if (!Number.isFinite(num)) {
    return null;
  }
  if (isEffectivelyInteger(num)) {
    return `${Math.round(num)}`;
  }
  return num.toFixed(FRACTIONAL_QTY_DECIMALS).replace(/\.?0+$/, '');
};

const formatDateTimeHuman = (value) => {
  if (!value) {
    return '—';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date?.getTime())) {
    return String(value);
  }
  return date.toLocaleString();
};

const formatRecurrenceLabel = (value) => {
  const normalized = normalizeRecurrence(value);
  return RECURRENCE_LABELS[normalized] || normalized;
};

const MARKET_OPEN_TIME = '09:30';
const MARKET_CLOSE_TIME = '16:00';
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;
const ORDER_FILL_POLL_ATTEMPTS = 6;
const ORDER_FILL_POLL_DELAY_MS = 750;
const ORDER_PENDING_STATUSES = new Set([
  'new',
  'accepted',
  'pending_new',
  'accepted_for_bidding',
  'partially_filled',
]);

const DEFAULT_REBALANCE_WINDOW_MINUTES = (() => {
  const parsed = Number(process.env.REBALANCE_WINDOW_MINUTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15;
})();

const computeRebalanceWindow = (closeTime, windowMinutes = DEFAULT_REBALANCE_WINDOW_MINUTES) => {
  const close = closeTime instanceof Date ? closeTime : new Date(closeTime);
  if (!close || Number.isNaN(close.getTime())) {
    return null;
  }
  const minutes = Math.max(1, Math.floor(Number(windowMinutes) || DEFAULT_REBALANCE_WINDOW_MINUTES));
  const start = new Date(close.getTime() - minutes * 60 * 1000);
  return { start, end: close, minutes };
};

const isWithinRebalanceWindow = (date, window) => {
  if (!date || !(date instanceof Date) || Number.isNaN(date.getTime())) {
    return false;
  }
  if (!window?.start || !window?.end) {
    return false;
  }
  return date >= window.start && date < window.end;
};

const sanitizeSymbol = (value) => {
  if (!value) {
    return null;
  }
  return String(value).trim().toUpperCase();
};

const buildHoldingsState = (stocks = []) => {
  const holdings = new Map();
  if (!Array.isArray(stocks)) {
    return holdings;
  }
  stocks.forEach((stock) => {
    const symbol = sanitizeSymbol(stock?.symbol);
    if (!symbol) {
      return;
    }
    holdings.set(symbol, {
      symbol,
      quantity: Math.max(0, toNumber(stock?.quantity, 0)),
      avgCost: toNumber(stock?.avgCost, null),
      currentPrice: toNumber(stock?.currentPrice, null),
      orderID: stock?.orderID || null,
    });
  });
  return holdings;
};

const updateHoldingsForTrade = (
  holdings,
  {
    symbol,
    qtyChange,
    price = null,
    orderId = null,
    overwriteOrderId = false,
  } = {},
) => {
  if (!holdings || typeof holdings.set !== 'function') {
    return;
  }
  const normalizedSymbol = sanitizeSymbol(symbol);
  if (!normalizedSymbol) {
    return;
  }
  const delta = toNumber(qtyChange, null);
  if (!Number.isFinite(delta) || delta === 0) {
    return;
  }

  const entry = holdings.get(normalizedSymbol) || {
    symbol: normalizedSymbol,
    quantity: 0,
    avgCost: null,
    currentPrice: null,
    orderID: null,
  };
  const prevQty = entry.quantity || 0;
  const nextQty = prevQty + delta;

  const fillPrice = toNumber(price, null);
  if (delta > 0 && Number.isFinite(fillPrice)) {
    const prevCost = Number.isFinite(entry.avgCost) ? entry.avgCost * prevQty : null;
    const baselineCost = prevCost !== null ? prevCost : prevQty * fillPrice;
    const totalCost = (baselineCost || 0) + delta * fillPrice;
    entry.avgCost = nextQty > 0 ? totalCost / nextQty : entry.avgCost;
  }

  entry.quantity = Math.max(0, nextQty);
  if (Number.isFinite(fillPrice)) {
    entry.currentPrice = fillPrice;
  }

  if (delta > 0) {
    if (overwriteOrderId && orderId) {
      entry.orderID = orderId;
    } else if (!entry.orderID) {
      entry.orderID = orderId || `rebalance-${Date.now()}-${normalizedSymbol}`;
    }
  }

  if (entry.quantity <= 0) {
    holdings.delete(normalizedSymbol);
  } else {
    holdings.set(normalizedSymbol, entry);
  }
};

const serializeHoldingsState = (holdings, priceCache = {}) => {
  if (!holdings || typeof holdings.values !== 'function') {
    return [];
  }
  return Array.from(holdings.values())
    .map((entry) => {
      const symbolPrice = toNumber(priceCache?.[entry.symbol], null);
      const currentPrice = Number.isFinite(symbolPrice)
        ? symbolPrice
        : toNumber(entry.currentPrice, toNumber(entry.avgCost, null));
      const normalizedAvgCost = toNumber(entry.avgCost, null);
      const normalizedQty = Math.max(0, toNumber(entry.quantity, 0));
      return {
        symbol: entry.symbol,
        quantity: normalizedQty,
        avgCost: Number.isFinite(normalizedAvgCost) ? normalizedAvgCost : null,
        currentPrice: currentPrice !== null ? currentPrice : null,
        orderID: entry.orderID || `rebalance-${entry.symbol}`,
      };
    })
    .filter((entry) => entry.quantity > 0);
};

const computePortfolioPerformanceTotals = (stocks = []) => {
  return stocks.reduce(
    (acc, stock) => {
      const qty = Math.max(0, toNumber(stock.quantity, 0));
      if (!qty) {
        return acc;
      }
      const avgCost = toNumber(stock.avgCost, null);
      const marketPrice = toNumber(stock.currentPrice, null);
      const costBasis = Number.isFinite(avgCost) ? avgCost * qty : 0;
      const marketValue = Number.isFinite(marketPrice)
        ? marketPrice * qty
        : costBasis;
      return {
        totalCostBasis: acc.totalCostBasis + costBasis,
        totalMarketValue: acc.totalMarketValue + marketValue,
      };
    },
    { totalCostBasis: 0, totalMarketValue: 0 }
  );
};

const getNthWeekdayOfMonth = (year, monthIndex, weekday, occurrence) => {
  const firstOfMonth = new Date(Date.UTC(year, monthIndex, 1));
  const firstWeekday = firstOfMonth.getUTCDay();
  const offset = (7 + weekday - firstWeekday) % 7;
  const day = 1 + offset + (occurrence - 1) * 7;
  return day;
};

const isUsMarketDST = (year, monthIndex, day) => {
  const secondSundayMarch = getNthWeekdayOfMonth(year, 2, 0, 2);
  const firstSundayNovember = getNthWeekdayOfMonth(year, 10, 0, 1);

  if (monthIndex < 2 || monthIndex > 10) {
    return false;
  }
  if (monthIndex > 2 && monthIndex < 10) {
    return true;
  }
  if (monthIndex === 2) {
    return day >= secondSundayMarch;
  }
  if (monthIndex === 10) {
    return day < firstSundayNovember;
  }
  return false;
};

const convertEasternToUTC = (dateStr, timeStr = MARKET_OPEN_TIME) => {
  if (!dateStr) {
    return null;
  }
  const [year, month, day] = dateStr.split('-').map((value) => Number(value));
  if (!year || !month || !day) {
    return null;
  }
  const [hour = 0, minute = 0] = timeStr.split(':').map((value) => Number(value));
  const isDST = isUsMarketDST(year, month - 1, day);
  const offsetHours = isDST ? 4 : 5;
  return new Date(Date.UTC(year, month - 1, day, hour + offsetHours, minute, 0));
};

const formatDateOnly = (date) => {
  const safeDate = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(safeDate?.getTime())) {
    return null;
  }
  return safeDate.toISOString().slice(0, 10);
};

const fetchNextMarketSessionAfter = async (tradingKeys, earliestDate) => {
  if (!tradingKeys?.client || !earliestDate) {
    return null;
  }
  const headers = {
    'APCA-API-KEY-ID': tradingKeys.keyId,
    'APCA-API-SECRET-KEY': tradingKeys.secretKey,
  };
  const start = new Date(earliestDate.getTime() - MILLIS_PER_DAY);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(earliestDate.getTime() + 30 * MILLIS_PER_DAY);
  end.setUTCHours(23, 59, 59, 999);

  const params = {
    start: formatDateOnly(start),
    end: formatDateOnly(end),
  };

  try {
    const { data } = await tradingKeys.client.get(`${tradingKeys.apiUrl}/v2/calendar`, {
      headers,
      params,
    });
    const sessions = Array.isArray(data) ? data : [];
    const threshold = earliestDate.getTime();
    let activeSession = null;
    let nextSession = null;

    for (const session of sessions) {
      const openTime = convertEasternToUTC(session.date, session.open || MARKET_OPEN_TIME);
      if (!openTime) {
        continue;
      }
      const closeTime = convertEasternToUTC(session.date, session.close || MARKET_CLOSE_TIME) || null;
      const openMs = openTime.getTime();
      const closeMs = closeTime ? closeTime.getTime() : null;

      if (!activeSession && openMs <= threshold && (closeMs === null || threshold < closeMs)) {
        activeSession = { open: openTime, close: closeTime };
      }

      if (!nextSession && openMs >= threshold) {
        nextSession = { open: openTime, close: closeTime };
      }

      if (activeSession && nextSession) {
        break;
      }
    }

    return {
      activeSession,
      nextSession: nextSession || null,
    };
  } catch (error) {
    console.warn('[Rebalance] Failed to fetch calendar for scheduling:', error.message);
  }
  return null;
};

const alignToNextMarketOpen = async (tradingKeys, desiredDate) => {
  if (!desiredDate) {
    return desiredDate;
  }
  const session = await fetchNextMarketSessionAfter(tradingKeys, desiredDate);
  if (!session) {
    return desiredDate;
  }

  const { activeSession, nextSession } = session;
  if (activeSession) {
    const closeTime = activeSession.close;
    if (closeTime && desiredDate > closeTime) {
      if (nextSession?.open) {
        return nextSession.open;
      }
      return new Date(closeTime.getTime() + MILLIS_PER_DAY);
    }
    // If the desired timestamp falls during an active session, keep it so we
    // don't falsely skip a day just because the request happened after the
    // opening bell.
    return desiredDate;
  }

  return nextSession?.open || desiredDate;
};

const alignToRebalanceWindowStart = async (tradingKeys, desiredDate) => {
  if (!desiredDate) {
    return desiredDate;
  }
  const session = await fetchNextMarketSessionAfter(tradingKeys, desiredDate);
  if (!session) {
    return desiredDate;
  }

  const pick = (targetDate, marketSession) => {
    if (!marketSession?.close) {
      return targetDate;
    }
    const window = computeRebalanceWindow(marketSession.close);
    if (!window) {
      return targetDate;
    }
    if (targetDate <= window.start) {
      return window.start;
    }
    if (isWithinRebalanceWindow(targetDate, window)) {
      return targetDate;
    }
    return null;
  };

  const activeCandidate = session.activeSession ? pick(desiredDate, session.activeSession) : null;
  if (activeCandidate) {
    return activeCandidate;
  }
  if (session.activeSession) {
    const activeWindow = computeRebalanceWindow(session.activeSession.close);
    if (activeWindow && desiredDate >= activeWindow.end) {
      const nextSession = session.nextSession?.open
        ? await fetchNextMarketSessionAfter(tradingKeys, new Date(session.nextSession.open.getTime() + 1000))
        : null;
      const followUp = nextSession?.activeSession || nextSession?.nextSession || session.nextSession;
      const nextCandidate = followUp ? pick(desiredDate, followUp) : null;
      if (nextCandidate) {
        return nextCandidate;
      }
    }
  }

  const nextCandidate = session.nextSession ? pick(desiredDate, session.nextSession) : null;
  if (nextCandidate) {
    return nextCandidate;
  }

  const alignedOpen = await alignToNextMarketOpen(tradingKeys, desiredDate);
  if (alignedOpen && alignedOpen !== desiredDate) {
    const nextAligned = await alignToRebalanceWindowStart(tradingKeys, alignedOpen);
    return nextAligned || alignedOpen;
  }
  return desiredDate;
};

const buildRebalanceHumanSummary = ({
  strategyName,
  recurrence,
  executedSells = [],
  executedBuys = [],
  decisionTrace = [],
  cashSummary = {},
  nextRebalanceAt = null,
  holds = [],
  reasoning = [],
  tooling = null,
  reconciliation = null,
}) => {
  const lines = [];
  lines.push(`Rebalance completed for "${strategyName}".`);
  lines.push(`• Cadence: ${formatRecurrenceLabel(recurrence)}.`);
  if (nextRebalanceAt) {
    lines.push(`• Next scheduled rebalance: ${formatDateTimeHuman(nextRebalanceAt)}.`);
  }

  if (Array.isArray(reasoning) && reasoning.length) {
    lines.push('');
    lines.push('Agent reasoning:');
    reasoning.forEach((entry) => {
      if (entry) {
        lines.push(`• ${entry}`);
      }
    });
  }

  const localTool = tooling?.localEvaluator;
  if (localTool?.used) {
    lines.push('');
    lines.push('Tooling:');
    const priceSourceLabel = localTool.priceSource || 'alpaca';
    const refreshLabel = localTool.priceRefresh ? 'forced refresh' : 'cached';
    lines.push(`• Local defsymphony evaluator computed allocations using ${refreshLabel} ${priceSourceLabel} prices.`);
    const tickers = Array.isArray(localTool.tickers) ? localTool.tickers.filter(Boolean) : [];
    if (tickers.length) {
      lines.push(`• Cached instrument universe: ${tickers.join(', ')}.`);
    }
    if (localTool.asOfMode || localTool.asOfDate) {
      const modeLabel = localTool.asOfMode ? String(localTool.asOfMode) : null;
      const dateLabel = localTool.asOfDate ? formatDateForLog(localTool.asOfDate) : null;
      const segments = [
        modeLabel ? `as-of mode ${modeLabel}` : null,
        dateLabel ? `effective as-of date ${dateLabel}` : null,
      ].filter(Boolean);
      if (segments.length) {
        lines.push(`• Data timing: ${segments.join(', ')}.`);
      }
    }
    if (localTool.dataAdjustment || localTool.rsiMethod) {
      const segments = [
        localTool.dataAdjustment ? `adjustment ${localTool.dataAdjustment}` : null,
        localTool.rsiMethod ? `RSI method ${localTool.rsiMethod}` : null,
      ].filter(Boolean);
      if (segments.length) {
        lines.push(`• Indicator settings: ${segments.join(', ')}.`);
      }
    }
    const blueprint = Array.isArray(localTool.blueprint) ? localTool.blueprint.filter(Boolean) : [];
    if (blueprint.length) {
      lines.push(`• Evaluation steps: ${blueprint.join(' -> ')}.`);
    }
    if (localTool.lookbackDays) {
      lines.push(`• Price cache lookback window: ${localTool.lookbackDays} days.`);
    }
    if (localTool.fallbackReason) {
      lines.push(`• Reason for local evaluation: ${localTool.fallbackReason}.`);
    }

    const warnings = [];
    const rsiMethod = String(localTool.rsiMethod || '').trim().toLowerCase();
    if (rsiMethod && rsiMethod !== 'wilder') {
      warnings.push(`RSI method "${localTool.rsiMethod}" (Composer uses Wilder RSI).`);
    }
    const priceSourceNormalized = String(localTool.priceSource || '').trim().toLowerCase();
    if (priceSourceNormalized && !['yahoo', 'tiingo'].includes(priceSourceNormalized)) {
      warnings.push(`Price source "${localTool.priceSource}" (recommended Yahoo or Tiingo).`);
    }
    const adjustment = String(localTool.dataAdjustment || '').trim().toLowerCase();
    if (adjustment && adjustment !== 'split') {
      warnings.push(`Price adjustment "${localTool.dataAdjustment}" (recommended "split").`);
    }
    if (warnings.length) {
      lines.push('• WARNING: ' + warnings.join(' '));
    }
  }

  const decisionMap = new Map(
    decisionTrace.map((entry) => [entry.symbol, entry])
  );

  if (executedSells.length) {
    lines.push('');
    lines.push('Sell orders:');
    executedSells.forEach(({ symbol, qty, price }) => {
      const decision = decisionMap.get(symbol);
      const segments = [
        `SELL ${qty} ${symbol}`,
        formatSharePrice(price) ? `@ approx. ${formatSharePrice(price)}` : null,
        Number.isFinite(decision?.targetWeightPercent)
          ? `(target weight ${formatPercentage(decision.targetWeightPercent)})`
          : null,
      ].filter(Boolean);
      let line = `• ${segments.join(' ')}`;
      if (decision?.explanation) {
        line += ` — ${decision.explanation}`;
      }
      lines.push(line);
    });
  } else {
    lines.push('');
    lines.push('Sell orders: none required.');
  }

  if (executedBuys.length) {
    lines.push('');
    lines.push('Buy orders:');
    executedBuys.forEach(({ symbol, qty, price }) => {
      const decision = decisionMap.get(symbol);
      const segments = [
        `BUY ${qty} ${symbol}`,
        formatSharePrice(price) ? `@ approx. ${formatSharePrice(price)}` : null,
        Number.isFinite(decision?.targetWeightPercent)
          ? `(target weight ${formatPercentage(decision.targetWeightPercent)})`
          : null,
      ].filter(Boolean);
      let line = `• ${segments.join(' ')}`;
      if (decision?.explanation) {
        line += ` — ${decision.explanation}`;
      }
      lines.push(line);
    });
  } else {
    lines.push('');
    lines.push('Buy orders: none required.');
  }

  if (holds.length) {
    lines.push('');
    lines.push('Positions unchanged:');
    holds.forEach((entry) => {
      const explanation = entry.explanation || 'Already aligned with target allocation.';
      lines.push(`• ${entry.symbol}: ${explanation}`);
    });
  }

  const {
    startingCash = null,
    sellProceeds = null,
    spentOnBuys = null,
    endingCash = null,
    cashBuffer = null,
  } = cashSummary || {};

  const cashSegments = [];
  if (startingCash !== null) {
    cashSegments.push(`started with ${formatCurrency(startingCash)}`);
  }
  if (sellProceeds !== null) {
    cashSegments.push(`raised ${formatCurrency(sellProceeds)} from sales`);
  }
  if (spentOnBuys !== null) {
    cashSegments.push(`deployed ${formatCurrency(spentOnBuys)} into buys`);
  }
  if (endingCash !== null) {
    cashSegments.push(`ending cash ${formatCurrency(endingCash)}`);
  }

  if (cashSegments.length) {
    lines.push('');
    lines.push(`Cash summary: ${cashSegments.filter(Boolean).join(', ')}.`);
  }

  if (cashBuffer !== null) {
    lines.push(`• Cash buffer now ${formatCurrency(cashBuffer)}.`);
  }

  if (reconciliation?.summary) {
    const { matched = 0, mismatched = 0, total = 0, tolerance } = reconciliation.summary;
    lines.push('');
    lines.push('Reconciliation:');
    lines.push(`• Targets aligned within tolerance: ${matched}/${total} (tolerance ${formatQuantity(tolerance)} shares).`);
    if (mismatched > 0) {
      const preview = Array.isArray(reconciliation.mismatches)
        ? reconciliation.mismatches.slice(0, 3)
        : [];
      if (preview.length) {
        preview.forEach((entry) => {
          const targetWeight = Number.isFinite(entry.targetWeight)
            ? formatPercentage(entry.targetWeight * 100)
            : null;
          const actualWeight = Number.isFinite(entry.actualWeight)
            ? formatPercentage(entry.actualWeight * 100)
            : null;
          const qtyDiff = formatQuantity(entry.qtyDiff);
          const weightLabel = targetWeight || actualWeight
            ? `target ${targetWeight || 'n/a'}, actual ${actualWeight || 'n/a'}`
            : null;
          const reasonText = Array.isArray(entry.reasons) && entry.reasons.length
            ? ` — ${entry.reasons.join(' ')}`
            : '';
          lines.push(
            `• ${entry.symbol}: ${weightLabel || 'allocation mismatch'}, qty diff ${qtyDiff || 'n/a'}${reasonText}`
          );
        });
      }
    }
  }

  return lines.join('\n');
};

const buildOrderMap = (orders = []) => {
  const map = new Map();
  if (!Array.isArray(orders)) {
    return map;
  }
  orders.forEach((order) => {
    const symbol = sanitizeSymbol(order?.symbol);
    if (!symbol) {
      return;
    }
    const qty = Math.abs(toNumber(order?.qty, 0));
    if (!qty) {
      return;
    }
    const entry = map.get(symbol) || { qty: 0, count: 0 };
    entry.qty += qty;
    entry.count += 1;
    map.set(symbol, entry);
  });
  return map;
};

const buildRebalanceReconciliation = ({
  adjustments = [],
  holdingsState,
  priceCache = {},
  budget = 0,
  plannedBuys = [],
  plannedSells = [],
  executedBuys = [],
  executedSells = [],
  tolerance = TOLERANCE,
} = {}) => {
  const adjustmentsMap = new Map();
  adjustments.forEach((adjustment) => {
    const symbol = sanitizeSymbol(adjustment?.symbol);
    if (!symbol) {
      return;
    }
    adjustmentsMap.set(symbol, adjustment);
  });

  const holdingsMap = holdingsState instanceof Map ? holdingsState : buildHoldingsState(holdingsState || []);
  const plannedBuyMap = buildOrderMap(plannedBuys);
  const plannedSellMap = buildOrderMap(plannedSells);
  const executedBuyMap = buildOrderMap(executedBuys);
  const executedSellMap = buildOrderMap(executedSells);

  const symbols = new Set([...adjustmentsMap.keys(), ...holdingsMap.keys()]);
  const entries = [];

  symbols.forEach((symbol) => {
    const adjustment = adjustmentsMap.get(symbol) || null;
    const holding = holdingsMap.get(symbol) || null;
    const actualQty = Math.max(0, toNumber(holding?.quantity, 0));
    const targetWeight = Number.isFinite(adjustment?.targetWeight) ? adjustment.targetWeight : 0;
    const price =
      toNumber(priceCache?.[symbol], null)
      ?? toNumber(holding?.currentPrice, toNumber(holding?.avgCost, null))
      ?? toNumber(adjustment?.currentPrice, null);
    const desiredQtyRaw = Number.isFinite(price) && price > 0 && budget > 0
      ? (targetWeight * budget) / price
      : 0;
    const desiredQty = Number.isFinite(adjustment?.desiredQty)
      ? adjustment.desiredQty
      : (ENABLE_FRACTIONAL_ORDERS ? desiredQtyRaw : Math.floor(desiredQtyRaw));
    const desiredValue = Number.isFinite(price) && price > 0 ? desiredQty * price : null;
    const actualValue = Number.isFinite(price) && price > 0 ? actualQty * price : null;
    const actualWeight = budget > 0 && Number.isFinite(actualValue) ? actualValue / budget : null;
    const qtyDiff = actualQty - desiredQty;
    const reasons = [];

    if (!Number.isFinite(price) || price <= 0) {
      reasons.push('Missing price for sizing/valuation.');
    }

    if (!ENABLE_FRACTIONAL_ORDERS && Number.isFinite(desiredQtyRaw) && desiredQtyRaw > 0 && !isEffectivelyInteger(desiredQtyRaw)) {
      reasons.push('Rounded down to whole shares.');
    }

    if (
      ENABLE_FRACTIONAL_ORDERS &&
      Number.isFinite(desiredQtyRaw) &&
      desiredQtyRaw > 0 &&
      Number.isFinite(price) &&
      price > 0
    ) {
      const normalized = normalizeQtyForOrder(desiredQtyRaw);
      const desiredNotional = desiredQtyRaw * price;
      if (normalized.isFractional && desiredNotional < MIN_FRACTIONAL_NOTIONAL) {
        reasons.push(`Below minimum fractional notional ${formatCurrency(MIN_FRACTIONAL_NOTIONAL)}.`);
      }
    }

    const plannedBuyQty = plannedBuyMap.get(symbol)?.qty || 0;
    const plannedSellQty = plannedSellMap.get(symbol)?.qty || 0;
    const executedBuyQty = executedBuyMap.get(symbol)?.qty || 0;
    const executedSellQty = executedSellMap.get(symbol)?.qty || 0;

    if (targetWeight === 0 && actualQty > tolerance) {
      reasons.push('Position not in target allocations.');
    }

    if (desiredQty - actualQty > tolerance) {
      if (plannedBuyQty > 0 && executedBuyQty + tolerance < plannedBuyQty) {
        reasons.push('Buy order not fully executed.');
      } else if (plannedBuyQty === 0 && targetWeight > 0) {
        reasons.push('No buy order was planned for this allocation.');
      }
    } else if (actualQty - desiredQty > tolerance) {
      if (plannedSellQty > 0 && executedSellQty + tolerance < plannedSellQty) {
        reasons.push('Sell order not fully executed.');
      }
    }

    entries.push({
      symbol,
      targetWeight,
      actualWeight,
      desiredQty: roundToDecimals(desiredQty, FRACTIONAL_QTY_DECIMALS),
      actualQty: roundToDecimals(actualQty, FRACTIONAL_QTY_DECIMALS),
      qtyDiff: roundToDecimals(qtyDiff, FRACTIONAL_QTY_DECIMALS),
      desiredValue: roundToTwo(desiredValue),
      actualValue: roundToTwo(actualValue),
      price: Number.isFinite(price) ? roundToTwo(price) : null,
      reasons,
    });
  });

  const mismatches = entries.filter((entry) => Math.abs(toNumber(entry.qtyDiff, 0)) > tolerance);
  const matched = entries.filter((entry) => Math.abs(toNumber(entry.qtyDiff, 0)) <= tolerance);
  const summary = {
    total: entries.length,
    matched: matched.length,
    mismatched: mismatches.length,
    tolerance,
  };

  const sortedMismatches = [...mismatches].sort(
    (a, b) => Math.abs(toNumber(b.qtyDiff, 0)) - Math.abs(toNumber(a.qtyDiff, 0))
  );

  return {
    summary,
    mismatches: sortedMismatches,
    entries,
  };
};

const normalizeTargets = (targets = []) => {
  if (!Array.isArray(targets)) {
    return [];
  }

  const cloned = targets
    .map((target) => ({
      symbol: target.symbol ? String(target.symbol).toUpperCase().trim() : null,
      targetQuantity: target.targetQuantity !== undefined ? toNumber(target.targetQuantity, null) : null,
      targetValue: target.targetValue !== undefined ? toNumber(target.targetValue, null) : null,
      targetWeight: target.targetWeight !== undefined ? toNumber(target.targetWeight, null) : null,
      targetQuantitySnapshot: target.targetQuantitySnapshot !== undefined
        ? toNumber(target.targetQuantitySnapshot, null)
        : null,
      targetPriceSnapshot: target.targetPriceSnapshot !== undefined
        ? toNumber(target.targetPriceSnapshot, null)
        : null,
      targetValueSnapshot: target.targetValueSnapshot !== undefined
        ? toNumber(target.targetValueSnapshot, null)
        : null,
    }))
    .filter((entry) => !!entry.symbol);

  if (!cloned.length) {
    return [];
  }

  const explicitWeightSum = cloned.reduce((sum, entry) => {
    return sum + (entry.targetWeight && entry.targetWeight > 0 ? entry.targetWeight : 0);
  }, 0);

  if (explicitWeightSum > 0) {
    return cloned.map((entry) => ({
      ...entry,
      targetWeight: entry.targetWeight > 0 ? entry.targetWeight / explicitWeightSum : 0,
    }));
  }

  const valueSum = cloned.reduce((sum, entry) => sum + (entry.targetValue && entry.targetValue > 0 ? entry.targetValue : 0), 0);
  if (valueSum > 0) {
    return cloned.map((entry) => ({
      ...entry,
      targetWeight: entry.targetValue && entry.targetValue > 0 ? entry.targetValue / valueSum : 0,
    }));
  }

  const quantitySum = cloned.reduce((sum, entry) => sum + (entry.targetQuantity && entry.targetQuantity > 0 ? entry.targetQuantity : 0), 0);
  if (quantitySum > 0) {
    return cloned.map((entry) => ({
      ...entry,
      targetWeight: entry.targetQuantity && entry.targetQuantity > 0 ? entry.targetQuantity / quantitySum : 0,
    }));
  }

  const equalWeight = 1 / cloned.length;
  return cloned.map((entry) => ({
    ...entry,
    targetWeight: equalWeight,
  }));
};

const fetchLatestPrices = async (symbols, dataKeys) => {
  const priceCache = {};
  const headers = {
    'APCA-API-KEY-ID': dataKeys.keyId,
    'APCA-API-SECRET-KEY': dataKeys.secretKey,
  };

  await Promise.all(
    symbols.map(async (symbol) => {
      if (!symbol || priceCache[symbol]) {
        return;
      }
      try {
        const { data } = await dataKeys.client.get(`${dataKeys.apiUrl}/v2/stocks/${symbol}/trades/latest`, {
          headers,
        });
        const tradePrice = toNumber(data?.trade?.p, null);
        if (tradePrice) {
          priceCache[symbol] = tradePrice;
        }
      } catch (error) {
        console.warn(`[Rebalance] Failed to fetch latest price for ${symbol}: ${error.message}`);
      }
    })
  );

  return priceCache;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchOrderFillPrice = async (tradingKeys, orderId) => {
  if (!orderId || !tradingKeys?.client || !tradingKeys?.apiUrl) {
    return null;
  }

  const headers = {
    'APCA-API-KEY-ID': tradingKeys.keyId,
    'APCA-API-SECRET-KEY': tradingKeys.secretKey,
  };

  for (let attempt = 0; attempt < ORDER_FILL_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await delay(ORDER_FILL_POLL_DELAY_MS);
    }
    try {
      const { data } = await tradingKeys.client.get(`${tradingKeys.apiUrl}/v2/orders/${orderId}`, {
        headers,
      });
      const fillPrice = toNumber(data?.filled_avg_price, null);
      if (Number.isFinite(fillPrice) && fillPrice > 0) {
        return fillPrice;
      }
      const status = String(data?.status || '').toLowerCase();
      if (!ORDER_PENDING_STATUSES.has(status)) {
        break;
      }
    } catch (error) {
      console.warn(`[Rebalance] Failed to poll order ${orderId} for fill price:`, error.message);
      break;
    }
  }
  return null;
};

const fetchMarketClock = async (tradingKeys) => {
  if (!tradingKeys?.client || !tradingKeys?.apiUrl) {
    return null;
  }

  try {
    const { data } = await tradingKeys.client.get(`${tradingKeys.apiUrl}/v2/clock`, {
      headers: {
        'APCA-API-KEY-ID': tradingKeys.keyId,
        'APCA-API-SECRET-KEY': tradingKeys.secretKey,
      },
    });
    return data;
  } catch (error) {
    console.warn(`[Rebalance] Failed to fetch market clock: ${error.message}`);
    return null;
  }
};

const buildAdjustments = async ({
  targets,
  budget,
  positionMap,
  priceCache,
  dataKeys,
  trackedHoldings = {},
  useSnapshotQuantities = false,
  maxSnapshotDriftPct = 0,
}) => {
  const symbolUniverse = new Set([
    ...targets.map((target) => target.symbol),
    ...Object.keys(trackedHoldings),
  ]);
  const symbolsNeedingPrice = Array.from(symbolUniverse).filter(
    (symbol) => symbol && !priceCache[symbol],
  );

  if (symbolsNeedingPrice.length) {
    const fetched = await fetchLatestPrices(symbolsNeedingPrice, dataKeys);
    Object.assign(priceCache, fetched);
  }

  const adjustments = targets.map((target) => {
    const position = positionMap[target.symbol];
    const tracked = trackedHoldings[target.symbol];
    const trackedQty = tracked ? Math.max(0, toNumber(tracked.quantity, 0)) : 0;
    const accountQty = position ? Math.max(0, toNumber(position.qty, 0)) : 0;
    const currentQty = tracked ? (accountQty > 0 ? Math.min(trackedQty, accountQty) : trackedQty) : 0;
    const currentPrice = priceCache[target.symbol]
      || toNumber(position?.current_price, toNumber(position?.avg_entry_price, null))
      || toNumber(tracked?.currentPrice, toNumber(tracked?.avgCost, null))
      || 0;
    const currentValue = currentQty * currentPrice;
    const desiredValue = Math.max(0, target.targetWeight * budget);
    const snapshotQty = Number.isFinite(target.targetQuantitySnapshot)
      ? target.targetQuantitySnapshot
      : null;
    const snapshotPrice = Number.isFinite(target.targetPriceSnapshot)
      ? target.targetPriceSnapshot
      : null;
    const priceDriftPct =
      Number.isFinite(snapshotPrice) && snapshotPrice > 0 && Number.isFinite(currentPrice) && currentPrice > 0
        ? Math.abs(currentPrice - snapshotPrice) / snapshotPrice
        : null;
    const snapshotValueNow =
      Number.isFinite(snapshotQty) && snapshotQty > 0 && Number.isFinite(currentPrice) && currentPrice > 0
        ? snapshotQty * currentPrice
        : null;
    const snapshotOvershootPct =
      Number.isFinite(desiredValue) && desiredValue > 0 && Number.isFinite(snapshotValueNow)
        ? (snapshotValueNow - desiredValue) / desiredValue
        : null;
    let useSnapshotSizing = Boolean(
      useSnapshotQuantities
      && Number.isFinite(snapshotQty)
      && snapshotQty > 0
      && Number.isFinite(snapshotPrice)
      && snapshotPrice > 0
      && (priceDriftPct === null || priceDriftPct <= maxSnapshotDriftPct)
      && (snapshotOvershootPct === null || snapshotOvershootPct <= maxSnapshotDriftPct)
    );

    let desiredQtyRaw = useSnapshotSizing
      ? snapshotQty
      : (currentPrice > 0 ? desiredValue / currentPrice : 0);
    let desiredQty = ENABLE_FRACTIONAL_ORDERS ? desiredQtyRaw : Math.floor(desiredQtyRaw);

    if (useSnapshotSizing && desiredQty <= 0 && desiredValue > 0 && currentPrice > 0) {
      useSnapshotSizing = false;
      desiredQtyRaw = desiredValue / currentPrice;
      desiredQty = ENABLE_FRACTIONAL_ORDERS ? desiredQtyRaw : Math.floor(desiredQtyRaw);
    }
    return {
      symbol: target.symbol,
      currentQty,
      desiredQty,
      currentPrice,
      desiredValue,
      currentValue,
      targetWeight: target.targetWeight,
      snapshotQty,
      snapshotPrice,
      priceDriftPct,
      snapshotOvershootPct,
      usedSnapshotSizing: useSnapshotSizing,
    };
  });

  // Ensure tracked positions not present in targets are liquidated
  Object.keys(trackedHoldings).forEach((symbol) => {
    if (!targets.find((target) => target.symbol === symbol)) {
      const tracked = trackedHoldings[symbol];
      const trackedQty = tracked ? Math.max(0, toNumber(tracked.quantity, 0)) : 0;
      if (trackedQty <= 0) {
        return;
      }
      const position = positionMap[symbol];
      const accountQty = position ? Math.max(0, toNumber(position.qty, 0)) : 0;
      const qtyToUse = accountQty > 0 ? Math.min(trackedQty, accountQty) : trackedQty;
      if (!qtyToUse) {
        return;
      }
      const price =
        priceCache[symbol]
        || toNumber(position?.current_price, toNumber(position?.avg_entry_price, null))
        || toNumber(tracked?.currentPrice, toNumber(tracked?.avgCost, null))
        || 0;
      adjustments.push({
        symbol,
        currentQty: qtyToUse,
        desiredQty: 0,
        currentPrice: price,
        desiredValue: 0,
        currentValue: qtyToUse * price,
        targetWeight: 0,
      });
    }
  });

  return adjustments;
};

const placeOrder = async (tradingKeys, order) => {
  return tradingKeys.client.post(
    `${tradingKeys.apiUrl}/v2/orders`,
    order,
    {
      headers: {
        'APCA-API-KEY-ID': tradingKeys.keyId,
        'APCA-API-SECRET-KEY': tradingKeys.secretKey,
      },
    },
  );
};

const fetchLatestTradePrice = async (dataKeys, symbol) => {
  if (!dataKeys?.client || !symbol) {
    return null;
  }
  try {
    const { data } = await dataKeys.client.get(`${dataKeys.apiUrl}/v2/stocks/${symbol}/trades/latest`, {
      headers: {
        'APCA-API-KEY-ID': dataKeys.keyId,
        'APCA-API-SECRET-KEY': dataKeys.secretKey,
      },
    });
    return toNumber(data?.trade?.p, null);
  } catch (error) {
    console.warn(`[Rebalance] Failed to fetch latest trade for ${symbol}: ${error.message}`);
  }
  return null;
};

const rebalancePortfolio = async (portfolio) => {
  if (!portfolio?.userId || !portfolio?.strategy_id) {
    return;
  }

  const strategyQuery = { strategy_id: portfolio.strategy_id };
  if (portfolio.userId) {
    strategyQuery.userId = String(portfolio.userId);
  }
  const strategy = await Strategy.findOne(strategyQuery);
  const recurrence = normalizeRecurrence(portfolio.recurrence || strategy?.recurrence);
  const alpacaConfig = await getAlpacaConfig(portfolio.userId);

  if (!alpacaConfig?.hasValidKeys) {
    throw new Error('Invalid Alpaca credentials for portfolio rebalancing');
  }

  const tradingKeys = alpacaConfig.getTradingKeys();
  const dataKeys = alpacaConfig.getDataKeys();
  const now = new Date();
  const snapshotSizingEnabled =
    String(process.env.COMPOSER_LOCK_SNAPSHOT_QTY ?? 'true').toLowerCase() !== 'false';
  const maxSnapshotDriftPct = normalizePercentValue(
    process.env.COMPOSER_SNAPSHOT_MAX_DRIFT_PCT,
    0.02
  );
  const baseThoughtProcess = {
    strategySummary: strategy?.summary || null,
    originalDecisions: Array.isArray(strategy?.decisions) ? strategy.decisions : [],
    reasoning: [],
    composerPositions: [],
    tooling: {
      localEvaluator: {
        used: false,
        blueprint: [],
        tickers: [],
        lookbackDays: null,
        fallbackReason: null,
      },
    },
  };
  const describeOrderError = (error) => {
    const message = String(error?.response?.data?.message || error?.message || '').trim();
    return message || null;
  };
  const recordFallback = ({ symbol, side, error, qty }) => {
    if (!symbol) {
      return;
    }
    const reason = describeOrderError(error) || 'fractional order rejected';
    const action = side === 'sell' ? 'Sell' : 'Buy';
    const qtyLabel = Number.isFinite(qty) ? `${qty} shares` : 'whole shares';
    baseThoughtProcess.reasoning.push(
      `${action} fallback to whole shares for ${symbol}: ${reason}. Submitted ${qtyLabel}.`
    );
  };

  const clockData = await fetchMarketClock(tradingKeys);
  if (clockData && clockData.is_open === false) {
    const fallbackNext = computeNextRebalanceAt(recurrence, now);
    const nextOpen = clockData.next_open ? new Date(clockData.next_open) : null;
    const nextOpenValid = nextOpen && !Number.isNaN(nextOpen.getTime());

    const openAnchor = nextOpenValid ? nextOpen : await alignToNextMarketOpen(tradingKeys, fallbackNext);
    let scheduledAt = await alignToRebalanceWindowStart(tradingKeys, openAnchor || fallbackNext);

    if (!scheduledAt || scheduledAt <= now) {
      const bufferDate = new Date(now.getTime() + 60000);
      const bufferedNext = computeNextRebalanceAt(recurrence, bufferDate);
      const alignedBuffered = await alignToRebalanceWindowStart(tradingKeys, bufferedNext);
      scheduledAt = alignedBuffered > now ? alignedBuffered : bufferedNext;
    }

    portfolio.nextRebalanceAt = scheduledAt;
    portfolio.nextRebalanceManual = false;
    portfolio.recurrence = recurrence;
    await portfolio.save();

    await recordStrategyLog({
      strategyId: portfolio.strategy_id,
      userId: portfolio.userId,
      strategyName: portfolio.name,
      message: 'Skipped rebalance: market closed',
      details: {
        recurrence,
        marketStatus: 'closed',
        nextOpen: clockData.next_open || null,
        rescheduledFor: scheduledAt.toISOString(),
        thoughtProcess: {
          ...baseThoughtProcess,
          reason: 'Market closed at attempted rebalance time; rescheduled to next open window.',
        },
        humanSummary: [
          `Rebalance postponed for "${portfolio.name}" because markets were closed.`,
          `• Planned cadence: ${formatRecurrenceLabel(recurrence)}.`,
          nextOpenValid ? `• Exchange reopens at ${formatDateTimeHuman(nextOpen)}.` : null,
          `• Next attempt scheduled for ${formatDateTimeHuman(scheduledAt)}.`,
        ].filter(Boolean).join('\n'),
      },
    });

    return;
  }

  if (!portfolio.nextRebalanceManual) {
    let closeTime = clockData?.next_close ? new Date(clockData.next_close) : null;
    if (!closeTime || Number.isNaN(closeTime.getTime())) {
      const session = await fetchNextMarketSessionAfter(tradingKeys, now);
      closeTime = session?.activeSession?.close || null;
    }
    const window = closeTime && !Number.isNaN(closeTime.getTime()) ? computeRebalanceWindow(closeTime) : null;
    if (window && !isWithinRebalanceWindow(now, window)) {
      const scheduledAt =
        now < window.start
          ? window.start
          : await alignToRebalanceWindowStart(tradingKeys, new Date(window.end.getTime() + 60000));

      portfolio.nextRebalanceAt = scheduledAt;
      portfolio.nextRebalanceManual = false;
      portfolio.recurrence = recurrence;
      await portfolio.save();

      await recordStrategyLog({
        strategyId: portfolio.strategy_id,
        userId: portfolio.userId,
        strategyName: portfolio.name,
        message: 'Skipped rebalance: outside rebalance window',
        details: {
          recurrence,
          marketStatus: 'open',
          rebalanceWindow: {
            minutes: window.minutes,
            start: window.start.toISOString(),
            end: window.end.toISOString(),
          },
          rescheduledFor: scheduledAt.toISOString(),
          thoughtProcess: {
            ...baseThoughtProcess,
            reason: 'Market open but current time is outside the default rebalance window; rescheduled.',
          },
          humanSummary: [
            `Rebalance postponed for "${portfolio.name}" because it's outside the default rebalance window.`,
            `• Window length: ${window.minutes} minutes before market close.`,
            `• Next attempt scheduled for ${formatDateTimeHuman(scheduledAt)}.`,
            '• Tip: You can manually schedule a one-time rebalance during market hours from the portfolio schedule dialog.',
          ].filter(Boolean).join('\n'),
        },
      });

      return;
    }
  }

  const [positionsResponse, accountResponse] = await Promise.all([
    tradingKeys.client.get(`${tradingKeys.apiUrl}/v2/positions`, {
      headers: {
        'APCA-API-KEY-ID': tradingKeys.keyId,
        'APCA-API-SECRET-KEY': tradingKeys.secretKey,
      },
    }),
    tradingKeys.client.get(`${tradingKeys.apiUrl}/v2/account`, {
      headers: {
        'APCA-API-KEY-ID': tradingKeys.keyId,
        'APCA-API-SECRET-KEY': tradingKeys.secretKey,
      },
    }),
  ]);

  const positions = Array.isArray(positionsResponse.data) ? positionsResponse.data : [];
  const accountCash = toNumber(accountResponse.data?.cash, 0);
  const positionMap = {};
  const priceCache = {};
  const holdingsState = buildHoldingsState(portfolio.stocks);
  const holdingsSnapshot = new Map();
  const trackedHoldings = {};

  positions.forEach((position) => {
    const symbol = sanitizeSymbol(position.symbol);
    if (!symbol) {
      return;
    }
    positionMap[symbol] = position;
    const price = toNumber(position.current_price, toNumber(position.avg_entry_price, null));
    if (price) {
      priceCache[symbol] = price;
    }
  });

  holdingsState.forEach((entry, symbol) => {
    trackedHoldings[symbol] = entry;
    holdingsSnapshot.set(symbol, { ...entry });
    if (priceCache[symbol] == null) {
      const fallbackPrice = toNumber(entry.currentPrice, toNumber(entry.avgCost, null));
      if (Number.isFinite(fallbackPrice) && fallbackPrice > 0) {
        priceCache[symbol] = fallbackPrice;
      }
    }
  });

  const computeTrackedValue = (symbol) => {
    const entry = trackedHoldings[symbol];
    if (!entry) {
      return 0;
    }
    const trackedQty = Math.max(0, toNumber(entry.quantity, 0));
    if (!trackedQty) {
      return 0;
    }
    const position = positionMap[symbol];
    const accountQty = position ? Math.max(0, toNumber(position.qty, 0)) : 0;
    const effectiveQty = accountQty > 0 ? Math.min(trackedQty, accountQty) : trackedQty;
    const price =
      priceCache[symbol]
      || toNumber(position?.current_price, toNumber(position?.avg_entry_price, null))
      || toNumber(entry.currentPrice, toNumber(entry.avgCost, null))
      || 0;
    return effectiveQty * price;
  };

  const currentPortfolioValue = Object.keys(trackedHoldings).reduce(
    (sum, symbol) => sum + computeTrackedValue(symbol),
    0,
  );

  if (!portfolio.initialInvestment) {
    const estimatedInvestment = Array.from(holdingsState.values()).reduce((sum, entry) => {
      if (!Number.isFinite(entry.avgCost)) {
        return sum;
      }
      return sum + entry.avgCost * Math.max(0, toNumber(entry.quantity, 0));
    }, 0);
    portfolio.initialInvestment = estimatedInvestment || toNumber(portfolio.budget, 0) || currentPortfolioValue;
  }

  const retainedProfits = (() => {
    const retained = toNumber(portfolio.retainedCash, null);
    if (retained !== null) {
      return retained;
    }
    return toNumber(portfolio.cashBuffer, 0);
  })();
  const cashBuffer = retainedProfits;
  let strategyCash = Math.max(0, cashBuffer);
  const cashLimit = toNumber(portfolio.cashLimit, toNumber(portfolio.budget, null));
  const baseLimit = cashLimit && cashLimit > 0
    ? cashLimit
    : (portfolio.initialInvestment || 0);
  const lossAdjustment = Math.min(0, retainedProfits);
  const deployableLimit = baseLimit > 0
    ? Math.max(0, baseLimit + lossAdjustment)
    : Infinity;
  const currentTotal = currentPortfolioValue + strategyCash;
  const effectiveCap = deployableLimit === Infinity ? currentTotal : deployableLimit;
  const budget = Math.max(
    0,
    Math.min(
      effectiveCap,
      currentTotal,
    ),
  );

  let composerEvaluation = null;
  if (strategy?.strategy && /\(defsymphony/i.test(strategy.strategy)) {
    const composerBudget = budget > 0 ? budget : currentTotal || accountCash;
    if (composerBudget && composerBudget > 0) {
      try {
        composerEvaluation = await runComposerStrategy({
          strategyText: strategy.strategy,
          budget: composerBudget,
        });
      } catch (error) {
        console.warn('[Rebalance] Composer evaluation failed:', error.message);
        throw new Error(`Composer evaluation failed: ${error.message}`);
      }
    }
  }

  let normalizedTargets = normalizeTargets(portfolio.targetPositions);
  if (!normalizedTargets.length) {
    normalizedTargets = normalizeTargets(
      (portfolio.stocks || []).map((stock) => ({
        symbol: stock.symbol,
        targetQuantity: stock.quantity,
        targetValue: stock.avgCost && stock.quantity ? stock.avgCost * stock.quantity : null,
      }))
    );
  }

  if (composerEvaluation?.positions?.length) {
    const meta = composerEvaluation.meta || {};
    const localMeta = meta.localEvaluator || {};
    if (localMeta.used) {
      baseThoughtProcess.tooling = {
        ...baseThoughtProcess.tooling,
        localEvaluator: {
          used: true,
          blueprint: Array.isArray(localMeta.blueprint) ? localMeta.blueprint : [],
          tickers: Array.isArray(localMeta.tickers) ? localMeta.tickers : [],
          lookbackDays: localMeta.lookbackDays || null,
          asOfDate: localMeta.asOfDate || null,
          asOfMode: localMeta.asOfMode || null,
          priceSource: localMeta.priceSource || null,
          priceRefresh: localMeta.priceRefresh || null,
          dataAdjustment: localMeta.dataAdjustment || null,
          fallbackReason: meta.fallbackReason || localMeta.fallbackReason || null,
          note: 'Composer strategy evaluated via local defsymphony interpreter.',
        },
      };
    }

    const composerTargets = normalizeTargets(
      composerEvaluation.positions.map((pos) => {
        const symbol = pos.symbol ? String(pos.symbol).trim().toUpperCase() : null;
        const quantity = toNumber(pos.quantity, null);
        const estimatedCost = toNumber(pos.estimated_cost, null);
        const snapshotPrice =
          Number.isFinite(quantity) && quantity > 0 && Number.isFinite(estimatedCost)
            ? estimatedCost / quantity
            : null;
        return {
          symbol,
          targetWeight: toNumber(pos.weight, null),
          targetQuantity: quantity,
          targetValue: estimatedCost,
          targetQuantitySnapshot: quantity,
          targetPriceSnapshot: snapshotPrice,
          targetValueSnapshot: estimatedCost,
        };
      })
    );

    if (composerTargets.length) {
      normalizedTargets = composerTargets;
      portfolio.targetPositions = composerTargets.map((target) => ({
        symbol: target.symbol,
        targetWeight: target.targetWeight,
        targetValue: target.targetWeight && budget > 0 ? target.targetWeight * budget : null,
        targetQuantity: target.targetWeight && budget > 0 ? null : target.targetQuantity,
      }));

      baseThoughtProcess.strategySummary = composerEvaluation.summary || baseThoughtProcess.strategySummary;
      if (Array.isArray(composerEvaluation.reasoning)) {
        baseThoughtProcess.reasoning = composerEvaluation.reasoning;
      }
      baseThoughtProcess.composerPositions = composerEvaluation.positions;
      if (baseThoughtProcess.tooling?.localEvaluator) {
        baseThoughtProcess.tooling.localEvaluator.snapshotSizing = {
          enabled: snapshotSizingEnabled,
          maxPriceDriftPct: maxSnapshotDriftPct,
        };
      }
    }
  }

  if (!normalizedTargets.length) {
    throw new Error('No target positions available for rebalancing');
  }

  const targetWeightSum = normalizedTargets.reduce((sum, target) => sum + target.targetWeight, 0);
  if (targetWeightSum <= 0) {
    throw new Error('Target weights are invalid');
  }

  const adjustments = await buildAdjustments({
    targets: normalizedTargets,
    budget,
    positionMap,
    priceCache,
    dataKeys,
    trackedHoldings,
    useSnapshotQuantities: snapshotSizingEnabled,
    maxSnapshotDriftPct,
  });

  const sells = [];
  const buys = [];
  const executedSells = [];
  const executedBuys = [];

  adjustments.forEach((adjustment) => {
    const qtyDiff = adjustment.desiredQty - adjustment.currentQty;
    if (qtyDiff < 0 && Math.abs(qtyDiff) > TOLERANCE) {
      const qtyToSell = Math.min(adjustment.currentQty, Math.abs(qtyDiff));
      if (qtyToSell > 0) {
        sells.push({
          symbol: adjustment.symbol,
          qty: qtyToSell,
          price: adjustment.currentPrice,
          currentQty: adjustment.currentQty,
          desiredQty: adjustment.desiredQty,
        });
      }
    } else if (qtyDiff > 0 && adjustment.currentPrice > 0) {
      buys.push({
        symbol: adjustment.symbol,
        qty: qtyDiff,
        price: adjustment.currentPrice,
        currentQty: adjustment.currentQty,
        desiredQty: adjustment.desiredQty,
      });
    }
  });

  let sellProceeds = 0;
  for (const sell of sells) {
    const normalized = normalizeQtyForOrder(sell.qty);
    if (!normalized.qty) {
      continue;
    }
    const estimatedNotional = normalized.qty * sell.price;
    if (normalized.isFractional && estimatedNotional < MIN_FRACTIONAL_NOTIONAL) {
      continue;
    }
    try {
      const response = await placeOrder(
        tradingKeys,
        buildMarketOrderPayload({
          symbol: sell.symbol,
          side: 'sell',
          qty: normalized.qty,
          isFractional: ENABLE_FRACTIONAL_ORDERS && normalized.isFractional,
        })
      );
      const orderId = response?.data?.client_order_id || response?.data?.id || null;
      sellProceeds += normalized.qty * sell.price;
      executedSells.push({
        symbol: sell.symbol,
        qty: normalized.qty,
        price: sell.price,
        orderId,
      });
    } catch (error) {
      if (ENABLE_FRACTIONAL_ORDERS && normalized.isFractional && shouldFallbackToWholeShares(error)) {
        const wholeDiff = computeWholeShareQtyDiff(sell.currentQty, sell.desiredQty);
        const fallbackQty = Math.max(0, -wholeDiff);
        if (fallbackQty > 0) {
          try {
            const response = await placeOrder(
              tradingKeys,
              buildMarketOrderPayload({
                symbol: sell.symbol,
                side: 'sell',
                qty: fallbackQty,
                isFractional: false,
              })
            );
            const orderId = response?.data?.client_order_id || response?.data?.id || null;
            sellProceeds += fallbackQty * sell.price;
            executedSells.push({
              symbol: sell.symbol,
              qty: fallbackQty,
              price: sell.price,
              orderId,
            });
            recordFallback({ symbol: sell.symbol, side: 'sell', error, qty: fallbackQty });
            continue;
          } catch (fallbackError) {
            console.error(
              `[Rebalance] Sell order failed for ${sell.symbol} (fractional + fallback):`,
              fallbackError.message
            );
          }
        }
      }
      console.error(`[Rebalance] Sell order failed for ${sell.symbol}:`, error.message);
    }
  }

  let realizedPnlDelta = 0;
  executedSells.forEach((sell) => {
    const snapshot = holdingsSnapshot.get(sell.symbol);
    if (!snapshot) {
      return;
    }
    const avgCost = toNumber(snapshot.avgCost, null);
    const availableQty = Math.max(0, toNumber(snapshot.quantity, 0));
    const qtySold = Math.min(Math.abs(sell.qty), availableQty);
    if (!qtySold || !Number.isFinite(avgCost)) {
      return;
    }
    realizedPnlDelta += (sell.price - avgCost) * qtySold;
    snapshot.quantity = Math.max(0, availableQty - qtySold);
  });

  strategyCash += sellProceeds;
  const actualCashAvailable = Math.max(0, accountCash) + sellProceeds;
  let availableCash = Math.min(budget, strategyCash, actualCashAvailable);
  let buySpend = 0;

  for (const buy of buys) {
    const normalized = normalizeQtyForOrder(buy.qty);
    if (!normalized.qty) {
      continue;
    }
    const estimatedCost = normalized.qty * buy.price;
    if (normalized.isFractional && estimatedCost < MIN_FRACTIONAL_NOTIONAL) {
      continue;
    }
    if (estimatedCost <= availableCash) {
      try {
        const response = await placeOrder(
          tradingKeys,
          buildMarketOrderPayload({
            symbol: buy.symbol,
            side: 'buy',
            qty: normalized.qty,
            isFractional: ENABLE_FRACTIONAL_ORDERS && normalized.isFractional,
          })
        );
        const orderId = response?.data?.client_order_id || response?.data?.id || null;
        const filledPrice = await fetchOrderFillPrice(tradingKeys, orderId);
        const executionPrice = Number.isFinite(filledPrice) && filledPrice > 0 ? filledPrice : buy.price;
        const actualCost = executionPrice * normalized.qty;
        availableCash -= actualCost;
        strategyCash = Math.max(0, strategyCash - actualCost);
        buySpend += actualCost;
        executedBuys.push({
          symbol: buy.symbol,
          qty: normalized.qty,
          price: executionPrice,
          orderId,
        });
      } catch (error) {
        if (ENABLE_FRACTIONAL_ORDERS && normalized.isFractional && shouldFallbackToWholeShares(error)) {
          const wholeDiff = computeWholeShareQtyDiff(buy.currentQty, buy.desiredQty);
          const fallbackQty = Math.max(0, wholeDiff);
          if (fallbackQty > 0) {
            try {
              const response = await placeOrder(
                tradingKeys,
                buildMarketOrderPayload({
                  symbol: buy.symbol,
                  side: 'buy',
                  qty: fallbackQty,
                  isFractional: false,
                })
              );
              const orderId = response?.data?.client_order_id || response?.data?.id || null;
              const filledPrice = await fetchOrderFillPrice(tradingKeys, orderId);
              const executionPrice = Number.isFinite(filledPrice) && filledPrice > 0 ? filledPrice : buy.price;
              const actualCost = executionPrice * fallbackQty;
              availableCash -= actualCost;
              strategyCash = Math.max(0, strategyCash - actualCost);
              buySpend += actualCost;
              executedBuys.push({
                symbol: buy.symbol,
                qty: fallbackQty,
                price: executionPrice,
                orderId,
              });
              recordFallback({ symbol: buy.symbol, side: 'buy', error, qty: fallbackQty });
              continue;
            } catch (fallbackError) {
              console.error(
                `[Rebalance] Buy order failed for ${buy.symbol} (fractional + fallback):`,
                fallbackError.message
              );
            }
          }
        }
        console.error(`[Rebalance] Buy order failed for ${buy.symbol}:`, error.message);
      }
    } else {
      const rawAffordableQty = availableCash / buy.price;
      const affordableQty = ENABLE_FRACTIONAL_ORDERS
        ? Math.min(toNumber(buy.qty, 0), rawAffordableQty)
        : Math.min(toNumber(buy.qty, 0), Math.floor(rawAffordableQty));
      const normalizedAffordable = normalizeQtyForOrder(affordableQty);
      if (normalizedAffordable.qty) {
        const estimatedAffordableCost = normalizedAffordable.qty * buy.price;
        if (normalizedAffordable.isFractional && estimatedAffordableCost < MIN_FRACTIONAL_NOTIONAL) {
          continue;
        }
        try {
          const response = await placeOrder(
            tradingKeys,
            buildMarketOrderPayload({
              symbol: buy.symbol,
              side: 'buy',
              qty: normalizedAffordable.qty,
              isFractional: ENABLE_FRACTIONAL_ORDERS && normalizedAffordable.isFractional,
            })
          );
          const orderId = response?.data?.client_order_id || response?.data?.id || null;
          const filledPrice = await fetchOrderFillPrice(tradingKeys, orderId);
          const executionPrice = Number.isFinite(filledPrice) && filledPrice > 0 ? filledPrice : buy.price;
          const actualCost = executionPrice * normalizedAffordable.qty;
          availableCash -= actualCost;
          strategyCash = Math.max(0, strategyCash - actualCost);
          buySpend += actualCost;
          executedBuys.push({
            symbol: buy.symbol,
            qty: normalizedAffordable.qty,
            price: executionPrice,
            orderId,
          });
        } catch (error) {
          if (ENABLE_FRACTIONAL_ORDERS && normalizedAffordable.isFractional && shouldFallbackToWholeShares(error)) {
            const fallbackQty = Math.floor(toNumber(affordableQty, 0));
            if (fallbackQty > 0) {
              try {
                const response = await placeOrder(
                  tradingKeys,
                  buildMarketOrderPayload({
                    symbol: buy.symbol,
                    side: 'buy',
                    qty: fallbackQty,
                    isFractional: false,
                  })
                );
                const orderId = response?.data?.client_order_id || response?.data?.id || null;
                const filledPrice = await fetchOrderFillPrice(tradingKeys, orderId);
                const executionPrice = Number.isFinite(filledPrice) && filledPrice > 0 ? filledPrice : buy.price;
                const actualCost = executionPrice * fallbackQty;
                availableCash -= actualCost;
                strategyCash = Math.max(0, strategyCash - actualCost);
                buySpend += actualCost;
                executedBuys.push({
                  symbol: buy.symbol,
                  qty: fallbackQty,
                  price: executionPrice,
                  orderId,
                });
                recordFallback({ symbol: buy.symbol, side: 'buy', error, qty: fallbackQty });
                continue;
            } catch (fallbackError) {
              console.error(
                `[Rebalance] Partial buy order failed for ${buy.symbol} (fractional + fallback):`,
                fallbackError.message
              );
            }
          }
        }
          console.error(`[Rebalance] Partial buy order failed for ${buy.symbol}:`, error.message);
        }
      }
    }
  }

  executedSells.forEach((sell) => {
    updateHoldingsForTrade(holdingsState, {
      symbol: sell.symbol,
      qtyChange: -Math.abs(sell.qty),
      price: sell.price,
    });
  });

  executedBuys.forEach((buy) => {
    updateHoldingsForTrade(holdingsState, {
      symbol: buy.symbol,
      qtyChange: Math.abs(buy.qty),
      price: buy.price,
      orderId: buy.orderId,
      overwriteOrderId: true,
    });
  });

  if (dataKeys?.keyId && dataKeys?.secretKey) {
    const symbolsNeedingPrice = [];
    holdingsState.forEach((entry, symbol) => {
      if (priceCache[symbol] == null && symbol) {
        symbolsNeedingPrice.push(symbol);
      }
    });
    if (symbolsNeedingPrice.length) {
      await Promise.all(
        symbolsNeedingPrice.map(async (symbol) => {
          const latestPrice = await fetchLatestTradePrice(dataKeys, symbol);
          if (Number.isFinite(latestPrice)) {
            priceCache[symbol] = latestPrice;
          }
        })
      );
    }
  }

  portfolio.stocks = serializeHoldingsState(holdingsState, priceCache);
  const reconciliation = buildRebalanceReconciliation({
    adjustments,
    holdingsState,
    priceCache,
    budget,
    plannedBuys: buys,
    plannedSells: sells,
    executedBuys,
    executedSells,
  });
  const { totalCostBasis, totalMarketValue } = computePortfolioPerformanceTotals(portfolio.stocks);
  const rawPnlValue = totalMarketValue - totalCostBasis;
  const rawPnlPercent = totalCostBasis > 0 ? (rawPnlValue / totalCostBasis) * 100 : 0;
  const unrealizedPnlValue = roundToTwo(rawPnlValue);
  const unrealizedPnlPercent = roundToTwo(rawPnlPercent);
  const previousRealized = toNumber(portfolio.realizedPnlValue, 0);
  const updatedRealized = roundToTwo((previousRealized || 0) + realizedPnlDelta);
  portfolio.realizedPnlValue = updatedRealized !== null ? updatedRealized : previousRealized;
  const totalPnlValue = roundToTwo((unrealizedPnlValue || 0) + (portfolio.realizedPnlValue || 0));
  const totalPnlPercent = portfolio.initialInvestment > 0
    ? (totalPnlValue / portfolio.initialInvestment) * 100
    : 0;
  const normalizedPnlPercent = roundToTwo(totalPnlPercent);
  portfolio.pnlValue = totalPnlValue !== null ? totalPnlValue : 0;
  portfolio.pnlPercent = normalizedPnlPercent !== null ? normalizedPnlPercent : 0;
  portfolio.lastPerformanceComputedAt = now;
  if (Number.isFinite(totalCostBasis) && totalCostBasis > 0) {
    const existingInitial = Math.max(0, toNumber(portfolio.initialInvestment, 0));
    if (totalCostBasis > existingInitial) {
      portfolio.initialInvestment = roundToTwo(totalCostBasis);
    }
  }

  const decisionTrace = adjustments.map((adjustment) => {
    const qtyDiff = adjustment.desiredQty - adjustment.currentQty;
    const action = Math.abs(qtyDiff) <= TOLERANCE
      ? 'hold'
      : qtyDiff > 0
        ? 'buy'
        : 'sell';
    const pct = Number.isFinite(adjustment.targetWeight)
      ? Math.round(adjustment.targetWeight * 10000) / 100
      : null;
    const explanation = (() => {
      if (action === 'hold') {
        return 'Holding position; allocation already within tolerance of target weight.';
      }
      const direction = action === 'buy' ? 'increase' : 'reduce';
      const base = `Need to ${direction} exposure to align ${pct !== null ? `${pct}%` : 'target'} weight. Desired ${adjustment.desiredQty} shares versus current ${adjustment.currentQty}.`;
      if (adjustment.usedSnapshotSizing) {
        const drift = Number.isFinite(adjustment.priceDriftPct)
          ? ` (price drift ${(adjustment.priceDriftPct * 100).toFixed(2)}%)`
          : '';
        return `${base} Snapshot sizing applied${drift}.`;
      }
      if (Number.isFinite(adjustment.priceDriftPct) && adjustment.snapshotQty) {
        return `${base} Snapshot sizing skipped due to price drift ${(adjustment.priceDriftPct * 100).toFixed(2)}%.`;
      }
      return base;
    })();
    return {
      symbol: adjustment.symbol,
      action,
      currentQty: adjustment.currentQty,
      desiredQty: adjustment.desiredQty,
      currentValue: roundToTwo(adjustment.currentValue),
      desiredValue: roundToTwo(adjustment.desiredValue),
      targetWeightPercent: pct,
      explanation,
    };
  });

  const thoughtProcess = {
    ...baseThoughtProcess,
    adjustments: decisionTrace,
    reconciliation,
    cashSummary: {
      startingCash: roundToTwo(accountCash),
      sellProceeds: roundToTwo(sellProceeds),
      spentOnBuys: roundToTwo(buySpend),
      endingCash: roundToTwo(availableCash),
      cashBuffer: null, // placeholder, updated after buffer computed
    },
  };
  const holdDecisions = decisionTrace.filter((entry) => entry.action === 'hold');

  const updatedRetainedCash = roundToTwo(Math.max(0, toNumber(portfolio.retainedCash, 0) + realizedPnlDelta));
  portfolio.retainedCash = updatedRetainedCash !== null ? updatedRetainedCash : 0;
  portfolio.cashBuffer = portfolio.retainedCash;
  thoughtProcess.cashSummary.cashBuffer = roundToTwo(portfolio.cashBuffer);
  if (!portfolio.initialInvestment) {
    portfolio.initialInvestment = Math.max(0, buySpend);
  }
  portfolio.rebalanceCount = (toNumber(portfolio.rebalanceCount, 0) || 0) + 1;
  portfolio.lastRebalancedAt = now;
  const provisionalNext = computeNextRebalanceAt(recurrence, now);
  const alignedNext = await alignToRebalanceWindowStart(tradingKeys, provisionalNext);
  portfolio.nextRebalanceAt = alignedNext || provisionalNext;
  portfolio.nextRebalanceManual = false;
  portfolio.recurrence = recurrence;

  const humanSummary = buildRebalanceHumanSummary({
    strategyName: portfolio.name,
    recurrence,
    executedSells,
    executedBuys,
    decisionTrace,
    holds: holdDecisions,
    reconciliation,
    cashSummary: {
      startingCash: accountCash,
      sellProceeds,
      spentOnBuys: buySpend,
      endingCash: availableCash,
      cashBuffer: portfolio.cashBuffer,
    },
    nextRebalanceAt: portfolio.nextRebalanceAt,
    tooling: baseThoughtProcess.tooling,
  });

  try {
    await portfolio.save();
  } catch (error) {
    if (
      error?.message?.includes('No matching document found') ||
      error?.code === 66
    ) {
      console.warn(
        `[Rebalance] Portfolio ${portfolio._id} could not be saved (possibly deleted). Skipping.`
      );
      await recordStrategyLog({
        strategyId: portfolio.strategy_id,
        userId: portfolio.userId,
        strategyName: portfolio.name,
        message: 'Skipped rebalance because portfolio record no longer exists.',
        details: { error: error.message },
        level: 'warn',
      });
      return;
    }
    throw error;
  }

  const holdingsMarketValue = Number.isFinite(totalMarketValue) ? roundToTwo(Math.max(0, totalMarketValue)) : null;
  const retainedCashValue = roundToTwo(Math.max(0, toNumber(portfolio.retainedCash, 0)));
  const totalEquityValue = (() => {
    if (holdingsMarketValue === null || retainedCashValue === null) {
      return null;
    }
    return roundToTwo(holdingsMarketValue + retainedCashValue);
  })();

  const snapshotUserId = portfolio.userId ? String(portfolio.userId) : null;

  if (totalEquityValue !== null && snapshotUserId) {
    try {
      await StrategyEquitySnapshot.create({
        strategy_id: portfolio.strategy_id,
        userId: snapshotUserId,
        portfolioId: portfolio._id,
        strategyName: portfolio.name,
        equityValue: totalEquityValue,
        holdingsMarketValue: holdingsMarketValue,
        retainedCash: retainedCashValue,
        cashLimit: toNumber(portfolio.cashLimit, null),
        pnlValue: toNumber(portfolio.pnlValue, null),
      });
    } catch (snapshotError) {
      console.error('[Rebalance] Failed to record equity snapshot:', snapshotError.message);
    }
  }

  await recordStrategyLog({
    strategyId: portfolio.strategy_id,
    userId: portfolio.userId,
    strategyName: portfolio.name,
    message: 'Portfolio rebalanced',
    details: {
      recurrence,
      sells: executedSells.map((sell) => ({
        symbol: sell.symbol,
        qty: sell.qty,
        price: sell.price,
      })),
      buys: executedBuys.map((buy) => ({
        symbol: buy.symbol,
        qty: buy.qty,
        price: buy.price,
      })),
      holds: holdDecisions.map((entry) => ({
        symbol: entry.symbol,
        explanation: entry.explanation,
      })),
      budget,
      buySpend: roundToTwo(buySpend),
      sellProceeds: roundToTwo(sellProceeds),
      remainingCash: roundToTwo(availableCash),
      cashBuffer: roundToTwo(portfolio.cashBuffer),
      accountCash: roundToTwo(accountCash),
      reconciliation,
      thoughtProcess,
      humanSummary,
    },
  });
};

let rebalanceInProgress = false;

const withRebalanceLock = async (handler) => {
  if (rebalanceInProgress) {
    throw new Error('Rebalance already in progress');
  }
  rebalanceInProgress = true;
  try {
    return await handler();
  } finally {
    rebalanceInProgress = false;
  }
};

const runDueRebalances = async () => {
  try {
    return await withRebalanceLock(async () => {
      const now = new Date();
      const duePortfolios = await Portfolio.find({
        recurrence: { $exists: true },
        $or: [
          { nextRebalanceAt: null },
          { nextRebalanceAt: { $lte: now } },
        ],
      });

      for (const portfolio of duePortfolios) {
        try {
          const provider = String(portfolio.provider || 'alpaca');
          if (provider === 'polymarket') {
            await syncPolymarketPortfolio(portfolio);
          } else {
            await rebalancePortfolio(portfolio);
          }
        } catch (error) {
          console.error(`[Rebalance] Failed for portfolio ${portfolio._id}:`, error.message);
          await recordStrategyLog({
            strategyId: portfolio.strategy_id,
            userId: portfolio.userId,
            strategyName: portfolio.name,
            level: 'error',
            message: String(portfolio.provider || 'alpaca') === 'polymarket'
              ? 'Polymarket sync failed'
              : 'Portfolio rebalance failed',
            details: {
              provider: String(portfolio.provider || 'alpaca'),
              error: error.message,
            },
          });
        }
      }
    });
  } catch (error) {
    if (String(error?.message || '').includes('Rebalance already in progress')) {
      console.log('[Rebalance] Skipping run; previous cycle still in progress.');
      return;
    }
    throw error;
  }
};

const rebalanceNow = async ({ strategyId, userId }) => withRebalanceLock(async () => {
  if (!strategyId || !userId) {
    throw new Error('strategyId and userId are required');
  }
  const portfolio = await Portfolio.findOne({ strategy_id: String(strategyId), userId: String(userId) });
  if (!portfolio) {
    throw new Error('Portfolio not found');
  }
  // Manual "rebalance now" should bypass the default end-of-day window once.
  portfolio.nextRebalanceManual = true;
  const provider = String(portfolio.provider || 'alpaca');
  if (provider === 'polymarket') {
    await syncPolymarketPortfolio(portfolio);
  } else {
    await rebalancePortfolio(portfolio);
  }
});

const isRebalanceLocked = () => rebalanceInProgress;

module.exports = {
  runDueRebalances,
  rebalancePortfolio,
  rebalanceNow,
  isRebalanceLocked,
  buildAdjustments,
  fetchNextMarketSessionAfter,
  alignToRebalanceWindowStart,
  computeRebalanceWindow,
};
