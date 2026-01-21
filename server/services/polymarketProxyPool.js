const Axios = require('axios');

const normalizeEnvValue = (value) => String(value || '').trim();

const DEFAULT_PROXY_SOURCE_URLS = [
  'https://raw.githubusercontent.com/SoliSpirit/proxy-list/main/Countries/https/Ireland.txt',
];

const PROXY_POOL_CACHE_MS = Number(normalizeEnvValue(process.env.POLYMARKET_PROXY_POOL_CACHE_MS || '300000'));
const PROXY_FAILURE_COOLDOWN_MS = Number(
  normalizeEnvValue(process.env.POLYMARKET_PROXY_FAILURE_COOLDOWN_MS || '300000')
);

let proxyPool = [];
let lastProxyRefresh = 0;
let proxyRotationIndex = 0;
const proxyCooldowns = new Map();

const normalizeProxyEntry = (entry) => {
  const raw = normalizeEnvValue(entry);
  if (!raw) {
    return null;
  }
  if (!raw.includes('://')) {
    return `http://${raw}`;
  }
  return raw;
};

const getProxySourceUrls = () => {
  const envUrls = normalizeEnvValue(process.env.POLYMARKET_PROXY_POOL_URLS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(new Set([...envUrls, ...DEFAULT_PROXY_SOURCE_URLS]));
};

const refreshProxyPool = async () => {
  const now = Date.now();
  if (proxyPool.length && now - lastProxyRefresh < PROXY_POOL_CACHE_MS) {
    return proxyPool;
  }
  const urls = getProxySourceUrls();
  if (!urls.length) {
    return proxyPool;
  }
  const responses = await Promise.all(
    urls.map(async (url) => {
      try {
        const response = await Axios.get(url, { timeout: 10000 });
        return String(response?.data || '')
          .split('\n')
          .map((line) => normalizeProxyEntry(line))
          .filter(Boolean);
      } catch (error) {
        return [];
      }
    })
  );
  const merged = Array.from(new Set(responses.flat()));
  if (merged.length) {
    proxyPool = merged;
    proxyRotationIndex = proxyRotationIndex % proxyPool.length;
    lastProxyRefresh = now;
  }
  return proxyPool;
};

const parseProxyConfig = (proxyUrl) => {
  try {
    const parsed = new URL(proxyUrl);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    if (!parsed.hostname || !Number.isFinite(port)) {
      return null;
    }
    const auth =
      parsed.username || parsed.password
        ? {
            username: decodeURIComponent(parsed.username || ''),
            password: decodeURIComponent(parsed.password || ''),
          }
        : undefined;
    return { host: parsed.hostname, port, ...(auth ? { auth } : {}) };
  } catch (error) {
    return null;
  }
};

const isProxyCoolingDown = (proxyUrl) => {
  const cooldownUntil = proxyCooldowns.get(proxyUrl);
  return cooldownUntil ? cooldownUntil > Date.now() : false;
};

const markProxyFailure = (proxyUrl) => {
  if (!proxyUrl) {
    return;
  }
  proxyCooldowns.set(proxyUrl, Date.now() + PROXY_FAILURE_COOLDOWN_MS);
};

const getNextProxy = async () => {
  await refreshProxyPool();
  if (!proxyPool.length) {
    return null;
  }
  const poolSize = proxyPool.length;
  for (let offset = 0; offset < poolSize; offset += 1) {
    const index = (proxyRotationIndex + offset) % poolSize;
    const proxyUrl = proxyPool[index];
    if (isProxyCoolingDown(proxyUrl)) {
      continue;
    }
    proxyRotationIndex = (index + 1) % poolSize;
    return { proxyUrl, proxyConfig: parseProxyConfig(proxyUrl) };
  }
  const fallbackProxy = proxyPool[proxyRotationIndex % poolSize];
  proxyRotationIndex = (proxyRotationIndex + 1) % poolSize;
  return { proxyUrl: fallbackProxy, proxyConfig: parseProxyConfig(fallbackProxy) };
};

const shouldUseProxyPool = () => {
  const raw = normalizeEnvValue(process.env.POLYMARKET_USE_PROXY_POOL || '');
  if (!raw) {
    return true;
  }
  const normalized = raw.toLowerCase();
  if (['false', '0', 'no'].includes(normalized)) {
    return false;
  }
  return ['true', '1', 'yes'].includes(normalized);
};

module.exports = {
  getNextProxy,
  markProxyFailure,
  shouldUseProxyPool,
};
