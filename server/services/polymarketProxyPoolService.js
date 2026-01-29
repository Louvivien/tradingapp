const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const normalizeEnvValue = (value) => String(value || '').trim();

const parseBooleanEnv = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  const raw = normalizeEnvValue(value).toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return fallback;
};

const toFiniteNumber = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clampInt = (value, { min, max, fallback }) => {
  const parsed = toFiniteNumber(value, null);
  if (!Number.isFinite(parsed)) return fallback;
  const floored = Math.floor(parsed);
  return Math.max(min, Math.min(max, floored));
};

const DEFAULT_PROXY_LIST_URL =
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/refs/heads/master/http.txt';
const DEFAULT_TEST_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
const DEFAULT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;

const DEFAULT_DENYLIST = new Set([
  'AU',
  'BE',
  'BY',
  'BI',
  'CF',
  'CD',
  'CU',
  'DE',
  'ET',
  'FR',
  'GB',
  'IR',
  'IQ',
  'IT',
  'KP',
  'LB',
  'LY',
  'MM',
  'NI',
  'PL',
  'RU',
  'SG',
  'SO',
  'SS',
  'SD',
  'SY',
  'TH',
  'TW',
  'UM',
  'US',
  'VE',
  'YE',
  'ZW',
  'CA',
  'UA',
]);

const parseCountryListEnv = (value) => {
  const raw = normalizeEnvValue(value);
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
};

const parseUrlListEnv = (value) => {
  const raw = normalizeEnvValue(value);
  if (!raw) return [];
  const seen = new Set();
  const urls = [];
  raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      if (seen.has(entry)) return;
      seen.add(entry);
      urls.push(entry);
    });
  return urls;
};

const normalizeProxyUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return raw;
  return `http://${raw}`;
};

const parseProxyUrl = (value) => {
  const normalized = normalizeProxyUrl(value);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
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
    return { protocol: parsed.protocol || 'http:', host: parsed.hostname, port, ...(auth ? { auth } : {}) };
  } catch {
    return null;
  }
};

const getEnvProxyList = () => {
  const raw = normalizeEnvValue(
    process.env.POLYMARKET_CLOB_PROXY ||
      process.env.POLYMARKET_HTTP_PROXY ||
      process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      ''
  );
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
};

const proxyId = (proxy) => {
  if (!proxy) return '';
  const proto = proxy.protocol ? String(proxy.protocol).replace(/:$/, '') : 'http';
  const base = `${proto}://${proxy.host}:${proxy.port}`;
  if (!proxy.auth || (!proxy.auth.username && !proxy.auth.password)) {
    return base;
  }
  return `${proxy.auth.username || ''}:${proxy.auth.password || ''}@${base}`;
};

const proxyToUrl = (proxy) => {
  if (!proxy?.host || !proxy?.port) return null;
  const protocol = proxy.protocol ? String(proxy.protocol).trim() : 'http:';
  const normalizedProtocol = protocol.endsWith(':') ? protocol : `${protocol}:`;
  const url = new URL(`${normalizedProtocol}//${proxy.host}:${proxy.port}`);
  if (proxy.auth && (proxy.auth.username || proxy.auth.password)) {
    url.username = encodeURIComponent(proxy.auth.username || '');
    url.password = encodeURIComponent(proxy.auth.password || '');
  }
  return url.toString();
};

const createHttpsProxyAgent = (proxy) => {
  const url = proxyToUrl(proxy);
  if (!url) return null;
  return new HttpsProxyAgent(url);
};

const httpsAgentCache = new Map();

const getPolymarketHttpsAgent = (proxy) => {
  const id = proxyId(proxy);
  if (!id) return null;
  const cached = httpsAgentCache.get(id);
  if (cached) return cached;
  const agent = createHttpsProxyAgent(proxy);
  if (!agent) return null;
  httpsAgentCache.set(id, agent);
  return agent;
};

const clearPolymarketHttpsAgentCache = () => {
  httpsAgentCache.clear();
};

const shuffleInPlace = (items) => {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
};

const parseCloudflareTrace = (rawBody) => {
  const body = String(rawBody || '');
  const lines = body.split(/\r?\n/);
  const map = {};
  for (const line of lines) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    map[key] = line.slice(idx + 1).trim();
  }
  const loc = map.loc ? String(map.loc).trim().toUpperCase() : null;
  const ip = map.ip ? String(map.ip).trim() : null;
  return {
    ok: Boolean(map && Object.keys(map).length),
    loc: loc && /^[A-Z]{2}$/.test(loc) ? loc : null,
    ip: ip || null,
    raw: map,
  };
};

const formatAxiosError = (error) => {
  const status = Number(error?.response?.status);
  if (Number.isFinite(status) && status > 0) {
    return `Request failed with status code ${status}`;
  }
  return String(error?.message || 'Request failed');
};

const isRetryableProxyTestError = (error) => {
  const status = Number(error?.response?.status);
  if (Number.isFinite(status) && status > 0) {
    if (status === 407) return false; // Proxy auth required
    if (status === 401) return false;
    if (status === 403 || status === 408 || status === 429) return true;
    return status >= 500;
  }
  const code = String(error?.code || '').toUpperCase();
  if (!code) return true;
  if (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'EAI_AGAIN'
  ) {
    return true;
  }
  if (code.includes('TLS') || code.includes('CERT')) {
    return true;
  }
  return true;
};

const resolveCachePath = () => {
  const configured = normalizeEnvValue(process.env.POLYMARKET_PROXY_CACHE_PATH);
  if (configured) {
    return configured;
  }
  return path.join(__dirname, '..', 'data', 'polymarketProxyPool.json');
};

const resolveSourceUrls = () => {
  const configuredList = parseUrlListEnv(process.env.POLYMARKET_PROXY_LIST_URLS);
  const fallbackSingle = normalizeEnvValue(process.env.POLYMARKET_PROXY_LIST_URL);
  const merged = [...configuredList];
  if (fallbackSingle && !merged.includes(fallbackSingle)) {
    merged.push(fallbackSingle);
  }
  if (!merged.length) {
    return [DEFAULT_PROXY_LIST_URL];
  }
  return merged;
};

const state = {
  env: {
    key: null,
    pool: [],
    cursor: 0,
  },
  dynamic: {
    enabled: parseBooleanEnv(
      process.env.POLYMARKET_PROXY_LIST_ENABLED,
      process.env.NODE_ENV === 'test' ? false : true
    ),
    urls: resolveSourceUrls(),
    testUrl: normalizeEnvValue(process.env.POLYMARKET_PROXY_TEST_URL) || DEFAULT_TEST_URL,
    refreshIntervalMs: clampInt(process.env.POLYMARKET_PROXY_REFRESH_INTERVAL_MS, {
      min: 60_000,
      max: 7 * 24 * 60 * 60 * 1000,
      fallback: DEFAULT_REFRESH_INTERVAL_MS,
    }),
    failureCooldownMs: clampInt(process.env.POLYMARKET_PROXY_FAILURE_COOLDOWN_MS, {
      min: 0,
      max: 7 * 24 * 60 * 60 * 1000,
      fallback: DEFAULT_FAILURE_COOLDOWN_MS,
    }),
    fetchTimeoutMs: clampInt(process.env.POLYMARKET_PROXY_LIST_FETCH_TIMEOUT_MS, {
      min: 1000,
      max: 120_000,
      fallback: 15_000,
    }),
    testTimeoutMs: clampInt(process.env.POLYMARKET_PROXY_TEST_TIMEOUT_MS, {
      min: 1000,
      max: 60_000,
      fallback: 8000,
    }),
    testConcurrency: clampInt(process.env.POLYMARKET_PROXY_TEST_CONCURRENCY, {
      min: 1,
      max: 50,
      fallback: 20,
    }),
    maxCandidates: clampInt(process.env.POLYMARKET_PROXY_MAX_CANDIDATES, {
      min: 10,
      max: 50_000,
      fallback: 3000,
    }),
    maxTests: clampInt(process.env.POLYMARKET_PROXY_MAX_TESTS, {
      min: 5,
      max: 50_000,
      fallback: 500,
    }),
    maxGood: clampInt(process.env.POLYMARKET_PROXY_MAX_GOOD, {
      min: 1,
      max: 5000,
      fallback: 200,
    }),
    denylist: (() => {
      const custom = parseCountryListEnv(process.env.POLYMARKET_PROXY_COUNTRY_DENYLIST);
      if (!custom.length) return DEFAULT_DENYLIST;
      return new Set(custom);
    })(),
    allowlist: (() => {
      const custom = parseCountryListEnv(process.env.POLYMARKET_PROXY_COUNTRY_ALLOWLIST);
      return custom.length ? new Set(custom) : null;
    })(),
    pool: [],
    cursor: 0,
    lastRefreshStartedAt: 0,
    lastRefreshCompletedAt: 0,
    lastError: null,
    stats: null,
    refreshPromise: null,
    cachePath: resolveCachePath(),
  },
};

const loadCacheFromDisk = () => {
  const cachePath = state.dynamic.cachePath;
  if (!cachePath) return;
  let raw;
  try {
    raw = fs.readFileSync(cachePath, 'utf8');
  } catch {
    return;
  }
  if (!raw) return;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const proxies = Array.isArray(parsed?.proxies) ? parsed.proxies : [];
  if (!proxies.length) return;
  const restored = proxies
    .map((entry) => {
      const host = entry?.host ? String(entry.host).trim() : '';
      const port = Number(entry?.port);
      if (!host || !Number.isFinite(port)) return null;
      const country = entry?.country ? String(entry.country).trim().toUpperCase() : null;
      return {
        host,
        port,
        ...(entry?.auth ? { auth: entry.auth } : {}),
        country: country && /^[A-Z]{2}$/.test(country) ? country : null,
        exitIp: entry?.exitIp ? String(entry.exitIp).trim() : null,
        latencyMs: Number.isFinite(Number(entry?.latencyMs)) ? Number(entry.latencyMs) : null,
        checkedAt: entry?.checkedAt ? String(entry.checkedAt) : null,
      };
    })
    .filter(Boolean);

  if (!restored.length) return;
  state.dynamic.pool = restored;
  state.dynamic.cursor = 0;
  const refreshedAt = Date.parse(String(parsed?.refreshedAt || ''));
  state.dynamic.lastRefreshCompletedAt = Number.isFinite(refreshedAt) ? refreshedAt : Date.now();
};

const persistCacheToDisk = () => {
  const cachePath = state.dynamic.cachePath;
  if (!cachePath) return;
  const dir = path.dirname(cachePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  const payload = {
    version: 2,
    refreshedAt: new Date(state.dynamic.lastRefreshCompletedAt || Date.now()).toISOString(),
    sourceUrl: state.dynamic.urls?.[0] || null,
    sourceUrls: Array.isArray(state.dynamic.urls) ? state.dynamic.urls : [],
    testUrl: state.dynamic.testUrl,
    denylist: Array.from(state.dynamic.denylist || []),
    allowlist: state.dynamic.allowlist ? Array.from(state.dynamic.allowlist) : null,
    proxies: state.dynamic.pool.map((entry) => ({
      host: entry.host,
      port: entry.port,
      ...(entry.auth ? { auth: entry.auth } : {}),
      country: entry.country || null,
      exitIp: entry.exitIp || null,
      latencyMs: entry.latencyMs ?? null,
      checkedAt: entry.checkedAt || null,
    })),
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(payload, null, 2));
  } catch {
    // ignore
  }
};

loadCacheFromDisk();

const getEnvProxyPool = () => {
  const list = getEnvProxyList();
  const key = list.join(',');
  if (key !== state.env.key) {
    state.env.key = key;
    state.env.pool = list.map(parseProxyUrl).filter(Boolean);
    state.env.cursor = 0;
  }
  return state.env.pool;
};

const pickFromPool = (poolState, pool) => {
  if (!pool.length) return null;
  const idx = poolState.cursor % pool.length;
  poolState.cursor = (poolState.cursor + 1) % pool.length;
  return pool[idx];
};

const proxyFailureCooldownUntilMs = new Map();

const getProxyFailureRemainingMs = (proxy) => {
  const id = proxyId(proxy);
  if (!id) return 0;
  const until = Number(proxyFailureCooldownUntilMs.get(id) || 0);
  const now = Date.now();
  if (!until || until <= now) {
    proxyFailureCooldownUntilMs.delete(id);
    return 0;
  }
  return until - now;
};

const countActiveProxyCooldowns = () => {
  const now = Date.now();
  let active = 0;
  for (const [id, until] of proxyFailureCooldownUntilMs.entries()) {
    if (!until || until <= now) {
      proxyFailureCooldownUntilMs.delete(id);
      continue;
    }
    active += 1;
  }
  return active;
};

const notePolymarketProxyFailure = (proxy, { reason = 'failure', cooldownMs } = {}) => {
  const id = proxyId(proxy);
  if (!id) {
    return { ok: false, reason: 'missing_proxy' };
  }
  const configuredCooldownMs = state.dynamic.failureCooldownMs;
  const overrideCooldownMs = toFiniteNumber(cooldownMs, null);
  const finalCooldownMs = Number.isFinite(overrideCooldownMs) ? Math.max(0, Math.floor(overrideCooldownMs)) : configuredCooldownMs;
  if (!finalCooldownMs) {
    proxyFailureCooldownUntilMs.delete(id);
    return { ok: true, skipped: true, reason, cooldownMs: 0 };
  }
  const until = Date.now() + finalCooldownMs;
  proxyFailureCooldownUntilMs.set(id, until);
  return { ok: true, skipped: false, reason, cooldownMs: finalCooldownMs, disabledUntilMs: until, disabledUntil: new Date(until).toISOString() };
};

const pickFromPoolSkippingCooldown = (poolState, pool) => {
  if (!pool.length) return null;
  for (let attempt = 0; attempt < pool.length; attempt += 1) {
    const candidate = pickFromPool(poolState, pool);
    if (!candidate) return null;
    if (!getProxyFailureRemainingMs(candidate)) {
      return candidate;
    }
  }
  return null;
};

const peekFromPoolSkippingCooldown = (poolState, pool) => {
  if (!pool.length) return null;
  const start = poolState.cursor % pool.length;
  for (let offset = 0; offset < pool.length; offset += 1) {
    const idx = (start + offset) % pool.length;
    const candidate = pool[idx];
    if (!candidate) continue;
    if (!getProxyFailureRemainingMs(candidate)) {
      return candidate;
    }
  }
  return null;
};

const shouldAllowCountry = (countryCode) => {
  const loc = countryCode ? String(countryCode).trim().toUpperCase() : '';
  if (!loc) return false;
  if (state.dynamic.allowlist) {
    return state.dynamic.allowlist.has(loc);
  }
  return !state.dynamic.denylist.has(loc);
};

const fetchProxyListText = async (url) => {
  const response = await Axios.get(String(url || ''), {
    timeout: state.dynamic.fetchTimeoutMs,
    proxy: false,
    responseType: 'text',
    transformResponse: (data) => data,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Proxy list fetch failed (status ${response.status}).`);
  }
  return typeof response.data === 'string' ? response.data : String(response.data || '');
};

const parseProxyListText = (contents, { limit } = {}) => {
  const lines = String(contents || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const seen = new Set();
  const candidates = [];
  for (const line of lines) {
    const parsed = parseProxyUrl(line);
    if (!parsed) continue;
    const id = proxyId(parsed);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    candidates.push(parsed);
    if (limit && candidates.length >= limit) break;
  }
  return candidates;
};

const fetchProxyCandidates = async () => {
  const urls = Array.isArray(state.dynamic.urls) ? state.dynamic.urls : [];
  if (!urls.length) {
    return [];
  }
  const results = await Promise.allSettled(urls.map((url) => fetchProxyListText(url)));
  const seen = new Set();
  const candidates = [];
  let anySuccess = false;

  results.forEach((result) => {
    if (result.status !== 'fulfilled') {
      return;
    }
    anySuccess = true;
    const parsed = parseProxyListText(result.value, { limit: state.dynamic.maxCandidates });
    parsed.forEach((candidate) => {
      if (candidates.length >= state.dynamic.maxCandidates) return;
      const id = proxyId(candidate);
      if (!id || seen.has(id)) return;
      seen.add(id);
      candidates.push(candidate);
    });
  });

  if (!anySuccess) {
    const errors = results
      .filter((result) => result.status === 'rejected')
      .map((result) => formatAxiosError(result.reason))
      .filter(Boolean);
    throw new Error(errors.length ? `Proxy list fetch failed: ${errors[0]}` : 'Proxy list fetch failed.');
  }

  return candidates;
};

const testProxy = async (proxyConfig) => {
  const startedAt = Date.now();
  const httpsAgent = createHttpsProxyAgent(proxyConfig);
  if (!httpsAgent) {
    throw new Error('Proxy config is missing host/port.');
  }
  const response = await Axios.get(state.dynamic.testUrl, {
    timeout: state.dynamic.testTimeoutMs,
    proxy: false,
    httpsAgent,
    responseType: 'text',
    transformResponse: (data) => data,
    headers: { 'User-Agent': 'tradingapp/1.0' },
    validateStatus: () => true,
  });

  const latencyMs = Date.now() - startedAt;
  if (response.status < 200 || response.status >= 300) {
    const err = new Error(`Proxy test returned status ${response.status}`);
    err.status = response.status;
    throw err;
  }

  const trace = parseCloudflareTrace(response.data);
  if (!trace.loc) {
    throw new Error('Proxy test returned an unknown country code.');
  }
  return {
    country: trace.loc,
    exitIp: trace.ip,
    latencyMs,
    checkedAt: new Date().toISOString(),
  };
};

const refreshPolymarketProxyPool = async ({ force = false, reason = 'scheduled' } = {}) => {
  if (!state.dynamic.enabled) {
    return {
      ok: false,
      skipped: true,
      reason: 'disabled',
      proxies: state.dynamic.pool.length,
      refreshedAt: state.dynamic.lastRefreshCompletedAt ? new Date(state.dynamic.lastRefreshCompletedAt).toISOString() : null,
    };
  }

  const now = Date.now();
  if (!force && state.dynamic.lastRefreshCompletedAt && now - state.dynamic.lastRefreshCompletedAt < state.dynamic.refreshIntervalMs) {
    return {
      ok: true,
      skipped: true,
      reason: 'fresh',
      proxies: state.dynamic.pool.length,
      refreshedAt: new Date(state.dynamic.lastRefreshCompletedAt).toISOString(),
    };
  }

  if (state.dynamic.refreshPromise) {
    return await state.dynamic.refreshPromise;
  }

  state.dynamic.refreshPromise = (async () => {
    state.dynamic.lastRefreshStartedAt = Date.now();
    state.dynamic.lastError = null;
    state.dynamic.stats = {
      reason,
      candidates: 0,
      tested: 0,
      accepted: 0,
      rejectedCountry: 0,
      rejectedTest: 0,
      retainedFromCache: state.dynamic.pool.length,
    };

    let candidates;
    try {
      candidates = await fetchProxyCandidates();
    } catch (error) {
      state.dynamic.lastError = formatAxiosError(error);
      throw error;
    }

    state.dynamic.stats.candidates = candidates.length;
    shuffleInPlace(candidates);
    const toTest = candidates.slice(0, Math.max(1, Math.min(state.dynamic.maxTests, candidates.length)));

    const accepted = [];
    let cursor = 0;
    let stop = false;

    const worker = async () => {
      while (!stop) {
        const idx = cursor;
        cursor += 1;
        if (idx >= toTest.length) {
          return;
        }
        if (stop) return;

        const candidate = toTest[idx];
        state.dynamic.stats.tested += 1;
        try {
          const probe = await testProxy(candidate);
          if (!shouldAllowCountry(probe.country)) {
            state.dynamic.stats.rejectedCountry += 1;
            continue;
          }
          accepted.push({ ...candidate, ...probe });
          state.dynamic.stats.accepted = accepted.length;
          if (accepted.length >= state.dynamic.maxGood) {
            stop = true;
            return;
          }
        } catch (error) {
          state.dynamic.stats.rejectedTest += 1;
          if (!isRetryableProxyTestError(error)) {
            // Keep moving; not retrying the same proxy.
          }
        }
      }
    };

    await Promise.all(Array.from({ length: state.dynamic.testConcurrency }, () => worker()));

    state.dynamic.pool = accepted;
    state.dynamic.cursor = 0;
    state.dynamic.lastRefreshCompletedAt = Date.now();
    clearPolymarketHttpsAgentCache();
    persistCacheToDisk();

    return {
      ok: true,
      skipped: false,
      reason,
      proxies: state.dynamic.pool.length,
      refreshedAt: new Date(state.dynamic.lastRefreshCompletedAt).toISOString(),
      stats: state.dynamic.stats,
    };
  })()
    .catch((error) => {
      state.dynamic.lastError = formatAxiosError(error);
      return {
        ok: false,
        skipped: false,
        reason: 'error',
        error: state.dynamic.lastError,
        proxies: state.dynamic.pool.length,
        refreshedAt: state.dynamic.lastRefreshCompletedAt ? new Date(state.dynamic.lastRefreshCompletedAt).toISOString() : null,
        stats: state.dynamic.stats,
      };
    })
    .finally(() => {
      state.dynamic.refreshPromise = null;
    });

  return await state.dynamic.refreshPromise;
};

const maybeRefreshInBackground = () => {
  if (!state.dynamic.enabled) return;
  const now = Date.now();
  if (state.dynamic.refreshPromise) return;
  if (state.dynamic.lastRefreshCompletedAt && now - state.dynamic.lastRefreshCompletedAt < state.dynamic.refreshIntervalMs) {
    return;
  }
  void refreshPolymarketProxyPool({ force: false, reason: 'auto' }).then((result) => {
    if (!result?.ok) {
      console.warn('[Polymarket Proxy Pool] Refresh failed:', result?.error || result?.reason);
    } else if (!result?.skipped) {
      console.log('[Polymarket Proxy Pool] Refreshed:', {
        proxies: result.proxies,
        refreshedAt: result.refreshedAt,
        reason: result.reason,
      });
    }
  });
};

const getNextPolymarketProxyConfig = () => {
  maybeRefreshInBackground();
  if (state.dynamic.pool.length) {
    const picked = pickFromPoolSkippingCooldown(state.dynamic, state.dynamic.pool);
    if (picked) return picked;
  }
  const envPool = getEnvProxyPool();
  return pickFromPoolSkippingCooldown(state.env, envPool);
};

const peekPolymarketProxyConfig = () => {
  if (state.dynamic.pool.length) {
    return peekFromPoolSkippingCooldown(state.dynamic, state.dynamic.pool);
  }
  const envPool = getEnvProxyPool();
  return peekFromPoolSkippingCooldown(state.env, envPool);
};

const getPolymarketProxyPoolKey = () => {
  if (state.dynamic.pool.length) {
    return 'polymarket-proxy-pool:dynamic';
  }
  if (getEnvProxyPool().length) {
    return 'polymarket-proxy-pool:env';
  }
  return 'polymarket-proxy-pool:none';
};

const getPolymarketProxyDebugInfo = () => {
  const current = peekPolymarketProxyConfig();
  const usingDynamic = state.dynamic.pool.length > 0;
  const authPresent = Boolean(current?.auth && (current.auth.username || current.auth.password));
  const cooldownRemainingMs = current ? getProxyFailureRemainingMs(current) : 0;
  return {
    source: usingDynamic ? 'dynamic' : getEnvProxyPool().length ? 'env' : 'none',
    configured: Boolean(current),
    count: usingDynamic ? state.dynamic.pool.length : getEnvProxyPool().length,
    host: current?.host ?? null,
    port: current?.port ?? null,
    authPresent,
    dynamic: {
      enabled: state.dynamic.enabled,
      url: Array.isArray(state.dynamic.urls) ? state.dynamic.urls[0] || null : null,
      urls: Array.isArray(state.dynamic.urls) ? state.dynamic.urls : [],
      testUrl: state.dynamic.testUrl,
      refreshIntervalMs: state.dynamic.refreshIntervalMs,
      failureCooldownMs: state.dynamic.failureCooldownMs,
      cooldownActive: cooldownRemainingMs > 0,
      cooldownRemainingMs,
      cooldownPoolSize: countActiveProxyCooldowns(),
      lastRefreshStartedAt: state.dynamic.lastRefreshStartedAt || 0,
      lastRefreshCompletedAt: state.dynamic.lastRefreshCompletedAt || 0,
      lastError: state.dynamic.lastError || null,
      poolSize: state.dynamic.pool.length,
      stats: state.dynamic.stats,
    },
  };
};

module.exports = {
  getPolymarketHttpsAgent,
  notePolymarketProxyFailure,
  refreshPolymarketProxyPool,
  getNextPolymarketProxyConfig,
  peekPolymarketProxyConfig,
  getPolymarketProxyPoolKey,
  getPolymarketProxyDebugInfo,
};
