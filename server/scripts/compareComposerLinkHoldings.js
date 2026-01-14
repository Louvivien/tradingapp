#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

const { runComposerStrategy } = require('../utils/openaiComposerStrategy');
const { computeComposerHoldingsWeights } = require('../utils/composerHoldingsWeights');
const { fetchComposerLinkSnapshot } = require('../utils/composerLinkClient');

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
  const normalizePrimitive = (value) => {
    if (value == null) {
      return value;
    }
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'n'].includes(normalized)) {
      return false;
    }
    return value;
  };

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
    args[key] = normalizePrimitive(next);
    idx += 1;
  }
  return args;
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
      mismatches.push({ symbol, remoteWeight: a, tradingAppWeight: b, diff });
    }
  }
  return { mismatches };
};

const main = async () => {
  const args = parseArgs(process.argv);

  const url = args.url || args.link || null;
  if (!url) {
    process.stderr.write('Missing `--url` (Composer symphony link).\n');
    process.exit(1);
  }

  const skipDb =
    args.skipDb === true ||
    String(args.skipDb || '').toLowerCase() === 'true' ||
    String(process.env.PRICE_CACHE_SKIP_DB || '').toLowerCase() === 'true';

  const mongoUri = String(process.env.MONGO_URI || process.env.MONGODB_URI || '').trim();
  const mongoPassword = String(process.env.MONGO_PASSWORD || process.env.MONGODB_PASSWORD || '').trim();
  const canConnectMongo = Boolean(mongoUri && mongoPassword && mongoUri.includes('<password>'));

  if (!skipDb && canConnectMongo) {
    mongoose.set('bufferCommands', false);
    const uri = mongoUri.replace('<password>', encodeURIComponent(mongoPassword));
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 15000),
      connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 15000),
    });
  }

  const budget = Number.isFinite(Number(args.budget)) && Number(args.budget) > 0 ? Number(args.budget) : 10000;
  const asOfMode = args.asOfMode || 'previous-close';
  const priceSource = args.priceSource || 'tiingo';
  const priceRefresh = args.priceRefresh ?? null;
  const dataAdjustment = args.dataAdjustment || 'all';
  const rsiMethod = args.rsiMethod || null;
  const debugIndicators = args.debugIndicators === false ? false : true;
  const simulateHoldings = args.simulateHoldings === false ? false : true;
  const tolerance = Number.isFinite(Number(args.tolerance)) ? Number(args.tolerance) : 0.005;

  const snapshot = await fetchComposerLinkSnapshot({ url });
  if (!snapshot.strategyText) {
    throw new Error('Unable to extract defsymphony strategy text from the provided link.');
  }
  const remoteEffectiveAsOf = snapshot.effectiveAsOfDateKey || null;
  let remoteHoldings = normalizePositions(snapshot.holdings || []);
  if (snapshot.publicHoldingsObject && remoteEffectiveAsOf) {
    try {
      const computed = await computeComposerHoldingsWeights({
        holdingsObject: snapshot.publicHoldingsObject,
        effectiveAsOfDateKey: remoteEffectiveAsOf,
        lastBacktestValue: snapshot.lastBacktestValue ?? null,
        priceSource,
        dataAdjustment,
        cacheOnly: true,
        forceRefresh: false,
        concurrency: 4,
      });
      remoteHoldings = normalizePositions(computed.holdings || []);
    } catch (error) {
      const computed = await computeComposerHoldingsWeights({
        holdingsObject: snapshot.publicHoldingsObject,
        effectiveAsOfDateKey: remoteEffectiveAsOf,
        lastBacktestValue: snapshot.lastBacktestValue ?? null,
        priceSource,
        dataAdjustment,
        cacheOnly: false,
        forceRefresh: false,
        concurrency: 2,
      });
      remoteHoldings = normalizePositions(computed.holdings || []);
    }
  }

  // If Composer provides an effective holdings date and we run in previous-close mode, pass the next day
  // so TradingApp aligns to that previous close (effective date key).
  const asOfDate =
    args.asOfDate ||
    (asOfMode === 'previous-close' && remoteEffectiveAsOf ? addDays(remoteEffectiveAsOf, 1) : remoteEffectiveAsOf) ||
    null;

  const localResult = await runComposerStrategy({
    strategyText: snapshot.strategyText,
    budget,
    asOfDate,
    rsiMethod,
    dataAdjustment,
    debugIndicators,
    asOfMode,
    priceSource,
    priceRefresh,
    simulateHoldings,
  });

  const localHoldingsSource =
    simulateHoldings && Array.isArray(localResult?.simulatedHoldings) && localResult.simulatedHoldings.length
      ? localResult.simulatedHoldings
      : localResult.positions || [];
  const localHoldings = normalizePositions(localHoldingsSource);
  const comparison = compareWeights({ remote: remoteHoldings, local: localHoldings, tolerance });

  const output = {
    input: {
      url,
    },
    settings: {
      budget,
      asOfMode,
      asOfDate: asOfDate || null,
      priceSource,
      priceRefresh: priceRefresh ?? null,
      dataAdjustment,
      rsiMethod: rsiMethod || null,
      simulateHoldings,
      tolerance,
      skipDb,
    },
    composer: {
      effectiveAsOfDate: remoteEffectiveAsOf,
      holdings: remoteHoldings,
    },
    tradingApp: {
      effectiveAsOfDate: localResult?.meta?.localEvaluator?.asOfDate
        ? toDateKey(localResult.meta.localEvaluator.asOfDate)
        : null,
      holdings: localHoldings,
      meta: localResult.meta || null,
    },
    comparison,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
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
