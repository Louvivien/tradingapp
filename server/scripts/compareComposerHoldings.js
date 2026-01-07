#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

const { runComposerStrategy } = require('../utils/openaiComposerStrategy');

dotenv.config({ path: path.resolve(__dirname, '../config/.env') });

const consoleToStderr = (method) => (...args) => {
  try {
    process.stderr.write(`[${method}] ${args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')}\n`);
  } catch {
    process.stderr.write(`[${method}] (unserializable log)\n`);
  }
};

// Keep JSON output on stdout clean for piping; send all logs to stderr.
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

const readStrategyText = async ({ filePath }) => {
  if (filePath) {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    return fs.readFileSync(abs, 'utf8');
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const main = async () => {
  const args = parseArgs(process.argv);
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

  const strategyText = String(await readStrategyText({ filePath: args.strategyFile || args.file || null }) || '').trim();
  if (!strategyText) {
    console.error('Missing strategy text. Provide `--strategyFile path/to/strategy.edn` or pipe via stdin.');
    process.exit(1);
  }

  const budget = Number.isFinite(Number(args.budget)) && Number(args.budget) > 0 ? Number(args.budget) : 10000;
  const asOfDate = args.asOfDate || null; // e.g. 2026-01-06 or ISO string
  const rsiMethod = args.rsiMethod || null;
  const dataAdjustment = args.dataAdjustment || null; // all|split
  const asOfMode = args.asOfMode || null; // previous-close|current
  const priceSource = args.priceSource || null; // tiingo|yahoo|alpaca
  const priceRefresh = args.priceRefresh ?? null; // true|false|null
  const debugIndicators = args.debugIndicators === false ? false : true;

  const result = await runComposerStrategy({
    strategyText,
    budget,
    asOfDate,
    rsiMethod,
    dataAdjustment,
    debugIndicators,
    asOfMode,
    priceSource,
    priceRefresh,
  });

  const filterReasoning = Array.isArray(result.reasoning)
    ? result.reasoning.filter((line) => String(line).includes('Filter evaluation:'))
    : [];

  const output = {
    settings: {
      budget,
      asOfDate,
      rsiMethod: rsiMethod || null,
      dataAdjustment: dataAdjustment || null,
      asOfMode: asOfMode || null,
      priceSource: priceSource || null,
      priceRefresh: priceRefresh ?? null,
      debugIndicators,
    },
    positions: result.positions || [],
    meta: result.meta || null,
    filterReasoning,
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
    console.error(error);
    if (mongoose.connection.readyState === 1) {
      await mongoose.disconnect();
    }
    process.exit(1);
  });
