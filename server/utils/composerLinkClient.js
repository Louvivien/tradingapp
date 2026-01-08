const Axios = require('axios');

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

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
    return {
      raw: payload,
      strategyText: guessStrategyText(payload),
      holdings: guessHoldings(payload),
      effectiveAsOfDateKey: guessEffectiveAsOfDateKey(payload),
    };
  }
  const html = typeof response.data === 'string' ? response.data : String(response.data || '');
  const nextData = extractNextDataFromHtml(html);
  if (!nextData) {
    return {
      raw: null,
      strategyText: null,
      holdings: null,
      effectiveAsOfDateKey: null,
    };
  }
  return {
    raw: nextData,
    strategyText: guessStrategyText(nextData),
    holdings: guessHoldings(nextData),
    effectiveAsOfDateKey: guessEffectiveAsOfDateKey(nextData),
  };
};

module.exports = {
  extractNextDataFromHtml,
  guessStrategyText,
  guessHoldings,
  guessEffectiveAsOfDateKey,
  fetchComposerLinkSnapshot,
};

