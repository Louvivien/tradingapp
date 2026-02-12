const crypto = require('crypto');
const fs = require('fs');
const Axios = require('axios');
const CryptoJS = require('crypto-js');
const { Wallet, providers, Contract, utils, constants, BigNumber } = require('ethers');
const {
  getNextPolymarketProxyConfig,
  getPolymarketProxyDebugInfo,
  getPolymarketHttpsAgent,
  notePolymarketProxyFailure,
} = require('./polymarketProxyPoolService');

const normalizeEnvValue = (value) => String(value || '').trim();

const isValidHexAddress = (value) => /^0x[a-fA-F0-9]{40}$/.test(normalizeEnvValue(value));

const decryptIfEncrypted = (value) => {
  const raw = normalizeEnvValue(value);
  if (!raw) return '';
  if (!raw.startsWith('U2Fsd')) return raw;

  const encryptionKey = normalizeEnvValue(process.env.ENCRYPTION_KEY || process.env.CryptoJS_secret_key);
  if (!encryptionKey) {
    throw new Error('Encrypted Polymarket secret provided but ENCRYPTION_KEY/CryptoJS_secret_key is not set.');
  }
  const bytes = CryptoJS.AES.decrypt(raw, encryptionKey);
  const decrypted = bytes.toString(CryptoJS.enc.Utf8);
  return normalizeEnvValue(decrypted);
};

const normalizeExecutionMode = (value) => {
  const raw = normalizeEnvValue(value).toLowerCase();
  if (!raw) return 'paper';
  if (raw === 'live' || raw === 'real') return 'live';
  if (raw === 'paper' || raw === 'dry' || raw === 'dry-run' || raw === 'dryrun') return 'paper';
  if (raw === 'true' || raw === '1' || raw === 'yes') return 'live';
  if (raw === 'false' || raw === '0' || raw === 'no') return 'paper';
  return 'paper';
};

const getPolymarketExecutionMode = () => normalizeExecutionMode(process.env.POLYMARKET_EXECUTION_MODE);

const normalizeChainId = (value) => {
  const raw = normalizeEnvValue(value).toLowerCase();
  if (!raw) return 137;
  if (raw === 'polygon' || raw === 'mainnet') return 137;
  if (raw === 'amoy' || raw === 'testnet') return 80002;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && (parsed === 137 || parsed === 80002)) return parsed;
  return 137;
};

const getPolymarketChainId = () => normalizeChainId(process.env.POLYMARKET_CHAIN_ID || process.env.POLYMARKET_CHAIN);

const parseSignatureType = (value) => {
  const raw = normalizeEnvValue(value);
  if (!raw) return 0;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && (parsed === 0 || parsed === 1)) return parsed;
  return 0;
};

const getPolymarketSignatureType = () =>
  parseSignatureType(process.env.POLYMARKET_SIGNATURE_TYPE || process.env.POLYMARKET_ORDER_SIGNATURE_TYPE);

const parseBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  const raw = normalizeEnvValue(value).toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return fallback;
};

const getPolymarketUseServerTime = () => parseBoolean(process.env.POLYMARKET_USE_SERVER_TIME, true);

const POLYMARKET_CLOB_TIMEOUT_MS = (() => {
  const raw = Number(process.env.POLYMARKET_CLOB_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 15_000;
  }
  return Math.max(1_000, Math.min(Math.floor(raw), 120_000));
})();

const POLYMARKET_CLOB_RATE_LIMIT_COOLDOWN_MS = (() => {
  const raw = Number(process.env.POLYMARKET_CLOB_RATE_LIMIT_COOLDOWN_MS);
  if (!Number.isFinite(raw)) {
    return 60_000;
  }
  return Math.max(0, Math.min(Math.floor(raw), 60 * 60 * 1000));
})();

const clobRateLimitState = {
  disabledUntilMs: 0,
  lastStatus: null,
  lastTriggeredAtMs: 0,
  lastRetryAfterMs: 0,
};

const isClobRateLimitActive = () =>
  POLYMARKET_CLOB_RATE_LIMIT_COOLDOWN_MS > 0 && Date.now() < clobRateLimitState.disabledUntilMs;

const getClobRateLimitCooldownStatus = () => {
  const cooldownMs = POLYMARKET_CLOB_RATE_LIMIT_COOLDOWN_MS;
  const disabledUntilMs = Number(clobRateLimitState.disabledUntilMs) || 0;
  const now = Date.now();
  const active = cooldownMs > 0 && disabledUntilMs > now;
  const remainingMs = active ? disabledUntilMs - now : 0;
  return {
    cooldownMs,
    active,
    remainingMs,
    disabledUntilMs: active ? disabledUntilMs : 0,
    disabledUntil: active ? new Date(disabledUntilMs).toISOString() : null,
    lastStatus: clobRateLimitState.lastStatus,
    lastTriggeredAt: clobRateLimitState.lastTriggeredAtMs
      ? new Date(clobRateLimitState.lastTriggeredAtMs).toISOString()
      : null,
    lastRetryAfterMs: clobRateLimitState.lastRetryAfterMs || 0,
  };
};

const resetClobRateLimitCooldown = () => {
  clobRateLimitState.disabledUntilMs = 0;
  clobRateLimitState.lastStatus = null;
  clobRateLimitState.lastTriggeredAtMs = 0;
  clobRateLimitState.lastRetryAfterMs = 0;
};

let clobUserAgentInterceptorKeyCjs = null;
let clobUserAgentInterceptorKeyEsm = null;
let clobProxyInterceptorKeyCjs = null;
let clobProxyInterceptorKeyEsm = null;
let clobProxyFailureInterceptorKeyCjs = null;
let clobProxyFailureInterceptorKeyEsm = null;
let clobRequestGuardInterceptorKeyCjs = null;
let clobRequestGuardInterceptorKeyEsm = null;
let clobProxyPoolKey = null;
let clobProxyPool = [];
let clobProxyCursor = 0;

let axiosEsmPromise = null;
const getAxiosEsm = async () => {
  if (!axiosEsmPromise) {
    axiosEsmPromise = import('axios')
      .then((mod) => mod?.default || null)
      .catch(() => null);
  }
  return await axiosEsmPromise;
};

const getClobProxyEnvList = () => {
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

const normalizeProxyUrl = (value) => {
  const raw = normalizeEnvValue(value);
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
    return { host: parsed.hostname, port, ...(auth ? { auth } : {}) };
  } catch {
    return null;
  }
};

const getClobProxyPool = () => {
  const list = getClobProxyEnvList();
  const key = list.join(',');
  if (key !== clobProxyPoolKey) {
    clobProxyPoolKey = key;
    clobProxyPool = list.map(parseProxyUrl).filter(Boolean);
    clobProxyCursor = 0;
  }
  return clobProxyPool;
};

const getClobProxyPoolKey = () => {
  getClobProxyPool();
  return clobProxyPoolKey || '';
};

const getNextClobProxyConfig = () => {
  const pool = getClobProxyPool();
  if (!pool.length) {
    return null;
  }
  const idx = clobProxyCursor % pool.length;
  clobProxyCursor = (clobProxyCursor + 1) % pool.length;
  return pool[idx];
};

const peekClobProxyConfig = () => {
  const pool = getClobProxyPool();
  if (!pool.length) {
    return null;
  }
  return pool[clobProxyCursor % pool.length];
};

const getClobProxyDebugInfo = () => {
  const list = getClobProxyEnvList();
  const config = peekClobProxyConfig();
  const authPresent = Boolean(config?.auth && (config.auth.username || config.auth.password));
  return {
    configured: Boolean(config),
    count: list.length,
    host: config?.host ?? null,
    port: config?.port ?? null,
    authPresent,
  };
};

const ensureAxiosUserAgentInterceptor = (axiosInstance, host, userAgent, currentKey) => {
  if (!axiosInstance || !axiosInstance.interceptors?.request || !host || !userAgent) {
    return currentKey;
  }
  const key = `${host}|${userAgent}`;
  if (currentKey === key) {
    return currentKey;
  }

  axiosInstance.interceptors.request.use((config) => {
    if (!config || !config.url) {
      return config;
    }
    if (String(config.url).startsWith(host)) {
      config.headers = config.headers || {};
      config.headers['User-Agent'] = userAgent;
    }
    return config;
  });

  return key;
};

const attachHiddenConfigValue = (config, key, value) => {
  if (!config || !key) return;
  try {
    Object.defineProperty(config, key, {
      value,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    config[key] = value;
  }
};

const extractCloudflareHtmlText = (payload) => {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload?.error === 'string') return payload.error;
  if (typeof payload?.message === 'string') return payload.message;
  return '';
};

const looksLikeCloudflareBlockPage = (payload) => {
  const body = extractCloudflareHtmlText(payload);
  if (!body) return false;
  const lower = body.toLowerCase();
  if (!lower.includes('cloudflare')) return false;
  return (
    lower.includes('ray id') ||
    lower.includes('cf-error-details') ||
    lower.includes('attention required') ||
    lower.includes('sorry, you have been blocked')
  );
};

const looksLikeCloudflareRateLimitPage = (payload) => {
  const body = extractCloudflareHtmlText(payload);
  if (!body) return false;
  const lower = body.toLowerCase();
  return lower.includes('error 1015') || (lower.includes('rate') && lower.includes('limited'));
};

const ensureAxiosProxyInterceptor = (axiosInstance, host, proxyProvider, currentKey) => {
  if (!axiosInstance || !axiosInstance.interceptors?.request || !host || !proxyProvider?.getProxy) {
    return currentKey;
  }
  const key = `${host}|${proxyProvider.key}`;
  if (currentKey === key) {
    return currentKey;
  }

  axiosInstance.interceptors.request.use((config) => {
    if (!config || !config.url) {
      return config;
    }
    if (String(config.url).startsWith(host)) {
      const proxyConfig = proxyProvider.getProxy();
      const httpsAgent = proxyConfig ? getPolymarketHttpsAgent(proxyConfig) : null;
      if (proxyConfig) {
        // Disable Axios's built-in proxy support and use an explicit HTTPS proxy agent instead.
        config.proxy = false;
        if (httpsAgent) {
          config.httpsAgent = httpsAgent;
        }
        attachHiddenConfigValue(config, '__polymarketProxy', proxyConfig);
      }
    }
    return config;
  });

  return key;
};

const parseRetryAfterMs = (headers) => {
  if (!headers || typeof headers !== 'object') {
    return null;
  }
  const raw = headers['retry-after'] ?? headers['Retry-After'] ?? null;
  if (raw === null || raw === undefined) {
    return null;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return Math.floor(seconds * 1000);
};

const noteClobRateLimit = ({ status, headers, payload } = {}) => {
  if (POLYMARKET_CLOB_RATE_LIMIT_COOLDOWN_MS <= 0) {
    return null;
  }
  const now = Date.now();
  const retryAfterMs = parseRetryAfterMs(headers) || 0;
  const cooldownMs = Math.max(POLYMARKET_CLOB_RATE_LIMIT_COOLDOWN_MS, retryAfterMs);
  const disabledUntilMs = now + cooldownMs;
  clobRateLimitState.disabledUntilMs = Math.max(clobRateLimitState.disabledUntilMs || 0, disabledUntilMs);
  clobRateLimitState.lastStatus = Number.isFinite(Number(status)) ? Number(status) : null;
  clobRateLimitState.lastTriggeredAtMs = now;
  clobRateLimitState.lastRetryAfterMs = retryAfterMs;

  const isCloudflare = looksLikeCloudflareBlockPage(payload) || looksLikeCloudflareRateLimitPage(payload);
  if (isCloudflare) {
    try {
      console.warn(
        `[CLOB Client] Rate limited by Cloudflare; pausing requests for ${Math.round(cooldownMs / 1000)}s.`
      );
    } catch {
      // ignore
    }
  }

  return new Date(clobRateLimitState.disabledUntilMs).toISOString();
};

const ensureAxiosRequestGuardInterceptor = (axiosInstance, host, currentKey) => {
  if (!axiosInstance || !axiosInstance.interceptors?.request || !axiosInstance.interceptors?.response || !host) {
    return currentKey;
  }
  const key = `${host}|polymarket-clob-guard`;
  if (currentKey === key) {
    return currentKey;
  }

  axiosInstance.interceptors.request.use((config) => {
    if (!config || !config.url) {
      return config;
    }
    if (!String(config.url).startsWith(host)) {
      return config;
    }

    if (!config.timeout || Number(config.timeout) <= 0) {
      config.timeout = POLYMARKET_CLOB_TIMEOUT_MS;
    }

    if (isClobRateLimitActive()) {
      const remainingMs = Math.max(0, clobRateLimitState.disabledUntilMs - Date.now());
      const err = new Error(
        `Polymarket CLOB temporarily rate limited (cooldown ${Math.ceil(remainingMs / 1000)}s remaining).`
      );
      err.status = 429;
      err.code = 'POLYMARKET_RATE_LIMIT';
      throw err;
    }

    return config;
  });

  axiosInstance.interceptors.response.use(
    (response) => response,
    (error) => {
      try {
        const url = String(error?.config?.url || '');
        if (url.startsWith(host)) {
          const status = Number(error?.response?.status);
          const payload = error?.response?.data;
          if (status === 429 || looksLikeCloudflareRateLimitPage(payload)) {
            noteClobRateLimit({ status, headers: error?.response?.headers, payload });
          }
        }
      } catch {
        // ignore
      }
      return Promise.reject(error);
    }
  );

  return key;
};

const ensureAxiosProxyFailureInterceptor = (axiosInstance, host, currentKey) => {
  if (!axiosInstance || !axiosInstance.interceptors?.response || !host) {
    return currentKey;
  }
  const key = `${host}|polymarket-proxy-failure`;
  if (currentKey === key) {
    return currentKey;
  }

  axiosInstance.interceptors.response.use(
    (response) => response,
    (error) => {
      try {
        const url = String(error?.config?.url || '');
        if (url.startsWith(host)) {
          const proxyConfig = error?.config?.__polymarketProxy;
          const status = Number(error?.response?.status);
          const code = String(error?.code || '').toUpperCase();

          if (
            proxyConfig &&
            (code === 'ECONNRESET' ||
              code === 'ECONNREFUSED' ||
              code === 'ETIMEDOUT' ||
              code === 'EHOSTUNREACH' ||
              code === 'ENETUNREACH' ||
              code === 'EAI_AGAIN')
          ) {
            notePolymarketProxyFailure(proxyConfig, { reason: `network_${code.toLowerCase()}` });
          } else if (proxyConfig && status === 407) {
            notePolymarketProxyFailure(proxyConfig, { reason: 'proxy_auth_required' });
          }

          if (status === 403 && looksLikeCloudflareBlockPage(error?.response?.data)) {
            if (proxyConfig) {
              notePolymarketProxyFailure(proxyConfig, { reason: 'cloudflare_403' });
            }
          }
        }
      } catch {
        // ignore
      }
      return Promise.reject(error);
    }
  );

  return key;
};

const ensureClobUserAgentInterceptor = async (host) => {
  const userAgent = normalizeEnvValue(
    process.env.POLYMARKET_CLOB_USER_AGENT || process.env.POLYMARKET_HTTP_USER_AGENT || 'tradingapp/1.0'
  );
  if (!userAgent || !host) {
    return;
  }
  clobUserAgentInterceptorKeyCjs = ensureAxiosUserAgentInterceptor(
    Axios,
    host,
    userAgent,
    clobUserAgentInterceptorKeyCjs
  );
  const axiosEsm = await getAxiosEsm();
  if (axiosEsm) {
    clobUserAgentInterceptorKeyEsm = ensureAxiosUserAgentInterceptor(
      axiosEsm,
      host,
      userAgent,
      clobUserAgentInterceptorKeyEsm
    );
  }
};

const ensureClobProxyInterceptor = async (host) => {
  if (!host) {
    return;
  }
  const proxyProvider = { key: 'polymarket-proxy-pool', getProxy: getNextPolymarketProxyConfig };
  clobProxyInterceptorKeyCjs = ensureAxiosProxyInterceptor(Axios, host, proxyProvider, clobProxyInterceptorKeyCjs);
  const axiosEsm = await getAxiosEsm();
  if (axiosEsm) {
    clobProxyInterceptorKeyEsm = ensureAxiosProxyInterceptor(
      axiosEsm,
      host,
      proxyProvider,
      clobProxyInterceptorKeyEsm
    );
  }
};

const ensureClobProxyFailureInterceptor = async (host) => {
  if (!host) {
    return;
  }
  clobProxyFailureInterceptorKeyCjs = ensureAxiosProxyFailureInterceptor(Axios, host, clobProxyFailureInterceptorKeyCjs);
  const axiosEsm = await getAxiosEsm();
  if (axiosEsm) {
    clobProxyFailureInterceptorKeyEsm = ensureAxiosProxyFailureInterceptor(
      axiosEsm,
      host,
      clobProxyFailureInterceptorKeyEsm
    );
  }
};

const ensureClobRequestGuardInterceptor = async (host) => {
  if (!host) {
    return;
  }
  clobRequestGuardInterceptorKeyCjs = ensureAxiosRequestGuardInterceptor(
    Axios,
    host,
    clobRequestGuardInterceptorKeyCjs
  );
  const axiosEsm = await getAxiosEsm();
  if (axiosEsm) {
    clobRequestGuardInterceptorKeyEsm = ensureAxiosRequestGuardInterceptor(
      axiosEsm,
      host,
      clobRequestGuardInterceptorKeyEsm
    );
  }
};

const normalizePrivateKey = (value) => {
  const raw = normalizeEnvValue(value);
  if (!raw) return '';
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return raw;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return `0x${raw}`;
  return raw;
};

const readFirstNonEmptyLine = (contents) =>
  String(contents || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0] || '';

const readPolymarketPrivateKeyFromFile = () => {
  const filePath = normalizeEnvValue(
    process.env.POLYMARKET_PRIVATE_KEY_FILE ||
      process.env.POLYMARKET_PRIVATE_KEY_PATH ||
      process.env.POLYMARKET_SIGNER_PRIVATE_KEY_FILE ||
      process.env.POLYMARKET_SIGNER_PRIVATE_KEY_PATH
  );
  if (!filePath) return '';

  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`POLYMARKET_PRIVATE_KEY_FILE could not be read: ${filePath}`);
  }

  const firstLine = readFirstNonEmptyLine(contents);
  if (!firstLine) {
    throw new Error(`POLYMARKET_PRIVATE_KEY_FILE is empty: ${filePath}`);
  }

  return normalizePrivateKey(decryptIfEncrypted(firstLine));
};

const getPolymarketLiveEnv = () => {
  const host = normalizeEnvValue(process.env.POLYMARKET_CLOB_HOST || process.env.CLOB_API_URL || 'https://clob.polymarket.com').replace(
    /\/+$/,
    ''
  );
  const chainId = getPolymarketChainId();
  const signatureType = getPolymarketSignatureType();
  const funderAddressRaw = normalizeEnvValue(
    process.env.POLYMARKET_FUNDER_ADDRESS || process.env.POLYMARKET_PROFILE_ADDRESS || ''
  );
  const funderAddress = isValidHexAddress(funderAddressRaw) ? funderAddressRaw : null;
  const geoBlockToken =
    normalizeEnvValue(process.env.POLYMARKET_GEO_BLOCK_TOKEN || process.env.GEO_BLOCK_TOKEN) || null;
  const useServerTime = getPolymarketUseServerTime();

  const apiKey = decryptIfEncrypted(process.env.POLYMARKET_API_KEY || process.env.CLOB_API_KEY);
  const secret = decryptIfEncrypted(process.env.POLYMARKET_SECRET || process.env.CLOB_SECRET);
  const passphrase = decryptIfEncrypted(process.env.POLYMARKET_PASSPHRASE || process.env.CLOB_PASS_PHRASE);

  const privateKeyEnv = normalizePrivateKey(
    decryptIfEncrypted(process.env.POLYMARKET_PRIVATE_KEY || process.env.POLYMARKET_SIGNER_PRIVATE_KEY)
  );
  const privateKey = privateKeyEnv || readPolymarketPrivateKeyFromFile();

  const authAddress = normalizeEnvValue(process.env.POLYMARKET_AUTH_ADDRESS || process.env.POLYMARKET_ADDRESS);

  return {
    host,
    chainId,
    signatureType,
    funderAddress,
    geoBlockToken,
    useServerTime,
    creds: { apiKey, secret, passphrase },
    privateKey,
    authAddress,
  };
};

const buildSecretFingerprint = (value) => {
  const raw = normalizeEnvValue(value);
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
};

const getPolymarketExecutionDebugInfo = () => {
  const mode = getPolymarketExecutionMode();
  let env;
  let decryptError = null;
  try {
    env = getPolymarketLiveEnv();
  } catch (error) {
    decryptError = String(error?.message || error);
    env = {
      host: normalizeEnvValue(process.env.POLYMARKET_CLOB_HOST || process.env.CLOB_API_URL || 'https://clob.polymarket.com').replace(
        /\/+$/,
        ''
      ),
      chainId: getPolymarketChainId(),
      signatureType: getPolymarketSignatureType(),
      funderAddress: null,
      geoBlockToken:
        normalizeEnvValue(process.env.POLYMARKET_GEO_BLOCK_TOKEN || process.env.GEO_BLOCK_TOKEN) || null,
      useServerTime: getPolymarketUseServerTime(),
      creds: { apiKey: '', secret: '', passphrase: '' },
      privateKey: '',
      authAddress: normalizeEnvValue(process.env.POLYMARKET_AUTH_ADDRESS || process.env.POLYMARKET_ADDRESS),
    };
  }

  const privateKeyPresent = Boolean(env.privateKey);
  const privateKeyLooksHex =
    Boolean(env.privateKey) && (/^0x[0-9a-fA-F]{64}$/.test(env.privateKey) || /^[0-9a-fA-F]{64}$/.test(env.privateKey));

  const signerAddress = (() => {
    if (!env.privateKey || !privateKeyLooksHex) return null;
    try {
      const wallet = new Wallet(env.privateKey);
      return wallet.address;
    } catch {
      return null;
    }
  })();

  const authAddressPresent = Boolean(env.authAddress);
  const authAddressValid = isValidHexAddress(env.authAddress);
  const authMatchesPrivateKey =
    Boolean(signerAddress && authAddressValid) &&
    signerAddress.toLowerCase() === normalizeEnvValue(env.authAddress).toLowerCase();

  const l2CredsPresent = Boolean(env.creds.apiKey && env.creds.secret && env.creds.passphrase);

  return {
    mode,
    host: env.host,
    chainId: env.chainId,
    signatureType: env.signatureType,
    useServerTime: env.useServerTime,
    geoTokenSet: Boolean(env.geoBlockToken),
    proxy: getPolymarketProxyDebugInfo(),
    l2CredsPresent,
    decryptError,
    clobRateLimit: getClobRateLimitCooldownStatus(),
    authAddressPresent,
    authAddressValid,
    authMatchesPrivateKey,
    funderAddressPresent: Boolean(env.funderAddress),
    privateKey: {
      rawPresent: privateKeyPresent,
      looksHex: privateKeyLooksHex,
      length: env.privateKey ? env.privateKey.length : 0,
      sha256_12: env.privateKey ? buildSecretFingerprint(env.privateKey) : null,
      derivedAddress: signerAddress,
    },
  };
};

let clobModulePromise = null;
const loadClobModule = async () => {
  if (!clobModulePromise) {
    clobModulePromise = import('@polymarket/clob-client');
  }
  return await clobModulePromise;
};

const normalizeRpcUrl = (value) => {
  const raw = normalizeEnvValue(value);
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
};

const getDefaultRpcUrlForChain = (chainId) => {
  if (chainId === 80002) {
    return 'https://rpc-amoy.polygon.technology';
  }
  return 'https://polygon-rpc.com';
};

const getPolymarketRpcUrl = (chainId) => {
  const configured = normalizeRpcUrl(
    process.env.POLYMARKET_RPC_URL ||
      process.env.POLYGON_RPC_URL ||
      process.env.POLYGON_RPC ||
      process.env.RPC_URL ||
      process.env.JSON_RPC_URL
  );
  return configured || getDefaultRpcUrlForChain(chainId);
};

const getContractConfig = (chainId) => {
  if (chainId === 80002) {
    return {
      exchange: '0xdFE02Eb6733538f8Ea35D585af8DE5958AD99E40',
      negRiskExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
      collateral: '0x9c4e1703476e875070ee25b56a58b008cfb8fa78',
    };
  }
  return {
    exchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
    negRiskExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
    collateral: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  };
};

const DEFAULT_GAMMA_HOST = normalizeEnvValue(process.env.POLYMARKET_GAMMA_API_HOST || 'https://gamma-api.polymarket.com').replace(
  /\/+$/,
  ''
);

const getRedeemContractConfig = (chainId) => {
  // Mainnet-only for now; contract addresses may differ on testnets.
  if (chainId !== 137) {
    return null;
  }
  return {
    proxyWalletFactory: '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052',
    conditionalTokens: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
    negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
  };
};

let cachedClient = null;
let cachedClientKey = null;

const getPolymarketClobClient = async (options = {}) => {
  const mode = getPolymarketExecutionMode();
  const requireLiveMode = options?.requireLiveMode ?? true;
  if (requireLiveMode && mode !== 'live') {
    throw new Error('Polymarket execution is in paper mode.');
  }

  const env = getPolymarketLiveEnv();
  ensureClobUserAgentInterceptor(env.host);
  ensureClobProxyInterceptor(env.host);
  ensureClobProxyFailureInterceptor(env.host);
  ensureClobRequestGuardInterceptor(env.host);
  if (!env.creds.apiKey || !env.creds.secret || !env.creds.passphrase) {
    throw new Error('Missing POLYMARKET_* CLOB credentials for live trading.');
  }
  if (!env.privateKey) {
    throw new Error('Missing POLYMARKET_PRIVATE_KEY (or POLYMARKET_PRIVATE_KEY_FILE) for live trading.');
  }

  let wallet;
  try {
    wallet = new Wallet(env.privateKey);
  } catch {
    throw new Error('POLYMARKET_PRIVATE_KEY (or POLYMARKET_PRIVATE_KEY_FILE) is invalid.');
  }

  if (env.authAddress && isValidHexAddress(env.authAddress)) {
    const expected = normalizeEnvValue(env.authAddress).toLowerCase();
    if (wallet.address.toLowerCase() !== expected) {
      throw new Error('POLYMARKET_AUTH_ADDRESS does not match POLYMARKET_PRIVATE_KEY.');
    }
  }

  const cacheKey = JSON.stringify({
    host: env.host,
    chainId: env.chainId,
    signatureType: env.signatureType,
    funderAddress: env.funderAddress,
    geoTokenSet: Boolean(env.geoBlockToken),
    useServerTime: env.useServerTime,
    authAddress: wallet.address,
    apiKeyFp: buildSecretFingerprint(env.creds.apiKey),
    secretFp: buildSecretFingerprint(env.creds.secret),
    passFp: buildSecretFingerprint(env.creds.passphrase),
    pkFp: buildSecretFingerprint(env.privateKey),
  });

  if (cachedClient && cachedClientKey === cacheKey) {
    return cachedClient;
  }

  const { ClobClient } = await loadClobModule();
  const creds = { key: env.creds.apiKey, secret: env.creds.secret, passphrase: env.creds.passphrase };
  const client = new ClobClient(
    env.host,
    env.chainId,
    wallet,
    creds,
    env.signatureType,
    env.funderAddress || undefined,
    env.geoBlockToken || undefined,
    env.useServerTime
  );

  cachedClient = client;
  cachedClientKey = cacheKey;
  return client;
};

const getPolymarketBalanceAllowance = async () => {
  const chainId = getPolymarketChainId();
  const rpcUrl = getPolymarketRpcUrl(chainId);
  const contracts = getContractConfig(chainId);

  const funderRaw = normalizeEnvValue(process.env.POLYMARKET_FUNDER_ADDRESS || process.env.POLYMARKET_PROFILE_ADDRESS);
  const funderAddress = isValidHexAddress(funderRaw) ? funderRaw : null;

  const authRaw = normalizeEnvValue(process.env.POLYMARKET_AUTH_ADDRESS || process.env.POLYMARKET_ADDRESS);
  const authAddress = isValidHexAddress(authRaw) ? authRaw : null;

  const address = funderAddress || authAddress;
  if (!address) {
    throw new Error(
      'Missing deposit address. Set POLYMARKET_FUNDER_ADDRESS (preferred) or POLYMARKET_AUTH_ADDRESS.'
    );
  }

  const provider = new providers.JsonRpcProvider(rpcUrl, chainId);
  const erc20 = new Contract(
    contracts.collateral,
    ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'],
    provider
  );

  const [balanceBaseUnits, allowanceBaseUnits] = await Promise.all([
    erc20.balanceOf(address),
    erc20.allowance(address, contracts.exchange),
  ]);

  const balance = Number(utils.formatUnits(balanceBaseUnits, 6));
  const allowance = Number(utils.formatUnits(allowanceBaseUnits, 6));

  return {
    source: 'onchain',
    chainId,
    rpcUrl,
    funderAddress,
    authAddress,
    address,
    collateral: contracts.collateral,
    spender: contracts.exchange,
    balance,
    allowance,
    raw: {
      balanceBaseUnits: balanceBaseUnits?.toString?.() ?? null,
      allowanceBaseUnits: allowanceBaseUnits?.toString?.() ?? null,
    },
  };
};

const getPolymarketOnchainUsdcBalance = async (address) => {
  const cleanedAddress = normalizeEnvValue(address);
  if (!isValidHexAddress(cleanedAddress)) {
    throw new Error('Address is missing or invalid.');
  }

  const chainId = getPolymarketChainId();
  const rpcUrl = getPolymarketRpcUrl(chainId);
  const contracts = getContractConfig(chainId);

  const provider = new providers.JsonRpcProvider(rpcUrl, chainId);
  const erc20 = new Contract(contracts.collateral, ['function balanceOf(address) view returns (uint256)'], provider);
  const balanceBaseUnits = await erc20.balanceOf(cleanedAddress);
  const balance = Number(utils.formatUnits(balanceBaseUnits, 6));

  return {
    source: 'onchain',
    chainId,
    rpcUrl,
    address: cleanedAddress,
    collateral: contracts.collateral,
    balance,
    raw: {
      balanceBaseUnits: balanceBaseUnits?.toString?.() ?? null,
    },
  };
};

const parseFiniteNumberOrNull = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const parseUsdcFromBaseUnitsOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  try {
    return Number(utils.formatUnits(value, 6));
  } catch {
    return null;
  }
};

const getPolymarketClobBalanceAllowance = async () => {
  const mode = getPolymarketExecutionMode();
  if (mode !== 'live') {
    throw new Error('Polymarket execution is in paper mode.');
  }

  const env = getPolymarketLiveEnv();
  const clobClient = await getPolymarketClobClient();
  const { AssetType } = await loadClobModule();

  const response = await clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  if (!response || typeof response !== 'object') {
    throw new Error('CLOB balance-allowance returned an empty response.');
  }

  if (response?.error) {
    const status = Number(response?.status);
    const wrapped = new Error(String(response?.error || 'CLOB balance-allowance failed'));
    if (Number.isFinite(status) && status > 0) {
      wrapped.response = { status, data: response };
    } else {
      wrapped.response = { data: response };
    }
    throw wrapped;
  }

  const contracts = getContractConfig(env.chainId);
  const allowancesBySpender =
    response?.allowances && typeof response.allowances === 'object' ? response.allowances : null;
  const exchangeAllowanceBaseUnits = allowancesBySpender
    ? allowancesBySpender[contracts.exchange] ?? null
    : response?.allowance ?? null;

  return {
    source: 'clob-l2',
    host: env.host,
    chainId: env.chainId,
    signatureType: env.signatureType,
    funderAddress: env.funderAddress || null,
    authAddress: isValidHexAddress(env.authAddress) ? env.authAddress : null,
    geoTokenSet: Boolean(env.geoBlockToken),
    spender: contracts.exchange,
    balance: parseUsdcFromBaseUnitsOrNull(response?.balance),
    allowance: parseUsdcFromBaseUnitsOrNull(exchangeAllowanceBaseUnits),
    raw: {
      balance: response?.balance ?? null,
      allowance: response?.allowance ?? null,
      allowances: allowancesBySpender ?? null,
    },
  };
};

const normalizeMarketOrderType = (value) => {
  const raw = normalizeEnvValue(value).toLowerCase();
  if (!raw) return 'fak';
  if (raw === 'fok') return 'fok';
  if (raw === 'fa k' || raw === 'fa-k') return 'fak';
  if (raw === 'fak') return 'fak';
  return 'fak';
};

const getDefaultMarketOrderType = () =>
  normalizeMarketOrderType(process.env.POLYMARKET_MARKET_ORDER_TYPE || process.env.POLYMARKET_ORDER_TYPE);

const safeJsonStringify = (value) => {
  try {
    return JSON.stringify(value);
  } catch (error) {
    try {
      const seen = new WeakSet();
      return JSON.stringify(value, (key, val) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      });
    } catch {
      return null;
    }
  }
};

const extractClobErrorMessage = (payload) => {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    return trimmed ? trimmed : null;
  }
  if (payload instanceof Error) {
    const msg = String(payload.message || '').trim();
    return msg ? msg : null;
  }
  if (typeof payload === 'object') {
    const direct =
      (payload?.errorMsg ? String(payload.errorMsg).trim() : '') ||
      (payload?.error ? String(payload.error).trim() : '') ||
      (payload?.message ? String(payload.message).trim() : '') ||
      '';
    if (direct) return direct;
    const json = safeJsonStringify(payload);
    if (json) return json.length > 500 ? `${json.slice(0, 500)}…` : json;
  }
  const fallback = String(payload).trim();
  return fallback ? fallback : null;
};

const executePolymarketMarketOrder = async ({ tokenID, side, amount, price }) => {
  const mode = getPolymarketExecutionMode();
  const cleanedToken = normalizeEnvValue(tokenID);
  const cleanedSide = normalizeEnvValue(side).toUpperCase();
  const cleanedAmount = Number(amount);
  const cleanedPrice = price === undefined || price === null || price === '' ? null : Number(price);

  if (!cleanedToken) {
    throw new Error('tokenID is required.');
  }
  if (cleanedSide !== 'BUY' && cleanedSide !== 'SELL') {
    throw new Error('side must be BUY or SELL.');
  }
  if (!Number.isFinite(cleanedAmount) || cleanedAmount <= 0) {
    throw new Error('amount must be a positive number.');
  }
  if (cleanedPrice !== null && (!Number.isFinite(cleanedPrice) || cleanedPrice <= 0 || cleanedPrice >= 1)) {
    throw new Error('price must be between 0 and 1.');
  }

  const orderTypeSetting = getDefaultMarketOrderType();

  if (mode !== 'live') {
    return {
      ok: true,
      mode,
      dryRun: true,
      request: {
        tokenID: cleanedToken,
        side: cleanedSide,
        amount: cleanedAmount,
        price: cleanedPrice,
        orderType: orderTypeSetting,
      },
      response: null,
    };
  }

  const clobClient = await getPolymarketClobClient();
  const { Side, OrderType } = await loadClobModule();

  const orderTypeEnum = orderTypeSetting === 'fok' ? OrderType.FOK : OrderType.FAK;

  const userMarketOrder = {
    tokenID: cleanedToken,
    amount: cleanedAmount,
    side: cleanedSide === 'BUY' ? Side.BUY : Side.SELL,
    ...(cleanedPrice !== null ? { price: cleanedPrice } : {}),
    orderType: orderTypeEnum,
  };

  const response = await clobClient.createAndPostMarketOrder(userMarketOrder, undefined, orderTypeEnum);
  if (response && typeof response === 'object') {
    const orderId = response.orderID || response.orderId || response.order_id || response.id || null;
    const txHashes = Array.isArray(response.transactionsHashes)
      ? response.transactionsHashes
      : Array.isArray(response.transactions)
        ? response.transactions
        : null;
    const statusNum = (() => {
      const candidate = Number(response?.status);
      return Number.isFinite(candidate) && candidate >= 100 ? candidate : null;
    })();
    const apiError = extractClobErrorMessage(response?.error ?? response?.errorMsg ?? response?.message ?? null);
    const successFlag = response?.success;
    const looksSuccessful =
      successFlag === true || Boolean(orderId) || (Array.isArray(txHashes) && txHashes.length > 0);

    if (successFlag === false || apiError || (statusNum !== null && statusNum >= 400) || !looksSuccessful) {
      const detailParts = [];
      if (apiError) detailParts.push(apiError);
      if (successFlag === false && !apiError) detailParts.push('success=false');
      const suffix = detailParts.length ? ` (${detailParts.join('; ')})` : '';
      const wrapped = new Error(
        statusNum !== null ? `Polymarket order failed (status ${statusNum})${suffix}` : `Polymarket order failed${suffix}`
      );
      if (statusNum !== null) {
        wrapped.status = statusNum;
      }
      wrapped.response = { status: statusNum, data: response };
      throw wrapped;
    }
  }
  return {
    ok: true,
    mode,
    dryRun: false,
    request: {
      tokenID: cleanedToken,
      side: cleanedSide,
      amount: cleanedAmount,
      price: cleanedPrice,
      orderType: orderTypeSetting,
    },
    response,
  };
};

const looksLikeBytes32 = (value) => /^0x[a-fA-F0-9]{64}$/.test(normalizeEnvValue(value));

const parseJsonArray = (value) => {
  if (Array.isArray(value)) {
    return value;
  }
  const raw = normalizeEnvValue(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const fetchGammaMarketsByConditionIds = async (conditionIds = [], options = {}) => {
  const host = normalizeEnvValue(options.host || DEFAULT_GAMMA_HOST).replace(/\/+$/, '');
  const ids = Array.from(
    new Set(
      (Array.isArray(conditionIds) ? conditionIds : [])
        .map((id) => normalizeEnvValue(id))
        .filter(Boolean)
    )
  );
  const map = new Map();
  if (!host || !ids.length) {
    return map;
  }

  const query = ids.map((id) => `condition_ids=${encodeURIComponent(id)}`).join('&');
  const url = `${host}/markets?${query}`;
  const res = await Axios.get(url, {
    timeout: 15000,
    proxy: false,
    validateStatus: () => true,
    ...(options.axios || {}),
  });

  const ok = res && typeof res.status === 'number' && res.status >= 200 && res.status < 300;
  const rows = ok && Array.isArray(res.data) ? res.data : [];
  rows.forEach((row) => {
    const conditionId = normalizeEnvValue(row?.conditionId);
    if (!conditionId) return;
    const outcomes = parseJsonArray(row?.outcomes);
    map.set(conditionId, {
      id: row?.id ?? null,
      slug: row?.slug ?? null,
      question: row?.question ?? null,
      negRisk: row?.negRisk === true,
      resolved: row?.resolved === true,
      outcomes: outcomes.map((o) => normalizeEnvValue(o)).filter(Boolean),
    });
  });

  return map;
};

const normalizeOutcomeKey = (value) => normalizeEnvValue(value).toLowerCase();

const sumPositionsByConditionAndOutcome = (positions = []) => {
  const byCondition = new Map();
  (Array.isArray(positions) ? positions : []).forEach((pos) => {
    const conditionId = normalizeEnvValue(pos?.market || pos?.conditionId);
    if (!conditionId) return;
    const outcomeKey = normalizeOutcomeKey(pos?.outcome);
    const qty = Number(pos?.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return;

    const entry = byCondition.get(conditionId) || { outcomes: new Map(), totalQty: 0 };
    entry.totalQty += qty;
    if (outcomeKey) {
      entry.outcomes.set(outcomeKey, (entry.outcomes.get(outcomeKey) || 0) + qty);
    }
    byCondition.set(conditionId, entry);
  });
  return byCondition;
};

const toUsdcBaseUnitsString = (amount) => {
  const num = Number(amount);
  if (!Number.isFinite(num) || num <= 0) return '0';
  // Polymarket shares correspond to USDC collateral (6 decimals).
  // Convert using a decimal string to avoid JS float issues.
  const fixed = num.toFixed(6);
  return utils.parseUnits(fixed, 6).toString();
};

const buildSafeSignatureBytes = async (signer, txHash) => {
  const messageArray = utils.arrayify(txHash);
  let sig = await signer.signMessage(messageArray);
  let v = parseInt(sig.slice(-2), 16);
  if (v === 0 || v === 1) {
    v += 31;
  } else if (v === 27 || v === 28) {
    v += 4;
  } else {
    throw new Error('Invalid signature');
  }
  const vHex = v.toString(16).padStart(2, '0');
  sig = sig.slice(0, -2) + vHex;
  return sig;
};

  const SAFE_MIN_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce) view returns (bytes32)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)',
];

const PROXY_FACTORY_ABI = [
  {
    constant: false,
    inputs: [
      {
        components: [
          { name: 'typeCode', type: 'uint8' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
        name: 'calls',
        type: 'tuple[]',
      },
    ],
    name: 'proxy',
    outputs: [{ name: 'returnValues', type: 'bytes[]' }],
    payable: true,
    stateMutability: 'payable',
    type: 'function',
  },
];

  const CTF_MIN_ABI = [
  'function payoutDenominator(bytes32) view returns (uint256)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
];

const NEG_RISK_ADAPTER_MIN_ABI = ['function redeemPositions(bytes32 conditionId, uint256[] amounts)'];

const getRedeemGasOverrides = () => {
  const overrides = {};
  const maxFeePerGas = normalizeEnvValue(process.env.POLYMARKET_REDEEM_MAX_FEE_GWEI);
  const maxPriorityFee = normalizeEnvValue(process.env.POLYMARKET_REDEEM_PRIORITY_FEE_GWEI);
  const gasLimit = normalizeEnvValue(process.env.POLYMARKET_REDEEM_GAS_LIMIT);

  if (maxFeePerGas) {
    const parsed = Number(maxFeePerGas);
    if (Number.isFinite(parsed) && parsed > 0) {
      overrides.maxFeePerGas = utils.parseUnits(String(parsed), 'gwei');
    }
  }
  if (maxPriorityFee) {
    const parsed = Number(maxPriorityFee);
    if (Number.isFinite(parsed) && parsed > 0) {
      overrides.maxPriorityFeePerGas = utils.parseUnits(String(parsed), 'gwei');
    }
  }
  if (gasLimit) {
    const parsed = Number(gasLimit);
    if (Number.isFinite(parsed) && parsed > 0) {
      overrides.gasLimit = Math.floor(parsed);
    }
  }

  // Default to 50 gwei max fee and 30 gwei priority if not set (Polygon minimum is ~25 gwei)
  if (!overrides.maxFeePerGas) {
    overrides.maxFeePerGas = utils.parseUnits('50', 'gwei');
  }
  if (!overrides.maxPriorityFeePerGas) {
    overrides.maxPriorityFeePerGas = utils.parseUnits('30', 'gwei');
  }

  return overrides;
};

const redeemPolymarketWinnings = async (positions = [], options = {}) => {
  const mode = getPolymarketExecutionMode();
  const enabled = parseBoolean(options.enabled ?? process.env.POLYMARKET_AUTO_REDEEM, false);
  if (!enabled) {
    return { ok: true, skipped: true, reason: 'disabled' };
  }
  if (mode !== 'live') {
    return { ok: true, skipped: true, reason: 'paper_mode' };
  }

  const maxConditions = (() => {
    const parsed = Number(options.maxConditions ?? process.env.POLYMARKET_AUTO_REDEEM_MAX_CONDITIONS ?? 20);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 20;
  })();
  const waitMs = (() => {
    const parsed = Number(options.waitMs ?? process.env.POLYMARKET_AUTO_REDEEM_WAIT_MS ?? 30000);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  })();

  const env = getPolymarketLiveEnv();
  if (!env.privateKey) {
    throw new Error('Missing POLYMARKET_PRIVATE_KEY (or POLYMARKET_PRIVATE_KEY_FILE).');
  }

  const redeemConfig = getRedeemContractConfig(env.chainId);
  if (!redeemConfig) {
    return { ok: false, skipped: true, reason: `unsupported_chain_${env.chainId}` };
  }

  const rpcUrl = getPolymarketRpcUrl(env.chainId);
  const provider = new providers.JsonRpcProvider(rpcUrl, env.chainId);
  const signer = new Wallet(env.privateKey).connect(provider);
  const signatureType = env.signatureType;
  const funderAddress = isValidHexAddress(env.funderAddress) ? env.funderAddress : null;

  const byCondition = sumPositionsByConditionAndOutcome(positions);
  const conditionIds = Array.from(byCondition.keys()).filter(looksLikeBytes32);
  if (!conditionIds.length) {
    return { ok: true, redeemed: 0, reason: 'no_conditions' };
  }

  const ctfRead = new Contract(redeemConfig.conditionalTokens, ['function payoutDenominator(bytes32) view returns (uint256)'], provider);

  const resolvedConditionIds = [];
  for (const conditionId of conditionIds) {
    if (resolvedConditionIds.length >= maxConditions) break;
    try {
      const denom = await ctfRead.payoutDenominator(conditionId);
      const isResolved = denom && BigNumber.isBigNumber(denom) ? denom.gt(0) : Number(denom) > 0;
      if (isResolved) {
        resolvedConditionIds.push(conditionId);
      }
    } catch {
      // ignore read failures
    }
  }

  if (!resolvedConditionIds.length) {
    return { ok: true, redeemed: 0, reason: 'no_resolved_conditions' };
  }

  let gammaMarkets = new Map();
  try {
    gammaMarkets = await fetchGammaMarketsByConditionIds(resolvedConditionIds, { host: options.gammaHost });
  } catch {
    gammaMarkets = new Map();
  }

  const contracts = getContractConfig(env.chainId);
  const ctfInterface = new utils.Interface(CTF_MIN_ABI);
  const negRiskInterface = new utils.Interface(NEG_RISK_ADAPTER_MIN_ABI);

  const calls = [];
  const planned = [];
  for (const conditionId of resolvedConditionIds) {
    const entry = byCondition.get(conditionId);
    if (!entry || entry.totalQty <= 0) continue;
    const gamma = gammaMarkets.get(conditionId) || null;
    const negRisk = gamma?.negRisk === true;
    const outcomes = Array.isArray(gamma?.outcomes) && gamma.outcomes.length ? gamma.outcomes : ['Yes', 'No'];

    if (negRisk) {
      if (outcomes.length !== 2) {
        planned.push({ conditionId, skipped: true, reason: 'neg_risk_outcomes_not_binary' });
        continue;
      }
      const yesKey = normalizeOutcomeKey(outcomes[0]);
      const noKey = normalizeOutcomeKey(outcomes[1]);
      const yesQty = entry.outcomes.get(yesKey) || 0;
      const noQty = entry.outcomes.get(noKey) || 0;
      const amounts = [toUsdcBaseUnitsString(yesQty), toUsdcBaseUnitsString(noQty)];
      if (amounts.every((a) => a === '0')) {
        planned.push({ conditionId, skipped: true, reason: 'no_balance' });
        continue;
      }
      const data = negRiskInterface.encodeFunctionData('redeemPositions', [conditionId, amounts]);
      calls.push({ typeCode: 1, to: redeemConfig.negRiskAdapter, value: 0, data });
      planned.push({ conditionId, negRisk: true, outcomes, amounts });
    } else {
      const data = ctfInterface.encodeFunctionData('redeemPositions', [
        contracts.collateral,
        constants.HashZero,
        conditionId,
        [1, 2],
      ]);
      calls.push({ typeCode: 1, to: redeemConfig.conditionalTokens, value: 0, data });
      planned.push({ conditionId, negRisk: false });
    }
  }

  if (!calls.length) {
    return { ok: true, redeemed: 0, reason: 'nothing_to_redeem', planned };
  }

  const resultBase = {
    ok: true,
    skipped: false,
    chainId: env.chainId,
    rpcUrl,
    signatureType,
    funderAddress,
    conditionsResolved: resolvedConditionIds.length,
    callsPlanned: calls.length,
    planned,
  };

  if (signatureType === 2) {
    if (!funderAddress) {
      return { ok: false, skipped: true, reason: 'missing_funder_address_for_safe', ...resultBase };
    }
    const safe = new Contract(funderAddress, SAFE_MIN_ABI, signer);
    const txHashes = [];
    for (const call of calls) {
      const nonce = await safe.nonce();
      const safeTxGas = 0;
      const baseGas = 0;
      const gasPrice = 0;
      const gasToken = constants.AddressZero;
      const refundReceiver = constants.AddressZero;
      const operation = 0; // Call
      const txHash = await safe.getTransactionHash(
        call.to,
        String(call.value ?? 0),
        call.data,
        operation,
        safeTxGas,
        baseGas,
        gasPrice,
        gasToken,
        refundReceiver,
        nonce
      );
      const sigBytes = await buildSafeSignatureBytes(signer, txHash);
      const safeGasOverrides = { ...getRedeemGasOverrides(), ...(options.txOverrides || {}) };
      const tx = await safe.execTransaction(
        call.to,
        String(call.value ?? 0),
        call.data,
        operation,
        safeTxGas,
        baseGas,
        gasPrice,
        gasToken,
        refundReceiver,
        sigBytes,
        safeGasOverrides
      );
      txHashes.push(tx.hash);
      if (waitMs > 0) {
        await provider.waitForTransaction(tx.hash, 1, waitMs).catch(() => {});
      }
    }
    return { ...resultBase, walletType: 'safe', txHashes };
  }

  // Proxy wallet factory (Magic/Email login) and fallback for other signature types.
  const factory = new Contract(redeemConfig.proxyWalletFactory, PROXY_FACTORY_ABI, signer);
  const gasOverrides = { ...getRedeemGasOverrides(), ...(options.txOverrides || {}) };
  const tx = await factory.proxy(calls, gasOverrides);
  if (waitMs > 0) {
    await provider.waitForTransaction(tx.hash, 1, waitMs).catch(() => {});
  }
  return { ...resultBase, walletType: 'proxy', txHash: tx.hash };
};

module.exports = {
  getPolymarketExecutionMode,
  getPolymarketExecutionDebugInfo,
  getPolymarketClobClient,
  getPolymarketBalanceAllowance,
  getPolymarketOnchainUsdcBalance,
  getPolymarketClobBalanceAllowance,
  executePolymarketMarketOrder,
  redeemPolymarketWinnings,
  getClobRateLimitCooldownStatus,
  resetClobRateLimitCooldown,
};
