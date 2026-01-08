#!/usr/bin/env node

const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

const Strategy = require('../models/strategyModel');
const { runComposerStrategy } = require('../utils/openaiComposerStrategy');
const { fetchComposerLinkSnapshot } = require('../utils/composerLinkClient');
const { computeComposerHoldingsWeights } = require('../utils/composerHoldingsWeights');

dotenv.config({ path: path.resolve(__dirname, '../config/.env') });

const consoleToStderr = (method) => (...args) => {
  try {
    process.stderr.write(
      `[${method}] ${args
        .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
        .join(' ')}\n`
    );
  } catch {
    process.stderr.write(`[${method}] (unserializable log)\n`);
  }
};

console.log = consoleToStderr('log');
console.warn = consoleToStderr('warn');
console.error = consoleToStderr('error');
console.info = consoleToStderr('info');

const parseArgs = (argv) => {
  const args = {};
  for (let idx = 2; idx < argv.length; idx += 1) {
    const raw = argv[idx];
    if (!raw.startsWith('--')) {
      continue;
    }
    const key = raw.slice(2);
    const next = argv[idx + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    idx += 1;
  }
  return args;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const toDateKey = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d.toISOString().slice(0, 10);
};

const addDays = (dayKey, days) => {
  if (!dayKey || !/^\d{4}-\d{2}-\d{2}$/.test(String(dayKey))) {
    return null;
  }
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return toDateKey(d);
};

const sha256 = (value) =>
  crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');

const normalizePositions = (positions = []) => {
  const rows = (positions || [])
    .map((pos) => {
      const symbol = String(pos?.symbol || '').trim().toUpperCase();
      const weight = Number(pos?.weight);
      if (!symbol || !Number.isFinite(weight)) {
        return null;
      }
      return { symbol, weight };
    })
    .filter(Boolean);
  rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return rows;
};

const compareWeights = ({ remote, local, tolerance }) => {
  const remoteMap = new Map(remote.map((row) => [row.symbol, row.weight]));
  const localMap = new Map(local.map((row) => [row.symbol, row.weight]));
  const symbols = Array.from(new Set([...remoteMap.keys(), ...localMap.keys()])).sort();
  const mismatches = [];
  for (const symbol of symbols) {
    const a = remoteMap.get(symbol) ?? 0;
    const b = localMap.get(symbol) ?? 0;
    const diff = Math.abs(a - b);
    if (diff > tolerance) {
      mismatches.push({ symbol, composerWeight: a, tradingAppWeight: b, diff });
    }
  }
  return { mismatches };
};

const connectMongo = async () => {
  const mongoUri = String(process.env.MONGO_URI || process.env.MONGODB_URI || '').trim();
  const mongoPassword = String(process.env.MONGO_PASSWORD || process.env.MONGODB_PASSWORD || '').trim();
  if (!(mongoUri && mongoPassword && mongoUri.includes('<password>'))) {
    throw new Error(
      'Missing Mongo credentials. Set MONGO_URI (with <password>) and MONGO_PASSWORD in `tradingapp/server/config/.env`.'
    );
  }
  mongoose.set('bufferCommands', false);
  const uri = mongoUri.replace('<password>', encodeURIComponent(mongoPassword));
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 15000),
    connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 15000),
  });
};

const main = async () => {
  const args = parseArgs(process.argv);

  const userId = args.userId ? String(args.userId) : null;
  const strategyId = args.strategyId ? String(args.strategyId) : null;
  const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Number(args.limit)) : 200;
  const sleepMs = Number.isFinite(Number(args.sleepMs)) ? Math.max(0, Number(args.sleepMs)) : 250;
  const skipDbPriceCache = args.skipDbPriceCache === true || String(args.skipDbPriceCache || '').toLowerCase() === 'true';
  const allowNonComposer =
    args.allowNonComposer === true || String(args.allowNonComposer || '').toLowerCase() === 'true';

  const asOfMode = args.asOfMode || 'previous-close';
  const priceSource = args.priceSource || 'tiingo';
  const priceRefresh = args.priceRefresh ?? null;
  const dataAdjustment = args.dataAdjustment || 'all';
  const rsiMethod = args.rsiMethod || null;
  const debugIndicators = args.debugIndicators === false ? false : true;
  const budget = Number.isFinite(Number(args.budget)) && Number(args.budget) > 0 ? Number(args.budget) : 10000;
  const tolerance = Number.isFinite(Number(args.tolerance)) ? Number(args.tolerance) : 0.005;

  const strategyTextSource = String(args.strategyTextSource || 'db').trim().toLowerCase(); // db|link
  if (!['db', 'link'].includes(strategyTextSource)) {
    throw new Error('Invalid --strategyTextSource. Use "db" or "link".');
  }

  if (skipDbPriceCache) {
    process.env.PRICE_CACHE_SKIP_DB = 'true';
  }

  await connectMongo();

  const query = {
    symphonyUrl: { $ne: null },
  };
  if (userId) {
    query.userId = userId;
  }
  if (strategyId) {
    query.strategy_id = strategyId;
  }

  const strategies = await Strategy.find(query).sort({ updatedAt: -1 }).limit(limit).lean();
  const results = [];

  for (const strategy of strategies) {
    const url = strategy?.symphonyUrl ? String(strategy.symphonyUrl).trim() : null;
    if (!url) {
      continue;
    }
    const entry = {
      strategyId: strategy?.strategy_id || null,
      userId: strategy?.userId || null,
      name: strategy?.name || null,
      symphonyUrl: url,
      status: 'ok',
      errors: [],
      composer: {
        effectiveAsOfDate: null,
        holdings: [],
        strategyHash: null,
      },
      tradingApp: {
        effectiveAsOfDate: null,
        holdings: [],
        strategyHash: null,
      },
      comparison: {
        mismatches: [],
      },
    };

    try {
      if (!allowNonComposer && !isComposerUrl(url)) {
        entry.status = 'skipped';
        entry.errors.push('symphonyUrl is not a Composer link (use --allowNonComposer true to force).');
        results.push(entry);
        if (sleepMs) {
          await sleep(sleepMs);
        }
        continue;
      }

      const snapshot = await fetchComposerLinkSnapshot({ url });
      entry.composer.effectiveAsOfDate = snapshot.effectiveAsOfDateKey || null;
      entry.composer.holdings = normalizePositions(snapshot.holdings || []);
      entry.composer.strategyHash = snapshot.strategyText ? sha256(snapshot.strategyText) : null;
      const composerHoldingsObject = snapshot.publicHoldingsObject || null;
      const composerLastBacktestValue = snapshot.lastBacktestValue ?? null;

      const dbText = String(strategy.strategy || '').trim();
      entry.tradingApp.strategyHash = dbText ? sha256(dbText) : null;

      if (!entry.composer.holdings.length) {
        entry.status = 'error';
        entry.errors.push('Unable to extract composer holdings from link.');
      }
      if (!dbText && strategyTextSource === 'db') {
        entry.status = 'error';
        entry.errors.push('Strategy text missing from DB (strategy.strategy).');
      }
      if (!snapshot.strategyText && strategyTextSource === 'link') {
        entry.status = 'error';
        entry.errors.push('Unable to extract defsymphony strategy text from link.');
      }

      if (entry.status !== 'ok') {
        results.push(entry);
        if (sleepMs) {
          await sleep(sleepMs);
        }
        continue;
      }

      const strategyText = strategyTextSource === 'link' ? snapshot.strategyText : dbText;
      const asOfDate =
        args.asOfDate ||
        (asOfMode === 'previous-close' && entry.composer.effectiveAsOfDate
          ? addDays(entry.composer.effectiveAsOfDate, 1)
          : entry.composer.effectiveAsOfDate) ||
        null;

      const localResult = await runComposerStrategy({
        strategyText,
        budget,
        asOfDate,
        rsiMethod,
        dataAdjustment,
        debugIndicators,
        asOfMode,
        priceSource,
        priceRefresh,
        requireAsOfDateCoverage: true,
      });

      entry.tradingApp.effectiveAsOfDate = localResult?.meta?.localEvaluator?.asOfDate
        ? toDateKey(localResult.meta.localEvaluator.asOfDate)
        : null;
      entry.tradingApp.holdings = normalizePositions(localResult.positions || []);

      if (composerHoldingsObject) {
        const localMeta = localResult?.meta?.localEvaluator || {};
        const composerPriceSource = localMeta.priceSource || priceSource || null;
        const composerAdjustment = localMeta.dataAdjustment || dataAdjustment || 'all';
        try {
          const computed = await computeComposerHoldingsWeights({
            holdingsObject: composerHoldingsObject,
            effectiveAsOfDateKey: entry.composer.effectiveAsOfDate,
            lastBacktestValue: composerLastBacktestValue,
            priceSource: composerPriceSource,
            dataAdjustment: composerAdjustment,
            cacheOnly: true,
            forceRefresh: false,
            concurrency: 4,
          });
          entry.composer.holdings = normalizePositions(computed.holdings || []);
        } catch (error) {
          const computed = await computeComposerHoldingsWeights({
            holdingsObject: composerHoldingsObject,
            effectiveAsOfDateKey: entry.composer.effectiveAsOfDate,
            lastBacktestValue: composerLastBacktestValue,
            priceSource: composerPriceSource,
            dataAdjustment: composerAdjustment,
            cacheOnly: false,
            forceRefresh: false,
            concurrency: 2,
          });
          entry.composer.holdings = normalizePositions(computed.holdings || []);
        }
      }

      entry.comparison = compareWeights({
        remote: entry.composer.holdings,
        local: entry.tradingApp.holdings,
        tolerance,
      });
    } catch (error) {
      entry.status = 'error';
      entry.errors.push(error?.message || String(error));
    }

    results.push(entry);
    if (sleepMs) {
      await sleep(sleepMs);
    }
  }

  process.stdout.write(`${JSON.stringify({ count: results.length, results }, null, 2)}\n`);
};

main()
  .then(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
  })
  .catch(async (error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
    process.exit(1);
  });
