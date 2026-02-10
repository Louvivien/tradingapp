#!/usr/bin/env node

const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.resolve(__dirname, '../config/.env') });

const StrategyLog = require('../models/strategyLogModel');
const StrategyEquitySnapshot = require('../models/strategyEquitySnapshotModel');
const PriceCache = require('../models/priceCacheModel');

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

const asBool = (value) => {
  if (value === true) return true;
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return ['true', '1', 'yes', 'y', 'on'].includes(normalized);
};

const asNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const formatBytes = (value) => {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let scaled = bytes;
  while (scaled >= 1024 && idx < units.length - 1) {
    scaled /= 1024;
    idx += 1;
  }
  const digits = idx === 0 ? 0 : 1;
  return `${scaled.toFixed(digits)} ${units[idx]}`;
};

const safeString = (value) => {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const printUsage = () => {
  // eslint-disable-next-line no-console
  console.error(
    [
      'Mongo cleanup helper (safe by default).',
      '',
      'Usage:',
      '  node scripts/mongo_cleanup.js --report',
      '  node scripts/mongo_cleanup.js --dropPriceCache --confirm',
      '  node scripts/mongo_cleanup.js --pruneStrategyLogsDays 14 --confirm',
      '  node scripts/mongo_cleanup.js --pruneEquitySnapshotsDays 180 --confirm',
      '',
      'Options:',
      '  --report                     Print collection stats + counts (default).',
      '  --dropPriceCache             Drop the PriceCache collection (it rebuilds automatically).',
      '  --dropStrategyLogs            Drop the StrategyLog collection.',
      '  --pruneStrategyLogsDays N     Delete StrategyLogs older than N days.',
      '  --pruneEquitySnapshotsDays N  Delete StrategyEquitySnapshots older than N days.',
      '  --confirm                    Required for any destructive action.',
      '',
      'Mongo credentials:',
      '  Reads `tradingapp/server/config/.env` and expects:',
      '  - MONGO_URI with a <password> placeholder',
      '  - MONGO_PASSWORD',
    ].join('\n')
  );
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

const tryCollectionStats = async (collectionName) => {
  try {
    const stats = await mongoose.connection.db.collection(collectionName).stats();
    return {
      ok: true,
      count: stats?.count ?? null,
      size: stats?.size ?? null,
      storageSize: stats?.storageSize ?? null,
      totalIndexSize: stats?.totalIndexSize ?? null,
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
};

const findOldestAndNewest = async (model, field) => {
  const oldest = await model.findOne({}, { [field]: 1 }).sort({ [field]: 1 }).lean();
  const newest = await model.findOne({}, { [field]: 1 }).sort({ [field]: -1 }).lean();
  return {
    oldest: oldest?.[field] ? new Date(oldest[field]).toISOString() : null,
    newest: newest?.[field] ? new Date(newest[field]).toISOString() : null,
  };
};

const reportModel = async ({ label, model, dateField }) => {
  const collectionName = model.collection?.name || label;
  const [estimatedCount, range, stats] = await Promise.all([
    model.estimatedDocumentCount().catch(() => null),
    findOldestAndNewest(model, dateField).catch(() => ({ oldest: null, newest: null })),
    tryCollectionStats(collectionName),
  ]);

  const lines = [];
  lines.push(`- ${label} (${collectionName})`);
  lines.push(`  - estimatedCount: ${estimatedCount ?? 'n/a'}`);
  if (range.oldest || range.newest) {
    lines.push(`  - ${dateField}: oldest=${range.oldest || 'n/a'} newest=${range.newest || 'n/a'}`);
  }
  if (stats.ok) {
    lines.push(
      `  - storage: data=${formatBytes(stats.size)} storage=${formatBytes(stats.storageSize)} indexes=${formatBytes(stats.totalIndexSize)}`
    );
  } else {
    lines.push(`  - storage: n/a (${stats.error})`);
  }

  // eslint-disable-next-line no-console
  console.error(lines.join('\n'));
};

const dropCollection = async (model, label) => {
  const collectionName = model.collection?.name || label;
  try {
    await model.collection.drop();
    // eslint-disable-next-line no-console
    console.error(`Dropped ${label} (${collectionName}).`);
  } catch (error) {
    // "ns not found" is ok (collection missing).
    if (String(error?.message || '').includes('ns not found')) {
      // eslint-disable-next-line no-console
      console.error(`Skipped drop for ${label} (${collectionName}): collection does not exist.`);
      return;
    }
    throw error;
  }
};

const pruneByAgeDays = async (model, field, days, label) => {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await model.deleteMany({ [field]: { $lt: cutoff } });
  // eslint-disable-next-line no-console
  console.error(`Pruned ${label}: deleted=${result?.deletedCount ?? 'n/a'} cutoff=${cutoff.toISOString()}`);
};

const main = async () => {
  const args = parseArgs(process.argv);
  if (asBool(args.help) || asBool(args.h)) {
    printUsage();
    process.exitCode = 0;
    return;
  }

  const confirm = asBool(args.confirm);
  const wantsReport = args.report === undefined ? true : asBool(args.report);

  const dropPriceCache = asBool(args.dropPriceCache);
  const dropStrategyLogs = asBool(args.dropStrategyLogs);

  const pruneStrategyLogsDaysRaw = args.pruneStrategyLogsDays ?? null;
  const pruneEquitySnapshotsDaysRaw = args.pruneEquitySnapshotsDays ?? null;

  const pruneStrategyLogsDays = pruneStrategyLogsDaysRaw != null ? asNumber(pruneStrategyLogsDaysRaw) : null;
  const pruneEquitySnapshotsDays =
    pruneEquitySnapshotsDaysRaw != null ? asNumber(pruneEquitySnapshotsDaysRaw) : null;

  const hasDestructiveAction =
    dropPriceCache ||
    dropStrategyLogs ||
    pruneStrategyLogsDays != null ||
    pruneEquitySnapshotsDays != null;

  if (hasDestructiveAction && !confirm) {
    // eslint-disable-next-line no-console
    console.error('Refusing to run destructive actions without --confirm.');
    printUsage();
    process.exitCode = 2;
    return;
  }

  if (pruneStrategyLogsDays != null && (!(Number.isFinite(pruneStrategyLogsDays) && pruneStrategyLogsDays > 0))) {
    throw new Error('--pruneStrategyLogsDays must be a positive number.');
  }
  if (
    pruneEquitySnapshotsDays != null &&
    (!(Number.isFinite(pruneEquitySnapshotsDays) && pruneEquitySnapshotsDays > 0))
  ) {
    throw new Error('--pruneEquitySnapshotsDays must be a positive number.');
  }

  await connectMongo();

  try {
    if (wantsReport) {
      // eslint-disable-next-line no-console
      console.error('Collection report:');
      await reportModel({ label: 'PriceCache', model: PriceCache, dateField: 'refreshedAt' });
      await reportModel({ label: 'StrategyLog', model: StrategyLog, dateField: 'createdAt' });
      await reportModel({ label: 'StrategyEquitySnapshot', model: StrategyEquitySnapshot, dateField: 'createdAt' });
    }

    if (dropPriceCache) {
      await dropCollection(PriceCache, 'PriceCache');
    }
    if (dropStrategyLogs) {
      await dropCollection(StrategyLog, 'StrategyLog');
    }
    if (pruneStrategyLogsDays != null) {
      await pruneByAgeDays(StrategyLog, 'createdAt', pruneStrategyLogsDays, 'StrategyLog');
    }
    if (pruneEquitySnapshotsDays != null) {
      await pruneByAgeDays(
        StrategyEquitySnapshot,
        'createdAt',
        pruneEquitySnapshotsDays,
        'StrategyEquitySnapshot'
      );
    }

    if (hasDestructiveAction && wantsReport) {
      // eslint-disable-next-line no-console
      console.error('\nCollection report (after):');
      await reportModel({ label: 'PriceCache', model: PriceCache, dateField: 'refreshedAt' });
      await reportModel({ label: 'StrategyLog', model: StrategyLog, dateField: 'createdAt' });
      await reportModel({ label: 'StrategyEquitySnapshot', model: StrategyEquitySnapshot, dateField: 'createdAt' });
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Mongo cleanup failed:', safeString(error?.message || error));
    process.exitCode = 1;
  } finally {
    try {
      await mongoose.disconnect();
    } catch {
      // ignore
    }
  }
};

void main();
