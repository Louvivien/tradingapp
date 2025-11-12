const { setAlpaca } = require('./alpaca');

const CACHE_TTL_MS = Number(process.env.ALPACA_CONFIG_CACHE_MS || 5 * 60 * 1000);
const configCache = new Map();
const pendingRequests = new Map();

const buildCacheKey = (userId, forceMode) =>
  `${userId || 'default'}::${forceMode || 'auto'}`;

const getAlpacaConfig = async (userId, forceMode = null) => {
  const cacheKey = buildCacheKey(userId, forceMode);
  const cached = configCache.get(cacheKey);
  const now = Date.now();

  if (
    cached &&
    cached.config?.hasValidKeys &&
    now - cached.timestamp < CACHE_TTL_MS
  ) {
    return cached.config;
  }

  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey);
  }

  const fetchPromise = (async () => {
    const config = await setAlpaca(userId, forceMode);
    if (!config.hasValidKeys) {
      throw new Error(config.error || 'No valid API keys found');
    }
    configCache.set(cacheKey, { timestamp: now, config });
    return config;
  })()
    .catch((error) => {
      console.error('[API Error] Failed to get Alpaca config:', error.message);
      throw error;
    })
    .finally(() => {
      pendingRequests.delete(cacheKey);
    });

  pendingRequests.set(cacheKey, fetchPromise);
  return fetchPromise;
};

const clearAlpacaConfigCache = (userId = null, forceMode = null) => {
  if (userId === null && forceMode === null) {
    configCache.clear();
    return;
  }
  configCache.delete(buildCacheKey(userId, forceMode));
};

module.exports = {
  getAlpacaConfig,
  clearAlpacaConfigCache,
};
