const {
  parseComposerScript,
  collectTickersFromAst,
  buildEvaluationBlueprint,
  describeMetricNode,
  describeSelectionNode,
  describeCondition,
} = require('../utils/composerDslParser');
const { getCachedPrices } = require('./priceCacheService');

const LOOKBACK_DAYS = 1200;

const toISODate = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
};

const now = () => new Date();

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

const computeRSI = (series, window) => {
  if (series.length < window + 1) {
    throw new Error(`Not enough data to compute RSI window ${window}.`);
  }
  let gains = 0;
  let losses = 0;
  for (let i = series.length - window; i < series.length; i += 1) {
    const diff = series[i] - series[i - 1];
    if (diff >= 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }
  const avgGain = gains / window;
  const avgLoss = losses / window;
  if (avgLoss === 0) {
    return 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
};

const computeSMA = (series, window) => {
  if (series.length < window) {
    throw new Error(`Not enough data to compute moving average window ${window}.`);
  }
  const subset = tail(series, window);
  return subset.reduce((sum, value) => sum + value, 0) / window;
};

const computeEMA = (series, window) => {
  if (series.length < window) {
    throw new Error(`Not enough data to compute EMA window ${window}.`);
  }
  const alpha = 2 / (window + 1);
  let ema = series[series.length - window];
  for (let i = series.length - window + 1; i < series.length; i += 1) {
    ema = alpha * series[i] + (1 - alpha) * ema;
  }
  return ema;
};

const computeReturns = (series, window) => {
  if (series.length < window + 1) {
    throw new Error(`Not enough data to compute returns window ${window}.`);
  }
  const returns = [];
  for (let i = series.length - window; i < series.length; i += 1) {
    const prev = series[i - 1];
    if (!prev) {
      continue;
    }
    returns.push((series[i] - prev) / prev);
  }
  return returns;
};

const computeMovingAverageReturn = (series, window) => {
  const returns = computeReturns(series, window);
  if (!returns.length) {
    throw new Error('Unable to compute moving average return.');
  }
  return returns.reduce((sum, value) => sum + value, 0) / returns.length;
};

const computeCumulativeReturn = (series, window) => {
  if (series.length < window + 1) {
    throw new Error(`Not enough data to compute cumulative return window ${window}.`);
  }
  const latest = series[series.length - 1];
  const prior = series[series.length - 1 - window];
  return (latest - prior) / prior;
};

const computeStdDevReturn = (series, window) => {
  const returns = computeReturns(series, window);
  if (!returns.length) {
    throw new Error('Unable to compute stdev return.');
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    returns.length;
  return Math.sqrt(variance);
};

const computeMaxDrawdown = (series, window) => {
  if (series.length < window) {
    throw new Error(`Not enough data to compute max drawdown window ${window}.`);
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

const evaluateCondition = (node, ctx) => {
  if (!isArray(node)) {
    return Boolean(node);
  }
  const operator = String(node[0]);
  const left = evaluateExpression(node[1], ctx);
  const right = evaluateExpression(node[2], ctx);
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
      if (!symbol) {
        throw new Error('Metric symbol context missing for RSI');
      }
      const window = Number(getKeyword(options, ':window') || getKeyword(options, 'window') || 14);
      const series = ctx.priceData.get(symbol);
      if (!series) {
        noteMissingPriceData(ctx, symbol);
        return null;
      }
      return computeRSI(series.closes, window);
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
      if (!symbol) {
        throw new Error('Metric symbol context missing for moving-average-price');
      }
      const window = Number(getKeyword(options, ':window') || getKeyword(options, 'window') || 20);
      const series = ctx.priceData.get(symbol);
      if (!series) {
        noteMissingPriceData(ctx, symbol);
        return null;
      }
      return computeSMA(series.closes, window);
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
      if (!symbol) {
        throw new Error('Metric symbol context missing for exponential-moving-average-price');
      }
      const window = Number(getKeyword(options, ':window') || getKeyword(options, 'window') || 20);
      const series = ctx.priceData.get(symbol);
      if (!series) {
        noteMissingPriceData(ctx, symbol);
        return null;
      }
      return computeEMA(series.closes, window);
    }
    case 'current-price': {
      const symbolNode = node[1];
      let symbol = ctx.metricSymbol || null;
      if (typeof symbolNode === 'string') {
        symbol = symbolNode.toUpperCase();
      }
      if (!symbol) {
        throw new Error('Metric symbol context missing for current-price');
      }
      const series = ctx.priceData.get(symbol);
      if (!series) {
        noteMissingPriceData(ctx, symbol);
        return null;
      }
      return series.closes[series.closes.length - 1];
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
      if (!symbol) {
        throw new Error('Metric symbol context missing for moving-average-return');
      }
      const window = Number(getKeyword(options, ':window') || getKeyword(options, 'window') || 20);
      const series = ctx.priceData.get(symbol);
      if (!series) {
        noteMissingPriceData(ctx, symbol);
        return null;
      }
      return computeMovingAverageReturn(series.closes, window);
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
      if (!symbol) {
        throw new Error('Metric symbol context missing for cumulative-return');
      }
      const window = Number(getKeyword(options, ':window') || getKeyword(options, 'window') || 20);
      const series = ctx.priceData.get(symbol);
      if (!series) {
        noteMissingPriceData(ctx, symbol);
        return null;
      }
      return computeCumulativeReturn(series.closes, window);
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
      if (!symbol) {
        throw new Error('Metric symbol context missing for stdev-return');
      }
      const window = Number(getKeyword(options, ':window') || getKeyword(options, 'window') || 20);
      const series = ctx.priceData.get(symbol);
      if (!series) {
        noteMissingPriceData(ctx, symbol);
        return null;
      }
      return computeStdDevReturn(series.closes, window);
    }
    case 'max-drawdown': {
      const optionsNode = node[1];
      let symbol = ctx.metricSymbol || null;
      let options = optionsNode && typeof optionsNode === 'object'
        ? optionsNode
        : {};
      if (typeof node[1] === 'string') {
        symbol = node[1].toUpperCase();
        options = node[2] && typeof node[2] === 'object' ? node[2] : {};
      }
      if (!symbol) {
        throw new Error('Metric symbol context missing for max-drawdown');
      }
      const window = Number(getKeyword(options, ':window') || getKeyword(options, 'window') || 30);
      const series = ctx.priceData.get(symbol);
      if (!series) {
        noteMissingPriceData(ctx, symbol);
        return null;
      }
      return computeMaxDrawdown(series.closes, window);
    }
    default:
      throw new Error(`Unsupported expression type ${type}`);
  }
};

const evaluateMetricForSymbol = (metricNode, symbol, ctx) => {
  if (!metricNode) {
    return 0;
  }
  if (typeof metricNode === 'number') {
    return metricNode;
  }
  if (!isArray(metricNode)) {
    return Number(metricNode) || 0;
  }
  const metricCtx = { ...ctx, metricSymbol: symbol };
  const value = evaluateExpression(metricNode, metricCtx);
  return Number.isFinite(value) ? value : null;
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

function evaluateFilterNode(node, parentWeight, ctx) {
  const metricNode = node[1];
  const selectorNode = node[2];
  const assets = node[3] || [];
  const metricSummary = describeMetricNode(metricNode);
  const selectionSummary = describeSelectionNode(selectorNode);
  const assetNodes = assets.filter(isAssetNode);
  const nonAssetNodes = assets.filter((assetNode) => !isAssetNode(assetNode));

  // Fallback: some Composer scripts incorrectly pass higher-level groups into a filter.
  // When that happens there are no tradable tickers to score, so instead of failing we
  // short-circuit the filter and evaluate those children directly with equal weights.
  if (!assetNodes.length && nonAssetNodes.length) {
    if (ctx?.reasoning) {
      ctx.reasoning.push(
        `Filter evaluation: ${metricSummary}. Provided children are not direct assets, so applying a fallback equal-weight allocation across ${nonAssetNodes.length} nested nodes instead of scoring.`
      );
    }
    const fallbackWeight = parentWeight / nonAssetNodes.length;
    const fallbackPositions = nonAssetNodes.flatMap((child) =>
      evaluateNode(child, fallbackWeight, ctx)
    );
    return mergePositions(fallbackPositions);
  }

  const evaluationAssets = assetNodes.length ? assetNodes : assets;
  const scored = evaluationAssets
    .map((assetNode) => {
      const symbol = extractSymbolFromAssetNode(assetNode);
      if (!symbol) {
        return null;
      }
      const value = evaluateMetricForSymbol(metricNode, symbol, ctx);
      if (!Number.isFinite(value)) {
        return null;
      }
      return { symbol, value };
    })
    .filter(Boolean);
  const selected = applySelector(selectorNode, scored);
  if (!selected.length) {
    if (ctx?.reasoning) {
      ctx.reasoning.push(
        `Filter evaluation: ${metricSummary}. No instruments produced a valid score; aborting branch.`
      );
    }
    const missingSymbols = evaluationAssets
      .map((assetNode) => extractSymbolFromAssetNode(assetNode))
      .filter(Boolean)
      .map((symbol) => {
        const reason = ctx?.missingSymbols?.get(symbol);
        return reason ? `${symbol} (${reason})` : symbol;
      });
    throw new Error(
      `Unable to evaluate ${metricSummary} because price/indicator data was missing for: ${missingSymbols.join(
        ', '
      )}.`
    );
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
    const scoreboard = scored.map(({ symbol, value }) => `${symbol}: ${formatValue(value)}`);
    const preview = scoreboard.slice(0, 10).join(', ');
    const extra = scoreboard.length > 10 ? `, … (+${scoreboard.length - 10} more)` : '';
    const winners = selected.map(({ symbol }) => symbol).join(', ') || 'none';
    ctx.reasoning.push(
      `Filter evaluation: ${metricSummary} -> ${preview}${extra}. Applied ${selectionSummary}, selecting ${winners}.`
    );
  }
  const weightEach = parentWeight / selected.length;
  return selected.map((entry) => ({
    symbol: entry.symbol,
    weight: weightEach,
    rationale: `Selected by filter (${Number.isFinite(entry.value) ? entry.value.toFixed(4) : 'n/a'})`,
  }));
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

const loadPriceData = async (symbols = []) => {
  const start = new Date(now().getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const end = now();
  const map = new Map();
  const missing = [];
  await Promise.all(
    symbols.map(async (symbol) => {
      const upper = symbol.toUpperCase();
      try {
        const response = await getCachedPrices({
          symbol: upper,
          startDate: start,
          endDate: end,
        });
        const closes = (response.bars || []).map((bar) => Number(bar.c));
        if (!closes.length) {
          throw new Error('No close prices returned.');
        }
        map.set(upper, {
          closes,
          latest: closes[closes.length - 1],
          bars: response.bars,
        });
      } catch (error) {
        missing.push({
          symbol: upper,
          reason: error?.message || 'Unknown pricing error.',
        });
      }
    })
  );
  return { map, missing };
};

const evaluateDefsymphonyStrategy = async ({ strategyText, budget = 1000 }) => {
  const ast = parseComposerScript(strategyText);
  if (!ast) {
    throw new Error('Failed to parse defsymphony script.');
  }
  const tickers = Array.from(collectTickersFromAst(ast)).sort();
  if (!tickers.length) {
    throw new Error('No tickers found in defsymphony script.');
  }
  const blueprint = buildEvaluationBlueprint(ast) || [];

  const { map: priceData, missing: missingFromCache } = await loadPriceData(tickers);
  const context = {
    priceData,
    missingSymbols: new Map(),
    reasoning: [
      `Step 1: Loaded ${priceData.size} of ${tickers.length} tickers from local Alpaca cache (lookback ${LOOKBACK_DAYS} days).`,
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
    const quantity = Math.max(Math.floor(targetValue / price), 0);
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
        lookbackDays: LOOKBACK_DAYS,
        missingData: context.missingSymbols
          ? Array.from(context.missingSymbols.entries()).map(([symbol, reason]) => ({ symbol, reason }))
          : [],
      },
    },
  };
};

module.exports = {
  evaluateDefsymphonyStrategy,
};
