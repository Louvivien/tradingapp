const edn = require('jsedn');

const parseComposerScript = (script) => {
  if (!script || typeof script !== 'string') {
    return null;
  }
  try {
    const parsed = edn.parse(script);
    return edn.toJS(parsed);
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

const collectTickersFromAst = (node, acc = new Set()) => {
  if (!node) {
    return acc;
  }
  if (Array.isArray(node)) {
    if (node[0] === 'asset' && typeof node[1] === 'string') {
      acc.add(node[1]);
    }
    node.forEach((child) => collectTickersFromAst(child, acc));
    return acc;
  }
  if (node && typeof node === 'object') {
    Object.values(node).forEach((value) => collectTickersFromAst(value, acc));
  }
  return acc;
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
};
