const User = require("../models/userModel");
const Strategy = require("../models/strategyModel");
const Portfolio = require("../models/portfolioModel");
const StrategyLog = require("../models/strategyLogModel");
const StrategyTemplate = require('../models/strategyTemplateModel');
const News = require("../models/newsModel");
const { getAlpacaConfig } = require("../config/alpacaConfig");
const Alpaca = require('@alpacahq/alpaca-trade-api');
const axios = require("axios");
const moment = require('moment');
const crypto = require('crypto');
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
const { rebalancePortfolio } = require('../services/rebalanceService');
const {
  addSubscriber,
  removeSubscriber,
  publishProgress,
  completeProgress,
} = require('../utils/progressBus');

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
  strategyId = null,
}) => {
  try {
    if (!userId || !name || !strategyText) {
      return null;
    }
    const normalizedRecurrence = normalizeRecurrence(recurrence);
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
    return { tradable: [], invalid: [] };
  }

  const tradingKeys = alpacaConfig.getTradingKeys();
  if (!tradingKeys?.client || !tradingKeys?.apiUrl || !tradingKeys?.keyId || !tradingKeys?.secretKey) {
    return { tradable: [], invalid: [] };
  }

  const uniqueSymbols = Array.from(
    new Set(
      symbols
        .map((symbol) => (typeof symbol === 'string' ? symbol.trim().toUpperCase() : null))
        .filter(Boolean)
    )
  );

  if (!uniqueSymbols.length) {
    return { tradable: [], invalid: [] };
  }

  const tradable = [];
  const invalid = [];

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

  return { tradable, invalid };
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
    const progressFail = (statusCode, message, step = 'error') => {
      publishProgress(jobId, { step, status: 'failed', message });
      completeProgress(jobId, { step: 'finished', status: 'failed', message });
      return res.status(statusCode).json({
        status: "fail",
        message,
        jobId,
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
      if (Array.isArray(composerResult.reasoning) && composerResult.reasoning.length) {
        workingDecisions = composerResult.reasoning.map((text, index) => ({
          symbol: composerResult.positions[index]?.symbol || `STEP_${index + 1}`,
          Rationale: text,
        }));
      }

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

      if (!workingDecisions.length && Array.isArray(composerResult.positions)) {
        workingDecisions = composerResult.positions.map((pos) => ({
          symbol: sanitizeSymbol(pos.symbol),
          Rationale: pos.rationale || 'Selected by Composer evaluation.',
        }));
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
    const accountCash = toNumber(account?.cash, 0);
    const planningBudget = Math.min(
      cashLimitInput,
      accountCash > 0 ? accountCash : cashLimitInput
    );

    if (!planningBudget || planningBudget <= 0) {
      return res.status(400).json({
        status: "fail",
        message: "Insufficient available cash to fund the collaborative strategy with the selected limit.",
      });
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

    const { invalid: nonTradableSymbols } = await validateAlpacaTradableSymbols(alpacaConfig, uniqueSymbols);
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

      const desiredValue = planningBudget * target.targetWeight;
      let qty = Math.floor(desiredValue / price);

      const remainingBudget = planningBudget - plannedCost;
      if (qty * price > remainingBudget) {
        qty = Math.floor(remainingBudget / price);
      }

      if (qty <= 0 && remainingBudget >= price) {
        qty = 1;
      }

      if (qty <= 0) {
        continue;
      }

      const cost = qty * price;
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

    const orderPromises = finalizedPlan.map(({ symbol, qty }) => {
      return retry(() => {
        return axios({
          method: 'post',
          url: alpacaConfig.apiURL + '/v2/orders',
          headers: {
            'APCA-API-KEY-ID': alpacaConfig.keyId,
            'APCA-API-SECRET-KEY': alpacaConfig.secretKey
          },
          data: {
            symbol,
            qty,
            side: 'buy',
            type: 'market',
            time_in_force: 'gtc'
          }
        }).then((response) => {
          console.log(`Order of ${qty} shares for ${symbol} has been placed. Order ID: ${response.data.client_order_id}`);
          return { qty, symbol, orderID: response.data.client_order_id };
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
        const sanitizedBody =
          responseData && typeof responseData === 'object'
            ? JSON.stringify(responseData)
            : (responseData || 'No response body');
        console.error(
          `[OrderError] Failed to place order for ${symbol}. status=${status || 'unknown'} requestId=${requestId} body=${sanitizedBody}`
        );
        if (error?.message) {
          console.error(`[OrderError] Axios message for ${symbol}: ${error.message}`);
        }
        return null;
      });
    });

    const orders = (await Promise.all(orderPromises)).filter(Boolean);
    const initialInvestmentEstimate = plannedCost;
    if (!orders.length) {
      console.error('Failed to place all orders.');
      return progressFail(400, "Failed to place orders. Try again.", 'placing_orders');
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
      strategyId: portfolioRecord?.strategy_id || null,
    });

    completeProgress(jobId, {
      step: 'finished',
      status: 'success',
      message: 'Strategy created successfully.',
    });

    return res.status(200).json({
      status: "success",
      orders,
      summary: workingSummary || "",
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
    const nextRebalanceAt = computeNextRebalanceAt(normalizedRecurrence, now);

    portfolio.recurrence = normalizedRecurrence;
    portfolio.nextRebalanceAt = nextRebalanceAt;
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

    portfolio.nextRebalanceAt = parsedDate;
    await portfolio.save();

    await recordStrategyLog({
      strategyId,
      userId: String(userId),
      strategyName: portfolio.name,
      message: 'Next reallocation updated manually',
      details: {
        nextRebalanceAt: parsedDate,
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



exports.getPortfolios = async (req, res) => {
  try {
    const { userId } = req.params;

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

    const alpacaConfig = await getAlpacaConfig(userId);
    if (!alpacaConfig?.hasValidKeys) {
      return res.status(403).json({
        status: 'fail',
        message: alpacaConfig?.error || 'Invalid Alpaca credentials',
      });
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

    const accountCash = toNumber(accountResponse?.data?.cash, 0);
    const positions = Array.isArray(positionsResponse.data) ? positionsResponse.data : [];

    const positionMap = {};
    const priceCache = {};

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

    if (symbolsToFetch.size) {
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
    const enhancedPortfolios = rawPortfolios.map((portfolio) => {
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
        name: portfolio.name,
        strategy_id: portfolio.strategy_id,
        recurrence: portfolio.recurrence || 'daily',
        lastRebalancedAt: portfolio.lastRebalancedAt,
        nextRebalanceAt: portfolio.nextRebalanceAt,
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

    const buyPromises = (portfolio.stocks || [])
      .filter((stock) => stock?.symbol && Number(stock.quantity) > 0)
      .map((stock) =>
        alpacaApi
          .createOrder({
            symbol: stock.symbol,
            qty: Number(stock.quantity),
            side: 'buy',
            type: 'market',
            time_in_force: 'gtc',
          })
          .then((response) => ({
            symbol: stock.symbol,
            qty: Number(stock.quantity),
            orderID: response?.client_order_id || null,
          }))
          .catch((error) => {
            console.error(`[ResendOrders] Failed to place buy order for ${stock.symbol}:`, error.message);
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
