#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

const { fetchComposerLinkSnapshot } = require('../utils/composerLinkClient');
const { runComposerStrategy } = require('../utils/openaiComposerStrategy');
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

const normalizeBoolean = (value) => {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  return null;
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

const sanitizeSymbol = (value) => String(value || '').trim().toUpperCase();

const toNumber = (value, fallback = null) => {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(n) ? n : fallback;
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

const readUrls = (args) => {
  if (args.file) {
    const abs = path.isAbsolute(args.file) ? args.file : path.resolve(process.cwd(), args.file);
    const content = fs.readFileSync(abs, 'utf8');
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  }
  const raw = args.urls || args.url || '';
  return String(raw)
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const connectMongoMaybe = async ({ skipDb }) => {
  if (skipDb) {
    return;
  }
  const mongoUri = String(process.env.MONGO_URI || process.env.MONGODB_URI || '').trim();
  const mongoPassword = String(process.env.MONGO_PASSWORD || process.env.MONGODB_PASSWORD || '').trim();
  const canConnectMongo = Boolean(mongoUri && mongoPassword && mongoUri.includes('<password>'));
  if (!canConnectMongo) {
    return;
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
  const urls = readUrls(args);
  if (!urls.length) {
    process.stderr.write(
      'Provide one or more Composer links via `--urls <url1,url2,...>` or `--file urls.txt`.\n'
    );
    process.exit(1);
  }

  const limit = Math.max(1, Math.min(500, Number(args.limit ?? urls.length)));
  const tolerance = toNumber(args.tolerance, 0.005);
  const sleepMs = Math.max(0, Math.min(2000, Number(args.sleepMs ?? 150)));

  const asOfMode = String(args.asOfMode || 'previous-close').trim();
  const asOfDate = args.asOfDate ? String(args.asOfDate).trim() : null;
  const priceSource = args.priceSource ? String(args.priceSource).trim() : null;
  const priceRefresh = args.priceRefresh ?? null;
  const dataAdjustment = args.dataAdjustment ? String(args.dataAdjustment).trim() : null;
  const rsiMethod = args.rsiMethod ? String(args.rsiMethod).trim() : null;
  const debugIndicators = normalizeBoolean(args.debugIndicators) ?? true;
  const budget = Math.max(1, toNumber(args.budget, 10000));
  const strategyTextSource = String(args.strategyTextSource || 'link').trim().toLowerCase(); // link|snapshot

  if (!['link', 'snapshot'].includes(strategyTextSource)) {
    process.stderr.write('`--strategyTextSource` must be "link" or "snapshot".\n');
    process.exit(1);
  }

  const skipDb =
    args.skipDb === true ||
    String(args.skipDb || '').toLowerCase() === 'true' ||
    String(process.env.PRICE_CACHE_SKIP_DB || '').toLowerCase() === 'true';

  await connectMongoMaybe({ skipDb });

  const results = [];
  for (const url of urls.slice(0, limit)) {
    const entry = {
      id: null,
      name: null,
      symphonyUrl: url,
      status: 'ok',
      errors: [],
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
      entry.id = snapshot?.id || null;
      entry.name = snapshot?.name || null;
      entry.composer.effectiveAsOfDate = snapshot?.effectiveAsOfDateKey || null;
      entry.composer.holdings = normalizeWeightRows(snapshot?.holdings || []);

      const composerHoldingsObject = snapshot?.publicHoldingsObject || null;
      const composerLastBacktestValue = snapshot?.lastBacktestValue ?? null;
      const strategyText =
        strategyTextSource === 'snapshot'
          ? String(snapshot?.strategyText || '').trim()
          : String(snapshot?.strategyText || '').trim();

      if (!entry.composer.holdings.length) {
        entry.status = 'error';
        entry.errors.push('Unable to extract Composer holdings from link.');
      }
      if (!strategyText) {
        entry.status = 'error';
        entry.errors.push('Unable to extract defsymphony text from link.');
      }

      if (entry.status === 'ok') {
        const resolvedAsOfDate =
          asOfDate ||
          (asOfMode === 'previous-close' && entry.composer.effectiveAsOfDate
            ? addDays(entry.composer.effectiveAsOfDate, 1)
            : entry.composer.effectiveAsOfDate) ||
          null;

        const local = await runComposerStrategy({
          strategyText,
          budget,
          asOfDate: resolvedAsOfDate,
          rsiMethod,
          dataAdjustment,
          debugIndicators,
          asOfMode,
          priceSource,
          priceRefresh,
          requireAsOfDateCoverage: true,
        });

        entry.tradingApp.meta = local?.meta || null;
        entry.tradingApp.effectiveAsOfDate = local?.meta?.localEvaluator?.asOfDate
          ? toDateKey(local.meta.localEvaluator.asOfDate)
          : null;
        entry.tradingApp.holdings = normalizeWeightRows(local?.positions || []);

        if (composerHoldingsObject) {
          const localMeta = local?.meta?.localEvaluator || {};
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
            entry.composer.holdings = normalizeWeightRows(computed.holdings || []);
            entry.composer.meta = computed.meta || null;
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
            entry.composer.holdings = normalizeWeightRows(computed.holdings || []);
            entry.composer.meta = computed.meta || null;
          }
        }

        entry.comparison = compareWeightRows({
          composer: entry.composer.holdings,
          tradingApp: entry.tradingApp.holdings,
          tolerance,
        });
      }
    } catch (error) {
      entry.status = 'error';
      entry.errors.push(error?.message || String(error));
    }

    results.push(entry);
    if (sleepMs) {
      await sleep(sleepMs);
    }
  }

  const mismatched = results.filter((r) => (r.comparison?.mismatches || []).length > 0).length;
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'success',
        summary: {
          total: results.length,
          mismatched,
          tolerance,
        },
        results,
      },
      null,
      2
    )}\n`
  );
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

