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
        snapshot.publicHoldingsObject = details?.last_backtest_holdings || null;
        snapshot.lastBacktestValue = details?.last_backtest_value ?? null;
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
      base.publicHoldingsObject = details?.last_backtest_holdings || null;
      base.lastBacktestValue = details?.last_backtest_value ?? null;
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
  fetchComposerLinkSnapshot,
};
