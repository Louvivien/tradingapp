const crypto = require('crypto');
<<<<<<< HEAD
const Axios = require('axios');
=======
const fs = require('fs');
>>>>>>> 940defd (failedpoly)
const CryptoJS = require('crypto-js');
const { Wallet, providers, Contract, utils } = require('ethers');

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

let clobUserAgentInterceptorKey = null;
let clobProxyInterceptorKey = null;

const getClobProxyConfig = () => {
  const raw = normalizeEnvValue(
    process.env.POLYMARKET_CLOB_PROXY ||
      process.env.POLYMARKET_HTTP_PROXY ||
      process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      ''
  );
  const proxyUrl = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)[0];
  if (!proxyUrl) {
    return null;
  }
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
  } catch {
    return null;
  }
};
const ensureClobUserAgentInterceptor = (host) => {
  const userAgent = normalizeEnvValue(
    process.env.POLYMARKET_CLOB_USER_AGENT || process.env.POLYMARKET_HTTP_USER_AGENT || 'tradingapp/1.0'
  );
  if (!userAgent || !host) {
    return;
  }
  const key = `${host}|${userAgent}`;
  if (clobUserAgentInterceptorKey === key) {
    return;
  }
  Axios.interceptors.request.use((config) => {
    if (!config || !config.url) {
      return config;
    }
    if (config.url.startsWith(host)) {
      config.headers = config.headers || {};
      config.headers['User-Agent'] = userAgent;
    }
    return config;
  });
  clobUserAgentInterceptorKey = key;
};

const ensureClobProxyInterceptor = (host) => {
  const proxyConfig = getClobProxyConfig();
  if (!proxyConfig || !host) {
    return;
  }
  const key = `${host}|${proxyConfig.host}:${proxyConfig.port}`;
  if (clobProxyInterceptorKey === key) {
    return;
  }
  Axios.interceptors.request.use((config) => {
    if (!config || !config.url) {
      return config;
    }
    if (config.url.startsWith(host)) {
      config.proxy = proxyConfig;
    }
    return config;
  });
  clobProxyInterceptorKey = key;
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
    l2CredsPresent,
    decryptError,
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

module.exports = {
  getPolymarketExecutionMode,
  getPolymarketExecutionDebugInfo,
  getPolymarketClobClient,
  getPolymarketBalanceAllowance,
  getPolymarketOnchainUsdcBalance,
  getPolymarketClobBalanceAllowance,
  executePolymarketMarketOrder,
};
