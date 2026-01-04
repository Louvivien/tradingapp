const crypto = require('crypto');
const Axios = require('axios');
const CryptoJS = require('crypto-js');
const { normalizeRecurrence, computeNextRebalanceAt } = require('../utils/recurrence');
const { recordStrategyLog } = require('./strategyLogger');

const CLOB_HOST = String(process.env.POLYMARKET_CLOB_HOST || 'https://clob.polymarket.com').replace(/\/+$/, '');
const GEO_BLOCK_TOKEN =
  (process.env.POLYMARKET_GEO_BLOCK_TOKEN || process.env.GEO_BLOCK_TOKEN || '').trim() || null;
const ENCRYPTION_KEY = String(process.env.ENCRYPTION_KEY || process.env.CryptoJS_secret_key || '').trim() || null;

const INITIAL_CURSOR = 'MA==';
const END_CURSOR = 'LTE=';
const MAX_TRADES_PER_SYNC = 2500;

const toNumber = (value, fallback = null) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const roundToDecimals = (value, decimals = 6) => {
  const num = toNumber(value, null);
  if (!Number.isFinite(num)) {
    return null;
  }
  const places = Math.max(0, Math.min(12, Number(decimals) || 0));
  const factor = 10 ** places;
  return Math.round((num + Number.EPSILON) * factor) / factor;
};

const buildGeoParams = (params = {}) => {
  if (!GEO_BLOCK_TOKEN) {
    return params;
  }
  return { ...params, geo_block_token: GEO_BLOCK_TOKEN };
};

const sanitizeBase64Secret = (secret) => {
  return String(secret || '')
    .trim()
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/[^A-Za-z0-9+/=]/g, '');
};

const decodeBase64Secret = (secret) => Buffer.from(sanitizeBase64Secret(secret), 'base64');

const makeUrlSafeBase64 = (base64) => String(base64 || '').replace(/\+/g, '-').replace(/\//g, '_');

const decryptIfEncrypted = (value) => {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (!raw.startsWith('U2Fsd')) {
    return raw;
  }
  if (!ENCRYPTION_KEY) {
    throw new Error('Encrypted Polymarket credentials provided but ENCRYPTION_KEY/CryptoJS_secret_key is not configured.');
  }
  try {
    const bytes = CryptoJS.AES.decrypt(raw, ENCRYPTION_KEY);
    const decrypted = bytes.toString(CryptoJS.enc.Utf8);
    return String(decrypted || '').trim();
  } catch (error) {
    throw new Error('Unable to decrypt Polymarket credentials.');
  }
};

const buildPolyHmacSignature = ({ secret, timestamp, method, requestPath, body }) => {
  const ts = Math.floor(toNumber(timestamp, 0));
  if (!ts) {
    throw new Error('Polymarket signature timestamp is invalid.');
  }

  const message = `${ts}${String(method || '').toUpperCase()}${requestPath}${body ?? ''}`;
  const key = decodeBase64Secret(secret);
  const signature = crypto.createHmac('sha256', key).update(message).digest('base64');
  return makeUrlSafeBase64(signature);
};

const fetchClobServerTime = async () => {
  const response = await Axios.get(`${CLOB_HOST}/time`, { params: buildGeoParams() });
  const ts = Math.floor(toNumber(response?.data, NaN));
  if (!Number.isFinite(ts) || ts <= 0) {
    throw new Error('Unable to fetch Polymarket server time.');
  }
  return ts;
};

const createL2Headers = async ({ address, apiKey, secret, passphrase, method, requestPath, body }) => {
  const ts = await fetchClobServerTime().catch(() => Math.floor(Date.now() / 1000));
  const signature = buildPolyHmacSignature({
    secret,
    timestamp: ts,
    method,
    requestPath,
    body,
  });

  return {
    POLY_ADDRESS: String(address || '').trim(),
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: `${ts}`,
    POLY_API_KEY: String(apiKey || '').trim(),
    POLY_PASSPHRASE: String(passphrase || '').trim(),
  };
};

const fetchTradesPage = async ({ address, apiKey, secret, passphrase, makerAddress, nextCursor }) => {
  const endpoint = '/data/trades';
  const headers = await createL2Headers({
    address,
    apiKey,
    secret,
    passphrase,
    method: 'GET',
    requestPath: endpoint,
  });

  const params = buildGeoParams({
    next_cursor: nextCursor || INITIAL_CURSOR,
    maker_address: makerAddress,
  });

  const response = await Axios.get(`${CLOB_HOST}${endpoint}`, { headers, params });
  return response?.data || null;
};

const fetchMarket = async (conditionId) => {
  if (!conditionId) {
    return null;
  }
  const cleaned = String(conditionId).trim();
  if (!cleaned) {
    return null;
  }
  const response = await Axios.get(`${CLOB_HOST}/markets/${cleaned}`, {
    params: buildGeoParams(),
  });
  return response?.data || null;
};

const buildMarketTokenPriceIndex = (market) => {
  const tokens = Array.isArray(market?.tokens) ? market.tokens : [];
  const index = new Map();
  tokens.forEach((token) => {
    const tokenId = token?.token_id ? String(token.token_id) : '';
    if (!tokenId) {
      return;
    }
    const price = toNumber(token?.price, null);
    const outcome = token?.outcome ? String(token.outcome) : null;
    index.set(tokenId, { price, outcome });
  });
  return index;
};

const isValidHexAddress = (value) => {
  const address = String(value || '').trim();
  return /^0x[a-fA-F0-9]{40}$/.test(address);
};

const parseTimeValue = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = String(value).trim();
  if (!raw) {
    return null;
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    // Heuristic: treat 10+ digits as milliseconds when it looks like epoch time.
    if (numeric > 1e12) {
      return numeric;
    }
    if (numeric > 1e9) {
      return numeric * 1000;
    }
    return numeric;
  }
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }
  return null;
};

const isTradeAfterAnchor = (tradeTime, anchorTime) => {
  const tradeMs = parseTimeValue(tradeTime);
  const anchorMs = parseTimeValue(anchorTime);
  if (tradeMs !== null && anchorMs !== null) {
    return tradeMs > anchorMs;
  }
  if (tradeMs !== null && anchorMs === null) {
    return true;
  }
  if (tradeMs === null && anchorMs !== null) {
    return false;
  }
  return String(tradeTime || '') > String(anchorTime || '');
};

const syncPolymarketPortfolio = async (portfolio) => {
  if (!portfolio) {
    throw new Error('Portfolio is required.');
  }
  const provider = String(portfolio.provider || 'alpaca');
  if (provider !== 'polymarket') {
    return { skipped: true, reason: 'not_polymarket' };
  }

  const poly = portfolio.polymarket || {};
  const address = String(poly.address || '').trim();
  const apiKey = decryptIfEncrypted(poly.apiKey);
  const secret = decryptIfEncrypted(poly.secret);
  const passphrase = decryptIfEncrypted(poly.passphrase);

  if (!isValidHexAddress(address)) {
    throw new Error('Polymarket address is missing or invalid.');
  }
  if (!apiKey || !secret || !passphrase) {
    throw new Error('Polymarket API credentials are required (apiKey, secret, passphrase).');
  }

  const lastTradeId = poly.lastTradeId ? String(poly.lastTradeId).trim() : null;
  const lastTradeMatchTime = poly.lastTradeMatchTime ? String(poly.lastTradeMatchTime).trim() : null;
  const now = new Date();
  const anchorMatchTime = !lastTradeId
    ? (lastTradeMatchTime || now.toISOString())
    : null;

  let nextCursor = INITIAL_CURSOR;
  let foundLastTrade = false;
  let foundAnchor = false;
  const pendingTrades = [];

  while (nextCursor !== END_CURSOR && pendingTrades.length < MAX_TRADES_PER_SYNC && !foundLastTrade) {
    const page = await fetchTradesPage({
      address,
      apiKey,
      secret,
      passphrase,
      makerAddress: address,
      nextCursor,
    });

    const trades = Array.isArray(page?.data) ? page.data : [];
    for (const trade of trades) {
      const id = trade?.id ? String(trade.id) : null;
      if (!id) {
        continue;
      }
      if (lastTradeId) {
        if (id === lastTradeId) {
          foundLastTrade = true;
          break;
        }
        pendingTrades.push(trade);
        continue;
      }

      const matchTime = trade?.match_time ? String(trade.match_time) : null;
      if (!matchTime) {
        continue;
      }
      if (anchorMatchTime && !isTradeAfterAnchor(matchTime, anchorMatchTime)) {
        foundAnchor = true;
        break;
      }
      pendingTrades.push(trade);
    }

    const cursor = page?.next_cursor ? String(page.next_cursor) : null;
    if (!cursor || cursor === nextCursor) {
      break;
    }
    nextCursor = cursor;
    if (!lastTradeId && foundAnchor) {
      break;
    }
  }

  if (!lastTradeId) {
    // Persist the anchor so we can copy the first trade that happens after setup.
    portfolio.polymarket = {
      ...(portfolio.polymarket || {}),
      lastTradeMatchTime: anchorMatchTime,
      lastTradeId: null,
    };
  }

  if (!pendingTrades.length) {
    portfolio.lastRebalancedAt = now;
    portfolio.nextRebalanceAt = computeNextRebalanceAt(normalizeRecurrence(portfolio.recurrence), now);
    await portfolio.save();
    return { processed: 0, waitingForTrades: !lastTradeId };
  }

  const processedTrades = pendingTrades.slice().reverse();
  const holdingsByAssetId = new Map();
  (portfolio.stocks || []).forEach((stock) => {
    const assetId = stock?.asset_id ? String(stock.asset_id) : stock?.symbol ? String(stock.symbol) : null;
    if (!assetId) {
      return;
    }
    holdingsByAssetId.set(assetId, stock);
  });

  let cash = toNumber(portfolio.retainedCash, toNumber(portfolio.cashBuffer, 0));
  const marketCache = new Map();
  const ensureMarket = async (conditionId) => {
    const key = String(conditionId || '').trim();
    if (!key) {
      return null;
    }
    if (marketCache.has(key)) {
      return marketCache.get(key);
    }
    try {
      const market = await fetchMarket(key);
      marketCache.set(key, market);
      return market;
    } catch (error) {
      marketCache.set(key, null);
      return null;
    }
  };

  const tradeSummary = {
    buys: [],
    sells: [],
    skipped: [],
  };

  for (const trade of processedTrades) {
    const assetId = trade?.asset_id ? String(trade.asset_id) : null;
    const conditionId = trade?.market ? String(trade.market) : null;
    const outcome = trade?.outcome ? String(trade.outcome) : null;
    const side = trade?.side ? String(trade.side).toUpperCase() : null;
    const tradeId = trade?.id ? String(trade.id) : null;
    const rawSize = toNumber(trade?.size, null);
    const rawPrice = toNumber(trade?.price, null);

    if (!tradeId || !assetId || !conditionId || !side || !rawSize || !rawPrice) {
      tradeSummary.skipped.push({
        id: tradeId,
        reason: 'invalid_trade_payload',
      });
      continue;
    }

    const price = Math.max(0, Math.min(1, rawPrice));
    let size = Math.max(0, rawSize);
    if (!size) {
      tradeSummary.skipped.push({
        id: tradeId,
        reason: 'zero_size',
      });
      continue;
    }

    const existing = holdingsByAssetId.get(assetId) || null;
    const currentQty = existing ? toNumber(existing.quantity, 0) : 0;
    const currentAvgCost = existing && existing.avgCost !== undefined && existing.avgCost !== null
      ? toNumber(existing.avgCost, null)
      : null;

    const symbol = existing?.symbol
      ? String(existing.symbol)
      : `PM:${String(conditionId).slice(0, 10)}:${outcome || 'OUTCOME'}`;

    if (side === 'BUY') {
      const maxAffordable = price > 0 ? cash / price : 0;
      if (maxAffordable <= 0) {
        tradeSummary.skipped.push({
          id: tradeId,
          side,
          assetId,
          reason: 'insufficient_cash',
        });
        continue;
      }

      if (size > maxAffordable) {
        size = maxAffordable;
      }

      size = roundToDecimals(size, 6);
      if (!size || size <= 0) {
        tradeSummary.skipped.push({
          id: tradeId,
          side,
          assetId,
          reason: 'insufficient_cash',
        });
        continue;
      }

      const cost = size * price;
      cash = roundToDecimals(cash - cost, 6);

      const newQty = roundToDecimals(currentQty + size, 6);
      const newAvgCost = (() => {
        if (!currentQty || currentAvgCost === null) {
          return price;
        }
        const totalCost = currentQty * currentAvgCost + size * price;
        return totalCost / newQty;
      })();

      const entry = existing || {
        symbol,
        market: conditionId,
        asset_id: assetId,
        outcome,
        orderID: `poly-${tradeId}`,
      };

      entry.quantity = newQty;
      entry.avgCost = roundToDecimals(newAvgCost, 6);
      entry.currentPrice = entry.currentPrice !== undefined && entry.currentPrice !== null
        ? toNumber(entry.currentPrice, null)
        : price;
      entry.market = entry.market || conditionId;
      entry.asset_id = entry.asset_id || assetId;
      entry.outcome = entry.outcome || outcome;

      holdingsByAssetId.set(assetId, entry);
      tradeSummary.buys.push({
        id: tradeId,
        assetId,
        outcome,
        size,
        price,
        cost: roundToDecimals(cost, 6),
      });
    } else if (side === 'SELL') {
      const available = currentQty;
      if (!available || available <= 0) {
        tradeSummary.skipped.push({
          id: tradeId,
          side,
          assetId,
          reason: 'no_position',
        });
        continue;
      }
      if (size > available) {
        size = available;
      }

      size = roundToDecimals(size, 6);
      if (!size || size <= 0) {
        tradeSummary.skipped.push({
          id: tradeId,
          side,
          assetId,
          reason: 'no_position',
        });
        continue;
      }

      const proceeds = size * price;
      cash = roundToDecimals(cash + proceeds, 6);

      const newQty = roundToDecimals(available - size, 6);
      if (existing) {
        existing.quantity = newQty;
        existing.currentPrice = existing.currentPrice !== undefined && existing.currentPrice !== null
          ? toNumber(existing.currentPrice, null)
          : price;
        existing.market = existing.market || conditionId;
        existing.asset_id = existing.asset_id || assetId;
        existing.outcome = existing.outcome || outcome;
      }

      if (existing && newQty > 0) {
        holdingsByAssetId.set(assetId, existing);
      } else {
        holdingsByAssetId.delete(assetId);
      }

      tradeSummary.sells.push({
        id: tradeId,
        assetId,
        outcome,
        size,
        price,
        proceeds: roundToDecimals(proceeds, 6),
      });
    } else {
      tradeSummary.skipped.push({
        id: tradeId,
        side,
        assetId,
        reason: 'unknown_side',
      });
    }

    if (conditionId) {
      await ensureMarket(conditionId);
    }
  }

  // Refresh current prices using market snapshots when possible.
  for (const [assetId, entry] of holdingsByAssetId.entries()) {
    const conditionId = entry?.market ? String(entry.market) : null;
    if (!conditionId) {
      continue;
    }
    const market = await ensureMarket(conditionId);
    if (!market) {
      continue;
    }
    const index = buildMarketTokenPriceIndex(market);
    const tokenInfo = index.get(String(assetId));
    if (tokenInfo && tokenInfo.price !== null) {
      entry.currentPrice = tokenInfo.price;
      if (!entry.outcome && tokenInfo.outcome) {
        entry.outcome = tokenInfo.outcome;
      }
    }
    if (market?.question && entry?.symbol && entry.symbol.startsWith('PM:')) {
      const question = String(market.question).trim();
      if (question) {
        entry.symbol = `PM: ${question.slice(0, 42)}${question.length > 42 ? '…' : ''} (${entry.outcome || 'Outcome'})`;
      }
    }
  }

  const updatedStocks = Array.from(holdingsByAssetId.values())
    .map((entry) => ({
      symbol: String(entry.symbol || '').trim() || `PM:${String(entry.asset_id || '').slice(-8)}`,
      market: entry.market ? String(entry.market) : null,
      asset_id: entry.asset_id ? String(entry.asset_id) : null,
      outcome: entry.outcome ? String(entry.outcome) : null,
      avgCost: toNumber(entry.avgCost, null),
      quantity: toNumber(entry.quantity, 0),
      currentPrice: toNumber(entry.currentPrice, null),
      orderID: entry.orderID ? String(entry.orderID) : `poly-${String(entry.asset_id || '').slice(-10)}`,
    }))
    .filter((row) => row.quantity > 0);

  const newest = pendingTrades[0] || null;
  if (newest?.id) {
    portfolio.polymarket = {
      ...(portfolio.polymarket || {}),
      lastTradeId: String(newest.id),
      lastTradeMatchTime: newest.match_time ? String(newest.match_time) : null,
    };
  }

  portfolio.stocks = updatedStocks;
  portfolio.retainedCash = toNumber(cash, 0);
  portfolio.cashBuffer = toNumber(cash, 0);
  portfolio.lastRebalancedAt = now;
  portfolio.nextRebalanceAt = computeNextRebalanceAt(normalizeRecurrence(portfolio.recurrence), now);
  portfolio.rebalanceCount = toNumber(portfolio.rebalanceCount, 0) + 1;
  portfolio.lastPerformanceComputedAt = now;
  await portfolio.save();

  await recordStrategyLog({
    strategyId: portfolio.strategy_id,
    userId: portfolio.userId,
    strategyName: portfolio.name,
    message: 'Polymarket copy-trader synced',
    details: {
      provider: 'polymarket',
      address,
      processedTrades: processedTrades.length,
      buys: tradeSummary.buys,
      sells: tradeSummary.sells,
      skipped: tradeSummary.skipped.slice(0, 50),
      cash: portfolio.retainedCash,
      positions: updatedStocks.map((pos) => ({
        market: pos.market,
        asset_id: pos.asset_id,
        outcome: pos.outcome,
        quantity: pos.quantity,
        avgCost: pos.avgCost,
        currentPrice: pos.currentPrice,
      })),
    },
  });

  return {
    processed: processedTrades.length,
    buys: tradeSummary.buys.length,
    sells: tradeSummary.sells.length,
    skipped: tradeSummary.skipped.length,
  };
};

module.exports = {
  syncPolymarketPortfolio,
  isValidHexAddress,
};
