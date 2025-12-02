const Portfolio = require('../models/portfolioModel');
const Strategy = require('../models/strategyModel');
const { getAlpacaConfig } = require('../config/alpacaConfig');
const { normalizeRecurrence, computeNextRebalanceAt } = require('../utils/recurrence');
const { recordStrategyLog } = require('./strategyLogger');
const { runComposerStrategy } = require('../utils/openaiComposerStrategy');

const TOLERANCE = 0.01;

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

const formatPercentage = (value) => {
  if (!Number.isFinite(value)) {
    return null;
  }
  return `${value.toFixed(1)}%`;
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
    lines.push('• Local defsymphony evaluator computed allocations using cached Alpaca prices.');
    const tickers = Array.isArray(localTool.tickers) ? localTool.tickers.filter(Boolean) : [];
    if (tickers.length) {
      lines.push(`• Cached instrument universe: ${tickers.join(', ')}.`);
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

  return lines.join('\n');
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
    const desiredQty = currentPrice > 0 ? Math.floor(desiredValue / currentPrice) : 0;
    return {
      symbol: target.symbol,
      currentQty,
      desiredQty,
      currentPrice,
      desiredValue,
      currentValue,
      targetWeight: target.targetWeight,
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

  const clockData = await fetchMarketClock(tradingKeys);
  if (clockData && clockData.is_open === false) {
    const fallbackNext = computeNextRebalanceAt(recurrence, now);
    const nextOpen = clockData.next_open ? new Date(clockData.next_open) : null;
    const nextOpenValid = nextOpen && !Number.isNaN(nextOpen.getTime());

    let scheduledAt = nextOpenValid ? nextOpen : await alignToNextMarketOpen(tradingKeys, fallbackNext);

    if (!scheduledAt || scheduledAt <= now) {
      const bufferDate = new Date(now.getTime() + 60000);
      const bufferedNext = computeNextRebalanceAt(recurrence, bufferDate);
      const alignedBuffered = await alignToNextMarketOpen(tradingKeys, bufferedNext);
      scheduledAt = alignedBuffered > now ? alignedBuffered : bufferedNext;
    }

    portfolio.nextRebalanceAt = scheduledAt;
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

  const baseBudget = portfolio.initialInvestment || 0;
  const cashBuffer = toNumber(portfolio.cashBuffer, 0);
  let strategyCash = Math.max(0, cashBuffer);
  const cashLimit = toNumber(portfolio.cashLimit, toNumber(portfolio.budget, null));
  const effectiveLimit = cashLimit && cashLimit > 0 ? cashLimit : Infinity;
  const maxBudget = Math.min(baseBudget + strategyCash, effectiveLimit);
  const currentTotal = currentPortfolioValue + strategyCash;
  const budget = Math.min(
    maxBudget > 0 ? maxBudget : currentTotal,
    currentTotal,
    effectiveLimit,
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
          fallbackReason: meta.fallbackReason || localMeta.fallbackReason || null,
          note: 'Composer strategy evaluated via local defsymphony interpreter.',
        },
      };
    }

    const composerTargets = normalizeTargets(
      composerEvaluation.positions.map((pos) => ({
        symbol: pos.symbol ? String(pos.symbol).trim().toUpperCase() : null,
        targetWeight: toNumber(pos.weight, null),
        targetQuantity: toNumber(pos.quantity, null),
        targetValue: toNumber(pos.estimated_cost, null),
      }))
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
        });
      }
    } else if (qtyDiff > 0 && adjustment.currentPrice > 0) {
      buys.push({
        symbol: adjustment.symbol,
        qty: qtyDiff,
        price: adjustment.currentPrice,
      });
    }
  });

  let sellProceeds = 0;
  for (const sell of sells) {
    try {
      const response = await placeOrder(tradingKeys, {
        symbol: sell.symbol,
        qty: sell.qty,
        side: 'sell',
        type: 'market',
        time_in_force: 'gtc',
      });
      const orderId = response?.data?.client_order_id || response?.data?.id || null;
      sellProceeds += sell.qty * sell.price;
      executedSells.push({
        symbol: sell.symbol,
        qty: sell.qty,
        price: sell.price,
        orderId,
      });
    } catch (error) {
      console.error(`[Rebalance] Sell order failed for ${sell.symbol}:`, error.message);
    }
  }

  strategyCash += sellProceeds;
  const actualCashAvailable = Math.max(0, accountCash) + sellProceeds;
  let availableCash = Math.min(budget, strategyCash, actualCashAvailable);
  let buySpend = 0;

  for (const buy of buys) {
    const estimatedCost = buy.qty * buy.price;
    if (estimatedCost <= availableCash) {
      try {
        const response = await placeOrder(tradingKeys, {
          symbol: buy.symbol,
          qty: buy.qty,
          side: 'buy',
          type: 'market',
          time_in_force: 'gtc',
        });
        const orderId = response?.data?.client_order_id || response?.data?.id || null;
        const filledPrice = await fetchOrderFillPrice(tradingKeys, orderId);
        const executionPrice = Number.isFinite(filledPrice) && filledPrice > 0 ? filledPrice : buy.price;
        const actualCost = executionPrice * buy.qty;
        availableCash -= actualCost;
        strategyCash = Math.max(0, strategyCash - actualCost);
        buySpend += actualCost;
        executedBuys.push({
          symbol: buy.symbol,
          qty: buy.qty,
          price: executionPrice,
          orderId,
        });
      } catch (error) {
        console.error(`[Rebalance] Buy order failed for ${buy.symbol}:`, error.message);
      }
    } else {
      const affordableQty = Math.floor(availableCash / buy.price);
      if (affordableQty > 0) {
        try {
          const response = await placeOrder(tradingKeys, {
            symbol: buy.symbol,
            qty: affordableQty,
            side: 'buy',
            type: 'market',
            time_in_force: 'gtc',
        });
        const orderId = response?.data?.client_order_id || response?.data?.id || null;
        const filledPrice = await fetchOrderFillPrice(tradingKeys, orderId);
        const executionPrice = Number.isFinite(filledPrice) && filledPrice > 0 ? filledPrice : buy.price;
        const actualCost = executionPrice * affordableQty;
        availableCash -= actualCost;
        strategyCash = Math.max(0, strategyCash - actualCost);
        buySpend += actualCost;
        executedBuys.push({
          symbol: buy.symbol,
          qty: affordableQty,
          price: executionPrice,
          orderId,
        });
      } catch (error) {
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

  portfolio.stocks = serializeHoldingsState(holdingsState, priceCache);
  const { totalCostBasis, totalMarketValue } = computePortfolioPerformanceTotals(portfolio.stocks);
  const rawPnlValue = totalMarketValue - totalCostBasis;
  const rawPnlPercent = totalCostBasis > 0 ? (rawPnlValue / totalCostBasis) * 100 : 0;
  const normalizedPnlValue = roundToTwo(rawPnlValue);
  const normalizedPnlPercent = roundToTwo(rawPnlPercent);
  portfolio.pnlValue = normalizedPnlValue !== null ? normalizedPnlValue : 0;
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
      return `Need to ${direction} exposure to align ${pct !== null ? `${pct}%` : 'target'} weight. Desired ${adjustment.desiredQty} shares versus current ${adjustment.currentQty}.`;
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
    cashSummary: {
      startingCash: roundToTwo(accountCash),
      sellProceeds: roundToTwo(sellProceeds),
      spentOnBuys: roundToTwo(buySpend),
      endingCash: roundToTwo(availableCash),
      cashBuffer: null, // placeholder, updated after buffer computed
    },
  };
  const holdDecisions = decisionTrace.filter((entry) => entry.action === 'hold');

  portfolio.cashBuffer = Math.max(0, strategyCash);
  if (cashLimit && cashLimit > 0) {
    const maxAllowedBuffer = Math.max(0, cashLimit - (portfolio.initialInvestment || 0));
    portfolio.cashBuffer = Math.min(portfolio.cashBuffer, maxAllowedBuffer);
  }
  thoughtProcess.cashSummary.cashBuffer = roundToTwo(portfolio.cashBuffer);
  if (!portfolio.initialInvestment) {
    portfolio.initialInvestment = Math.max(0, buySpend);
  }
  portfolio.rebalanceCount = (toNumber(portfolio.rebalanceCount, 0) || 0) + 1;
  portfolio.lastRebalancedAt = now;
  const provisionalNext = computeNextRebalanceAt(recurrence, now);
  const alignedNext = await alignToNextMarketOpen(tradingKeys, provisionalNext);
  portfolio.nextRebalanceAt = alignedNext || provisionalNext;
  portfolio.recurrence = recurrence;

  const humanSummary = buildRebalanceHumanSummary({
    strategyName: portfolio.name,
    recurrence,
    executedSells,
    executedBuys,
    decisionTrace,
    holds: holdDecisions,
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
      thoughtProcess,
      humanSummary,
    },
  });
};

let rebalanceInProgress = false;

const runDueRebalances = async () => {
  if (rebalanceInProgress) {
    console.log('[Rebalance] Skipping run; previous cycle still in progress.');
    return;
  }
  rebalanceInProgress = true;
  try {
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
        await rebalancePortfolio(portfolio);
      } catch (error) {
        console.error(`[Rebalance] Failed for portfolio ${portfolio._id}:`, error.message);
        await recordStrategyLog({
          strategyId: portfolio.strategy_id,
          userId: portfolio.userId,
          strategyName: portfolio.name,
          level: 'error',
          message: 'Portfolio rebalance failed',
          details: { error: error.message },
        });
      }
    }
  } finally {
    rebalanceInProgress = false;
  }
};

module.exports = {
  runDueRebalances,
  rebalancePortfolio,
};
