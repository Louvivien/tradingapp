const User = require("../models/userModel");
const Strategy = require("../models/strategyModel");
const Portfolio = require("../models/portfolioModel");
const StrategyLog = require("../models/strategyLogModel");
const StrategyTemplate = require('../models/strategyTemplateModel');
const StrategyEquitySnapshot = require('../models/strategyEquitySnapshotModel');
const MaintenanceTask = require('../models/maintenanceTaskModel');
const News = require("../models/newsModel");
const { getAlpacaConfig } = require("../config/alpacaConfig");
const Alpaca = require('@alpacahq/alpaca-trade-api');
const axios = require("axios");
const moment = require('moment');
const crypto = require('crypto');
const CryptoJS = require('crypto-js');
const jwt = require('jsonwebtoken');
const extractGPT = require("../utils/ChatGPTplugins");
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { distance } = require('fastest-levenshtein');
const Axios = require("axios");
const { normalizeRecurrence, computeNextRebalanceAt } = require('../utils/recurrence');
const { recordStrategyLog } = require('../services/strategyLogger');
const { runComposerStrategy } = require('../utils/openaiComposerStrategy');
const {
  rebalanceNow,
  isRebalanceLocked,
  fetchNextMarketSessionAfter,
  alignToRebalanceWindowStart,
} = require('../services/rebalanceService');
const { syncPolymarketPortfolio, isValidHexAddress } = require('../services/polymarketCopyService');
const { getPolymarketBalanceAllowance: fetchPolymarketBalanceAllowance } = require('../services/polymarketExecutionService');
const { runEquityBackfill, TASK_NAME: EQUITY_BACKFILL_TASK } = require('../services/equityBackfillService');
const {
  addSubscriber,
  removeSubscriber,
  publishProgress,
  completeProgress,
} = require('../utils/progressBus');
	const { fetchComposerLinkSnapshot, fetchPublicSymphonyBacktestById, parseSymphonyIdFromUrl } = require('../utils/composerLinkClient');
	const { computeComposerHoldingsWeights } = require('../utils/composerHoldingsWeights');
	const { compareComposerStrategySemantics } = require('../utils/composerStrategySemantics');

const RECURRENCE_LABELS = {
  every_minute: 'Every minute',
  every_5_minutes: 'Every 5 minutes',
  every_15_minutes: 'Every 15 minutes',
  hourly: 'Hourly',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

const VALID_RECURRENCES = new Set(['every_minute','every_5_minutes','every_15_minutes','hourly','daily','weekly','monthly']);

const parseOptionalHttpUrl = (value) => {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (error) {
    throw new Error('Please provide a valid Symphony URL (including https://).');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Please provide a valid Symphony URL (http or https).');
  }
  return parsed.toString();
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

const stripEvaluatorShareEstimates = (summary) => {
  if (typeof summary !== 'string' || !summary) {
    return summary;
  }
  return summary.replace(/\(\s*[-+]?\d*\.?\d+\s+shares,\s*/gi, '(');
};

const roundToTwo = (value) => {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.round((value + Number.EPSILON) * 100) / 100;
};

const mapDecisionRationales = (decisions = []) => {
  const rationaleMap = new Map();
  decisions.forEach((decision) => {
    const symbol = sanitizeSymbol(
      decision?.['Asset ticker']
        || decision?.symbol
        || decision?.ticker
        || decision?.Ticker
    );
    if (!symbol) {
      return;
    }
    const rationale =
      decision?.Rationale
      || decision?.rationale
      || decision?.reason
      || decision?.explanation
      || '';
    if (rationale) {
      rationaleMap.set(symbol, rationale.trim());
    }
  });
  return rationaleMap;
};

const extractTickersFromScript = (script) => {
  if (!script || typeof script !== 'string') {
    return [];
  }
  const tickers = new Set();
  const assetRegex = /\(asset\s+"([A-Z][A-Z0-9\.]{0,9})"\s+"[^"]*"\)/g;
  let match;
  while ((match = assetRegex.exec(script)) !== null) {
    tickers.add(match[1]);
  }
  if (!tickers.size) {
    // Fallback: look for quoted tickers (all caps, <=6 chars) not immediately preceded by letters
    const genericRegex = /"([A-Z]{2,10}(?:\.[A-Z0-9]{1,4})?)"/g;
    while ((match = genericRegex.exec(script)) !== null) {
      const candidate = match[1];
      if (/^[A-Z]{1,6}(?:\.[A-Z0-9]{1,4})?$/.test(candidate)) {
        tickers.add(candidate);
      }
    }
  }
  return Array.from(tickers);
};

const buildFallbackFromRawStrategy = (strategyText) => {
  const tickers = extractTickersFromScript(strategyText);
  if (!tickers.length) {
    return null;
  }
  const weight = 1 / tickers.length;
  const positions = tickers.map((ticker) => ({
    symbol: ticker,
    targetWeight: weight,
    targetQuantity: null,
    targetValue: null,
  }));
  const decisions = tickers.map((ticker) => ({
    symbol: ticker,
    Rationale: 'Allocated via fallback parser; original script requires runtime filters so an equal-weight plan is used.',
  }));
  const summary = `Fallback allocation: equal-weight exposure across ${tickers.length} tickers parsed from the provided strategy script.`;
  return { positions, decisions, summary };
};

const upsertStrategyTemplate = async ({
  userId,
  name,
  strategyText,
  summary,
  decisions,
  recurrence,
  symphonyUrl = null,
  strategyId = null,
}) => {
  try {
    if (!userId || !name || !strategyText) {
      return null;
    }
    const normalizedRecurrence = normalizeRecurrence(recurrence);
    const normalizedSymphonyUrl = (() => {
      try {
        return parseOptionalHttpUrl(symphonyUrl) ?? null;
      } catch (error) {
        return null;
      }
    })();
    return await StrategyTemplate.findOneAndUpdate(
      { userId: String(userId), name },
      {
        userId: String(userId),
        name,
        strategy: strategyText,
        summary: summary || '',
        decisions: Array.isArray(decisions) ? decisions : [],
        recurrence: normalizedRecurrence,
        strategyId: strategyId || null,
        symphonyUrl: normalizedSymphonyUrl,
        lastUsedAt: new Date(),
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );
  } catch (error) {
    console.warn('[StrategyTemplate] Failed to save template:', error.message);
    return null;
  }
};

const validateAlpacaTradableSymbols = async (alpacaConfig, symbols = []) => {
  if (!alpacaConfig?.getTradingKeys || !Array.isArray(symbols) || !symbols.length) {
    return { tradable: [], invalid: [], fractionableBySymbol: {} };
  }

  const tradingKeys = alpacaConfig.getTradingKeys();
  if (!tradingKeys?.client || !tradingKeys?.apiUrl || !tradingKeys?.keyId || !tradingKeys?.secretKey) {
    return { tradable: [], invalid: [], fractionableBySymbol: {} };
  }

  const uniqueSymbols = Array.from(
    new Set(
      symbols
        .map((symbol) => (typeof symbol === 'string' ? symbol.trim().toUpperCase() : null))
        .filter(Boolean)
    )
  );

  if (!uniqueSymbols.length) {
    return { tradable: [], invalid: [], fractionableBySymbol: {} };
  }

  const tradable = [];
  const invalid = [];
  const fractionableBySymbol = {};

  await Promise.all(
    uniqueSymbols.map(async (symbol) => {
      try {
        const { data } = await tradingKeys.client.get(
          `${tradingKeys.apiUrl}/v2/assets/${encodeURIComponent(symbol)}`,
          {
            headers: {
              'APCA-API-KEY-ID': tradingKeys.keyId,
              'APCA-API-SECRET-KEY': tradingKeys.secretKey,
            },
          }
        );

        const assetStatus = (data?.status || '').toLowerCase();
        const isTradable = data?.tradable !== false && (assetStatus === '' || assetStatus === 'active');
        if (isTradable) {
          tradable.push(symbol);
          fractionableBySymbol[symbol] = Boolean(data?.fractionable);
        } else {
          console.warn(`[AlpacaValidation] ${symbol} is not tradable (status: ${data?.status}, tradable: ${data?.tradable}).`);
          invalid.push(symbol);
        }
      } catch (error) {
        const message = error?.response?.data?.message || error.message;
        console.warn(`[AlpacaValidation] Unable to validate ${symbol}: ${message}`);
        invalid.push(symbol);
      }
    })
  );

  return { tradable, invalid, fractionableBySymbol };
};

const fetchLatestPriceFromYahoo = async (symbol) => {
  if (!symbol) {
    return null;
  }
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?range=1d&interval=1m`;
    const { data } = await Axios.get(url, { timeout: 5000 });
    const result = data?.chart?.result?.[0];
    if (!result) {
      return null;
    }
    const metaPrice = toNumber(result?.meta?.regularMarketPrice, null);
    if (metaPrice && metaPrice > 0) {
      return metaPrice;
    }
    const quote = result?.indicators?.quote?.[0] || {};
    const closes = Array.isArray(quote.close) ? quote.close : [];
    for (let i = closes.length - 1; i >= 0; i -= 1) {
      const price = toNumber(closes[i], null);
      if (price && price > 0) {
        return price;
      }
    }
  } catch (error) {
    console.warn(`[Yahoo] Failed to fetch price for ${symbol}:`, error.message);
  }
  return null;
};

const MASSIVE_PRICE_BASE_URLS = [
  'https://api.massive.com/v2',
  'https://api.polygon.io/v2',
];

const fetchLatestPriceFromMassive = async (symbol) => {
  const apiKey = process.env.MASSIVE_API_KEY;
  if (!symbol || !apiKey) {
    return null;
  }
  for (const baseUrl of MASSIVE_PRICE_BASE_URLS) {
    try {
      const { data } = await Axios.get(
        `${baseUrl}/last/trade/${encodeURIComponent(symbol)}`,
        {
          params: { apiKey },
          timeout: 5000,
        }
      );
      const price =
        toNumber(data?.last?.price, null) ??
        toNumber(data?.last?.p, null) ??
        toNumber(data?.results?.p, null);
      if (price && price > 0) {
        return price;
      }
    } catch (error) {
      const status = error?.response?.status || null;
      const errMessage = error?.response?.data?.error || error.message;
      console.warn(
        `[Massive] Failed to fetch price for ${symbol} via ${baseUrl}:`,
        status ? `${status} ${errMessage}` : errMessage
      );
    }
  }
  return null;
};

const buildCreationHumanSummary = ({
  strategyName,
  summaryText,
  decisions = [],
  orders = [],
  recurrence,
  nextRebalanceAt = null,
  cashLimit = null,
  initialInvestment = null,
  status = 'executed',
  originalScript = null,
  reasoning = [],
  tooling = null,
}) => {
  const lines = [];
  const statusLabel = status === 'pending'
    ? 'prepared (orders queued while market is closed)'
    : 'initialized';

  lines.push(`Strategy "${strategyName}" ${statusLabel}.`);
  lines.push(`• Rebalance cadence: ${formatRecurrenceLabel(recurrence)}.`);

  if (cashLimit !== null) {
    const cashLine = formatCurrency(cashLimit);
    if (cashLine) {
      lines.push(`• Cash limit: ${cashLine}.`);
    }
  }

  if (initialInvestment !== null) {
    const investmentLine = formatCurrency(initialInvestment);
    if (investmentLine) {
      lines.push(`• Initial capital earmarked: ${investmentLine}.`);
    }
  }

  if (nextRebalanceAt) {
    lines.push(`• Next scheduled rebalance: ${formatDateTimeHuman(nextRebalanceAt)}.`);
  }

  if (summaryText) {
    lines.push('');
    lines.push('Strategy overview:');
    summaryText
      .split(/\n+/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .forEach((paragraph) => {
        lines.push(`• ${paragraph}`);
      });
  }

  const decisionsMap = mapDecisionRationales(decisions);
  if (decisionsMap.size) {
    lines.push('');
    lines.push('Rationale by asset:');
    Array.from(decisionsMap.entries()).forEach(([symbol, rationale]) => {
      lines.push(`• ${symbol}: ${rationale}`);
    });
  }

  const localTool = tooling?.localEvaluator;
  if (localTool?.used) {
    lines.push('');
    lines.push('Tooling:');
    lines.push('• Local defsymphony evaluator used cached Alpaca prices to size orders.');
    const tickers = Array.isArray(localTool.tickers)
      ? localTool.tickers.filter(Boolean)
      : [];
    if (tickers.length) {
      lines.push(`• Cached instrument universe: ${tickers.join(', ')}.`);
    }
    const blueprint = Array.isArray(localTool.blueprint)
      ? localTool.blueprint.filter(Boolean)
      : [];
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

  if (Array.isArray(reasoning) && reasoning.length) {
    lines.push('');
    lines.push('Agent reasoning:');
    reasoning.forEach((entry) => {
      if (entry) {
        lines.push(`• ${entry}`);
      }
    });
  }

  if (orders.length) {
    lines.push('');
    lines.push(status === 'pending' ? 'Orders to submit:' : 'Orders executed:');
    orders.forEach((order) => {
      const symbol = sanitizeSymbol(order.symbol);
      const qty = toNumber(order.qty, null);
      if (!symbol || !qty) {
        return;
      }
      const price = formatSharePrice(order.price || (order.cost && qty ? order.cost / qty : null));
      const weight = Number.isFinite(order.targetWeight)
        ? formatPercentage(order.targetWeight * 100)
        : null;
      const rationale = decisionsMap.get(symbol);
      const segments = [
        `BUY ${qty} ${symbol}`,
        price ? `@ approx. ${price}` : null,
        weight ? `(target weight ${weight})` : null,
      ].filter(Boolean);
      let line = `• ${segments.join(' ')}`;
      if (rationale) {
        line += ` — ${rationale}`;
      }
      lines.push(line);
    });
  }

  if (status === 'pending') {
    lines.push('');
    lines.push('Orders will be sent automatically once markets reopen.');
  }

  if (originalScript) {
    lines.push('');
    lines.push('Original strategy script:');
    lines.push(originalScript);
  }

  return lines.join('\n');
};



//Work in progress: prompt engineering (see jira https://ai-trading-bot.atlassian.net/browse/AI-76)

const sanitizeSymbol = (value) => {
  if (!value) {
    return null;
  }
  return String(value).trim().toUpperCase();
};

const toNumber = (value, fallback = null) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
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

const FRACTIONAL_QTY_DECIMALS = 6;
const ENABLE_FRACTIONAL_ORDERS =
  String(process.env.ALPACA_ENABLE_FRACTIONAL ?? 'true').toLowerCase() !== 'false';
const MIN_FRACTIONAL_NOTIONAL = (() => {
  const parsed = Number(process.env.ALPACA_MIN_FRACTIONAL_NOTIONAL);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
})();

const floorToDecimals = (value, decimals = 0) => {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  const places = Math.max(0, Math.min(12, Number(decimals) || 0));
  const factor = 10 ** places;
  return Math.floor(num * factor) / factor;
};

const isEffectivelyInteger = (value, epsilon = 1e-9) => {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return false;
  }
  return Math.abs(num - Math.round(num)) <= epsilon;
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
  const floored = floorToDecimals(numeric, FRACTIONAL_QTY_DECIMALS);
  if (!Number.isFinite(floored) || floored <= 0) {
    return { qty: null, isFractional: false };
  }
  return { qty: floored, isFractional: true };
};

const normalizeComposerHoldings = (holdings = []) => {
  if (!Array.isArray(holdings)) {
    return [];
  }
  return holdings
    .map((entry) => {
      const symbol = sanitizeSymbol(entry?.symbol || entry?.ticker);
      if (!symbol) {
        return null;
      }
      const quantity = toNumber(entry?.quantity ?? entry?.qty ?? entry?.shares, null);
      const value = toNumber(entry?.value ?? entry?.marketValue, null);
      const weightRaw = toNumber(entry?.weight ?? entry?.allocation ?? entry?.targetWeight, null);
      let weight = weightRaw;
      if (Number.isFinite(weightRaw) && weightRaw > 1.5) {
        weight = weightRaw / 100;
      }
      return {
        symbol,
        quantity: Number.isFinite(quantity) ? quantity : null,
        value: Number.isFinite(value) ? value : null,
        weight: Number.isFinite(weight) ? weight : null,
      };
    })
    .filter(Boolean);
};

const fetchLatestPrices = async (symbols, dataKeys) => {
  const priceCache = {};
  if (!dataKeys?.client || !dataKeys?.apiUrl) {
    return priceCache;
  }
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
        const price = toNumber(data?.trade?.p, null);
        if (price) {
          priceCache[symbol] = price;
        }
      } catch (error) {
        console.warn(`[ComposerHoldings] Failed to fetch latest price for ${symbol}: ${error.message}`);
      }
    })
  );
  return priceCache;
};

const shouldFallbackToWholeShares = (error) => {
  const status = Number(error?.response?.status);
  const code = Number(error?.response?.data?.code);
  const message = String(error?.response?.data?.message || error?.message || '').toLowerCase();
  if (status !== 400 && status !== 403 && status !== 422) {
    return false;
  }
  return (
    code === 40310000 ||
    message.includes('fractional') ||
    message.includes('fractionable') ||
    message.includes('cannot be fractional') ||
    message.includes('qty must be integer') ||
    message.includes('quantity must be integer') ||
    message.includes('must be an integer') ||
    message.includes('notional')
  );
};

const extractTargetPositions = (rawPositions = []) => {
  if (!Array.isArray(rawPositions)) {
    return [];
  }

  return rawPositions
    .map((entry) => {
      const symbol = sanitizeSymbol(
        entry?.symbol
        || entry?.ticker
        || entry?.Ticker
        || entry?.['Asset ticker']
        || entry?.['asset ticker']
      );

      if (!symbol) {
        return null;
      }

      const quantity = toNumber(
        entry?.targetQuantity
          ?? entry?.quantity
          ?? entry?.Quantity
          ?? entry?.qty
          ?? entry?.['Quantity'],
        null,
      );

      const totalCost = toNumber(
        entry?.targetValue
          ?? entry?.value
          ?? entry?.amount
          ?? entry?.['Total Cost']
          ?? entry?.['Total cost']
          ?? entry?.['Total'],
        null,
      );

      const weight = toNumber(entry?.targetWeight, null);

      return {
        symbol,
        targetQuantity: quantity,
        targetValue: totalCost,
        targetWeight: weight,
      };
    })
    .filter(Boolean);
};

const normalizeTargetPositions = (rawTargets = []) => {
  const targets = extractTargetPositions(rawTargets);
  if (!targets.length) {
    return [];
  }

  let weightSum = targets.reduce((sum, target) => {
    return sum + (target.targetWeight && target.targetWeight > 0 ? target.targetWeight : 0);
  }, 0);

  if (weightSum > 0) {
    return targets.map((target) => ({
      ...target,
      targetWeight: target.targetWeight && target.targetWeight > 0 ? target.targetWeight / weightSum : 0,
    }));
  }

  const valueSum = targets.reduce((sum, target) => {
    return sum + (target.targetValue && target.targetValue > 0 ? target.targetValue : 0);
  }, 0);

  if (valueSum > 0) {
    return targets.map((target) => ({
      ...target,
      targetWeight: target.targetValue && target.targetValue > 0 ? target.targetValue / valueSum : 0,
    }));
  }

  const quantitySum = targets.reduce((sum, target) => {
    return sum + (target.targetQuantity && target.targetQuantity > 0 ? target.targetQuantity : 0);
  }, 0);

  if (quantitySum > 0) {
    return targets.map((target) => ({
      ...target,
      targetWeight: target.targetQuantity && target.targetQuantity > 0 ? target.targetQuantity / quantitySum : 0,
    }));
  }

  const equalWeight = 1 / targets.length;
  return targets.map((target) => ({
    ...target,
    targetWeight: equalWeight,
  }));
};

const estimateInitialInvestment = (targets = [], budget = null) => {
  const parsedBudget = toNumber(budget, null);
  if (parsedBudget && parsedBudget > 0) {
    return parsedBudget;
  }

  const valueSum = targets.reduce((sum, target) => {
    return sum + (target.targetValue && target.targetValue > 0 ? target.targetValue : 0);
  }, 0);

  if (valueSum > 0) {
    return valueSum;
  }

  return 0;
};



exports.createCollaborative = async (req, res) => {
  try {
    const UserID = req.body.userID;
    const userKey = String(UserID || '');
    const sourceStrategyId = req.body.sourceStrategyId;
    let input = typeof req.body.collaborative === 'string' ? req.body.collaborative : '';
    const rawJobId = typeof req.body.jobId === 'string' ? req.body.jobId.trim() : '';
    if (!rawJobId) {
      return res.status(400).json({
        status: "fail",
        message: "jobId is required for progress tracking.",
      });
    }

    const jobId = rawJobId;
    const progressFail = (statusCode, message, step = 'error', details = null) => {
      const payload = details ? { step, status: 'failed', message, details } : { step, status: 'failed', message };
      const finishedPayload = details
        ? { step: 'finished', status: 'failed', message, details }
        : { step: 'finished', status: 'failed', message };
      publishProgress(jobId, payload);
      completeProgress(jobId, finishedPayload);
      return res.status(statusCode).json({
        status: "fail",
        message,
        jobId,
        ...(details ? { details } : {}),
      });
    };

    publishProgress(jobId, {
      step: 'received',
      status: 'in_progress',
      message: 'Strategy request received.',
    });
    publishProgress(jobId, {
      step: 'validation',
      status: 'in_progress',
      message: 'Validating request payload.',
    });

    if (!userKey || req.user !== userKey) {
      return progressFail(403, "Credentials couldn't be validated.", 'validation');
    }

    if ((!input || !input.trim()) && sourceStrategyId) {
      const storedStrategy = await Strategy.findOne({
        strategy_id: sourceStrategyId,
        userId: userKey,
      });
      if (!storedStrategy) {
        return progressFail(404, "Selected strategy could not be found.", 'validation');
      }
      input = storedStrategy.strategy || '';
    }

    if (!input || !input.trim()) {
      return progressFail(400, "Please provide a strategy description.", 'validation');
    }

    const rawStrategyName = typeof req.body.strategyName === 'string' ? req.body.strategyName.trim() : '';
    if (!rawStrategyName) {
      return progressFail(400, "Please provide a name for this strategy.", 'validation');
    }
    const strategyName = rawStrategyName;

    let symphonyUrl = null;
    try {
      symphonyUrl = parseOptionalHttpUrl(req.body.symphonyUrl) ?? null;
    } catch (error) {
      return progressFail(400, error.message || 'Invalid Symphony URL.', 'validation');
    }

    if (/Below is a trading[\s\S]*strategy does\?/.test(input)) {
      input = input.replace(/Below is a trading[\s\S]*strategy does\?/, "");
    }

    const strategy = input;
    const cashLimitInput = toNumber(
      req.body?.cashLimit !== undefined ? req.body.cashLimit : req.body?.budget,
      null
    );
    const parseJsonData = (fullMessage) => {
      if (!fullMessage) {
        throw new Error("Empty response from OpenAI");
      }

      const fenceMatch = fullMessage.match(/```json\s*([\s\S]*?)```/i);
      const payload = fenceMatch ? fenceMatch[1] : fullMessage;

      try {
        const parsed = JSON.parse(payload);
        if (Array.isArray(parsed)) {
          return { positions: parsed, summary: "", decisions: [] };
        }
        if (Array.isArray(parsed?.positions)) {
          return {
            positions: parsed.positions,
            summary: typeof parsed.summary === "string" ? parsed.summary : "",
            decisions: Array.isArray(parsed.decisions) ? parsed.decisions : []
          };
        }
        throw new Error("Response JSON missing positions array");
      } catch (error) {
        console.error("Failed to parse JSON from OpenAI response", error);
        throw new Error("Collaborative strategy response is not valid JSON");
      }
    };

    const existingStrategy = await Strategy.findOne({
      userId: userKey,
      name: strategyName,
    });
    if (existingStrategy) {
      return progressFail(409, `A strategy named "${strategyName}" already exists. Please choose another name.`, 'validation');
    }

    let workingPositions = [];
    let workingSummary = '';
    let workingDecisions = [];
    let composerReasoning = [];
    let composerMeta = null;

    try {
      publishProgress(jobId, {
        step: 'composer_evaluation',
        status: 'in_progress',
        message: 'Running Composer evaluation.',
      });
      const composerResult = await runComposerStrategy({
        strategyText: strategy,
        budget: cashLimitInput,
      });

      if (!composerResult?.positions?.length) {
        return progressFail(502, "Composer evaluation returned no positions.", 'composer_evaluation');
      }

      workingSummary = composerResult.summary || '';
      composerReasoning = Array.isArray(composerResult.reasoning) ? composerResult.reasoning : [];
      composerMeta = composerResult.meta || composerMeta;

      workingPositions = composerResult.positions
        .map((pos) => {
          const symbol = sanitizeSymbol(pos.symbol);
          const weight = toNumber(pos.weight, null);
          const quantity = toNumber(pos.quantity, null);
          const cost = toNumber(pos.estimated_cost, null);
          if (!symbol) {
            return null;
          }
          return {
            symbol,
            targetWeight: Number.isFinite(weight) ? weight : null,
            targetQuantity: Number.isFinite(quantity) ? quantity : null,
            targetValue: Number.isFinite(cost) ? cost : null,
            rationale: pos.rationale || null,
          };
        })
        .filter(Boolean);

      if (Array.isArray(composerResult.positions)) {
        workingDecisions = composerResult.positions
          .map((pos) => {
            const symbol = sanitizeSymbol(pos.symbol);
            if (!symbol) {
              return null;
            }
            return {
              symbol,
              Rationale: pos.rationale || 'Selected by local defsymphony evaluation.',
            };
          })
          .filter(Boolean);
      }
      publishProgress(jobId, {
        step: 'composer_evaluation',
        status: 'completed',
        message: 'Composer evaluation completed.',
      });
    } catch (error) {
      console.error('[ComposerEvaluation]', error);
      return progressFail(502, `Composer evaluation failed: ${error.message || 'unknown error'}`, 'composer_evaluation');
    }
    const recurrence = normalizeRecurrence(req.body?.recurrence);

    publishProgress(jobId, {
      step: 'validation',
      status: 'completed',
      message: 'Inputs validated.',
    });

    if (!cashLimitInput || cashLimitInput <= 0) {
      return progressFail(400, "Please provide a positive cash limit for the collaborative strategy.", 'validation');
    }

    let normalizedTargets = normalizeTargetPositions(workingPositions);
    if (!normalizedTargets.length) {
      const fallbackPlan = buildFallbackFromRawStrategy(strategy);
      if (!fallbackPlan) {
        return progressFail(400, "Unable to determine target positions for this strategy.", 'evaluation');
      }
      workingPositions = fallbackPlan.positions;
      normalizedTargets = normalizeTargetPositions(workingPositions);
      if (!normalizedTargets.length) {
        return progressFail(400, "Unable to derive a tradable allocation from this strategy.", 'evaluation');
      }
      workingSummary = [workingSummary, fallbackPlan.summary].filter(Boolean).join('\n\n') || fallbackPlan.summary;
      workingDecisions = [...workingDecisions, ...fallbackPlan.decisions];
      composerReasoning = composerReasoning.length ? composerReasoning : ['Applied equal-weight fallback due to missing parsed targets.'];
    }

    console.log('Strategy summary: ', workingSummary || 'No summary provided.');
    console.log('Orders payload: ', JSON.stringify(workingPositions, null, 2));
    if (workingDecisions?.length) {
      console.log('Decision rationale:', JSON.stringify(workingDecisions, null, 2));
    }

    const alpacaConfig = await getAlpacaConfig(UserID);
    console.log("config key done");

    const alpacaApi = new Alpaca(alpacaConfig);
    console.log("connected to alpaca");
    const account = await alpacaApi.getAccount();
    const accountStatus = String(account?.status || '').trim().toLowerCase();
    if (accountStatus && accountStatus !== 'active') {
      return progressFail(
        403,
        `Alpaca account status is "${account?.status || accountStatus}". Trading is not available until the account is active.`,
        'validation'
      );
    }
    if (account?.trading_blocked || account?.account_blocked) {
      return progressFail(
        403,
        'Alpaca account is blocked from trading. Please check your Alpaca account permissions/status.',
        'validation'
      );
    }

    const accountCash = toNumber(account?.cash, 0);
    const planningBudget = Math.min(cashLimitInput, Math.max(0, accountCash));

    if (!planningBudget || planningBudget <= 0) {
      return progressFail(
        400,
        "Insufficient available cash to fund the collaborative strategy with the selected limit.",
        'validation'
      );
    }

    const dataKeys = alpacaConfig.getDataKeys ? alpacaConfig.getDataKeys() : null;
    const uniqueSymbols = Array.from(
      new Set(
        normalizedTargets
          .map((target) => target.symbol)
          .filter(Boolean)
      )
    );

    if (!uniqueSymbols.length) {
      return res.status(400).json({
        status: "fail",
        message: "No valid tickers found in the collaborative strategy.",
      });
    }

    const { invalid: nonTradableSymbols, fractionableBySymbol } = await validateAlpacaTradableSymbols(
      alpacaConfig,
      uniqueSymbols
    );
    if (nonTradableSymbols.length) {
      return res.status(400).json({
        status: "fail",
        message: `The following tickers are not tradable on Alpaca: ${nonTradableSymbols.join(', ')}.`,
      });
    }

    const priceMap = {};

    publishProgress(jobId, {
      step: 'market_data',
      status: 'in_progress',
      message: 'Fetching latest market prices.',
    });

    if (dataKeys?.client && dataKeys?.apiUrl && dataKeys?.keyId && dataKeys?.secretKey) {
      await Promise.all(
        uniqueSymbols.map(async (symbol) => {
          try {
            const { data } = await dataKeys.client.get(
              `${dataKeys.apiUrl}/v2/stocks/${symbol}/trades/latest`,
              {
                headers: {
                  'APCA-API-KEY-ID': dataKeys.keyId,
                  'APCA-API-SECRET-KEY': dataKeys.secretKey,
                },
              }
            );
            const lastTradePrice = toNumber(data?.trade?.p, null);
            if (lastTradePrice && lastTradePrice > 0) {
              priceMap[symbol] = lastTradePrice;
            }
          } catch (error) {
            console.warn(`Failed to fetch latest price for ${symbol}:`, error.message);
          }
        })
      );
    }

    const yahooFallbackSymbols = uniqueSymbols.filter((symbol) => !priceMap[symbol]);
    if (yahooFallbackSymbols.length) {
      await Promise.all(
        yahooFallbackSymbols.map(async (symbol) => {
          const yahooPrice = await fetchLatestPriceFromYahoo(symbol);
          if (yahooPrice && yahooPrice > 0) {
            priceMap[symbol] = yahooPrice;
            console.log(`[MarketData] Yahoo fallback price used for ${symbol}.`);
          }
        })
      );
    }

    const massiveFallbackSymbols = uniqueSymbols.filter((symbol) => !priceMap[symbol]);
    if (massiveFallbackSymbols.length) {
      await Promise.all(
        massiveFallbackSymbols.map(async (symbol) => {
          const massivePrice = await fetchLatestPriceFromMassive(symbol);
          if (massivePrice && massivePrice > 0) {
            priceMap[symbol] = massivePrice;
            console.log(`[MarketData] Massive fallback price used for ${symbol}.`);
          }
        })
      );
    }

    publishProgress(jobId, {
      step: 'market_data',
      status: 'completed',
      message: 'Market price data fetched.',
    });

    const sortedTargets = normalizedTargets
      .filter((target) => target.symbol && target.targetWeight > 0)
      .sort((a, b) => (b.targetWeight || 0) - (a.targetWeight || 0));

    const orderPlan = [];
    const symbolsWithoutPrices = new Set();
    let plannedCost = 0;

    const resolveFallbackPrice = (target) => {
      const quantity = toNumber(target.targetQuantity, null);
      const value = toNumber(target.targetValue, null);
      if (quantity && quantity > 0 && value && value > 0) {
        return value / quantity;
      }
      return null;
    };

    for (const target of sortedTargets) {
      const symbol = target.symbol;
      const explicitPrice = toNumber(priceMap[symbol], null);
      const fallbackPrice = resolveFallbackPrice(target);
      const price = explicitPrice && explicitPrice > 0
        ? explicitPrice
        : (fallbackPrice && fallbackPrice > 0 ? fallbackPrice : null);

      if (!price || price <= 0) {
        console.warn(`Skipping ${symbol}; unable to determine a valid price.`);
        symbolsWithoutPrices.add(symbol);
        continue;
      }

      const fractionableKnown = Boolean(
        fractionableBySymbol &&
          typeof fractionableBySymbol === 'object' &&
          Object.prototype.hasOwnProperty.call(fractionableBySymbol, symbol)
      );
      const isFractionable = fractionableKnown ? Boolean(fractionableBySymbol[symbol]) : true;
      const allowFractionalQty = ENABLE_FRACTIONAL_ORDERS && isFractionable;

      const desiredValue = planningBudget * target.targetWeight;
      const remainingBudget = planningBudget - plannedCost;
      const cappedValue = Math.min(desiredValue, Math.max(0, remainingBudget));
      let qty = ENABLE_FRACTIONAL_ORDERS
        ? ((allowFractionalQty
            ? floorToDecimals(cappedValue / price, FRACTIONAL_QTY_DECIMALS)
            : Math.floor(cappedValue / price)) || 0)
        : Math.floor(cappedValue / price);

      if (!ENABLE_FRACTIONAL_ORDERS || !allowFractionalQty) {
        if (qty <= 0 && remainingBudget >= price) {
          qty = 1;
        }
      }

      if (qty <= 0) {
        continue;
      }

      const cost = qty * price;
      if (allowFractionalQty && cost < MIN_FRACTIONAL_NOTIONAL) {
        continue;
      }
      plannedCost += cost;
      orderPlan.push({
        symbol,
        qty,
        price,
        cost,
      });

      if (plannedCost >= planningBudget) {
        break;
      }
    }

    let remainingBudget = planningBudget - plannedCost;
    if (remainingBudget > 0 && orderPlan.length) {
      if (ENABLE_FRACTIONAL_ORDERS) {
        const topPlan = orderPlan[0];
        const topFractionable =
          !fractionableBySymbol ||
          typeof fractionableBySymbol !== 'object' ||
          !Object.prototype.hasOwnProperty.call(fractionableBySymbol, topPlan.symbol)
            ? true
            : Boolean(fractionableBySymbol[topPlan.symbol]);
        const extraQty = topFractionable
          ? floorToDecimals(remainingBudget / topPlan.price, FRACTIONAL_QTY_DECIMALS) || 0
          : Math.floor(remainingBudget / topPlan.price);
        if (extraQty > 0) {
          topPlan.qty = (topPlan.qty || 0) + extraQty;
          topPlan.cost += extraQty * topPlan.price;
          plannedCost += extraQty * topPlan.price;
          remainingBudget = planningBudget - plannedCost;
        }
      } else {
      for (const plan of orderPlan) {
        if (remainingBudget < plan.price) {
          continue;
        }
        const additionalQty = Math.floor(remainingBudget / plan.price);
        if (additionalQty <= 0) {
          continue;
        }
        const additionalCost = additionalQty * plan.price;
        plan.qty += additionalQty;
        plan.cost += additionalCost;
        plannedCost += additionalCost;
        remainingBudget -= additionalCost;
        if (plannedCost >= planningBudget || remainingBudget <= 0) {
          break;
        }
      }
      }
    }

    const finalizedPlan = orderPlan.filter((entry) => entry.qty > 0);
    if (!finalizedPlan.length) {
      if (symbolsWithoutPrices.size) {
        return res.status(400).json({
          status: "fail",
          message: `Unable to fetch market prices for: ${Array.from(symbolsWithoutPrices).join(', ')}. Please verify these tickers or try again later.`,
        });
      }
      return res.status(400).json({
        status: "fail",
        message: "Cash limit is too low to purchase any assets for this strategy.",
      });
    }

    plannedCost = finalizedPlan.reduce((sum, entry) => sum + entry.cost, 0);
    console.log(
      'Collaborative strategy order plan within cash limit:',
      finalizedPlan.map((entry) => ({ symbol: entry.symbol, qty: entry.qty, price: entry.price })),
      'Total estimated cost:',
      plannedCost.toFixed(2)
    );

    const executedTargetsRaw = finalizedPlan.map((entry) => ({
      symbol: entry.symbol,
      targetQuantity: entry.qty,
      targetValue: entry.cost,
      targetWeight: plannedCost > 0 ? entry.cost / plannedCost : 0,
    }));
    const executedTargets = normalizeTargetPositions(executedTargetsRaw);

    publishProgress(jobId, {
      step: 'placing_orders',
      status: 'in_progress',
      message: 'Submitting orders to Alpaca.',
    });

    const orderFailures = [];
    const orderPromises = finalizedPlan.map(({ symbol, qty }) => {
      return retry(() => {
        const normalized = ENABLE_FRACTIONAL_ORDERS ? normalizeQtyForOrder(qty) : { qty: Math.floor(toNumber(qty, 0)), isFractional: false };
        if (!normalized.qty) {
          return Promise.resolve(null);
        }
        const qtyValue = normalized.isFractional
          ? normalized.qty.toFixed(FRACTIONAL_QTY_DECIMALS)
          : normalized.qty;
        const timeInForce = normalized.isFractional ? 'day' : 'gtc';

        const submit = (payloadQty, tif) =>
          axios({
            method: 'post',
            url: alpacaConfig.apiURL + '/v2/orders',
            headers: {
              'APCA-API-KEY-ID': alpacaConfig.keyId,
              'APCA-API-SECRET-KEY': alpacaConfig.secretKey
            },
            data: {
              symbol,
              qty: payloadQty,
              side: 'buy',
              type: 'market',
              time_in_force: tif
            }
          });

        return submit(qtyValue, timeInForce)
          .then((response) => {
            console.log(`Order of ${qtyValue} shares for ${symbol} has been placed. Order ID: ${response.data.client_order_id}`);
            return { qty: normalized.qty, symbol, orderID: response.data.client_order_id };
          })
          .catch((error) => {
            if (normalized.isFractional && shouldFallbackToWholeShares(error)) {
              const fallbackQty = Math.floor(toNumber(qty, 0));
              if (fallbackQty > 0) {
                return submit(fallbackQty, 'gtc').then((response) => {
                  console.log(`Order of ${fallbackQty} shares for ${symbol} has been placed (fallback). Order ID: ${response.data.client_order_id}`);
                  return { qty: fallbackQty, symbol, orderID: response.data.client_order_id };
                });
              }
            }
            return Promise.reject(error);
          });
      }, 5, 2000).catch((error) => {
        const status = error?.response?.status;
        const responseData = error?.response?.data;
        const headers = error?.response?.headers || {};
        const requestId =
          headers['apca-request-id']
          || headers['x-request-id']
          || headers['x-request-id'.toLowerCase()]
          || 'n/a';
        const sanitizedBody = (() => {
          if (!responseData) {
            return 'No response body';
          }
          if (typeof responseData === 'object') {
            return JSON.stringify(responseData);
          }
          return String(responseData);
        })();
        console.error(
          `[OrderError] Failed to place order for ${symbol}. status=${status || 'unknown'} requestId=${requestId} body=${sanitizedBody}`
        );
        if (error?.message) {
          console.error(`[OrderError] Axios message for ${symbol}: ${error.message}`);
        }
        orderFailures.push({
          symbol,
          status: status ?? null,
          requestId,
          message:
            (typeof responseData === 'object' && responseData && responseData.message)
              ? String(responseData.message)
              : (error?.message ? String(error.message) : 'Unknown order error'),
          body: responseData && typeof responseData === 'object' ? responseData : sanitizedBody,
        });
        return null;
      });
    });

    const orders = (await Promise.all(orderPromises)).filter(Boolean);
    const initialInvestmentEstimate = plannedCost;
    if (!orders.length) {
      console.error('Failed to place all orders.');
      const first = orderFailures[0];
      const suffix = orderFailures.length > 1 ? ` (+${orderFailures.length - 1} more)` : '';
      const detail = first?.message ? ` First error: ${first.message}${suffix}.` : '';
      return progressFail(
        400,
        `Failed to place orders.${detail}`,
        'placing_orders',
        orderFailures.length ? { orderFailures } : null
      );
    }

    publishProgress(jobId, {
      step: 'placing_orders',
      status: 'completed',
      message: 'Orders submitted to Alpaca.',
    });
    const portfolioRecord = await exports.addPortfolio(
      strategy,
      strategyName,
      orders,
      UserID,
      {
        budget: cashLimitInput,
        cashLimit: cashLimitInput,
        targetPositions: executedTargets,
        recurrence,
        initialInvestment: initialInvestmentEstimate,
        summary: workingSummary,
        decisions: workingDecisions,
        reasoning: composerReasoning,
        orderPlan: finalizedPlan,
        composerMeta,
        symphonyUrl,
      }
    );

    const schedule = portfolioRecord
      ? {
          recurrence: portfolioRecord.recurrence,
          nextRebalanceAt: portfolioRecord.nextRebalanceAt,
          lastRebalancedAt: portfolioRecord.lastRebalancedAt,
        }
      : null;

    await upsertStrategyTemplate({
      userId: userKey,
      name: strategyName,
      strategyText: strategy,
      summary: workingSummary,
      decisions: workingDecisions,
      recurrence,
      symphonyUrl,
      strategyId: portfolioRecord?.strategy_id || null,
    });

    completeProgress(jobId, {
      step: 'finished',
      status: 'success',
      message: 'Strategy created successfully.',
    });

    const summaryForUi = stripEvaluatorShareEstimates(workingSummary);

    return res.status(200).json({
      status: "success",
      orders,
      summary: summaryForUi || "",
      decisions: workingDecisions || [],
      reasoning: composerReasoning || [],
      schedule,
      strategyId: portfolioRecord?.strategy_id || null,
      strategyName,
      jobId,
    });
  } catch (error) {
    console.error(`Error in createCollaborative:`, error);
    publishProgress(req.body.jobId, {
      step: 'error',
      status: 'failed',
      message: error.message || 'Unexpected server error',
    });
    completeProgress(req.body.jobId, {
      step: 'finished',
      status: 'failed',
      message: error.message || 'Unexpected server error',
    });
    return res.status(500).json({
      status: "fail",
      message: `Something unexpected happened: ${error.message}`,
      jobId: req.body.jobId || null,
    });
  }
};

 


  exports.deleteCollaborative = async (req, res) => {
    console.log('deleting strategy');
    try {
      // Get the strategy ID from the request parameters
      const strategyId = req.params.strategyId;
      const UserID = req.params.userId;
      const userKey = String(UserID || '');

      if (!userKey || req.user !== userKey) {
        return res.status(403).json({
          status: "fail",
          message: "Credentials couldn't be validated.",
        });
      }

      console.log('strategyId', strategyId);

      const strategy = await Strategy.findOne({
        strategy_id: strategyId,
        $or: [
          { userId: userKey },
          { userId: { $exists: false } },
          { userId: null },
          { userId: '' },
        ],
      });

      if (!strategy) {
        return res.status(404).json({
          status: "fail",
          message: "Strategy not found",
        });
      }
  
      // Find the portfolio in the database
      const portfolio = await Portfolio.findOne({ strategy_id: strategyId, userId: userKey });

      if (!portfolio) {
        return res.status(404).json({
          status: "fail",
          message: "Portfolio not found",
        });
      }

      const provider = String(portfolio.provider || 'alpaca');
  
      // Delete the strategy
      await Strategy.deleteOne({
        strategy_id: strategyId,
        $or: [
          { userId: userKey },
          { userId: { $exists: false } },
          { userId: null },
          { userId: '' },
        ],
      })
      .catch(error => {
        console.error(`Error deleting strategy: ${error}`);
        return res.status(500).json({
          status: "fail",
          message: "An error occurred while deleting the strategy",
        });
      });
  
      // Delete the portfolio
      await Portfolio.deleteOne({ strategy_id: strategyId, userId: userKey })
      .catch(error => {
        console.error(`Error deleting portfolio: ${error}`);
        return res.status(500).json({
          status: "fail",
          message: "An error occurred while deleting the portfolio",
        });
      });

      if (provider === 'polymarket') {
        await recordStrategyLog({
          strategyId,
          userId: userKey,
          strategyName: strategy.name,
          message: 'Polymarket strategy deleted',
          details: {
            provider,
            liquidationAttempted: false,
            humanSummary: [
              `Polymarket strategy \"${strategy.name}\" deleted.`,
              '• This strategy is paper-only; no live Polymarket orders were sent.',
            ].join('\n'),
          },
        });
        return res.status(200).json({
          status: 'success',
          message: 'Strategy deleted.',
          sellOrders: [],
        });
      }
  
      const alpacaConfig = await getAlpacaConfig(UserID);
      const alpacaApi = new Alpaca(alpacaConfig);
      const clock = await alpacaApi.getClock().catch((error) => {
        console.error('Failed to retrieve market clock for deletion:', error.message);
        return null;
      });

      const marketOpen = clock?.is_open === true;

      if (!marketOpen) {
        console.log('[Delete Strategy] Market closed, skipping liquidation orders.');
        await recordStrategyLog({
          strategyId,
          userId: userKey,
          strategyName: strategy.name,
          message: 'Strategy deleted while market closed',
          details: {
            liquidationAttempted: false,
            humanSummary: [
              `Strategy "${strategy.name}" deleted while markets were closed.`,
              '• No liquidation orders were sent; positions remain until the next trading session.',
            ].join('\n'),
          },
        });
        return res.status(200).json({
          status: "success",
          message: "Strategy deleted. Market was closed, so no liquidation orders were placed.",
          sellOrders: [],
        });
      }

      let sellOrderPromises = portfolio.stocks.map((stock) => {
        const rawQty = toNumber(stock.quantity, 0);
        const normalized = ENABLE_FRACTIONAL_ORDERS
          ? normalizeQtyForOrder(rawQty)
          : { qty: Math.floor(rawQty), isFractional: false };
        if (!normalized.qty) {
          return Promise.resolve(null);
        }
        const order = {
          symbol: stock.symbol,
          qty: normalized.isFractional ? normalized.qty.toFixed(FRACTIONAL_QTY_DECIMALS) : normalized.qty,
          side: 'sell',
          type: 'market',
          time_in_force: normalized.isFractional ? 'day' : 'gtc',
        };
        return alpacaApi.createOrder(order)
          .then((response) => {
            console.log(`Sell order of ${order.qty} shares for ${stock.symbol} has been placed. Order ID: ${response.client_order_id}`);
            return { qty: normalized.qty, symbol: stock.symbol, orderID: response.client_order_id };
          }).catch((error) => {
            console.error(`Failed to place sell order for ${stock.symbol}: ${error}`);
            return null;
          });
      });
  
      Promise.all(sellOrderPromises).then(sellOrders => {
        // Filter out any null values
        sellOrders = sellOrders.filter(order => order !== null);
  
        // If all sell orders failed, return an error message
        if (sellOrders.length === 0) {
          console.error('Failed to place all sell orders.');
          return res.status(400).json({
            status: "fail",
            message: "Failed to place sell orders. Try again.",
          });
        }
  
        // If some sell orders were successful, return a success message
        return res.status(200).json({
          status: "success",
          message: "Strategy and portfolio deleted successfully, and sell orders placed.",
          sellOrders: sellOrders,
        });





        
      }).catch(error => {
        console.error(`Error: ${error}`);
        return res.status(400).json({
          status: "fail",
          message: `Something unexpected happened: ${error.message}`,
        });
      });
  
    } catch (error) {
      console.error(`Error deleting strategy and portfolio: ${error}`);
      return res.status(500).json({
        status: "fail",
        message: "An error occurred while deleting the strategy and portfolio",
      });
    }
  };



  //still it does not use all the budget it seems
 
exports.enableAIFund = async (req, res) => {
    try {
        let budget = toNumber(req.body.budget, 0);
        const UserID = req.body.userID;
        const userKey = String(UserID || '');
        const strategyName = req.body.strategyName;
        const strategy = "AiFund";
        const recurrence = normalizeRecurrence(req.body?.recurrence);

        if (!userKey || req.user !== userKey) {
          return res.status(403).json({
            status: "fail",
            message: "Credentials couldn't be validated.",
          });
        }

        const existingStrategy = await Strategy.findOne({
          userId: userKey,
          name: strategyName,
        });
        if (existingStrategy) {
          return res.status(409).json({
            status: "fail",
            message: `The strategy "${strategyName}" already exists. You can manage it from the dashboard.`,
          });
        }
  
        // Scoring
        let scoreResults = require('../data/scoreResults.json');
        scoreResults.sort((a, b) => b.Score - a.Score); // Sort by score in descending order
        let topAssets = scoreResults.slice(0, 5); // Get the top 5 assets
  
        // Creating orders
        let orderList = topAssets.map(asset => {
          return {
            'Asset ticker': asset.Ticker,
            'Quantity': 0, // Quantity will be calculated later
            'Current Price': 0, // Current price will be updated later
            'Score': asset.Score,
          };
        });
  
        console.log('orderList', orderList);
  
        // Calculating investing amounts
        let totalScore = topAssets.reduce((total, asset) => total + asset.Score, 0);
        let remainingBudget = budget;
  
        const alpacaConfig = await getAlpacaConfig(UserID);
        console.log("config key done");
  
        for (let i = 0; i < orderList.length; i++) {
          let asset = orderList[i];
          let symbol = asset['Asset ticker'];
          let originalSymbol = symbol; // Save the original symbol for later use
  
          let currentPrice = 0;
  
          // Get the last price for the stock using the Alpaca API
          const alpacaUrl = `https://data.alpaca.markets/v2/stocks/${symbol}/quotes/latest`;
          const alpacaResponse = await Axios.get(alpacaUrl, {
            headers: {
              'APCA-API-KEY-ID': alpacaConfig.keyId,
              'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
            },
          });
          currentPrice = alpacaResponse.data.quote.ap;
          asset['Current Price'] = currentPrice; // Update the current price in the order list

  
          // If the current price is still 0, get the adjClose from the past day
          if (currentPrice === 0) {
  
            // Get the historical stock data for the given ticker from the Tiingo API
            const startDate = new Date();
            startDate.setFullYear(startDate.getFullYear() - 2);
            const year = startDate.getFullYear();
            const month = startDate.getMonth() + 1;
            const day = startDate.getDate();
  
            let url = `https://api.tiingo.com/tiingo/daily/${symbol}/prices?startDate=${year}-${month}-${day}&token=${process.env.TIINGO_API_KEY1}`;
            let response;
            try {
              response = await Axios.get(url);
            } catch (error) {
              if (symbol.includes('.')) {
                symbol = symbol.replace('.', '-');
                url = `https://api.tiingo.com/tiingo/daily/${symbol}/prices?startDate=${year}-${month}-${day}&token=${process.env.TIINGO_API_KEY1}`;
                response = await Axios.get(url);
              } else {
                throw error;
              }
            }
            const data = response.data;
            currentPrice = data[data.length - 1].adjClose;
          }
  
          console.log(`Current price of ${symbol} is ${currentPrice}`);

          // Calculate the quantity based on the score of the asset
          let assetScore = topAssets.find(a => a.Ticker === originalSymbol).Score; // Use the original symbol here
          let allocatedBudget = (assetScore / totalScore) * budget;
          
          // Calculate the quantity to buy
          let quantity = Math.floor(allocatedBudget / currentPrice);
          
          // Update the remaining budget
          remainingBudget -= quantity * currentPrice;
          
          // Update the order list with the calculated quantity
          orderList[i]['Quantity'] = quantity;
          }
          
      // Sort the orderList by price in ascending order
      orderList.sort((a, b) => a['Current Price'] - b['Current Price']);

      // If there's remaining budget, distribute it to the assets again
      while (remainingBudget > 0) {
        let budgetUsed = false;
        for (let i = 0; i < orderList.length; i++) {
          let asset = orderList[i];
          let symbol = asset['Asset ticker'];
          let currentPrice = asset['Current Price'];

          // Calculate the quantity to buy with the remaining budget
          let quantity = Math.floor(remainingBudget / currentPrice);

          // If quantity is 0, continue to the next asset
          if (quantity === 0) continue;

          // Update the remaining budget
          remainingBudget -= quantity * currentPrice;

          // Update the order list with the additional quantity
          orderList[i]['Quantity'] += quantity;

          // Set budgetUsed to true
          budgetUsed = true;

          // If there's no remaining budget, break the loop
          if (remainingBudget <= 0) {
            break;
          }
        }

        // If no budget was used in a full loop through the orderList, break the while loop
        if (!budgetUsed) break;
      }

          
        const aiFundDecisions = orderList.map((asset) => {
          const symbol = sanitizeSymbol(asset['Asset ticker']);
          if (!symbol) {
            return null;
          }
          const score = toNumber(asset['Score'], null);
          const quantity = toNumber(asset['Quantity'], null);
          const rationaleSegments = [];
          if (Number.isFinite(score)) {
            rationaleSegments.push(`sentiment score ${score.toFixed(2)}`);
          }
          if (Number.isFinite(quantity)) {
            rationaleSegments.push(`allocating ${quantity} shares`);
          }
          const rationale = rationaleSegments.length
            ? `${rationaleSegments.join(' → ')}.`
            : 'Allocated by sentiment ranking.';
          return {
            symbol,
            Rationale: rationale,
          };
        }).filter(Boolean);

              const normalizedTargets = normalizeTargetPositions(
                orderList.map((asset) => ({
                  symbol: asset['Asset ticker'],
                  targetQuantity: asset['Quantity'],
                  targetValue: toNumber(asset['Quantity'], 0) * toNumber(asset['Current Price'], 0),
                }))
              );
              const initialInvestmentEstimate = estimateInitialInvestment(normalizedTargets, budget);

              // Send the orders to the trading platform
              console.log('Order: ', JSON.stringify(orderList, null, 2));
        
              // Send the orders to alpaca
              const orderPromises = orderList.map(asset => {
                const symbol = sanitizeSymbol(asset['Asset ticker']);
                const qty = Math.floor(asset['Quantity']);
        
                if (qty > 0) {
                  return retry(() => {
                    return axios({
                      method: 'post',
                      url: alpacaConfig.apiURL + '/v2/orders',
                      headers: {
                        'APCA-API-KEY-ID': alpacaConfig.keyId,
                        'APCA-API-SECRET-KEY': alpacaConfig.secretKey
                      },
                      data: {
                        symbol: symbol,
                        qty: qty,
                        side: 'buy',
                        type: 'market',
                        time_in_force: 'gtc'
                      }
                    }).then((response) => {
                      console.log(`Order of ${qty} shares for ${symbol} has been placed. Order ID: ${response.data.client_order_id}`);
                      return { qty: qty, symbol: symbol, orderID: response.data.client_order_id};
                    });
                  }, 5, 2000).catch((error) => {
                    console.error(`Failed to place order for ${symbol}: ${error}`)
                    return null;
                  })
                } else {
                  console.log(`Quantity for ${symbol} is ${qty}. Order not placed.`);
                  return null;
                }
        });

        const orders = (await Promise.all(orderPromises)).filter(Boolean);

        if (orders.length === 0) {
          console.error('Failed to place all orders.');
          return res.status(400).json({
            status: "fail",
            message: "Failed to place orders. Try again.",
          });
        }

        const portfolioRecord = await exports.addPortfolio(
          strategy,
          strategyName,
          orders,
          UserID,
        {
          budget,
          targetPositions: normalizedTargets,
          recurrence,
          initialInvestment: initialInvestmentEstimate,
          summary: 'AI Fund strategy generated from latest sentiment scoring.',
          decisions: aiFundDecisions,
          orderPlan: orderList.map((item) => ({
            symbol: item['Asset ticker'],
            qty: toNumber(item['Quantity'], null),
            price: toNumber(item['Current Price'], null),
            targetWeight: null,
          })),
        }
      );

        const schedule = portfolioRecord
          ? {
              recurrence: portfolioRecord.recurrence,
              nextRebalanceAt: portfolioRecord.nextRebalanceAt,
              lastRebalancedAt: portfolioRecord.lastRebalancedAt,
            }
          : null;

      return res.status(200).json({
        status: "success",
        orders,
        schedule,
        strategyId: portfolioRecord?.strategy_id || null,
        strategyName,
      });
    } catch (error) {
      console.error(`Error in enableAIFund: ${error}`);
      await recordStrategyLog({
        strategyId: strategyName,
        userId: String(UserID || ''),
        strategyName,
        level: 'error',
        message: 'Failed to enable AI Fund strategy',
        details: { error: error.message },
      });
      return res.status(500).json({
        status: "fail",
        message: `Something unexpected happened: ${error.message}`,
      });
    }
  }




exports.disableAIFund = async (req, res) => {
      console.log('deleting strategy');
      try {
        // Get the strategy ID 
        const strategyId = "01";
        const UserID = req.body.userID;
        const userKey = String(UserID || '');

        if (!userKey || req.user !== userKey) {
          return res.status(403).json({
            status: "fail",
            message: "Credentials couldn't be validated.",
          });
        }
    
        console.log('strategyId', strategyId);
    
        // Find the strategy in the database
        const strategy = await Strategy.findOne({ strategy_id: strategyId, userId: userKey });
    
        if (!strategy) {
          return res.status(404).json({
            status: "fail",
            message: "Strategy not found",
          });
        }
    
        // Find the portfolio in the database
        const portfolio = await Portfolio.findOne({ strategy_id: strategyId, userId: userKey });
    
        if (!portfolio) {
          return res.status(404).json({
            status: "fail",
            message: "Portfolio not found",
          });
        }
    
        // Delete the strategy
        await Strategy.deleteOne({ strategy_id: strategyId, userId: userKey })
        .catch(error => {
          console.error(`Error deleting strategy: ${error}`);
          return res.status(500).json({
            status: "fail",
            message: "An error occurred while deleting the strategy",
          });
        });
    
        // Delete the portfolio
        await Portfolio.deleteOne({ strategy_id: strategyId, userId: userKey })
        .catch(error => {
          console.error(`Error deleting portfolio: ${error}`);
          return res.status(500).json({
            status: "fail",
            message: "An error occurred while deleting the portfolio",
          });
        });
    
        // Send a sell order for all the stocks in the portfolio
        const alpacaConfig = await getAlpacaConfig(UserID);
        const alpacaApi = new Alpaca(alpacaConfig);
    
        let sellOrderPromises = portfolio.stocks.map(stock => {
          return alpacaApi.createOrder({
            symbol: stock.symbol,
            qty: stock.quantity,
            side: 'sell',
            type: 'market',
            time_in_force: 'gtc'
          }).then((response) => {
            console.log(`Sell order of ${stock.quantity} shares for ${stock.symbol} has been placed. Order ID: ${response.client_order_id}`);
            return { qty: stock.quantity, symbol: stock.symbol, orderID: response.client_order_id};
          }).catch((error) => {
            console.error(`Failed to place sell order for ${stock.symbol}: ${error}`)
            return null;
          });
        });
    
        Promise.all(sellOrderPromises).then(sellOrders => {
          // Filter out any null values
          sellOrders = sellOrders.filter(order => order !== null);
    
          // If all sell orders failed, return an error message
          if (sellOrders.length === 0) {
            console.error('Failed to place all sell orders.');
            return res.status(400).json({
              status: "fail",
              message: "Failed to place sell orders. Try again.",
            });
          }
    
          // If some sell orders were successful, return a success message
          return res.status(200).json({
            status: "success",
            message: "Strategy and portfolio deleted successfully, and sell orders placed.",
            sellOrders: sellOrders,
          });
  
  
  
  
  
          
        }).catch(error => {
          console.error(`Error: ${error}`);
          return res.status(400).json({
            status: "fail",
            message: `Something unexpected happened: ${error.message}`,
          });
        });
    
  } catch (error) {
    console.error(`Error deleting strategy and portfolio: ${error}`);
    return res.status(500).json({
      status: "fail",
      message: "An error occurred while deleting the strategy and portfolio",
    });
  }
};


exports.createPolymarketCopyTrader = async (req, res) => {
  try {
    const UserID = req.body.userID;
    const userKey = String(UserID || '');
    if (!userKey || req.user !== userKey) {
      return res.status(403).json({
        status: 'fail',
        message: "Credentials couldn't be validated.",
      });
    }

    const rawName = typeof req.body.strategyName === 'string' ? req.body.strategyName.trim() : '';
    if (!rawName) {
      return res.status(400).json({
        status: 'fail',
        message: 'Please provide a name for this strategy.',
      });
    }

    const cashLimit = toNumber(req.body.cashLimit, null);
    if (!cashLimit || cashLimit <= 0) {
      return res.status(400).json({
        status: 'fail',
        message: 'Please provide a positive cash limit.',
      });
    }

    const recurrence = req.body.recurrence || 'every_minute';
    if (recurrence && !VALID_RECURRENCES.has(String(recurrence))) {
      return res.status(400).json({
        status: 'fail',
        message: 'Recurrence value is not supported.',
      });
    }
    const normalizedRecurrence = normalizeRecurrence(recurrence);

    const address = typeof req.body.address === 'string' ? req.body.address.trim() : '';
    if (!isValidHexAddress(address)) {
      return res.status(400).json({
        status: 'fail',
        message: 'Please provide a valid Polymarket address (0x…).',
      });
    }

    const apiKeyInput = typeof req.body.apiKey === 'string' ? req.body.apiKey.trim() : '';
    const secretInput = typeof req.body.secret === 'string' ? req.body.secret.trim() : '';
    const passphraseInput = typeof req.body.passphrase === 'string' ? req.body.passphrase.trim() : '';

    const apiKeyEnv = String(process.env.POLYMARKET_API_KEY || process.env.CLOB_API_KEY || '').trim();
    const secretEnv = String(process.env.POLYMARKET_SECRET || process.env.CLOB_SECRET || '').trim();
    const passphraseEnv = String(
      process.env.POLYMARKET_PASSPHRASE || process.env.CLOB_PASS_PHRASE || ''
    ).trim();

    const apiKey = apiKeyInput || apiKeyEnv;
    const secret = secretInput || secretEnv;
    const passphrase = passphraseInput || passphraseEnv;

    const tradesSourceSetting = String(process.env.POLYMARKET_TRADES_SOURCE || 'auto').trim().toLowerCase();
    const requiresClobCreds =
      tradesSourceSetting === 'clob' || tradesSourceSetting === 'l2' || tradesSourceSetting === 'clob-l2';

    if (requiresClobCreds && (!apiKey || !secret || !passphrase)) {
      return res.status(400).json({
        status: 'fail',
        message:
          'Polymarket credentials are required. Provide apiKey/secret/passphrase or set POLYMARKET_API_KEY, POLYMARKET_SECRET, POLYMARKET_PASSPHRASE in server config.',
      });
    }

    const authAddressEnv = String(
      process.env.POLYMARKET_AUTH_ADDRESS || process.env.POLYMARKET_ADDRESS || ''
    ).trim();
    const usingEnvCreds = !(apiKeyInput || secretInput || passphraseInput);
    if (requiresClobCreds && usingEnvCreds) {
      if (!authAddressEnv) {
        return res.status(400).json({
          status: 'fail',
          message:
            'POLYMARKET_AUTH_ADDRESS is required when using server .env Polymarket keys. Set it to the wallet address that generated your POLYMARKET_API_KEY.',
        });
      }
      if (!isValidHexAddress(authAddressEnv)) {
        return res.status(400).json({
          status: 'fail',
          message: 'POLYMARKET_AUTH_ADDRESS is set but invalid (expected 0x…).',
        });
      }
    }

    const backfillRequested = (() => {
      if (req.body.backfill === true) {
        return true;
      }
      if (req.body.backfill === false || req.body.backfill === null || req.body.backfill === undefined) {
        return false;
      }
      const normalized = String(req.body.backfill || '').trim().toLowerCase();
      return normalized === 'true' || normalized === '1' || normalized === 'yes';
    })();

    const sizeToBudget = (() => {
      if (req.body.sizeToBudget === true) {
        return true;
      }
      if (req.body.sizeToBudget === false || req.body.sizeToBudget === null || req.body.sizeToBudget === undefined) {
        return false;
      }
      const normalized = String(req.body.sizeToBudget || '').trim().toLowerCase();
      return normalized === 'true' || normalized === '1' || normalized === 'yes';
    })();

    const requestedExecutionMode = (() => {
      const raw = String(req.body.executionMode ?? '').trim().toLowerCase();
      if (raw === 'live' || raw === 'real') {
        return 'live';
      }
      if (raw === 'paper' || raw === 'dry' || raw === 'dry-run' || raw === 'dryrun') {
        return 'paper';
      }

      const realMoneyRaw = req.body.realMoney ?? req.body.realTrading ?? req.body.liveTrading ?? req.body.enableRealTrading;
      if (realMoneyRaw === true) {
        return 'live';
      }
      if (realMoneyRaw === false) {
        return 'paper';
      }
      const normalized = String(realMoneyRaw ?? '').trim().toLowerCase();
      if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
        return 'live';
      }
      if (normalized === 'false' || normalized === '0' || normalized === 'no') {
        return 'paper';
      }
      return 'paper';
    })();

    const encryptionKey = String(process.env.ENCRYPTION_KEY || process.env.CryptoJS_secret_key || '').trim();
    const encryptIfPossible = (value) => {
      const raw = String(value || '').trim();
      if (!raw) {
        return raw;
      }
      if (raw.startsWith('U2Fsd')) {
        return raw;
      }
      if (!encryptionKey) {
        return raw;
      }
      try {
        return CryptoJS.AES.encrypt(raw, encryptionKey).toString();
      } catch (error) {
        return raw;
      }
    };

    const now = new Date();
    const strategy_id = crypto.randomBytes(16).toString('hex');
    const strategyLabel = requestedExecutionMode === 'live'
      ? 'Polymarket copy trader (real money)'
      : 'Polymarket copy trader (paper)';
    const strategySummary = requestedExecutionMode === 'live'
      ? 'Copies trades from a Polymarket account and executes them with real money.'
      : 'Copies trades from a Polymarket account into a paper portfolio.';

    const strategy = new Strategy({
      userId: userKey,
      provider: 'polymarket',
      name: rawName,
      strategy: strategyLabel,
      strategy_id,
      recurrence: normalizedRecurrence,
      summary: strategySummary,
      decisions: [],
      symphonyUrl: null,
    });

    await strategy.save();

    const portfolio = new Portfolio({
      userId: userKey,
      provider: 'polymarket',
      name: rawName,
      strategy_id,
      recurrence: normalizedRecurrence,
      initialInvestment: cashLimit,
      cashBuffer: cashLimit,
      retainedCash: cashLimit,
      lastRebalancedAt: null,
      nextRebalanceAt: computeNextRebalanceAt(normalizedRecurrence, now),
      budget: cashLimit,
      cashLimit: cashLimit,
      rebalanceCount: 0,
      pnlValue: 0,
      pnlPercent: 0,
      lastPerformanceComputedAt: now,
      stocks: [],
      polymarket: {
        address,
        executionMode: requestedExecutionMode,
        sizeToBudget,
        authAddress: authAddressEnv || null,
        backfillPending: backfillRequested,
        backfilledAt: null,
        // If the user provided explicit keys, store them encrypted; otherwise rely on server env vars.
        apiKey: apiKeyInput ? encryptIfPossible(apiKey) : null,
        secret: secretInput ? encryptIfPossible(secret) : null,
        passphrase: passphraseInput ? encryptIfPossible(passphrase) : null,
        lastTradeMatchTime: now.toISOString(),
        lastTradeId: null,
      },
    });

    await portfolio.save();

    await recordStrategyLog({
      strategyId: strategy_id,
      userId: userKey,
      strategyName: rawName,
      message: 'Polymarket strategy created',
      details: {
        provider: 'polymarket',
        recurrence: normalizedRecurrence,
        nextRebalanceAt: portfolio.nextRebalanceAt,
        executionMode: requestedExecutionMode,
        cashLimit,
        address,
        backfill: backfillRequested,
      },
    });

    const initialMode = backfillRequested ? 'backfill' : 'incremental';

    await recordStrategyLog({
      strategyId: strategy_id,
      userId: userKey,
      strategyName: rawName,
      message: 'Polymarket initial sync queued',
      details: {
        provider: 'polymarket',
        mode: initialMode,
      },
    });

    // Run the initial sync asynchronously so the UI isn't blocked by a long backfill/retries.
    setImmediate(async () => {
      try {
        const fresh = await Portfolio.findOne({ strategy_id, userId: userKey });
        if (!fresh) {
          await recordStrategyLog({
            strategyId: strategy_id,
            userId: userKey,
            strategyName: rawName,
            level: 'warn',
            message: 'Polymarket initial sync skipped (portfolio not found)',
            details: { provider: 'polymarket', mode: initialMode },
          });
          return;
        }

        await recordStrategyLog({
          strategyId: strategy_id,
          userId: userKey,
          strategyName: rawName,
          message: 'Polymarket initial sync started',
          details: { provider: 'polymarket', mode: initialMode },
        });

        await syncPolymarketPortfolio(fresh, { mode: initialMode });
      } catch (error) {
        await recordStrategyLog({
          strategyId: strategy_id,
          userId: userKey,
          strategyName: rawName,
          level: 'warn',
          message: 'Polymarket initial sync failed',
          details: {
            provider: 'polymarket',
            mode: initialMode,
            error: String(error?.message || error),
          },
        });
      }
    });

    return res.status(200).json({
      status: 'success',
      message: 'Polymarket strategy created.',
      strategyId: strategy_id,
      schedule: {
        recurrence: normalizedRecurrence,
        nextRebalanceAt: portfolio.nextRebalanceAt,
      },
    });
  } catch (error) {
    const isDuplicate = error?.code === 11000;
    if (isDuplicate) {
      return res.status(409).json({
        status: 'fail',
        message: 'A strategy with this name already exists.',
      });
    }
    console.error('[Polymarket] Failed to create strategy:', error.message);
    return res.status(500).json({
      status: 'fail',
      message: error.message || 'Failed to create Polymarket strategy.',
    });
  }
};

exports.getPolymarketBalanceAllowance = async (req, res) => {
  try {
    const { userId } = req.params;
    const userKey = String(userId || '');
    if (!userKey || req.user !== userKey) {
      return res.status(403).json({
        status: 'fail',
        message: "Credentials couldn't be validated.",
      });
    }

    const { balance, allowance } = await fetchPolymarketBalanceAllowance();
    const balanceNum = Number(balance);
    const allowanceNum = Number(allowance);
    const available =
      Number.isFinite(balanceNum) && Number.isFinite(allowanceNum) ? Math.min(balanceNum, allowanceNum) : null;

    return res.status(200).json({
      status: 'success',
      balance,
      allowance,
      available,
    });
  } catch (error) {
    return res.status(500).json({
      status: 'fail',
      message: error?.message || 'Failed to fetch Polymarket balance.',
    });
  }
};



exports.getStrategyLogs = async (req, res) => {
  try {
    const { userId, strategyId } = req.params;

    if (req.user !== userId) {
      return res.status(403).json({
        status: 'fail',
        message: 'Credentials could not be validated.',
      });
    }

    const logs = await StrategyLog.find({
      strategy_id: strategyId,
      userId: String(userId),
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return res.status(200).json({
      status: 'success',
      logs,
    });
  } catch (error) {
    console.error('Error fetching strategy logs:', error.message);
    return res.status(500).json({
      status: 'fail',
      message: 'Failed to load strategy logs',
    });
  }
};

exports.getStrategyEquityHistory = async (req, res) => {
  try {
    const { userId, strategyId } = req.params;
    if (!userId || !strategyId) {
      return res.status(400).json({
        status: 'fail',
        message: 'Missing userId or strategyId',
      });
    }

    const limitParam = Number(req.query?.limit);
    const limit = Number.isFinite(limitParam)
      ? Math.min(1000, Math.max(1, Math.floor(limitParam)))
      : 180;

    const startDate = req.query?.startDate ? new Date(req.query.startDate) : null;
    const filter = {
      userId: String(userId),
      strategy_id: String(strategyId),
    };
    if (startDate && !Number.isNaN(startDate.getTime())) {
      filter.createdAt = { $gte: startDate };
    }

    const snapshots = await StrategyEquitySnapshot.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const data = snapshots
      .map((snapshot) => ({
        strategyId: snapshot.strategy_id,
        timestamp: snapshot.createdAt,
        equityValue: roundToTwo(snapshot.equityValue),
        holdingsMarketValue: roundToTwo(snapshot.holdingsMarketValue),
        retainedCash: roundToTwo(snapshot.retainedCash),
        pnlValue: roundToTwo(snapshot.pnlValue),
        cashLimit: roundToTwo(snapshot.cashLimit),
      }))
      .reverse();

    return res.status(200).json({
      status: 'success',
      results: data.length,
      data,
    });
  } catch (error) {
    console.error('[Strategies] Failed to fetch equity history:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Unable to fetch strategy equity history.',
    });
  }
};

exports.getEquityBackfillStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    if (req.user !== userId) {
      return res.status(403).json({
        status: 'fail',
        message: 'Credentials could not be validated.',
      });
    }
    const task = await MaintenanceTask.findOne({ taskName: EQUITY_BACKFILL_TASK }).lean();
    return res.status(200).json({
      status: 'success',
      data: {
        taskName: EQUITY_BACKFILL_TASK,
        status: task?.status || 'pending',
        startedAt: task?.startedAt,
        completedAt: task?.completedAt,
        metadata: task?.metadata || null,
        lastError: task?.lastError || null,
      },
    });
  } catch (error) {
    console.error('[Strategies] Failed to fetch backfill status:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Unable to fetch backfill status.',
    });
  }
};

exports.triggerEquityBackfill = async (req, res) => {
  try {
    const { userId } = req.params;
    if (req.user !== userId) {
      return res.status(403).json({
        status: 'fail',
        message: 'Credentials could not be validated.',
      });
    }

    const result = await runEquityBackfill({ initiatedBy: userId });
    return res.status(200).json({
      status: 'success',
      result,
    });
  } catch (error) {
    console.error('[Strategies] Equity backfill failed:', error.message);
    return res.status(500).json({
      status: 'error',
      message: error?.message || 'Equity backfill failed.',
    });
  }
};

exports.updateStrategyRecurrence = async (req, res) => {
  try {
    const { userId, strategyId } = req.params;
    const { recurrence } = req.body || {};

    if (!recurrence) {
      return res.status(400).json({
        status: 'fail',
        message: 'Recurrence value is required.',
      });
    }

    if (!VALID_RECURRENCES.has(String(recurrence))) {
      return res.status(400).json({
        status: 'fail',
        message: 'Recurrence value is not supported.',
      });
    }

    if (req.user !== userId) {
      return res.status(403).json({
        status: 'fail',
        message: 'Credentials could not be validated.',
      });
    }

    const normalizedRecurrence = normalizeRecurrence(recurrence);
    if (!normalizedRecurrence) {
      return res.status(400).json({
        status: 'fail',
        message: 'Recurrence value is not supported.',
      });
    }

    const portfolio = await Portfolio.findOne({ strategy_id: strategyId, userId: String(userId) });
    if (!portfolio) {
      return res.status(404).json({
        status: 'fail',
        message: 'Portfolio not found for this strategy.',
      });
    }

    const strategy = await Strategy.findOne({ strategy_id: strategyId, userId: String(userId) });

    const now = new Date();
    const provisionalNext = computeNextRebalanceAt(normalizedRecurrence, now);
    let nextRebalanceAt = provisionalNext;
    try {
      const alpacaConfig = await getAlpacaConfig(userId);
      if (alpacaConfig?.hasValidKeys) {
        const tradingKeys = alpacaConfig.getTradingKeys();
        nextRebalanceAt = await alignToRebalanceWindowStart(tradingKeys, provisionalNext);
      }
    } catch (error) {
      nextRebalanceAt = provisionalNext;
    }

    portfolio.recurrence = normalizedRecurrence;
    portfolio.nextRebalanceAt = nextRebalanceAt;
    portfolio.nextRebalanceManual = false;
    await portfolio.save();

    if (strategy) {
      strategy.recurrence = normalizedRecurrence;
      await strategy.save();
    }

    await recordStrategyLog({
      strategyId,
      userId: String(userId),
      strategyName: portfolio.name,
      message: 'Strategy frequency updated',
      details: {
        recurrence: normalizedRecurrence,
        nextRebalanceAt,
      },
    });

    return res.status(200).json({
      status: 'success',
      recurrence: normalizedRecurrence,
      nextRebalanceAt,
    });
  } catch (error) {
    console.error('Error updating strategy recurrence:', error.message);
    return res.status(500).json({
      status: 'fail',
      message: 'Failed to update recurrence',
    });
  }
};

exports.updateNextRebalanceDate = async (req, res) => {
  try {
    const { userId, strategyId } = req.params;
    const { nextRebalanceAt } = req.body || {};

    if (!nextRebalanceAt) {
      return res.status(400).json({
        status: 'fail',
        message: 'nextRebalanceAt is required.',
      });
    }

    if (req.user !== userId) {
      return res.status(403).json({
        status: 'fail',
        message: "Credentials couldn't be validated.",
      });
    }

    const parsedDate = new Date(nextRebalanceAt);
    if (!parsedDate || Number.isNaN(parsedDate.getTime())) {
      return res.status(400).json({
        status: 'fail',
        message: 'Invalid nextRebalanceAt value.',
      });
    }

    if (parsedDate.getTime() <= Date.now()) {
      return res.status(400).json({
        status: 'fail',
        message: 'Next reallocation must be scheduled in the future.',
      });
    }

    const portfolio = await Portfolio.findOne({ strategy_id: strategyId, userId: String(userId) });
    if (!portfolio) {
      return res.status(404).json({
        status: 'fail',
        message: 'Portfolio not found for this strategy.',
      });
    }

    const provider = String(portfolio.provider || 'alpaca');
    if (provider !== 'polymarket') {
      const alpacaConfig = await getAlpacaConfig(userId);
      if (!alpacaConfig?.hasValidKeys) {
        return res.status(400).json({
          status: 'fail',
          message: 'Invalid Alpaca credentials; cannot validate market hours for scheduling.',
        });
      }
      const tradingKeys = alpacaConfig.getTradingKeys();
      const session = await fetchNextMarketSessionAfter(tradingKeys, parsedDate);
      if (!session?.activeSession) {
        return res.status(400).json({
          status: 'fail',
          message: 'Manual reschedule must be within market open hours on a trading day.',
        });
      }
      const openTime = session.activeSession.open;
      const closeTime = session.activeSession.close;
      if (!openTime || !closeTime || parsedDate < openTime || parsedDate >= closeTime) {
        return res.status(400).json({
          status: 'fail',
          message: 'Manual reschedule must be within market open hours on a trading day.',
        });
      }
    }

    portfolio.nextRebalanceAt = parsedDate;
    portfolio.nextRebalanceManual = true;
    await portfolio.save();

    await recordStrategyLog({
      strategyId,
      userId: String(userId),
      strategyName: portfolio.name,
      message: 'Next reallocation updated manually',
      details: {
        nextRebalanceAt: parsedDate,
        nextRebalanceManual: true,
        requestedBy: userId,
      },
    });

    return res.status(200).json({
      status: 'success',
      nextRebalanceAt: parsedDate,
    });
  } catch (error) {
    console.error('Error updating next reallocation:', error.message);
    return res.status(500).json({
      status: 'fail',
      message: 'Failed to update next reallocation date.',
    });
  }
};

exports.updateStrategyMetadata = async (req, res) => {
  try {
    const { userId, strategyId } = req.params;
    const userKey = String(userId || '');

    if (!userKey || req.user !== userKey) {
      return res.status(403).json({
        status: 'fail',
        message: "Credentials couldn't be validated.",
      });
    }

    const payload = req.body || {};
    const updates = {};

    if (payload.name !== undefined) {
      const nextName = String(payload.name || '').trim();
      if (!nextName) {
        return res.status(400).json({
          status: 'fail',
          message: 'Strategy name cannot be empty.',
        });
      }
      updates.name = nextName;
    }

    if (payload.symphonyUrl !== undefined) {
      try {
        updates.symphonyUrl = parseOptionalHttpUrl(payload.symphonyUrl);
      } catch (error) {
        return res.status(400).json({
          status: 'fail',
          message: error.message || 'Invalid Symphony URL.',
        });
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        status: 'fail',
        message: 'No metadata updates provided.',
      });
    }

    const existing = await Strategy.findOne({ strategy_id: strategyId, userId: userKey });
    if (!existing) {
      return res.status(404).json({
        status: 'fail',
        message: 'Strategy not found.',
      });
    }

    if (updates.name && updates.name !== existing.name) {
      const conflict = await Strategy.findOne({
        userId: userKey,
        name: updates.name,
        strategy_id: { $ne: strategyId },
      }).lean();
      if (conflict) {
        return res.status(409).json({
          status: 'fail',
          message: `A strategy named "${updates.name}" already exists. Please choose another name.`,
        });
      }
    }

    const updated = await Strategy.findOneAndUpdate(
      { strategy_id: strategyId, userId: userKey },
      { $set: updates },
      { new: true }
    ).lean();

    if (updates.name) {
      await Portfolio.updateOne(
        { strategy_id: strategyId, userId: userKey },
        { $set: { name: updates.name } }
      );
    }

    await recordStrategyLog({
      strategyId,
      userId: userKey,
      strategyName: updated?.name || existing.name,
      message: 'Strategy metadata updated',
      details: updates,
    });

    return res.status(200).json({
      status: 'success',
      strategy: {
        id: updated?.strategy_id || strategyId,
        name: updated?.name || existing.name,
        symphonyUrl: updated?.symphonyUrl || null,
      },
    });
  } catch (error) {
    console.error('Error updating strategy metadata:', error.message);
    return res.status(500).json({
      status: 'fail',
      message: 'Failed to update strategy metadata.',
    });
  }
};

exports.updateComposerHoldings = async (req, res) => {
  try {
    const { userId, strategyId } = req.params;
    const payload = req.body || {};

    if (req.user !== userId) {
      return res.status(403).json({
        status: 'fail',
        message: "Credentials couldn't be validated.",
      });
    }

    const holdingsInput = Array.isArray(payload) ? payload : payload.holdings;
    const normalizedHoldings = normalizeComposerHoldings(holdingsInput);

    if (!normalizedHoldings.length) {
      return res.status(400).json({
        status: 'fail',
        message: 'Holdings list is empty or invalid.',
      });
    }

    const portfolio = await Portfolio.findOne({ strategy_id: strategyId, userId: String(userId) });
    if (!portfolio) {
      return res.status(404).json({
        status: 'fail',
        message: 'Portfolio not found for this strategy.',
      });
    }

    portfolio.composerHoldings = normalizedHoldings;
    portfolio.composerHoldingsUpdatedAt = new Date();
    portfolio.composerHoldingsSource = payload.source ? String(payload.source) : 'manual';
    await portfolio.save();

    return res.status(200).json({
      status: 'success',
      composerHoldings: normalizedHoldings,
      updatedAt: portfolio.composerHoldingsUpdatedAt,
      source: portfolio.composerHoldingsSource,
    });
  } catch (error) {
    console.error('[ComposerHoldings] Failed to update composer holdings:', error.message);
    return res.status(500).json({
      status: 'fail',
      message: 'Failed to update composer holdings.',
    });
  }
};

exports.getComposerHoldings = async (req, res) => {
  try {
    const { userId, strategyId } = req.params;
    if (req.user !== userId) {
      return res.status(403).json({
        status: 'fail',
        message: "Credentials couldn't be validated.",
      });
    }

    const portfolio = await Portfolio.findOne({ strategy_id: strategyId, userId: String(userId) }).lean();
    if (!portfolio) {
      return res.status(404).json({
        status: 'fail',
        message: 'Portfolio not found for this strategy.',
      });
    }

    const composerHoldings = normalizeComposerHoldings(portfolio.composerHoldings || []);
    return res.status(200).json({
      status: 'success',
      composerHoldings,
      updatedAt: portfolio.composerHoldingsUpdatedAt || null,
      source: portfolio.composerHoldingsSource || null,
    });
  } catch (error) {
    console.error('[ComposerHoldings] Failed to fetch composer holdings:', error.message);
    return res.status(500).json({
      status: 'fail',
      message: 'Failed to fetch composer holdings.',
    });
  }
};

exports.compareComposerHoldings = async (req, res) => {
  try {
    const { userId, strategyId } = req.params;
    const tolerance = Number(req.query?.tolerance ?? 0.01);

    if (req.user !== userId) {
      return res.status(403).json({
        status: 'fail',
        message: "Credentials couldn't be validated.",
      });
    }

    const portfolio = await Portfolio.findOne({ strategy_id: strategyId, userId: String(userId) }).lean();
    if (!portfolio) {
      return res.status(404).json({
        status: 'fail',
        message: 'Portfolio not found for this strategy.',
      });
    }

    const composerHoldings = normalizeComposerHoldings(portfolio.composerHoldings || []);
    if (!composerHoldings.length) {
      return res.status(400).json({
        status: 'fail',
        message: 'No composer holdings stored for this portfolio.',
      });
    }

    const alpacaConfig = await getAlpacaConfig(userId);
    if (!alpacaConfig?.hasValidKeys) {
      return res.status(403).json({
        status: 'fail',
        message: alpacaConfig?.error || 'Invalid Alpaca credentials',
      });
    }

    const tradingKeys = alpacaConfig.getTradingKeys();
    const dataKeys = alpacaConfig.getDataKeys();

    const positionsResponse = await tradingKeys.client.get(`${tradingKeys.apiUrl}/v2/positions`, {
      headers: {
        'APCA-API-KEY-ID': tradingKeys.keyId,
        'APCA-API-SECRET-KEY': tradingKeys.secretKey,
      },
    });

    const positions = Array.isArray(positionsResponse.data) ? positionsResponse.data : [];
    const alpacaMap = new Map();
    const priceCache = {};

    positions.forEach((position) => {
      const symbol = sanitizeSymbol(position.symbol);
      if (!symbol) {
        return;
      }
      const qty = toNumber(position.qty, 0);
      const price = toNumber(position.current_price, toNumber(position.avg_entry_price, null));
      alpacaMap.set(symbol, { symbol, quantity: qty, price });
      if (Number.isFinite(price)) {
        priceCache[symbol] = price;
      }
    });

    const missingSymbols = composerHoldings
      .map((entry) => entry.symbol)
      .filter((symbol) => symbol && priceCache[symbol] == null);

    if (missingSymbols.length) {
      const fetchedPrices = await fetchLatestPrices(missingSymbols, dataKeys);
      Object.assign(priceCache, fetchedPrices);
    }

    const composeValue = (entry, price) => {
      if (Number.isFinite(entry.value)) {
        return entry.value;
      }
      if (Number.isFinite(entry.quantity) && Number.isFinite(price)) {
        return entry.quantity * price;
      }
      return null;
    };

    const deriveQty = (entry, price) => {
      if (Number.isFinite(entry.quantity)) {
        return entry.quantity;
      }
      if (Number.isFinite(entry.value) && Number.isFinite(price) && price > 0) {
        return entry.value / price;
      }
      return null;
    };

    const composerEntries = composerHoldings.map((entry) => {
      const price = Number.isFinite(priceCache[entry.symbol]) ? priceCache[entry.symbol] : null;
      const quantity = deriveQty(entry, price);
      const value = composeValue({ ...entry, quantity }, price);
      return {
        symbol: entry.symbol,
        quantity,
        value,
        weight: Number.isFinite(entry.weight) ? entry.weight : null,
        price,
      };
    });

    const composerTotalValue = composerEntries.reduce((sum, entry) => {
      return sum + (Number.isFinite(entry.value) ? entry.value : 0);
    }, 0);

    const alpacaEntries = Array.from(alpacaMap.values()).map((entry) => {
      const price = Number.isFinite(entry.price) ? entry.price : null;
      const value = Number.isFinite(price) ? entry.quantity * price : null;
      return {
        symbol: entry.symbol,
        quantity: entry.quantity,
        value,
        price,
      };
    });

    const alpacaTotalValue = alpacaEntries.reduce((sum, entry) => {
      return sum + (Number.isFinite(entry.value) ? entry.value : 0);
    }, 0);

    const symbolSet = new Set([
      ...composerEntries.map((entry) => entry.symbol),
      ...alpacaEntries.map((entry) => entry.symbol),
    ]);

    const diffs = Array.from(symbolSet).map((symbol) => {
      const composer = composerEntries.find((entry) => entry.symbol === symbol) || null;
      const alpaca = alpacaEntries.find((entry) => entry.symbol === symbol) || null;
      const composerValue = Number.isFinite(composer?.value) ? composer.value : null;
      const alpacaValue = Number.isFinite(alpaca?.value) ? alpaca.value : null;
      const composerWeight = Number.isFinite(composer?.weight)
        ? composer.weight
        : composerTotalValue > 0 && Number.isFinite(composerValue)
          ? composerValue / composerTotalValue
          : null;
      const alpacaWeight = alpacaTotalValue > 0 && Number.isFinite(alpacaValue)
        ? alpacaValue / alpacaTotalValue
        : null;
      const composerQty = Number.isFinite(composer?.quantity) ? composer.quantity : 0;
      const alpacaQty = Number.isFinite(alpaca?.quantity) ? alpaca.quantity : 0;
      const qtyDiff = alpacaQty - composerQty;
      const reasons = [];

      if (!composer) {
        reasons.push('Missing in composer snapshot.');
      }
      if (!alpaca) {
        reasons.push('Missing in Alpaca positions.');
      }
      if (!Number.isFinite(composer?.price) && !Number.isFinite(alpaca?.price)) {
        reasons.push('Missing price data for comparison.');
      }
      if (!Number.isFinite(composer?.quantity) && Number.isFinite(composer?.weight)) {
        reasons.push('Composer entry missing quantity (weight-only).');
      }

      return {
        symbol,
        composerQty: Number.isFinite(composer?.quantity) ? composer.quantity : null,
        alpacaQty: Number.isFinite(alpaca?.quantity) ? alpaca.quantity : null,
        qtyDiff: Number.isFinite(qtyDiff) ? qtyDiff : null,
        composerWeight,
        alpacaWeight,
        composerValue,
        alpacaValue,
        reasons,
      };
    });

    const mismatches = diffs.filter((entry) => Math.abs(toNumber(entry.qtyDiff, 0)) > tolerance);

    return res.status(200).json({
      status: 'success',
      summary: {
        total: diffs.length,
        mismatched: mismatches.length,
        tolerance,
        composerTotalValue: composerTotalValue || null,
        alpacaTotalValue: alpacaTotalValue || null,
      },
      differences: diffs,
      mismatches,
      composerHoldings: composerEntries,
      alpacaHoldings: alpacaEntries,
    });
  } catch (error) {
    console.error('[ComposerHoldings] Failed to compare composer holdings:', error.message);
    return res.status(500).json({
      status: 'fail',
      message: 'Failed to compare composer holdings.',
    });
  }
};

const isComposerUrl = (value) => {
  try {
    const parsed = new URL(String(value));
    const host = String(parsed.hostname || '').toLowerCase();
    return (
      host === 'composer.trade' ||
      host.endsWith('.composer.trade') ||
      host === 'app.composer.trade' ||
      host === 'investcomposer.com' ||
      host.endsWith('.investcomposer.com')
    );
  } catch {
    return false;
  }
};

const normalizeWeightRows = (rows = []) => {
  const mapped = (rows || [])
    .map((row) => {
      const symbol = sanitizeSymbol(row?.symbol);
      const weight = toNumber(row?.weight, null);
      if (!symbol || !Number.isFinite(weight)) {
        return null;
      }
      return { symbol, weight };
    })
    .filter(Boolean);
  mapped.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return mapped;
};

const toDateKey = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
};

const addDays = (dayKey, days) => {
  if (!dayKey || !/^\d{4}-\d{2}-\d{2}$/.test(String(dayKey))) {
    return null;
  }
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return toDateKey(date);
};

	const compareWeightRows = ({ composer, tradingApp, tolerance }) => {
	  const composerMap = new Map(composer.map((row) => [row.symbol, row.weight]));
	  const tradingMap = new Map(tradingApp.map((row) => [row.symbol, row.weight]));
	  const symbols = Array.from(new Set([...composerMap.keys(), ...tradingMap.keys()])).sort();
	  const diffs = symbols.map((symbol) => {
    const composerWeight = composerMap.get(symbol) ?? 0;
    const tradingAppWeight = tradingMap.get(symbol) ?? 0;
    const diff = Math.abs(composerWeight - tradingAppWeight);
    return { symbol, composerWeight, tradingAppWeight, diff };
  });
  const mismatches = diffs.filter((row) => row.diff > tolerance);
  return { diffs, mismatches };
};

exports.compareComposerHoldingsAll = async (req, res) => {
  try {
    const userId = String(req.params.userId || '');
    if (!userId || req.user !== userId) {
      return res.status(403).json({
        status: 'fail',
        message: "Credentials couldn't be validated.",
      });
    }

    const limit = Math.max(1, Math.min(200, Number(req.query?.limit ?? 50)));
    const tolerance = toNumber(req.query?.tolerance, 0.005);
    const sleepMs = Math.max(0, Math.min(2000, Number(req.query?.sleepMs ?? 150)));
    const asOfMode = String(req.query?.asOfMode || 'previous-close').trim();
    const asOfDate = req.query?.asOfDate ? String(req.query.asOfDate).trim() : null;
    const asOfTargetRaw = req.query?.asOfTarget ?? req.query?.target ?? null;
    const priceSource = req.query?.priceSource ? String(req.query.priceSource).trim() : null;
    const priceRefresh = req.query?.priceRefresh ?? null;
    const dataAdjustment = req.query?.dataAdjustment ? String(req.query.dataAdjustment).trim() : null;
    const rsiMethod = req.query?.rsiMethod ? String(req.query.rsiMethod).trim() : null;
    const debugIndicators = normalizeBoolean(req.query?.debugIndicators) ?? true;
    const simulateHoldings = normalizeBoolean(req.query?.simulateHoldings) ?? true;
    const budgetOverride = toNumber(req.query?.budget, null);
    const strategyTextSource = String(req.query?.strategyTextSource || 'db')
      .trim()
      .toLowerCase(); // db|link

    if (!['db', 'link'].includes(strategyTextSource)) {
      return res.status(400).json({
        status: 'fail',
        message: 'Invalid strategyTextSource. Use "db" or "link".',
      });
    }

    const normalizeAsOfTarget = (value) => {
      const normalized = String(value || '').trim().toLowerCase();
      if (!normalized) {
        return 'next-rebalance';
      }
      if (['next', 'nextrebalance', 'next-rebalance', 'rebalance', 'schedule'].includes(normalized)) {
        return 'next-rebalance';
      }
      if (['composer', 'composer-effective', 'effective', 'snapshot'].includes(normalized)) {
        return 'composer-effective';
      }
      return null;
    };

    const asOfTarget = normalizeAsOfTarget(asOfTargetRaw);
    if (!asOfTarget) {
      return res.status(400).json({
        status: 'fail',
        message: 'Invalid asOfTarget. Use "next-rebalance" or "composer-effective".',
      });
    }

    const portfolios = await Portfolio.find({ userId })
      .select('strategy_id recurrence nextRebalanceAt cashLimit budget lastRebalancedAt')
      .lean();
    const portfolioByStrategyId = new Map();
    (portfolios || []).forEach((portfolio) => {
      const key = portfolio?.strategy_id ? String(portfolio.strategy_id) : null;
      if (key) {
        portfolioByStrategyId.set(key, portfolio);
      }
    });

    const strategies = await Strategy.find({ userId })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean();

    const results = [];

    for (const strategy of strategies) {
      const url = strategy?.symphonyUrl ? String(strategy.symphonyUrl).trim() : null;
      const provider = String(strategy?.provider || 'alpaca').trim().toLowerCase();
      const portfolio = portfolioByStrategyId.get(String(strategy?.strategy_id || '')) || null;

      if (!url || provider === 'polymarket' || !isComposerUrl(url)) {
        continue;
      }

      const entry = {
        id: strategy?.strategy_id || null,
        name: strategy?.name || null,
        symphonyUrl: url,
        status: 'ok',
        errors: [],
        prediction: {
          asOfTarget,
          asOfSource: null,
          requestedAsOf: null,
          nextRebalanceAt: portfolio?.nextRebalanceAt ? new Date(portfolio.nextRebalanceAt).toISOString() : null,
          cashLimit: Number.isFinite(portfolio?.cashLimit) ? Number(portfolio.cashLimit) : null,
          budget: null,
          strategyTextMatchesComposer: null,
          usedIncompleteUniverse: false,
          usedComposerBacktest: false,
          matchesComposer: false,
          canGuaranteeMatchNextRebalance: false,
          confidence: 'unknown',
          reasons: [],
        },
        composer: {
          effectiveAsOfDate: null,
          holdings: [],
          meta: null,
        },
        tradingApp: {
          effectiveAsOfDate: null,
          holdings: [],
          meta: null,
        },
        comparison: {
          diffs: [],
          mismatches: [],
        },
      };

      try {
        const snapshot = await fetchComposerLinkSnapshot({ url });
        entry.composer.effectiveAsOfDate = snapshot.effectiveAsOfDateKey || null;
        entry.composer.holdings = normalizeWeightRows(snapshot.holdings || []);
        const composerHoldingsObject = snapshot.publicHoldingsObject || null;
        const composerLastBacktestValue = snapshot.lastBacktestValue ?? null;

        const dbStrategyText = String(strategy?.strategy || '').trim();
        const strategyText = strategyTextSource === 'link' ? snapshot.strategyText : dbStrategyText;

        entry.prediction.strategyTextMatchesComposer = compareComposerStrategySemantics({
          dbStrategyText,
          linkStrategyText: snapshot?.strategyText ? String(snapshot.strategyText) : null,
        });

        if (!entry.composer.holdings.length) {
          entry.status = 'error';
          entry.errors.push('Unable to extract Composer holdings from link.');
        }
        if (!strategyText) {
          entry.status = 'error';
          entry.errors.push(
            strategyTextSource === 'link'
              ? 'Unable to extract defsymphony text from link.'
              : 'Strategy text missing in DB.'
          );
        }

        if (entry.status === 'ok') {
          const resolvedBudget = Math.max(
            1,
            Number.isFinite(budgetOverride)
              ? budgetOverride
              : toNumber(portfolio?.cashLimit, toNumber(portfolio?.budget, 10000))
          );

          const nextRebalanceAt = portfolio?.nextRebalanceAt ? new Date(portfolio.nextRebalanceAt) : null;
          const resolvedAsOf = (() => {
            if (asOfDate) {
              return { value: asOfDate, source: 'explicit' };
            }
            if (asOfTarget === 'next-rebalance' && nextRebalanceAt) {
              // Use the scheduled rebalance timestamp so the evaluator derives the same "previous-close"
              // effective date it will use during the live rebalance window.
              return { value: nextRebalanceAt, source: 'nextRebalanceAt' };
            }
            return { value: entry.composer.effectiveAsOfDate || null, source: 'composerEffective' };
          })();
          const resolvedAsOfDate = resolvedAsOf.value;

          entry.prediction.requestedAsOf =
            resolvedAsOfDate instanceof Date ? resolvedAsOfDate.toISOString() : resolvedAsOfDate;
          entry.prediction.asOfSource = resolvedAsOf.source;
          entry.prediction.budget = resolvedBudget;

          const maxMissingForFallback = (() => {
            const parsed = Number(process.env.REBALANCE_MAX_MISSING_TICKERS);
            return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3;
          })();

          let local = null;
          let usedIncompleteUniverse = false;
          let strictError = null;
          try {
            local = await runComposerStrategy({
              strategyText,
              budget: resolvedBudget,
              asOfDate: resolvedAsOfDate,
              rsiMethod,
              dataAdjustment,
              debugIndicators,
              asOfMode,
              priceSource,
              priceRefresh,
              requireAsOfDateCoverage: true,
              simulateHoldings,
            });
          } catch (error) {
            strictError = error;
            const missingSymbols = Array.isArray(error?.missingSymbols) ? error.missingSymbols : [];
            const canRetryIncompleteUniverse =
              error?.code === 'INSUFFICIENT_MARKET_DATA' &&
              missingSymbols.length > 0 &&
              missingSymbols.length <= maxMissingForFallback;

            if (canRetryIncompleteUniverse) {
              usedIncompleteUniverse = true;
              local = await runComposerStrategy({
                strategyText,
                budget: resolvedBudget,
                asOfDate: resolvedAsOfDate,
                rsiMethod,
                dataAdjustment,
                debugIndicators,
                asOfMode,
                priceSource,
                priceRefresh,
                requireCompleteUniverse: false,
                requireAsOfDateCoverage: true,
                simulateHoldings,
              });
            } else {
              throw error;
            }
          }

          entry.prediction.usedIncompleteUniverse = usedIncompleteUniverse;

          entry.tradingApp.meta = local?.meta || null;
          entry.tradingApp.effectiveAsOfDate = local?.meta?.localEvaluator?.asOfDate
            ? toDateKey(local.meta.localEvaluator.asOfDate)
            : null;
          const tradingHoldingsSource =
            simulateHoldings && Array.isArray(local?.simulatedHoldings) && local.simulatedHoldings.length
              ? local.simulatedHoldings
              : local?.positions || [];
          entry.tradingApp.holdings = normalizeWeightRows(tradingHoldingsSource);

          const symphonyId = parseSymphonyIdFromUrl(url);
          let composerHoldingsObjectToUse = composerHoldingsObject;
          let composerLastBacktestValueToUse = composerLastBacktestValue;
          let composerBacktestError = null;

          if (asOfTarget === 'next-rebalance' && symphonyId && entry.tradingApp.effectiveAsOfDate) {
            const localMeta = local?.meta?.localEvaluator || {};
            const lookbackDays = Number(localMeta.lookbackDays);
            const resolvedLookback = Number.isFinite(lookbackDays) ? Math.max(30, Math.ceil(lookbackDays)) : 400;
            const endDateKey = entry.tradingApp.effectiveAsOfDate;
            const startDateKey = addDays(endDateKey, -resolvedLookback) || endDateKey;

            try {
              const backtest = await fetchPublicSymphonyBacktestById({
                symphonyId,
                capital: resolvedBudget,
                startDate: startDateKey,
                endDate: endDateKey,
                broker: provider === 'alpaca' ? 'alpaca' : 'alpaca',
                abbreviateDays: 1,
              });
              entry.prediction.usedComposerBacktest = true;
              if (backtest?.effectiveAsOfDateKey) {
                entry.composer.effectiveAsOfDate = backtest.effectiveAsOfDateKey;
              }
              if (backtest?.holdingsObject && Object.keys(backtest.holdingsObject).length) {
                composerHoldingsObjectToUse = backtest.holdingsObject;
              }
              if (backtest?.lastBacktestValue != null) {
                composerLastBacktestValueToUse = backtest.lastBacktestValue;
              }
            } catch (error) {
              entry.prediction.usedComposerBacktest = false;
              composerBacktestError = error;
            }
          }

          if (composerHoldingsObjectToUse) {
            const localMeta = local?.meta?.localEvaluator || {};
            const composerPriceSource = localMeta.priceSource || priceSource || null;
            const composerAdjustment = localMeta.dataAdjustment || dataAdjustment || 'all';
            try {
              const computed = await computeComposerHoldingsWeights({
                holdingsObject: composerHoldingsObjectToUse,
                effectiveAsOfDateKey: entry.composer.effectiveAsOfDate,
                lastBacktestValue: composerLastBacktestValueToUse,
                priceSource: composerPriceSource,
                dataAdjustment: composerAdjustment,
                cacheOnly: true,
                forceRefresh: false,
                concurrency: 4,
              });
              entry.composer.holdings = normalizeWeightRows(computed.holdings || []);
              entry.composer.meta = computed.meta || null;
            } catch (error) {
              const computed = await computeComposerHoldingsWeights({
                holdingsObject: composerHoldingsObjectToUse,
                effectiveAsOfDateKey: entry.composer.effectiveAsOfDate,
                lastBacktestValue: composerLastBacktestValueToUse,
                priceSource: composerPriceSource,
                dataAdjustment: composerAdjustment,
                cacheOnly: false,
                forceRefresh: false,
                concurrency: 2,
              });
              entry.composer.holdings = normalizeWeightRows(computed.holdings || []);
              entry.composer.meta = computed.meta || null;
            }
          }

          entry.comparison = compareWeightRows({
            composer: entry.composer.holdings,
            tradingApp: entry.tradingApp.holdings,
            tolerance,
          });

          const matchesComposer = (entry.comparison?.mismatches || []).length === 0;
          entry.prediction.matchesComposer = matchesComposer;

          const predictionReasons = [];
          const composerEffective = entry.composer.effectiveAsOfDate;
          const tradingEffective = entry.tradingApp.effectiveAsOfDate;
          const asOfAligned =
            !composerEffective || !tradingEffective ? null : composerEffective === tradingEffective;
          if (asOfAligned === false) {
            predictionReasons.push(
              `Effective as-of date differs (Composer=${composerEffective}, TradingApp=${tradingEffective}).`
            );
          }
          if (entry.prediction.strategyTextMatchesComposer === false) {
            predictionReasons.push(
              matchesComposer
                ? 'TradingApp strategy text differs from the defsymphony text extracted from the Composer link (allocations still match for the requested date).'
                : 'TradingApp strategy text differs from the defsymphony text extracted from the Composer link.'
            );
          }
          if (entry.prediction.strategyTextMatchesComposer == null) {
            predictionReasons.push(
              'Unable to verify TradingApp strategy text equivalence with the Composer strategy definition.'
            );
          }
          if (asOfTarget === 'next-rebalance' && !entry.prediction.usedComposerBacktest) {
            const base = 'Composer public backtest did not run for the requested effective date; cannot guarantee parity with Composer at the next rebalance.';
            if (composerBacktestError?.outdatedSeries?.length) {
              predictionReasons.push(
                `${base} Outdated series: ${composerBacktestError.outdatedSeries.join(', ')}.`
              );
            } else if (composerBacktestError?.message) {
              predictionReasons.push(`${base} (${composerBacktestError.message})`);
            } else {
              predictionReasons.push(base);
            }
          }
          if (usedIncompleteUniverse) {
            predictionReasons.push(
              'TradingApp evaluation required skipping missing/stale tickers; results may diverge if the missing tickers affect rankings/conditions.'
            );
          }
          if (asOfTarget === 'next-rebalance' && entry.prediction.asOfSource !== 'nextRebalanceAt' && !asOfDate) {
            predictionReasons.push('Missing nextRebalanceAt schedule; falling back to Composer effective date.');
          }

          const scheduleOk =
            asOfTarget !== 'next-rebalance' ||
            entry.prediction.asOfSource === 'nextRebalanceAt' ||
            entry.prediction.asOfSource === 'explicit';
          const composerBacktestOk = asOfTarget !== 'next-rebalance' || entry.prediction.usedComposerBacktest === true;
          const canGuarantee =
            matchesComposer &&
            asOfAligned === true &&
            !usedIncompleteUniverse &&
            scheduleOk &&
            composerBacktestOk;
          entry.prediction.canGuaranteeMatchNextRebalance = canGuarantee;
          entry.prediction.reasons = predictionReasons;

          if (!matchesComposer) {
            entry.prediction.confidence = 'low';
          } else if (canGuarantee) {
            entry.prediction.confidence = 'high';
          } else {
            const scheduleMismatch =
              asOfTarget === 'next-rebalance' &&
              entry.prediction.asOfSource !== 'nextRebalanceAt' &&
              entry.prediction.asOfSource !== 'explicit';
            const hasCritical =
              asOfAligned !== true ||
              usedIncompleteUniverse ||
              scheduleMismatch ||
              (asOfTarget === 'next-rebalance' && !entry.prediction.usedComposerBacktest);
            entry.prediction.confidence = hasCritical ? 'low' : 'medium';
          }

          if (strictError && usedIncompleteUniverse) {
            entry.prediction.reasons.push(
              `Strict evaluation failed (${strictError.message}); compared using incomplete-universe fallback.`
            );
          }
        }
      } catch (error) {
        entry.status = 'error';
        entry.errors.push(error?.message || String(error));
      }

      results.push(entry);
      if (sleepMs) {
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }
    }

    const mismatched = results.filter((r) => (r.comparison?.mismatches || []).length > 0).length;
    const guaranteed = results.filter((r) => Boolean(r?.prediction?.canGuaranteeMatchNextRebalance)).length;
    const confidenceCounts = results.reduce(
      (acc, row) => {
        const level = String(row?.prediction?.confidence || '').toLowerCase();
        if (level === 'high' || level === 'medium' || level === 'low') {
          acc[level] += 1;
        } else {
          acc.unknown += 1;
        }
        return acc;
      },
      { high: 0, medium: 0, low: 0, unknown: 0 }
    );

    return res.status(200).json({
      status: 'success',
      summary: {
        total: results.length,
        mismatched,
        tolerance,
        guaranteed,
        confidence: confidenceCounts,
      },
      results,
    });
  } catch (error) {
    console.error('[CompareAll] Failed to compare holdings:', error?.message || error);
    return res.status(500).json({
      status: 'fail',
      message: 'Failed to compare holdings.',
    });
  }
};

const pickEvaluatorDebugLines = (reasoning = []) =>
  (Array.isArray(reasoning) ? reasoning : [])
    .filter((line) =>
      typeof line === 'string' &&
      (line.startsWith('Step 1: Loaded') ||
        line.startsWith('Indicator debug:') ||
        line.startsWith('Conditional evaluation:') ||
        line.startsWith('Filter evaluation:'))
    )
    .slice(0, 80);

exports.diagnoseAllocationMismatch = async (req, res) => {
  try {
    const { userId, strategyId } = req.params;
    if (req.user !== userId) {
      return res.status(403).json({
        status: 'fail',
        message: "Credentials couldn't be validated.",
      });
    }

    const portfolio = await Portfolio.findOne({ strategy_id: strategyId, userId: String(userId) }).lean();
    if (!portfolio) {
      return res.status(404).json({
        status: 'fail',
        message: 'Portfolio not found for this strategy.',
      });
    }

    const strategy = await Strategy.findOne({ strategy_id: strategyId, userId: String(userId) }).lean();
    if (!strategy?.strategy) {
      return res.status(404).json({
        status: 'fail',
        message: 'Strategy definition not found for this portfolio.',
      });
    }

    const latestRebalanceLog = await StrategyLog.findOne({
      strategy_id: strategyId,
      userId: String(userId),
      message: 'Portfolio rebalanced',
    })
      .sort({ createdAt: -1 })
      .lean();

    const requestedAsOf = req.query?.asOfDate ?? req.query?.asOf ?? null;
    const requestedAsOfMode = req.query?.asOfMode ?? req.query?.mode ?? null;
    const requestedBudget = toNumber(req.query?.budget, null);

    const defaultAsOf = latestRebalanceLog?.createdAt
      ? new Date(latestRebalanceLog.createdAt).toISOString().slice(0, 10)
      : null;

    const budget =
      requestedBudget ??
      toNumber(portfolio.cashLimit, null) ??
      toNumber(portfolio.budget, null) ??
      toNumber(latestRebalanceLog?.details?.budget, null) ??
      1000;

    const asOfDate = requestedAsOf || defaultAsOf || null;
    const asOfMode = requestedAsOfMode || 'previous-close';

    const base = {
      strategyText: strategy.strategy,
      budget,
      asOfDate,
      asOfMode,
      debugIndicators: true,
      priceRefresh: false,
    };

    const runs = [
      {
        name: 'alpaca_raw_simple',
        params: { ...base, priceSource: 'alpaca', dataAdjustment: 'raw', rsiMethod: 'simple' },
      },
      {
        name: 'alpaca_raw_wilder',
        params: { ...base, priceSource: 'alpaca', dataAdjustment: 'raw', rsiMethod: 'wilder' },
      },
      {
        name: 'alpaca_split_wilder',
        params: { ...base, priceSource: 'alpaca', dataAdjustment: 'split', rsiMethod: 'wilder' },
      },
      {
        name: 'tiingo_split_wilder',
        params: { ...base, priceSource: 'tiingo', dataAdjustment: 'split', rsiMethod: 'wilder' },
      },
      {
        name: 'yahoo_split_wilder',
        params: { ...base, priceSource: 'yahoo', dataAdjustment: 'split', rsiMethod: 'wilder' },
      },
    ];

    const evaluations = [];
    for (const run of runs) {
      try {
        const evaluation = await runComposerStrategy(run.params);
        evaluations.push({
          name: run.name,
          request: {
            budget: run.params.budget,
            asOfDate: run.params.asOfDate || null,
            asOfMode: run.params.asOfMode || null,
            priceSource: run.params.priceSource || null,
            dataAdjustment: run.params.dataAdjustment || null,
            rsiMethod: run.params.rsiMethod || null,
          },
          positions: (evaluation?.positions || []).map((pos) => ({
            symbol: pos.symbol,
            weight: toNumber(pos.weight, null),
            quantity: toNumber(pos.quantity, null),
            estimated_cost: toNumber(pos.estimated_cost, null),
          })),
          meta: evaluation?.meta?.localEvaluator || evaluation?.meta || null,
          indicatorTrace: pickEvaluatorDebugLines(evaluation?.reasoning),
        });
      } catch (error) {
        evaluations.push({
          name: run.name,
          request: {
            budget: run.params.budget,
            asOfDate: run.params.asOfDate || null,
            asOfMode: run.params.asOfMode || null,
            priceSource: run.params.priceSource || null,
            dataAdjustment: run.params.dataAdjustment || null,
            rsiMethod: run.params.rsiMethod || null,
          },
          error: error.message,
        });
      }
    }

    let brokerSnapshot = null;
    const includeBroker = String(req.query?.includeBroker ?? '').trim().toLowerCase();
    const wantBroker = ['1', 'true', 'yes', 'y'].includes(includeBroker);
    if (wantBroker) {
      try {
        const alpacaConfig = await getAlpacaConfig(userId);
        if (alpacaConfig?.hasValidKeys) {
          const tradingKeys = alpacaConfig.getTradingKeys();
          const headers = {
            'APCA-API-KEY-ID': tradingKeys.keyId,
            'APCA-API-SECRET-KEY': tradingKeys.secretKey,
          };
          const [accountResponse, positionsResponse] = await Promise.all([
            tradingKeys.client.get(`${tradingKeys.apiUrl}/v2/account`, { headers }),
            tradingKeys.client.get(`${tradingKeys.apiUrl}/v2/positions`, { headers }),
          ]);
          const positions = Array.isArray(positionsResponse.data) ? positionsResponse.data : [];
          brokerSnapshot = {
            apiUrl: tradingKeys.apiUrl,
            account: {
              cash: toNumber(accountResponse?.data?.cash, null),
              equity: toNumber(accountResponse?.data?.equity, null),
              portfolio_value: toNumber(accountResponse?.data?.portfolio_value, null),
              buying_power: toNumber(accountResponse?.data?.buying_power, null),
            },
            positions: positions
              .map((pos) => ({
                symbol: sanitizeSymbol(pos.symbol),
                qty: toNumber(pos.qty, null),
                market_value: toNumber(pos.market_value, null),
              }))
              .filter((entry) => entry.symbol),
          };
        } else {
          brokerSnapshot = { error: alpacaConfig?.error || 'Invalid Alpaca credentials' };
        }
      } catch (snapshotError) {
        brokerSnapshot = { error: snapshotError.message };
      }
    }

    return res.status(200).json({
      status: 'success',
      portfolio: {
        id: String(portfolio._id),
        name: portfolio.name,
        cashLimit: toNumber(portfolio.cashLimit, null),
        budget: toNumber(portfolio.budget, null),
        initialInvestment: toNumber(portfolio.initialInvestment, null),
        cashBuffer: toNumber(portfolio.cashBuffer, null),
        retainedCash: toNumber(portfolio.retainedCash, null),
        trackedStocks: (portfolio.stocks || []).map((entry) => ({
          symbol: sanitizeSymbol(entry.symbol),
          quantity: toNumber(entry.quantity, null),
          avgCost: toNumber(entry.avgCost, null),
        })),
        composerHoldingsCount: Array.isArray(portfolio.composerHoldings) ? portfolio.composerHoldings.length : 0,
        composerHoldingsUpdatedAt: portfolio.composerHoldingsUpdatedAt || null,
        composerHoldingsSource: portfolio.composerHoldingsSource || null,
      },
      latestRebalance: latestRebalanceLog
        ? {
          createdAt: latestRebalanceLog.createdAt || null,
          budget: toNumber(latestRebalanceLog?.details?.budget, null),
          accountCash: toNumber(latestRebalanceLog?.details?.accountCash, null),
          cashBuffer: toNumber(latestRebalanceLog?.details?.cashBuffer, null),
          indicatorTrace: pickEvaluatorDebugLines(
            latestRebalanceLog?.details?.thoughtProcess?.reasoning || []
          ),
        }
        : null,
      brokerSnapshot,
      evaluations,
      hint:
        'If Composer and TradingApp disagree, compare (1) portfolio cashLimit/budget, (2) as-of mode/date (requested vs effective), (3) price source & adjustment, and (4) RSI method. The runs above show how those settings change the decision path.',
    });
  } catch (error) {
    console.error('[Diagnostics] diagnoseAllocationMismatch failed:', error.message);
    return res.status(500).json({
      status: 'fail',
      message: 'Failed to generate allocation mismatch diagnostics.',
    });
  }
};

exports.rebalanceNow = async (req, res) => {
  try {
    const { userId, strategyId } = req.params;
    if (req.user !== userId) {
      return res.status(403).json({
        status: 'fail',
        message: "Credentials couldn't be validated.",
      });
    }

    if (isRebalanceLocked()) {
      return res.status(409).json({
        status: 'fail',
        message: 'A rebalance is already in progress. Try again in a moment.',
      });
    }

    const requestedMode = String(req.body?.mode || '').trim().toLowerCase();
    await rebalanceNow({ strategyId, userId, mode: requestedMode });

    const latestLog = await StrategyLog.findOne({
      strategy_id: String(strategyId),
      userId: String(userId),
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      status: 'success',
      log: latestLog || null,
    });
  } catch (error) {
    const message = String(error?.message || 'Failed to rebalance now.');
    const statusCode = message.includes('Rebalance already in progress') ? 409 : 500;
    console.error('[RebalanceNow] Failed:', message);
    return res.status(statusCode).json({
      status: 'fail',
      message,
    });
  }
};

exports.getPortfolios = async (req, res) => {
  try {
    const { userId } = req.params;
    const userKey = String(userId || '');

    if (!userId) {
      return res.status(400).json({
        status: 'fail',
        message: 'User ID is required',
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        status: 'fail',
        message: 'User not found',
      });
    }

    let accountCash = 0;
    let positions = [];
    const positionMap = {};
    const priceCache = {};
    let tradingKeys = null;
    let dataKeys = null;

    let alpacaConfig = null;
    try {
      alpacaConfig = await getAlpacaConfig(userId);
    } catch (error) {
      alpacaConfig = null;
    }

    if (alpacaConfig?.hasValidKeys) {
      tradingKeys = alpacaConfig.getTradingKeys();
      dataKeys = alpacaConfig.getDataKeys();

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

      accountCash = toNumber(accountResponse?.data?.cash, 0);
      positions = Array.isArray(positionsResponse.data) ? positionsResponse.data : [];

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
    }

    const rawPortfolios = await Portfolio.find({
      userId: String(userId),
    }).lean();

    if (!rawPortfolios.length) {
      return res.json({
        status: 'success',
        portfolios: [],
        cash: accountCash,
      });
    }

    const symbolsToFetch = new Set();
    rawPortfolios.forEach((portfolio) => {
      if (String(portfolio?.provider || 'alpaca') === 'polymarket') {
        return;
      }
      (portfolio.stocks || []).forEach((stock) => {
        const symbol = sanitizeSymbol(stock.symbol);
        if (symbol && priceCache[symbol] == null) {
          symbolsToFetch.add(symbol);
        }
      });
      (portfolio.targetPositions || []).forEach((target) => {
        const symbol = sanitizeSymbol(target.symbol);
        if (symbol && priceCache[symbol] == null) {
          symbolsToFetch.add(symbol);
        }
      });
    });

    if (symbolsToFetch.size && dataKeys) {
      const headers = {
        'APCA-API-KEY-ID': dataKeys.keyId,
        'APCA-API-SECRET-KEY': dataKeys.secretKey,
      };
      await Promise.all(
        Array.from(symbolsToFetch).map(async (symbol) => {
          try {
            const { data } = await dataKeys.client.get(`${dataKeys.apiUrl}/v2/stocks/${symbol}/trades/latest`, {
              headers,
            });
            const price = toNumber(data?.trade?.p, null);
            if (price) {
              priceCache[symbol] = price;
            }
          } catch (error) {
            console.warn(`[Portfolios] Failed to fetch latest price for ${symbol}: ${error.message}`);
          }
        })
      );
    }

    const now = new Date();
    const symphonyUrlByStrategyId = new Map();
    const strategyIds = Array.from(
      new Set(
        rawPortfolios
          .map((portfolio) => String(portfolio.strategy_id || '').trim())
          .filter(Boolean)
      )
    );
    if (strategyIds.length) {
      const rows = await Strategy.find({
        strategy_id: { $in: strategyIds },
        $or: [
          { userId: userKey },
          { userId: null },
          { userId: '' },
          { userId: { $exists: false } },
        ],
      })
        .select('strategy_id symphonyUrl userId')
        .lean()
        .catch(() => []);

      rows.forEach((row) => {
        const id = row?.strategy_id ? String(row.strategy_id) : '';
        if (!id) {
          return;
        }
        const shouldOverride = !symphonyUrlByStrategyId.has(id) || String(row.userId || '') === userKey;
        if (shouldOverride) {
          symphonyUrlByStrategyId.set(id, row?.symphonyUrl || null);
        }
      });
    }
    const enhancedPortfolios = rawPortfolios.map((portfolio) => {
      const provider = String(portfolio?.provider || 'alpaca');
      let normalizedTargets = normalizeTargetPositions(portfolio.targetPositions || []);
      if (!normalizedTargets.length) {
        normalizedTargets = normalizeTargetPositions(
          (portfolio.stocks || []).map((stock) => ({
            symbol: stock.symbol,
            targetQuantity: stock.quantity,
            targetValue: stock.avgCost && stock.quantity ? stock.avgCost * stock.quantity : null,
          }))
        );
      }

      const stocks = (portfolio.stocks || []).map((stock) => {
        if (provider === 'polymarket') {
          const symbol = stock?.symbol ? String(stock.symbol).trim() : '';
          const storedQuantity = stock.quantity !== undefined && stock.quantity !== null
            ? toNumber(stock.quantity, 0)
            : 0;
          const storedAvgCost = stock.avgCost === null || stock.avgCost === undefined
            ? null
            : toNumber(stock.avgCost, null);
          const storedCurrent = stock.currentPrice === null || stock.currentPrice === undefined
            ? null
            : toNumber(stock.currentPrice, null);
          const hasPendingOrder = storedQuantity > 0 && (storedAvgCost === null || storedCurrent === null);

          const quantity = storedQuantity;
          const avgCost = hasPendingOrder
            ? null
            : storedAvgCost !== null
              ? storedAvgCost
              : storedCurrent;
          const currentPrice = hasPendingOrder
            ? null
            : storedCurrent !== null
              ? storedCurrent
              : storedAvgCost;

          return {
            symbol: symbol || (stock?.asset_id ? String(stock.asset_id) : null),
            market: stock?.market ? String(stock.market) : null,
            asset_id: stock?.asset_id ? String(stock.asset_id) : null,
            outcome: stock?.outcome ? String(stock.outcome) : null,
            avgCost,
            quantity,
            currentPrice,
            orderID: stock.orderID || null,
            pendingQuantity: hasPendingOrder ? storedQuantity : 0,
            pending: Boolean(hasPendingOrder),
            currentTotal: currentPrice !== null ? quantity * currentPrice : null,
          };
        }

        const symbol = sanitizeSymbol(stock.symbol);
        const alpacaPosition = symbol ? positionMap[symbol] : null;
        const storedQuantity = stock.quantity !== undefined && stock.quantity !== null
          ? toNumber(stock.quantity, 0)
          : 0;
        const storedAvgCost = stock.avgCost === null || stock.avgCost === undefined
          ? null
          : toNumber(stock.avgCost, null);
        const hasPendingOrder = storedQuantity > 0 && storedAvgCost === null;

        const quantity = storedQuantity;

        const avgCost = hasPendingOrder
          ? null
          : storedAvgCost !== null
            ? storedAvgCost
            : toNumber(alpacaPosition?.avg_entry_price, null);

        const currentPrice = hasPendingOrder
          ? null
          : symbol && priceCache[symbol] !== undefined
            ? priceCache[symbol]
            : toNumber(
                stock.currentPrice,
                toNumber(alpacaPosition?.current_price, toNumber(alpacaPosition?.avg_entry_price, null))
              );

        return {
          symbol,
          avgCost,
          quantity,
          currentPrice,
          orderID: stock.orderID || null,
          pendingQuantity: hasPendingOrder ? storedQuantity : 0,
          pending: Boolean(hasPendingOrder),
          currentTotal: currentPrice !== null ? quantity * currentPrice : null,
        };
      });
      const hasPendingHoldings = stocks.some((stock) => stock.pending);

      const totalCurrentValue = stocks.reduce((sum, stock) => {
        if (stock.pending || stock.currentTotal === null) {
          return sum;
        }
        return sum + toNumber(stock.currentTotal, 0);
      }, 0);
      const initialInvestment = toNumber(portfolio.initialInvestment, 0);
      const retainedCash = (() => {
        const retained = toNumber(portfolio.retainedCash, null);
        if (retained !== null) {
          return retained;
        }
        return toNumber(portfolio.cashBuffer, 0);
      })();
      const equityBase = hasPendingHoldings ? null : (totalCurrentValue + retainedCash);
      const computedPnlValue = equityBase !== null ? roundToTwo(equityBase - initialInvestment) : null;
      const computedPnlPercent = equityBase !== null && initialInvestment > 0
        ? roundToTwo((computedPnlValue / initialInvestment) * 100)
        : null;
      const storedPnlValue = portfolio.pnlValue !== undefined && portfolio.pnlValue !== null
        ? toNumber(portfolio.pnlValue, null)
        : null;
      const storedPnlPercent = portfolio.pnlPercent !== undefined && portfolio.pnlPercent !== null
        ? toNumber(portfolio.pnlPercent, null)
        : null;
      const pnlValue = computedPnlValue !== null
        ? computedPnlValue
        : storedPnlValue !== null
          ? storedPnlValue
          : totalCurrentValue - initialInvestment;
      const pnlPercent = computedPnlPercent !== null
        ? computedPnlPercent
        : storedPnlPercent !== null
          ? storedPnlPercent
          : (initialInvestment > 0 ? (pnlValue / initialInvestment) * 100 : null);

      return {
        provider,
        name: portfolio.name,
        strategy_id: portfolio.strategy_id,
        symphonyUrl: symphonyUrlByStrategyId.get(String(portfolio.strategy_id || '')) || null,
        recurrence: portfolio.recurrence || 'daily',
        lastRebalancedAt: portfolio.lastRebalancedAt,
        nextRebalanceAt: portfolio.nextRebalanceAt,
        composerHoldingsCount: Array.isArray(portfolio.composerHoldings) ? portfolio.composerHoldings.length : 0,
        composerHoldingsUpdatedAt: portfolio.composerHoldingsUpdatedAt || null,
        composerHoldingsSource: portfolio.composerHoldingsSource || null,
        cashBuffer: retainedCash,
        initialInvestment,
        currentValue: hasPendingHoldings ? null : totalCurrentValue,
        pnlValue,
        pnlPercent,
        targetPositions: normalizedTargets,
        budget: toNumber(portfolio.budget, null),
        cashLimit: toNumber(portfolio.cashLimit, toNumber(portfolio.budget, null)),
        rebalanceCount: toNumber(portfolio.rebalanceCount, 0),
        status: (() => {
          const next = portfolio.nextRebalanceAt ? new Date(portfolio.nextRebalanceAt) : null;
          const last = portfolio.lastRebalancedAt ? new Date(portfolio.lastRebalancedAt) : null;
          if (next && next <= now) {
            return 'pending';
          }
          if (last) {
            return 'running';
          }
          return 'scheduled';
        })(),
        stocks,
        polymarket: provider === 'polymarket'
          ? {
              executionMode: portfolio?.polymarket?.executionMode
                ? String(portfolio.polymarket.executionMode).trim().toLowerCase()
                : null,
            }
          : null,
        isRealMoney:
          provider === 'polymarket' &&
          String(portfolio?.polymarket?.executionMode || '').trim().toLowerCase() === 'live',
      };
    });

    return res.json({
      status: 'success',
      cash: accountCash,
      portfolios: enhancedPortfolios,
    });
  } catch (error) {
    console.error('Error in getPortfolios:', error.message);
    if (error.response) {
      console.error('API Response:', error.response.status, error.response.data);
    }
    return res.status(error.response?.status || 500).json({
      status: 'fail',
      message: 'Failed to fetch strategy portfolios',
      details: error.response?.data || error.message,
    });
  }
};



exports.addPortfolio = async (strategyinput, strategyName, orders, UserID, options = {}) => {
  console.log('strategyName', strategyName);
  console.log('orders', orders);
  console.log('UserID', UserID);

  const {
    budget = null,
    cashLimit = null,
    targetPositions = [],
    recurrence = 'daily',
    initialInvestment: initialInvestmentInput = null,
    summary = '',
    decisions = [],
    reasoning = [],
    orderPlan = null,
    composerMeta = null,
    symphonyUrl = null,
  } = options || {};
  const limitValue = toNumber(cashLimit, null) ?? toNumber(budget, null);
  const finalizedPlan = Array.isArray(orderPlan) ? orderPlan : [];

  let strategy_id;

  try {
    const normalizedRecurrence = normalizeRecurrence(recurrence);
    let targets = normalizeTargetPositions(targetPositions);
    if (!targets.length && Array.isArray(orders)) {
      targets = normalizeTargetPositions(orders);
    }

    const alpacaConfig = await getAlpacaConfig(UserID);
    const alpacaApi = new Alpaca(alpacaConfig);
    const clock = await alpacaApi.getClock();
    const now = new Date();

    if (strategyName === 'AI Fund') {
      strategy_id = '01';
    } else {
      strategy_id = crypto.randomBytes(16).toString('hex');
    }

    const strategy = new Strategy({
      userId: String(UserID || ''),
      name: strategyName,
      strategy: strategyinput,
      strategy_id,
      recurrence: normalizedRecurrence,
      summary: typeof summary === 'string' ? summary : '',
      decisions: Array.isArray(decisions) ? decisions : [],
      symphonyUrl: (() => {
        try {
          return parseOptionalHttpUrl(symphonyUrl) ?? null;
        } catch (error) {
          return null;
        }
      })(),
    });

    await strategy.save();
    console.log('Strategy ' + strategyName + ' has been created.');

    const initialInvestmentEstimate = initialInvestmentInput && initialInvestmentInput > 0
      ? initialInvestmentInput
      : estimateInitialInvestment(targets, limitValue);

    if (!clock.is_open) {
      console.log('Market is closed.');

      const portfolio = new Portfolio({
        userId: String(UserID),
        name: strategyName,
        strategy_id,
        recurrence: normalizedRecurrence,
        initialInvestment: initialInvestmentEstimate,
        cashBuffer: 0,
        retainedCash: 0,
        lastRebalancedAt: null,
        nextRebalanceAt: computeNextRebalanceAt(normalizedRecurrence, now),
        targetPositions: targets,
        budget: toNumber(limitValue, null),
        cashLimit: toNumber(limitValue, null),
        rebalanceCount: 0,
        pnlValue: 0,
        pnlPercent: 0,
        lastPerformanceComputedAt: null,
        stocks: Array.isArray(orders)
          ? orders.map((order) => ({
              symbol: sanitizeSymbol(order.symbol),
              avgCost: null,
              quantity: toNumber(order.qty, 0),
              currentPrice: null,
              orderID: order.orderID,
            }))
          : [],
      });

      const savedPortfolio = await portfolio.save();
      const thoughtProcessPayload = {
        summary: typeof summary === 'string' ? summary : '',
        decisions: Array.isArray(decisions) ? decisions : [],
      };

      if (composerMeta?.localEvaluator) {
        thoughtProcessPayload.tooling = {
          ...(thoughtProcessPayload.tooling || {}),
        };
        thoughtProcessPayload.tooling.localEvaluator = composerMeta.localEvaluator;
      }

      if (Array.isArray(reasoning) && reasoning.length) {
        thoughtProcessPayload.reasoning = reasoning;
      }

      const plannedOrders = finalizedPlan.map((entry) => {
        const symbol = sanitizeSymbol(entry.symbol);
        const qty = toNumber(entry.qty, null);
        let cost = toNumber(entry.cost, null);
        let price = toNumber(entry.price, null);
        if (!Number.isFinite(cost) && Number.isFinite(price) && Number.isFinite(qty)) {
          cost = price * qty;
        }
        if ((!Number.isFinite(price) || price === null) && Number.isFinite(cost) && Number.isFinite(qty) && qty > 0) {
          price = cost / qty;
        }
        return {
          symbol,
          qty,
          price,
          cost,
          targetWeight: toNumber(entry.targetWeight, null),
        };
      }).filter((entry) => entry.symbol && entry.qty > 0);

      const baseDetails = {
        recurrence: normalizedRecurrence,
        initialInvestment: initialInvestmentEstimate,
        cashLimit: toNumber(limitValue, null),
        orderCount: plannedOrders.length,
        orders: plannedOrders,
        thoughtProcess: thoughtProcessPayload,
        humanSummary: buildCreationHumanSummary({
          strategyName,
          summaryText: summary,
          decisions,
          reasoning,
          orders: plannedOrders,
          recurrence: normalizedRecurrence,
          nextRebalanceAt: computeNextRebalanceAt(normalizedRecurrence, now),
          cashLimit: toNumber(limitValue, null),
          initialInvestment: initialInvestmentEstimate,
          status: 'pending',
          originalScript: strategy,
          tooling: thoughtProcessPayload.tooling,
        }),
      };

      await recordStrategyLog({
        strategyId: strategy_id,
        userId: String(UserID),
        strategyName,
        message: 'Strategy created (orders pending fill)',
        details: baseDetails,
      });
      console.log('Portfolio for strategy ' + strategyName + ' has been created. Market is closed so the orders are not filled yet.');
      return savedPortfolio.toObject();
    }

    console.log('Market is open.');
    const numberOfOrders = Array.isArray(orders) ? orders.length : 0;
    const expectedOrderMap = new Map(
      (Array.isArray(orders) ? orders : [])
        .filter((entry) => entry?.orderID)
        .map((entry) => [String(entry.orderID), toNumber(entry.qty, 0)])
    );

    const getOrders = async () => {
      const ordersResponse = await axios({
        method: 'get',
        url: alpacaConfig.apiURL + '/v2/orders',
        headers: {
          'APCA-API-KEY-ID': alpacaConfig.keyId,
          'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
        },
        params: {
          limit: Math.max(numberOfOrders, expectedOrderMap.size || 1) * 2,
          status: 'all',
          nested: true,
        },
      });

      const filtered = expectedOrderMap.size
        ? ordersResponse.data.filter((order) => expectedOrderMap.has(order.client_order_id))
        : ordersResponse.data.slice(0, numberOfOrders);

      if (!filtered.length || filtered.length < (expectedOrderMap.size || numberOfOrders)) {
        throw new Error('Not all submitted orders were returned yet.');
      }

      const outstanding = filtered.filter((order) => {
        const desiredQty = expectedOrderMap.size
          ? expectedOrderMap.get(order.client_order_id)
          : toNumber(order.qty, 0);
        const filledQty = toNumber(order.filled_qty, 0);
        const status = String(order.status || '').toLowerCase();
        const fullyFilled = Number.isFinite(desiredQty) && desiredQty > 0
          ? filledQty >= desiredQty
          : status === 'filled';
        return !(status === 'filled' && fullyFilled);
      });

      if (outstanding.length) {
        throw new Error('Not all orders are closed or filled yet.');
      }

      return filtered;
    };

    let ordersResponse;
    try {
      ordersResponse = await retry(getOrders, 5, 4000);
    } catch (error) {
      console.error('Error:', error);
      throw error;
    }

    const stocks = [];
    let totalInvested = 0;

    ordersResponse.forEach((order) => {
      if (order.side === 'buy') {
        const avgPrice = toNumber(order.filled_avg_price, null);
        const filledQty = toNumber(order.filled_qty, 0);
        totalInvested += (avgPrice || 0) * filledQty;
        stocks.push({
          symbol: sanitizeSymbol(order.symbol),
          avgCost: avgPrice,
          quantity: filledQty,
          currentPrice: avgPrice,
          orderID: order.client_order_id,
        });
      }
    });

    const determinedInitialInvestment = totalInvested || initialInvestmentEstimate || 0;
    const cashBuffer = 0;
    const retainedCash = 0;

    const portfolio = new Portfolio({
      userId: String(UserID),
      name: strategyName,
      strategy_id,
      recurrence: normalizedRecurrence,
      initialInvestment: determinedInitialInvestment,
      cashBuffer,
      retainedCash,
      lastRebalancedAt: now,
      nextRebalanceAt: computeNextRebalanceAt(normalizedRecurrence, now),
      targetPositions: targets,
      budget: toNumber(limitValue, null),
      cashLimit: toNumber(limitValue, null),
      rebalanceCount: 0,
      pnlValue: 0,
      pnlPercent: 0,
      lastPerformanceComputedAt: now,
      stocks,
    });

    const savedPortfolio = await portfolio.save();
    const thoughtProcessPayload = {
      summary: typeof summary === 'string' ? summary : '',
      decisions: Array.isArray(decisions) ? decisions : [],
    };

    if (composerMeta?.localEvaluator) {
      thoughtProcessPayload.tooling = {
        ...(thoughtProcessPayload.tooling || {}),
      };
      thoughtProcessPayload.tooling.localEvaluator = composerMeta.localEvaluator;
    }

    if (Array.isArray(reasoning) && reasoning.length) {
      thoughtProcessPayload.reasoning = reasoning;
    }

    const executedOrders = (Array.isArray(orderPlan) && orderPlan.length ? orderPlan : orders).map((entry) => {
      const symbol = sanitizeSymbol(entry.symbol);
      const qty = toNumber(entry.qty, null);
      let cost = toNumber(entry.cost, null);
      let price = toNumber(entry.price, null);
      if (!Number.isFinite(cost) && Number.isFinite(price) && Number.isFinite(qty)) {
        cost = price * qty;
      }
      if ((!Number.isFinite(price) || price === null) && Number.isFinite(cost) && Number.isFinite(qty) && qty > 0) {
        price = cost / qty;
      }
      return {
        symbol,
        qty,
        price,
        cost,
        targetWeight: toNumber(entry.targetWeight, null),
      };
    }).filter((entry) => entry.symbol && entry.qty > 0);

    const logDetails = {
      recurrence: normalizedRecurrence,
      initialInvestment: determinedInitialInvestment,
      cashBuffer,
      cashLimit: toNumber(limitValue, null),
      orderCount: executedOrders.length,
      orders: executedOrders,
    };

    if (thoughtProcessPayload.summary || thoughtProcessPayload.decisions.length || thoughtProcessPayload.tooling) {
      logDetails.thoughtProcess = thoughtProcessPayload;
    }

    logDetails.humanSummary = buildCreationHumanSummary({
      strategyName,
      summaryText: summary,
      decisions,
      reasoning,
      orders: executedOrders.length ? executedOrders : orders,
      recurrence: normalizedRecurrence,
      nextRebalanceAt: portfolio.nextRebalanceAt,
      cashLimit: toNumber(limitValue, null),
      initialInvestment: determinedInitialInvestment,
      status: 'executed',
      originalScript: strategy,
      tooling: thoughtProcessPayload.tooling,
    });

    await recordStrategyLog({
      strategyId: strategy_id,
      userId: String(UserID),
      strategyName,
      message: 'Strategy created',
      details: logDetails,
    });
    console.log('Portfolio for strategy ' + strategyName + ' has been created.');
    return savedPortfolio.toObject();
  } catch (error) {
    console.error('Error:', error);
    if (strategy_id) {
      await recordStrategyLog({
        strategyId: strategy_id,
        userId: String(UserID),
        strategyName,
        level: 'error',
        message: 'Failed to add portfolio',
        details: { error: error.message },
      });
    }
    throw error;
  }
};

//this is also in strategiesController can be put in utils 
//not exactly here it is symbol not ticker
const getPricesData = async (stocks, marketOpen, userId) => {
  try {
    const alpacaConfig = await getAlpacaConfig(userId);

    const promises = stocks.map(async (stock) => {
      let url;
      if (marketOpen) {
        url = `https://data.alpaca.markets/v2/stocks/${stock.symbol}/trades/latest`;
      } else {
        url = `https://data.alpaca.markets/v2/stocks/${stock.symbol}/bars?timeframe=1D&limit=1`;
      }

      const response = await Axios.get(url, {
        headers: {
          'APCA-API-KEY-ID': alpacaConfig.keyId,
          'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
        },
      });

      const currentPrice = marketOpen ? response.data.trade.p : response.data.bars.c;
      const date = marketOpen ? response.data.trade.t : response.data.bars.t;

      const alpacaApi = new Alpaca(alpacaConfig);
      const asset = await alpacaApi.getAsset(stock.symbol);
      const assetName = asset.name;

      return {
        ticker: stock.symbol,
        date,
        adjClose: currentPrice,
        name: assetName,
      };
    });

    return Promise.all(promises);
  } catch (error) {
    return [];
  }
};

exports.resendCollaborativeOrders = async (req, res) => {
  try {
    const { userId, strategyId } = req.params;
    const userKey = String(userId || '');

    if (!userKey || req.user !== userKey) {
      return res.status(403).json({
        status: 'fail',
        message: "Credentials couldn't be validated.",
      });
    }

    const portfolio = await Portfolio.findOne({ strategy_id: strategyId, userId: userKey });
    if (!portfolio) {
      return res.status(404).json({
        status: 'fail',
        message: 'Portfolio not found for this strategy.',
      });
    }

    const strategy = await Strategy.findOne({ strategy_id: strategyId, userId: userKey });

    const alpacaConfig = await getAlpacaConfig(userId);
    if (!alpacaConfig?.hasValidKeys) {
      throw new Error('Alpaca credentials are invalid for this account.');
    }

    const alpacaApi = new Alpaca(alpacaConfig);
    const clock = await alpacaApi.getClock().catch((error) => {
      console.error('[ResendOrders] Failed to retrieve market clock:', error.message);
      return null;
    });

    const marketOpen = clock?.is_open === true;
    if (!marketOpen) {
      return res.status(400).json({
        status: 'fail',
        message: 'Market is closed. Please try again when markets are open.',
      });
    }

    const buyPayloads = (portfolio.stocks || [])
      .filter((stock) => stock?.symbol && Number(stock.quantity) > 0)
      .map((stock) => {
        const rawQty = toNumber(stock.quantity, 0);
        const normalized = ENABLE_FRACTIONAL_ORDERS
          ? normalizeQtyForOrder(rawQty)
          : { qty: Math.floor(rawQty), isFractional: false };
        if (!normalized.qty) {
          return null;
        }
        return {
          symbol: stock.symbol,
          qty: normalized.isFractional ? normalized.qty.toFixed(FRACTIONAL_QTY_DECIMALS) : normalized.qty,
          side: 'buy',
          type: 'market',
          time_in_force: normalized.isFractional ? 'day' : 'gtc',
          __submittedQty: normalized.qty,
        };
      })
      .filter(Boolean);

    const buyPromises = buyPayloads.map((payload) =>
      alpacaApi
        .createOrder((({ __submittedQty, ...orderPayload }) => orderPayload)(payload))
        .then((response) => ({
          symbol: payload.symbol,
          qty: payload.__submittedQty,
          orderID: response?.client_order_id || null,
        }))
        .catch((error) => {
          console.error(`[ResendOrders] Failed to place buy order for ${payload.symbol}:`, error.message);
          return null;
        })
    );

    let buyOrders = await Promise.all(buyPromises);
    buyOrders = buyOrders.filter(Boolean);

    if (!buyOrders.length) {
      return res.status(400).json({
        status: 'fail',
        message: 'No orders could be placed. Please verify strategy holdings.',
      });
    }

    await recordStrategyLog({
      strategyId,
      userId: userKey,
      strategyName: strategy?.name || portfolio.name,
      message: 'Manual resend triggered',
      details: {
        type: 'manual_resend',
        buyOrders,
      },
    });

    return res.status(200).json({
      status: 'success',
      message: 'Orders resent successfully. Check strategy logs for details.',
      buyOrders,
    });
  } catch (error) {
    console.error('[ResendOrders] Failed to resend orders:', error);
    return res.status(500).json({
      status: 'fail',
      message: error.message || 'Unable to resend orders at this time.',
    });
  }
};
exports.getStrategies = async (req, res) => {
  try {
    const userId = String(req.params.userId || '');
    if (!userId || req.user !== userId) {
      return res.status(403).json({
        status: "fail",
        message: "Credentials couldn't be validated.",
      });
    }

    let strategies = await Strategy.find({ userId })
      .sort({ createdAt: -1 })
      .lean();

    const hasUserAIFund = strategies.some((strategy) => strategy.strategy_id === '01');
    if (!hasUserAIFund) {
      const globalAIFund = await Strategy.findOne({
        strategy_id: '01',
        $or: [{ userId: null }, { userId: { $exists: false } }, { userId: '' }],
      }).lean();
      if (globalAIFund) {
        strategies = [globalAIFund, ...strategies];
      }
    }

    return res.status(200).json({
      status: "success",
      strategies: strategies.map((strategy) => ({
        id: strategy.strategy_id,
        name: strategy.name,
        provider: strategy.provider || 'alpaca',
        symphonyUrl: strategy.symphonyUrl || null,
        recurrence: strategy.recurrence,
        strategy: strategy.strategy,
        summary: strategy.summary || '',
        decisions: Array.isArray(strategy.decisions) ? strategy.decisions : [],
        createdAt: strategy.createdAt,
        updatedAt: strategy.updatedAt,
        isAIFund: strategy.strategy_id === '01',
        sourceType: 'portfolio',
      })),
    });
  } catch (error) {
    console.error('Error fetching strategies:', error);
    return res.status(500).json({
      status: "fail",
      message: "Something unexpected happened.",
    });
  }
};

exports.getStrategyTemplates = async (req, res) => {
  try {
    const userId = String(req.params.userId || '');
    if (!userId || req.user !== userId) {
      return res.status(403).json({
        status: 'fail',
        message: "Credentials couldn't be validated.",
      });
    }

    const templates = await StrategyTemplate.find({ userId })
      .sort({ updatedAt: -1 })
      .lean();

    return res.status(200).json({
      status: 'success',
      templates: templates.map((template) => ({
        id: String(template._id),
        name: template.name,
        symphonyUrl: template.symphonyUrl || null,
        strategy: template.strategy,
        summary: template.summary || '',
        decisions: Array.isArray(template.decisions) ? template.decisions : [],
        recurrence: template.recurrence,
        lastUsedAt: template.lastUsedAt,
        createdAt: template.createdAt,
        updatedAt: template.updatedAt,
        strategyId: template.strategyId || null,
        sourceType: 'template',
      })),
    });
  } catch (error) {
    console.error('[StrategyTemplates] Failed to fetch templates:', error);
    return res.status(500).json({
      status: 'fail',
      message: 'Unable to load saved Composer strategies.',
    });
  }
};



exports.getNewsHeadlines = async (req, res) => {
  const ticker = req.body.ticker;
  const period = req.body.period;

  const python = spawn('python3', ['./scripts/news.py', '--ticker', ticker, '--period', period]);

  let python_output = "";
  let python_log = "";

  const pythonPromise = new Promise((resolve, reject) => {
      python.stdout.on('data', (data) => {
          python_output += data.toString();
      });

      python.stderr.on('data', (data) => {
          python_log += data.toString();
      });

      python.on('close', (code) => {
          if (code !== 0) {
              console.log(`Python script exited with code ${code}`);
              reject(`Python script exited with code ${code}`);
          } else {
              resolve(python_output);
          }
      });
  });

  try {
      const python_output = await pythonPromise;
      console.log('Python output:', python_output);

      let newsData;
      try {
          newsData = JSON.parse(python_output);
          console.log('newsData:', newsData);

      } catch (err) {
          console.error(`Error parsing JSON in nodejs: ${err}`);
          console.error(`Invalid  JSON in nodejs: ${python_output}`);
          newsData = [];
      }

      const newsHeadlines = newsData.map(news => news["title"]);

      const stockKeywords = ["stock", "jumped", "intraday", "pre-market", "uptrend", "position", "increased", "gains", "loss", "up", "down", "rise", "fall", "bullish", "bearish", "nasdaq", "nyse", "percent", "%"];

      for (const news of newsData) {
          const lowerCaseTitle = news.title.toLowerCase();
          if (stockKeywords.some(keyword => lowerCaseTitle.includes(keyword))) {
              continue;
          }

          const existingNews = await News.find({ "Stock name": ticker, Date: news.date }).catch(err => {
              console.error('Error finding news:', err);
              throw err;
          });

          let isSimilar = false;
          for (const existing of existingNews) {
              const similarity = 1 - distance(existing["News headline"], news.title) / Math.max(existing["News headline"].length, news.title.length);
              if (similarity > 0.6) {
                  isSimilar = true;
                  break;
              }
          }

          if (!isSimilar) {
              const newNews = new News({
                  newsId: news.id,
                  "News headline": news.title,
                  Date: news.date,
                  Ticker: news.ticker,
                  "Stock name": ticker, 
                  Source: news.source,
              });
              try {
                  await newNews.save();
                  console.log(`Saved: ${newNews["News headline"]}`);
              } catch (err) {
                  console.log('Error saving news: ', err);
              }
          }
      }
      res.send(newsHeadlines);
  } catch (err) {
      console.error('Error:', err);
      res.status(500).send(err);
  }
};
exports.getScoreHeadlines = async (req, res) => {
  try {
    const newsData = await News.find({});
    const newsDataJson = JSON.stringify(newsData);
    const inputFilePath = './data/newsData.json';
    const outputFilePath = './data/sentimentResults.json';
    const output2FilePath = './data/scoreResults.json';

    fs.writeFileSync(inputFilePath, newsDataJson);

    const python = spawn('python3', ['-u', './scripts/sentiment_claude5.py', inputFilePath, outputFilePath, output2FilePath]);

    python.stdout.on('data', (data) => {
      const message = data.toString();
      if (message.trim() !== '') {
        console.log(message);
      }
    });

    python.stderr.on('data', (data) => {
      console.error('Python error:', data.toString());
    });

    const pythonPromise = new Promise((resolve, reject) => {
      python.on('close', (code) => {
        if (code !== 0) {
          console.log(`Python script exited with code ${code}`);
          reject(`Python script exited with code ${code}`);
        } else {
          resolve();
        }
      });
    });

    try {
      await pythonPromise;
      res.send('Sentiment analysis completed successfully');
    } catch (err) {
      console.error('Error:', err);
      res.status(500).send(err);
    }
  } catch (err) {
    console.error('Error in getScoreHeadlines:', err);
    res.status(500).send('Error in getScoreHeadlines');
  }
};



exports.testPython = async (req, res) => {
  console.log('testPython called');
  const { spawn } = require('child_process');
  let input = req.body.input;

  const runPythonScript = async (input) => {
    return new Promise((resolve, reject) => {
      let python_process = spawn('python3', ['scripts/test.py', input]);
      let python_output = "";

      python_process.stdout.on('data', (data) => {
        console.log(`stdout: ${data}`);
        python_output += data.toString();
      });

      python_process.stderr.on('data', (data) => {
        console.error(`stderr: ${data}`);
      });

      python_process.on('close', (code) => {
        console.log(`child process exited with code ${code}`);
        resolve(python_output);
      });
    });
  }

  const getPython = async (input) => {
    let python_output = await runPythonScript(input);
    console.log('python_output:'+'\n\n'+python_output);
    return python_output.toString();
  }

  try {
    let result = await getPython(input);
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'An error occurred while running the Python script.' });
  }
};



// // Mock the Alpaca client when market is closed:

// const Mock = require('jest-mock');
// const Alpaca = Mock.fn(() => ({
//   getClock: Mock.fn(() => Promise.resolve({ is_open: true, next_open: '2023-05-14T13:30:00Z' })),
//   createOrder: Mock.fn(({ symbol, qty, side, type, time_in_force }, { price = 999 } = {}) => {
//     return Promise.resolve({ id: 'mock_order_id', status: 'accepted', price });
//   }),  
//   getPositions: Mock.fn(() => Promise.resolve([])),
// }));



// // Debugging function to log all axios requests as curl commands
// axios.interceptors.request.use((request) => {
//   let data = request.data ? JSON.stringify(request.data) : '';
//   let headers = '';
//   for (let header in request.headers) {
//     headers += `-H '${header}: ${request.headers[header]}' `;
//   }

//   let params = '';
//   if (request.params) {
//     params = Object.keys(request.params)
//       .map(key => `${key}=${encodeURIComponent(request.params[key])}`)
//       .join('&');
//   }

//   console.log(`curl -X ${request.method.toUpperCase()} '${request.url}${params ? `?${params}` : ''}' ${headers}${data ? ` -d '${data}'` : ''}` + '\n');
//   return request;
// });

function retry(fn, retriesLeft = 5, interval = 1000) {
  return new Promise((resolve, reject) => {
    fn().then(resolve)
      .catch((error) => {
        setTimeout(() => {
          if (retriesLeft === 1) {
            reject(error);
          } else {
            console.log(`Retrying... attempts left: ${retriesLeft - 1}`);
            retry(fn, retriesLeft - 1, interval).then(resolve, reject);
          }
        }, interval);
      });
  });
}
exports.streamStrategyProgress = async (req, res) => {
  try {
    const { jobId } = req.params;
    const token = req.query?.token;

    if (!jobId) {
      return res.status(400).json({
        status: "fail",
        message: "jobId is required.",
      });
    }

    if (!token) {
      return res.status(401).json({
        status: "fail",
        message: "Authorization denied, missing token.",
      });
    }

    try {
      jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      return res.status(401).json({
        status: "fail",
        message: "Authorization denied, invalid token.",
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    addSubscriber(jobId, res);
    res.write(`data: ${JSON.stringify({
      jobId,
      step: 'connected',
      status: 'listening',
      timestamp: new Date().toISOString(),
    })}\n\n`);

    req.on('close', () => {
      removeSubscriber(jobId, res);
    });
  } catch (error) {
    console.error('[ProgressStream] Error:', error.message);
    try {
      res.status(500).end();
    } catch (err) {
      // ignore
    }
  }
};
