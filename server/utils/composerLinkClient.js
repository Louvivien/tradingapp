const Axios = require('axios');

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parseSymphonyIdFromUrl = (url) => {
  try {
    const parsed = new URL(String(url));
    const parts = String(parsed.pathname || '')
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean);
    const idx = parts.findIndex((part) => part === 'symphony');
    if (idx >= 0 && parts[idx + 1]) {
      return parts[idx + 1];
    }
    return null;
  } catch {
    return null;
  }
};

const extractNextDataFromHtml = (html) => {
  if (!html || typeof html !== 'string') {
    return null;
  }
  const match = html.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!match) {
    return null;
  }
  const raw = String(match[1] || '').trim();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const collectDeep = (node, visit) => {
  const stack = [node];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    if (typeof current === 'object') {
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
    }
    visit(current);
    if (Array.isArray(current)) {
      for (const child of current) {
        stack.push(child);
      }
      continue;
    }
    if (isObject(current)) {
      for (const value of Object.values(current)) {
        stack.push(value);
      }
    }
  }
};

const guessStrategyText = (payload) => {
  const candidates = [];
  collectDeep(payload, (node) => {
    if (typeof node !== 'string') {
      return;
    }
    if (!node.includes('(defsymphony')) {
      return;
    }
    candidates.push(node);
  });
  if (!candidates.length) {
    return null;
  }
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
};

const normalizeSymbol = (value) => {
  if (!value) {
    return null;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.toUpperCase();
};

const holdingsObjectToWeights = (holdingsObject) => {
  if (!isObject(holdingsObject)) {
    return null;
  }
  const entries = Object.entries(holdingsObject)
    .map(([rawSymbol, rawValue]) => {
      const symbol = normalizeSymbol(rawSymbol);
      const value = Number(rawValue);
      if (!symbol || !Number.isFinite(value)) {
        return null;
      }
      if (symbol === '$USD' || symbol === 'USD' || symbol === 'CASH') {
        return null;
      }
      if (value <= 0) {
        return null;
      }
      return { symbol, value };
    })
    .filter(Boolean);

  if (!entries.length) {
    return [];
  }
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return [];
  }
  return entries
    .map((entry) => ({
      symbol: entry.symbol,
      weight: entry.value / total,
      raw: entry,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
};

const normalizeWeightsToUnit = (entries) => {
  const weights = entries.map((entry) => entry.weight).filter((w) => Number.isFinite(w));
  if (!weights.length) {
    return entries;
  }
  const total = weights.reduce((acc, w) => acc + w, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return entries;
  }
  const isPercent = total > 1.5 && total <= 100.5;
  if (!isPercent) {
    return entries;
  }
  return entries.map((entry) => ({ ...entry, weight: entry.weight / 100 }));
};

const guessHoldings = (payload) => {
  const symbolKeys = ['symbol', 'ticker', 'asset', 'underlyingSymbol'];
  const weightKeys = ['weight', 'allocation', 'targetWeight', 'percent', 'percentage', 'portion'];
  const candidates = [];

  const scoreArray = (arr) => {
    let score = 0;
    let count = 0;
    for (const item of arr) {
      if (!isObject(item)) {
        continue;
      }
      const symbol = symbolKeys.map((key) => item[key]).find((v) => v != null);
      const weight = weightKeys.map((key) => item[key]).find((v) => v != null);
      const parsedSymbol = normalizeSymbol(symbol);
      const parsedWeight = Number(weight);
      if (parsedSymbol && Number.isFinite(parsedWeight)) {
        count += 1;
        score += 2;
      }
    }
    if (count >= 1) {
      score += Math.min(5, count);
    }
    return { score, count };
  };

  collectDeep(payload, (node) => {
    if (!Array.isArray(node) || node.length < 1) {
      return;
    }
    const { score, count } = scoreArray(node);
    if (score <= 0 || count <= 0) {
      return;
    }
    candidates.push({ score, node });
  });

  if (!candidates.length) {
    return null;
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0].node;
  const parsed = best
    .map((item) => {
      if (!isObject(item)) {
        return null;
      }
      const symbol = symbolKeys.map((key) => item[key]).find((v) => v != null);
      const weight = weightKeys.map((key) => item[key]).find((v) => v != null);
      const parsedSymbol = normalizeSymbol(symbol);
      const parsedWeight = Number(weight);
      if (!parsedSymbol || !Number.isFinite(parsedWeight)) {
        return null;
      }
      return {
        symbol: parsedSymbol,
        weight: parsedWeight,
        raw: item,
      };
    })
    .filter(Boolean);

  if (!parsed.length) {
    return null;
  }
  const normalized = normalizeWeightsToUnit(parsed);
  normalized.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return normalized;
};

const fetchPublicSymphonyDetailsById = async ({ symphonyId }) => {
  if (!symphonyId) {
    throw new Error('Missing symphony id.');
  }
  const url = `https://backtest-api.composer.trade/api/v1/public/symphonies/${encodeURIComponent(symphonyId)}`;
  const response = await Axios.get(url, {
    headers: {
      'User-Agent': 'tradingapp/compareComposerLinkHoldings',
      Accept: 'application/json',
    },
    timeout: 20000,
  });
  return response.data;
};

const fetchPublicSymphonyScoreById = async ({ symphonyId }) => {
  if (!symphonyId) {
    throw new Error('Missing symphony id.');
  }
  const url = `https://backtest-api.composer.trade/api/v1/public/symphonies/${encodeURIComponent(
    symphonyId
  )}/score?score_version=v2`;
  const response = await Axios.get(url, {
    headers: {
      'User-Agent': 'tradingapp/compareComposerLinkHoldings',
      Accept: 'application/json',
    },
    timeout: 20000,
  });
  return response.data;
};

const escapeEdnString = (value) => JSON.stringify(String(value ?? ''));

const formatNumber = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return '0';
  }
  if (Number.isInteger(number)) {
    return String(number);
  }
  const rounded = Number(number.toFixed(12));
  if (Number.isInteger(rounded)) {
    return String(rounded);
  }
  return String(rounded);
};

const extractSymbolFromComposerTicker = (ticker) => {
  const raw = String(ticker ?? '').trim();
  if (!raw) {
    return null;
  }
  const withoutPrefix = raw.includes('::') ? raw.split('::').slice(1).join('::') : raw;
  const withoutSuffix = withoutPrefix.includes('//') ? withoutPrefix.split('//')[0] : withoutPrefix;
  const symbol = withoutSuffix.trim().toUpperCase();
  return symbol || null;
};

const getScoreFnName = (expr) => {
  if (Array.isArray(expr) && typeof expr[0] === 'string') {
    return expr[0];
  }
  return null;
};

const isPercentLikeFn = (fnName) =>
  fnName === 'fn_relative_strength_index' ||
  fnName === 'fn_cumulative_return' ||
  fnName === 'fn_max_drawdown';

const normalizePercentConstant = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return numeric;
  }
  const scaled = numeric * 100;
  const rounded = Number(scaled.toFixed(12));
  return rounded;
};

const convertScoreExpression = (expr) => {
  if (expr == null) {
    return 'nil';
  }
  if (typeof expr === 'number') {
    return formatNumber(expr);
  }
  if (typeof expr === 'string') {
    const symbol = extractSymbolFromComposerTicker(expr);
    if (symbol) {
      return escapeEdnString(symbol);
    }
    return escapeEdnString(expr);
  }
  if (!Array.isArray(expr) || !expr.length) {
    throw new Error(`Unsupported score expression: ${JSON.stringify(expr)}`);
  }

  const fn = expr[0];
  const args = expr.slice(1);

  switch (fn) {
    case 'fn_constant': {
      return formatNumber(args[0]);
    }
    case 'metric_close': {
      const symbol = extractSymbolFromComposerTicker(args[0]);
      if (!symbol) {
        throw new Error(`Unable to parse metric_close symbol from: ${JSON.stringify(expr)}`);
      }
      return `(current-price ${escapeEdnString(symbol)})`;
    }
    case 'fn_relative_strength_index': {
      const symbol = extractSymbolFromComposerTicker(args[0]?.[1] ?? args[0]);
      const window = Number(args[1]);
      if (!symbol || !Number.isFinite(window)) {
        throw new Error(`Unable to parse RSI expression: ${JSON.stringify(expr)}`);
      }
      return `(rsi ${escapeEdnString(symbol)} {:window ${formatNumber(window)}})`;
    }
    case 'fn_cumulative_return': {
      const symbol = extractSymbolFromComposerTicker(args[0]?.[1] ?? args[0]);
      const window = Number(args[1]);
      if (!symbol || !Number.isFinite(window)) {
        throw new Error(`Unable to parse cumulative return expression: ${JSON.stringify(expr)}`);
      }
      return `(cumulative-return ${escapeEdnString(symbol)} {:window ${formatNumber(window)}})`;
    }
    case 'fn_max_drawdown': {
      const symbol = extractSymbolFromComposerTicker(args[0]?.[1] ?? args[0]);
      const window = Number(args[1]);
      if (!symbol || !Number.isFinite(window)) {
        throw new Error(`Unable to parse max drawdown expression: ${JSON.stringify(expr)}`);
      }
      return `(max-drawdown ${escapeEdnString(symbol)} {:window ${formatNumber(window)}})`;
    }
    case 'fn_simple_moving_average': {
      const symbol = extractSymbolFromComposerTicker(args[0]?.[1] ?? args[0]);
      const window = Number(args[1]);
      if (!symbol || !Number.isFinite(window)) {
        throw new Error(`Unable to parse moving average expression: ${JSON.stringify(expr)}`);
      }
      return `(moving-average-price ${escapeEdnString(symbol)} {:window ${formatNumber(window)}})`;
    }
    case 'fn_exponential_moving_average': {
      const symbol = extractSymbolFromComposerTicker(args[0]?.[1] ?? args[0]);
      const window = Number(args[1]);
      if (!symbol || !Number.isFinite(window)) {
        throw new Error(`Unable to parse exponential moving average expression: ${JSON.stringify(expr)}`);
      }
      return `(exponential-moving-average-price ${escapeEdnString(symbol)} {:window ${formatNumber(window)}})`;
    }
    case 'fn_lt':
    case 'fn_gt':
    case 'fn_lte':
    case 'fn_gte':
    case 'fn_eq': {
      const operator = {
        fn_lt: '<',
        fn_gt: '>',
        fn_lte: '<=',
        fn_gte: '>=',
        fn_eq: '=',
      }[fn];
      const left = args[0];
      const right = args[1];
      const leftFn = getScoreFnName(left);
      const rightFn = getScoreFnName(right);

      const normalizeConstSide = (sideExpr, otherFnName) => {
        if (!Array.isArray(sideExpr) || sideExpr[0] !== 'fn_constant') {
          return convertScoreExpression(sideExpr);
        }
        const rawValue = sideExpr[1];
        const scaledValue = isPercentLikeFn(otherFnName) ? normalizePercentConstant(rawValue) : rawValue;
        return formatNumber(scaledValue);
      };

      const leftConverted = normalizeConstSide(left, rightFn);
      const rightConverted = normalizeConstSide(right, leftFn);

      return `(${operator} ${leftConverted} ${rightConverted})`;
    }
    default: {
      throw new Error(`Unsupported score function: ${fn}`);
    }
  }
};

const convertScoreMetric = (expr) => {
  if (!Array.isArray(expr) || !expr.length) {
    throw new Error(`Unsupported score metric: ${JSON.stringify(expr)}`);
  }
  const fn = expr[0];
  const args = expr.slice(1);

  switch (fn) {
    case 'fn_relative_strength_index': {
      const window = Number(args[1]);
      if (!Number.isFinite(window)) {
        throw new Error(`Unable to parse RSI metric: ${JSON.stringify(expr)}`);
      }
      return `(rsi {:window ${formatNumber(window)}})`;
    }
    case 'fn_cumulative_return': {
      const window = Number(args[1]);
      if (!Number.isFinite(window)) {
        throw new Error(`Unable to parse cumulative return metric: ${JSON.stringify(expr)}`);
      }
      return `(cumulative-return {:window ${formatNumber(window)}})`;
    }
    case 'fn_max_drawdown': {
      const window = Number(args[1]);
      if (!Number.isFinite(window)) {
        throw new Error(`Unable to parse max drawdown metric: ${JSON.stringify(expr)}`);
      }
      return `(max-drawdown {:window ${formatNumber(window)}})`;
    }
    case 'fn_simple_moving_average': {
      const window = Number(args[1]?.[2] ?? args[1]);
      const maybeWindow = Number(args[1] ?? args[2]);
      const resolvedWindow = Number.isFinite(window) ? window : maybeWindow;
      if (!Number.isFinite(resolvedWindow)) {
        throw new Error(`Unable to parse moving average return metric: ${JSON.stringify(expr)}`);
      }
      return `(moving-average-return {:window ${formatNumber(resolvedWindow)}})`;
    }
    case 'fn_standard_deviation': {
      const window = Number(args[1]?.[2] ?? args[1]);
      const maybeWindow = Number(args[1] ?? args[2]);
      const resolvedWindow = Number.isFinite(window) ? window : maybeWindow;
      if (!Number.isFinite(resolvedWindow)) {
        throw new Error(`Unable to parse stdev return metric: ${JSON.stringify(expr)}`);
      }
      return `(stdev-return {:window ${formatNumber(resolvedWindow)}})`;
    }
    default: {
      throw new Error(`Unsupported score metric function: ${fn}`);
    }
  }
};

const convertScoreNode = (node) => {
  if (!isObject(node)) {
    throw new Error(`Invalid score node: ${JSON.stringify(node)}`);
  }

  switch (node.type) {
    case 'node_asset': {
      const symbol = extractSymbolFromComposerTicker(node.ticker);
      if (!symbol) {
        throw new Error(`Unable to parse asset ticker: ${JSON.stringify(node.ticker)}`);
      }
      const name = node?.meta?.name;
      if (name) {
        return `(asset ${escapeEdnString(symbol)} ${escapeEdnString(name)})`;
      }
      return `(asset ${escapeEdnString(symbol)})`;
    }
    case 'node_filter': {
      const rawSortFn = node.sort_fn;
      const sortFn =
        Array.isArray(rawSortFn) && rawSortFn[0] === 'weight_every_fn' ? rawSortFn[1] : rawSortFn;
      const metric = convertScoreMetric(sortFn);
      const direction = String(node.direction || '').trim().toLowerCase();
      const takeCount = Number(node.take_count);
      if (!Number.isFinite(takeCount) || takeCount <= 0) {
        throw new Error(`Invalid filter take_count: ${JSON.stringify(node.take_count)}`);
      }
      const selector = direction === 'asc' ? 'select-bottom' : 'select-top';
      const children = Array.isArray(node.children) ? node.children : [];
      const convertedChildren = children.map(convertScoreNode).join(' ');
      return `(filter ${metric} (${selector} ${formatNumber(takeCount)}) [${convertedChildren}])`;
    }
    case 'node_if': {
      const condition = convertScoreExpression(node.condition);
      const thenChildren = Array.isArray(node.then_children) ? node.then_children : [];
      const elseChildren = Array.isArray(node.else_children) ? node.else_children : [];
      const thenExpr = thenChildren.map(convertScoreNode).join(' ');
      const elseExpr = elseChildren.map(convertScoreNode).join(' ');
      return `(if ${condition} [${thenExpr}] [${elseExpr}])`;
    }
    case 'node_weight': {
      const weight = node.weight;
      const weightType = Array.isArray(weight) ? weight[0] : null;
      const children = Array.isArray(node.children) ? node.children : [];

      let rendered = null;
      if (weightType === 'weight_equal') {
        const inner = children.map(convertScoreNode).join(' ');
        rendered = `(weight-equal [${inner}])`;
      } else if (weightType === 'weight_constants') {
        const constants = Array.isArray(weight[1]) ? weight[1] : [];
        if (constants.length !== children.length) {
          throw new Error(
            `Weight constants length mismatch (weights=${constants.length}, children=${children.length}).`
          );
        }
        const pairs = children
          .map((child, idx) => `${formatNumber(constants[idx])} ${convertScoreNode(child)}`)
          .join(' ');
        rendered = `(weight-specified ${pairs})`;
      } else if (weightType === 'weight_every_fn') {
        const weightFn = weight[1];
        const fnName = getScoreFnName(weightFn);
        if (fnName !== 'fn_inverse_volatility') {
          throw new Error(`Unsupported weight function: ${JSON.stringify(weightFn)}`);
        }
        const window = Number(weightFn?.[2]);
        if (!Number.isFinite(window) || window <= 0) {
          throw new Error(`Invalid inverse volatility window: ${JSON.stringify(weightFn?.[2])}`);
        }
        const inner = children.map(convertScoreNode).join(' ');
        rendered = `(weight-inverse-volatility ${formatNumber(window)} [${inner}])`;
      } else {
        throw new Error(`Unsupported weight node type: ${JSON.stringify(weight)}`);
      }

      const label = String(node?.meta?.name || '').trim();
      if (label) {
        return `(group ${escapeEdnString(label)} [${rendered}])`;
      }
      return rendered;
    }
    case 'node_root': {
      const children = Array.isArray(node.children) ? node.children : [];
      if (!children.length) {
        return `(weight-equal [])`;
      }
      if (children.length === 1) {
        return convertScoreNode(children[0]);
      }
      const inner = children.map(convertScoreNode).join(' ');
      return `(weight-equal [${inner}])`;
    }
    default: {
      throw new Error(`Unsupported score node type: ${node.type}`);
    }
  }
};

const scoreTreeToStrategyText = (scoreTree) => {
  if (!isObject(scoreTree) || scoreTree.type !== 'node_root') {
    throw new Error('Invalid score tree payload.');
  }

  const name = scoreTree?.meta?.name || 'Composer Symphony';
  const assetClass = scoreTree.asset_class || 'EQUITIES';
  const rebalance = String(scoreTree.rebalance || '').trim().toLowerCase();

  const options = [`:asset-class ${escapeEdnString(assetClass)}`];
  if (rebalance === 'daily') {
    options.push(`:rebalance-frequency :daily`);
  } else if (rebalance === 'threshold') {
    options.push(`:rebalance-threshold ${formatNumber(scoreTree.rebalance_corridor_width)}`);
  } else if (rebalance) {
    options.push(`:rebalance-frequency ${escapeEdnString(rebalance)}`);
  }

  const body = convertScoreNode(scoreTree);
  return `(defsymphony ${escapeEdnString(name)} {${options.join(', ')}} ${body})`;
};

const guessEffectiveAsOfDateKey = (payload) => {
  const dateKeys = ['asOf', 'asOfDate', 'effectiveDate', 'date', 'holdingDate', 'rebalanceDate'];
  const candidates = [];
  const looksLikeDateKey = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());

  collectDeep(payload, (node) => {
    if (!isObject(node)) {
      return;
    }
    for (const key of dateKeys) {
      const value = node[key];
      if (looksLikeDateKey(value)) {
        candidates.push(String(value).trim());
      }
    }
  });

  if (!candidates.length) {
    return null;
  }
  candidates.sort();
  return candidates[candidates.length - 1];
};

const fetchComposerLinkSnapshot = async ({ url }) => {
  if (!url) {
    throw new Error('Missing Composer symphony URL.');
  }
  const symphonyId = parseSymphonyIdFromUrl(url);
  const response = await Axios.get(url, {
    headers: {
      'User-Agent': 'tradingapp/compareComposerLinkHoldings',
      Accept: 'text/html,application/json',
    },
    timeout: 20000,
    maxRedirects: 5,
  });
  const contentType = String(response.headers?.['content-type'] || '');
  if (contentType.includes('application/json') && typeof response.data === 'object') {
    const payload = response.data;
    const snapshot = {
      raw: payload,
      strategyText: guessStrategyText(payload),
      holdings: guessHoldings(payload),
      effectiveAsOfDateKey: guessEffectiveAsOfDateKey(payload),
    };
    if (!snapshot.holdings && symphonyId) {
      try {
        const details = await fetchPublicSymphonyDetailsById({ symphonyId });
        snapshot.raw = snapshot.raw || details;
        snapshot.holdings = holdingsObjectToWeights(details?.last_backtest_holdings) || snapshot.holdings;
        snapshot.effectiveAsOfDateKey =
          details?.last_backtest_last_market_day || snapshot.effectiveAsOfDateKey;
        snapshot.name = details?.name || snapshot.name;
        snapshot.publicHoldingsObject = details?.last_backtest_holdings || null;
        snapshot.lastBacktestValue = details?.last_backtest_value ?? null;
      } catch {
        // ignore and return best-effort snapshot
      }
    }
    if (!snapshot.strategyText && symphonyId) {
      try {
        const score = await fetchPublicSymphonyScoreById({ symphonyId });
        snapshot.strategyText = scoreTreeToStrategyText(score);
        snapshot.name = score?.meta?.name || snapshot.name;
        snapshot.id = symphonyId;
      } catch {
        // ignore and return best-effort snapshot
      }
    }
    return snapshot;
  }
  const html = typeof response.data === 'string' ? response.data : String(response.data || '');
  const nextData = extractNextDataFromHtml(html);
  const base = nextData
    ? {
        raw: nextData,
        strategyText: guessStrategyText(nextData),
        holdings: guessHoldings(nextData),
        effectiveAsOfDateKey: guessEffectiveAsOfDateKey(nextData),
      }
    : {
        raw: null,
        strategyText: null,
        holdings: null,
        effectiveAsOfDateKey: null,
      };

  if ((!base.holdings || !base.holdings.length) && symphonyId) {
    try {
      const details = await fetchPublicSymphonyDetailsById({ symphonyId });
      base.raw = base.raw || details;
      base.holdings = holdingsObjectToWeights(details?.last_backtest_holdings) || base.holdings;
      base.effectiveAsOfDateKey = details?.last_backtest_last_market_day || base.effectiveAsOfDateKey;
      base.name = details?.name || base.name;
      base.publicHoldingsObject = details?.last_backtest_holdings || null;
      base.lastBacktestValue = details?.last_backtest_value ?? null;
    } catch {
      // ignore and return best-effort snapshot
    }
  }

  if (!base.strategyText && symphonyId) {
    try {
      const score = await fetchPublicSymphonyScoreById({ symphonyId });
      base.strategyText = scoreTreeToStrategyText(score);
      base.name = score?.meta?.name || base.name;
      base.id = symphonyId;
    } catch {
      // ignore and return best-effort snapshot
    }
  }

  return base;
};

module.exports = {
  extractNextDataFromHtml,
  parseSymphonyIdFromUrl,
  guessStrategyText,
  guessHoldings,
  holdingsObjectToWeights,
  guessEffectiveAsOfDateKey,
  fetchPublicSymphonyDetailsById,
  fetchPublicSymphonyScoreById,
  scoreTreeToStrategyText,
  fetchComposerLinkSnapshot,
};
