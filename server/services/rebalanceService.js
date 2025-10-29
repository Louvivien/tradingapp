const Portfolio = require('../models/portfolioModel');
const Strategy = require('../models/strategyModel');
const { getAlpacaConfig } = require('../config/alpacaConfig');
const { normalizeRecurrence, computeNextRebalanceAt } = require('../utils/recurrence');
const { recordStrategyLog } = require('./strategyLogger');

const TOLERANCE = 0.01;

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

const buildAdjustments = async ({
  targets,
  budget,
  positionMap,
  priceCache,
  dataKeys,
}) => {
  const symbolsNeedingPrice = targets
    .filter((target) => !priceCache[target.symbol])
    .map((target) => target.symbol);

  if (symbolsNeedingPrice.length) {
    const fetched = await fetchLatestPrices(symbolsNeedingPrice, dataKeys);
    Object.assign(priceCache, fetched);
  }

  const adjustments = targets.map((target) => {
    const position = positionMap[target.symbol];
    const currentQty = position ? toNumber(position.qty, 0) : 0;
    const currentPrice = priceCache[target.symbol]
      || toNumber(position?.current_price, null)
      || toNumber(position?.avg_entry_price, null)
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

  // Ensure positions not present in targets are liquidated
  Object.keys(positionMap).forEach((symbol) => {
    if (!targets.find((target) => target.symbol === symbol)) {
      const position = positionMap[symbol];
      const price = toNumber(position.current_price, toNumber(position.avg_entry_price, 0));
      adjustments.push({
        symbol,
        currentQty: toNumber(position.qty, 0),
        desiredQty: 0,
        currentPrice: price,
        desiredValue: 0,
        currentValue: toNumber(position.market_value, 0),
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

  const strategy = await Strategy.findOne({ strategy_id: portfolio.strategy_id });
  const recurrence = normalizeRecurrence(portfolio.recurrence || strategy?.recurrence);
  const alpacaConfig = await getAlpacaConfig(portfolio.userId);

  if (!alpacaConfig?.hasValidKeys) {
    throw new Error('Invalid Alpaca credentials for portfolio rebalancing');
  }

  const tradingKeys = alpacaConfig.getTradingKeys();
  const dataKeys = alpacaConfig.getDataKeys();

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

  positions.forEach((position) => {
    positionMap[position.symbol] = position;
    const price = toNumber(position.current_price, toNumber(position.avg_entry_price, null));
    if (price) {
      priceCache[position.symbol] = price;
    }
  });

  const currentPortfolioValue = positions.reduce(
    (sum, position) => sum + toNumber(position.market_value, 0),
    0,
  );

  if (!portfolio.initialInvestment) {
    const estimatedInvestment = positions.reduce(
      (sum, position) => sum + toNumber(position.cost_basis, 0),
      0,
    );
    portfolio.initialInvestment = estimatedInvestment || toNumber(portfolio.budget, 0) || currentPortfolioValue;
  }

  const baseBudget = portfolio.initialInvestment || 0;
  const cashBuffer = toNumber(portfolio.cashBuffer, 0);
  const maxBudget = baseBudget + cashBuffer;
  const currentTotal = currentPortfolioValue + accountCash;
  const budget = Math.min(maxBudget > 0 ? maxBudget : currentTotal, currentTotal);

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
  });

  const sells = [];
  const buys = [];

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
      await placeOrder(tradingKeys, {
        symbol: sell.symbol,
        qty: sell.qty,
        side: 'sell',
        type: 'market',
        time_in_force: 'gtc',
      });
      sellProceeds += sell.qty * sell.price;
    } catch (error) {
      console.error(`[Rebalance] Sell order failed for ${sell.symbol}:`, error.message);
    }
  }

  let availableCash = Math.min(budget, accountCash + sellProceeds);
  let buySpend = 0;

  for (const buy of buys) {
    const estimatedCost = buy.qty * buy.price;
    if (estimatedCost <= availableCash) {
      try {
        await placeOrder(tradingKeys, {
          symbol: buy.symbol,
          qty: buy.qty,
          side: 'buy',
          type: 'market',
          time_in_force: 'gtc',
        });
        availableCash -= estimatedCost;
        buySpend += estimatedCost;
      } catch (error) {
        console.error(`[Rebalance] Buy order failed for ${buy.symbol}:`, error.message);
      }
    } else {
      const affordableQty = Math.floor(availableCash / buy.price);
      if (affordableQty > 0) {
        try {
          await placeOrder(tradingKeys, {
            symbol: buy.symbol,
            qty: affordableQty,
            side: 'buy',
            type: 'market',
            time_in_force: 'gtc',
          });
          const cost = affordableQty * buy.price;
          availableCash -= cost;
          buySpend += cost;
        } catch (error) {
          console.error(`[Rebalance] Partial buy order failed for ${buy.symbol}:`, error.message);
        }
      }
    }
  }

  const now = new Date();
  portfolio.cashBuffer = Math.max(0, availableCash);
  if (!portfolio.initialInvestment) {
    portfolio.initialInvestment = Math.max(0, buySpend);
  }
  portfolio.lastRebalancedAt = now;
  portfolio.nextRebalanceAt = computeNextRebalanceAt(recurrence, now);
  portfolio.recurrence = recurrence;

  await portfolio.save();

  await recordStrategyLog({
    strategyId: portfolio.strategy_id,
    userId: portfolio.userId,
    strategyName: portfolio.name,
    message: 'Portfolio rebalanced',
    details: {
      recurrence,
      sells: sells.map((sell) => ({ symbol: sell.symbol, qty: sell.qty })),
      buys: buys.map((buy) => ({ symbol: buy.symbol, qty: buy.qty })),
      budget,
      buySpend: roundToTwo(buySpend),
      sellProceeds: roundToTwo(sellProceeds),
      remainingCash: roundToTwo(availableCash),
      cashBuffer: roundToTwo(portfolio.cashBuffer),
      accountCash: roundToTwo(accountCash),
    },
  });
};

const runDueRebalances = async () => {
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
};

module.exports = {
  runDueRebalances,
  rebalancePortfolio,
};
