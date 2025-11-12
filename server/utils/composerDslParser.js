const edn = require('jsedn');

const COMPARATOR_ENCODE = {
  '<=': '__composer_lte__',
  '>=': '__composer_gte__',
  '<': '__composer_lt__',
  '>': '__composer_gt__',
  '=': '__composer_eq__',
};

const COMPARATOR_DECODE = Object.entries(COMPARATOR_ENCODE).reduce(
  (acc, [symbol, placeholder]) => {
    acc[placeholder] = symbol;
    return acc;
  },
  {}
);

const comparatorPattern = /(^|[\s([\{])([<>]=?|=)/g;

const encodeComparators = (script) =>
  script.replace(comparatorPattern, (match, prefix, symbol) => {
    const replacement = COMPARATOR_ENCODE[symbol];
    if (!replacement) {
      return match;
    }
    return `${prefix}${replacement}`;
  });

const restoreComparators = (node) => {
  if (Array.isArray(node)) {
    return node.map((entry) => restoreComparators(entry));
  }
  if (node && typeof node === 'object') {
    const restored = {};
    Object.entries(node).forEach(([key, value]) => {
      const decodedKey = COMPARATOR_DECODE[key] || key;
      restored[decodedKey] = restoreComparators(value);
    });
    return restored;
  }
  if (typeof node === 'string' && COMPARATOR_DECODE[node]) {
    return COMPARATOR_DECODE[node];
  }
  return node;
};

const normalizeVectorSpacing = (script) =>
  script.replace(/\[\(/g, '[ (');

const parseComposerScript = (script) => {
  if (!script || typeof script !== 'string') {
    return null;
  }
  try {
    const spaced = normalizeVectorSpacing(script);
    const encoded = encodeComparators(spaced);
    const parsed = edn.parse(encoded);
    const jsValue = edn.toJS(parsed);
    return restoreComparators(jsValue);
  } catch (error) {
    return null;
  }
};

const normalizeKeyword = (value) => {
  if (typeof value !== 'string') {
    return value;
  }
  return value.startsWith(':') ? value.slice(1) : value;
};

const RESERVED_TICKER_TOKENS = new Set([
  'EQUITIES',
  'OPTIONS',
  'FUTURES',
  'CRYPTO',
  'FOREX',
]);

const isTickerLike = (value) => {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (RESERVED_TICKER_TOKENS.has(trimmed.toUpperCase())) {
    return false;
  }
  // Most supported tickers (stocks, ETFs, ETNs) are <=6 characters; longer strings like "EQUITIES"
  // are usually metadata (e.g., asset-class descriptors) and should not be treated as tickers.
  return /^[A-Z][A-Z0-9.\-]{0,5}$/.test(trimmed);
};

const addTicker = (acc, value) => {
  if (!value) {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  acc.add(trimmed.toUpperCase());
};

const collectTickersFromAst = (node, acc = new Set()) => {
  if (!node) {
    return acc;
  }
  if (Array.isArray(node)) {
    if (node[0] === 'asset' && typeof node[1] === 'string') {
      addTicker(acc, node[1]);
    }
    node.forEach((child) => collectTickersFromAst(child, acc));
    return acc;
  }
  if (typeof node === 'string' && isTickerLike(node)) {
    addTicker(acc, node);
    return acc;
  }
  if (node && typeof node === 'object') {
    Object.values(node).forEach((value) => collectTickersFromAst(value, acc));
  }
  return acc;
};

const formatSymbol = (symbol) => {
  if (!symbol || typeof symbol !== 'string') {
    return 'the selected instrument';
  }
  return symbol.trim().toUpperCase();
};

const extractWindow = (options) => {
  if (!options || typeof options !== 'object') {
    return null;
  }
  return options[':window'] ?? options.window ?? null;
};

const describeMetricNode = (node) => {
  if (!Array.isArray(node) || typeof node[0] !== 'string') {
    return 'specified metric';
  }
  const name = node[0];
  const options = node[1] && typeof node[1] === 'object' ? node[1] : null;
  const window = options ? options[':window'] ?? options.window : null;
  switch (name) {
    case 'moving-average-return':
      return window ? `${window}-day moving average of daily returns` : 'moving average return';
    case 'stdev-return':
    case 'stdev-return%':
      return window ? `${window}-day standard deviation of daily returns` : 'return volatility';
    case 'momentum':
      return window ? `${window}-day momentum` : 'momentum score';
    default: {
      if (!options) {
        return name.replace(/-/g, ' ');
      }
      const optionPairs = Object.entries(options)
        .map(([key, value]) => `${normalizeKeyword(key)}=${value}`)
        .join(', ');
      return `${name.replace(/-/g, ' ')} (${optionPairs})`;
    }
  }
};

const describeSelectionNode = (node) => {
  if (!Array.isArray(node) || typeof node[0] !== 'string') {
    return 'apply selection criteria';
  }
  const name = node[0];
  const count = node[1];
  switch (name) {
    case 'select-top':
      return Number.isFinite(count)
        ? `select the top ${count} instruments by this metric`
        : 'select the top performers by this metric';
    case 'select-bottom':
      return Number.isFinite(count)
        ? `select the bottom ${count} instruments by this metric`
        : 'select the weakest performers by this metric';
    default:
      return name.replace(/-/g, ' ');
  }
};

const describeFilterNode = (node) => {
  if (!Array.isArray(node) || node[0] !== 'filter') {
    return null;
  }
  const metricNode = node[1];
  const selectionNode = node[2];
  const universeNode = node[3];
  const tickers = Array.isArray(universeNode)
    ? universeNode
        .map((item) => (Array.isArray(item) && item[0] === 'asset' ? item[1] : null))
        .filter(Boolean)
    : [];
  const metricDescription = describeMetricNode(metricNode);
  const selectionDescription = describeSelectionNode(selectionNode);
  const tickerText = tickers.length ? ` across tickers ${tickers.join(', ')}` : '';
  return `Compute the ${metricDescription}${tickerText}, then ${selectionDescription}.`;
};

const describeIndicatorExpression = (type, symbol, options = {}) => {
  const window = extractWindow(options);
  const windowText = window ? `${window}-day ` : '';
  const symbolText = formatSymbol(symbol);
  switch (type) {
    case 'rsi':
      return `${windowText || ''}RSI of ${symbolText}`.trim();
    case 'moving-average-price':
      return `${windowText || ''}moving average price of ${symbolText}`.trim();
    case 'exponential-moving-average-price':
      return `${windowText || ''}exponential moving average price of ${symbolText}`.trim();
    case 'moving-average-return':
      return `${windowText || ''}moving average return of ${symbolText}`.trim();
    case 'stdev-return':
    case 'stdev-return%':
      return `${windowText || ''}return volatility of ${symbolText}`.trim();
    case 'momentum':
      return `${windowText || ''}momentum of ${symbolText}`.trim();
    case 'current-price':
      return `current price of ${symbolText}`;
    case 'max-drawdown':
      return `${windowText || ''}max drawdown of ${symbolText}`.trim();
    default:
      return `${type.replace(/-/g, ' ')} of ${symbolText}`;
  }
};

const describeExpression = (node) => {
  if (node == null) {
    return 'value';
  }
  if (typeof node === 'number') {
    return node.toString();
  }
  if (typeof node === 'string') {
    return /^[A-Z][A-Z0-9.\-]{0,9}$/i.test(node)
      ? node.toUpperCase()
      : node;
  }
  if (!Array.isArray(node) || !node.length) {
    return JSON.stringify(node);
  }
  const head = node[0];
  if (['<', '>', '<=', '>=', '=', '=='].includes(head)) {
    const left = describeExpression(node[1]);
    const right = describeExpression(node[2]);
    const operator = head === '==' ? '=' : head;
    return `${left} ${operator} ${right}`;
  }
  if (
    [
      'rsi',
      'moving-average-price',
      'exponential-moving-average-price',
      'moving-average-return',
      'stdev-return',
      'stdev-return%',
      'momentum',
      'current-price',
      'max-drawdown',
    ].includes(head)
  ) {
    let symbol = null;
    let options = {};
    if (typeof node[1] === 'string') {
      symbol = node[1];
      options = node[2] && typeof node[2] === 'object' ? node[2] : {};
    } else if (node[1] && typeof node[1] === 'object' && !Array.isArray(node[1])) {
      options = node[1];
    }
    return describeIndicatorExpression(head, symbol, options);
  }
  return `${head.replace(/-/g, ' ')} expression`;
};

const describeCondition = (node) => {
  if (!Array.isArray(node)) {
    return describeExpression(node);
  }
  const head = node[0];
  if (['<', '>', '<=', '>=', '=', '=='].includes(head)) {
    const left = describeExpression(node[1]);
    const right = describeExpression(node[2]);
    const operatorWord = {
      '<': 'less than',
      '>': 'greater than',
      '<=': 'less than or equal to',
      '>=': 'greater than or equal to',
      '=': 'equal to',
      '==': 'equal to',
    }[head] || head;
    return `${left} ${operatorWord} ${right}`;
  }
  if (head === 'not') {
    return `NOT (${describeCondition(node[1])})`;
  }
  return describeExpression(node);
};

const describeOptions = (options) => {
  if (!options || typeof options !== 'object') {
    return null;
  }
  const entries = Object.entries(options).map(([key, value]) => {
    const normalizedKey = normalizeKeyword(key);
    const normalizedValue = typeof value === 'string' ? normalizeKeyword(value) : value;
    return `${normalizedKey}: ${normalizedValue}`;
  });
  return entries.length ? entries.join(', ') : null;
};

const buildEvaluationBlueprint = (node, context = { steps: [] }) => {
  if (!node) {
    return context.steps;
  }

  if (Array.isArray(node) && typeof node[0] === 'string') {
    const head = node[0];

    switch (head) {
      case 'defsymphony': {
        const name = node[1];
        const options = node[2];
        const optionSummary = describeOptions(options);
        const strategyLine = `Interpret Composer strategy "${name}"${optionSummary ? ` (${optionSummary})` : ''}.`;
        context.steps.push(strategyLine);
        const body = node[3];
        buildEvaluationBlueprint(body, context);
        return context.steps;
      }
      case 'group': {
        const groupName = node[1];
        context.steps.push(`Enter group "${groupName}" and evaluate the nested instructions.`);
        const nextNodes = node.slice(2).flat();
        nextNodes.forEach((child) => buildEvaluationBlueprint(child, context));
        return context.steps;
      }
      case 'weight-equal': {
        const block = node[1];
        const blockArray = Array.isArray(block) ? block : [];
        const blockCount = blockArray.filter((child) => Array.isArray(child)).length;
        context.steps.push(
          `Apply weight-equal to distribute equal weights across the ${blockCount || 'nested'} resulting allocations.`
        );
        blockArray.forEach((child) => buildEvaluationBlueprint(child, context));
        return context.steps;
      }
      case 'filter': {
        const filterDescription = describeFilterNode(node);
        if (filterDescription) {
          context.steps.push(filterDescription);
        } else {
          context.steps.push('Apply filter operation as defined by the script.');
        }
        node.slice(1).forEach((child) => buildEvaluationBlueprint(child, context));
        return context.steps;
      }
      case 'if': {
        const conditionDescription = describeCondition(node[1]);
        context.steps.push(`Conditional branch: ${conditionDescription}.`);
        const trueBranch = node[2];
        buildEvaluationBlueprint(trueBranch, context);
        return context.steps;
      }
      default: {
        node.slice(1).forEach((child) => buildEvaluationBlueprint(child, context));
        return context.steps;
      }
    }
  }

  if (Array.isArray(node)) {
    node.forEach((child) => buildEvaluationBlueprint(child, context));
  } else if (node && typeof node === 'object') {
    Object.values(node).forEach((value) => buildEvaluationBlueprint(value, context));
  }

  return context.steps;
};

module.exports = {
  parseComposerScript,
  collectTickersFromAst,
  buildEvaluationBlueprint,
  describeMetricNode,
  describeSelectionNode,
  describeFilterNode,
  describeExpression,
  describeCondition,
};
