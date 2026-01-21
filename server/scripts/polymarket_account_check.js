/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const axios = require('axios');
const CryptoJS = require('crypto-js');

dotenv.config({ path: path.resolve(__dirname, '../config/.env') });

const CLOB_HOST = String(process.env.POLYMARKET_CLOB_HOST || process.env.CLOB_API_URL || 'https://clob.polymarket.com')
  .trim()
  .replace(/\/+$/, '');
const DATA_API_HOST = String(process.env.POLYMARKET_DATA_API_HOST || 'https://data-api.polymarket.com')
  .trim()
  .replace(/\/+$/, '');

const normalizeEnvValue = (value) => String(value || '').trim();
const isValidHexAddress = (value) => /^0x[a-fA-F0-9]{40}$/.test(normalizeEnvValue(value));

const buildFingerprint = (value) => {
  const raw = normalizeEnvValue(value);
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
};

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

const sanitizeBase64Secret = (value) =>
  String(value || '')
    .trim()
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/[^A-Za-z0-9+/=]/g, '');

const decodeBase64Secret = (value) => Buffer.from(sanitizeBase64Secret(value), 'base64');

const makeUrlSafeBase64 = (base64) => String(base64 || '').replace(/\+/g, '-').replace(/\//g, '_');

const parseSignatureType = (value) => {
  const raw = normalizeEnvValue(value);
  if (!raw) return 0;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && (parsed === 0 || parsed === 1)) return parsed;
  return 0;
};

const signL2 = ({ ts, method, requestPath, body, secret }) => {
  const message = `${ts}${String(method).toUpperCase()}${requestPath}${body ?? ''}`;
  const key = decodeBase64Secret(secret);
  const signature = crypto.createHmac('sha256', key).update(message).digest('base64');
  return makeUrlSafeBase64(signature);
};

const parseArgs = (argv) => {
  const args = { auth: null, funder: null, maker: null, proxyUrl: null, proxyRotate: false, proxyAuth: false };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--auth') {
      args.auth = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--funder' || token === '--deposit') {
      args.funder = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--maker') {
      args.maker = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--proxy-url') {
      args.proxyUrl = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--proxy-rotate') {
      args.proxyRotate = true;
      continue;
    }
    if (token === '--proxy-auth') {
      args.proxyAuth = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    positionals.push(token);
  }

  if (!args.auth && positionals[0]) args.auth = positionals[0];
  if (!args.funder && positionals[1]) args.funder = positionals[1];
  if (!args.maker && positionals[2]) args.maker = positionals[2];

  return args;
};

const proxyListPath = path.resolve(__dirname, './proxy/workingproxies.txt');

const normalizeProxyUrl = (value) => {
  const raw = normalizeEnvValue(value);
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `http://${raw}`;
};

const parseAxiosProxy = (proxyUrl) => {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return null;
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (error) {
    throw new Error(`Invalid proxy URL: ${normalized}`);
  }
  if (!parsed.hostname) {
    throw new Error(`Invalid proxy URL (missing host): ${normalized}`);
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid proxy port for: ${normalized}`);
  }
  const auth = parsed.username
    ? {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password || ''),
    }
    : undefined;
  return {
    protocol: parsed.protocol.replace(':', ''),
    host: parsed.hostname,
    port,
    ...(auth ? { auth } : {}),
  };
};

const loadProxyCandidates = () => {
  if (!fs.existsSync(proxyListPath)) return [];
  const raw = fs.readFileSync(proxyListPath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
};

const pickProxy = (candidates) => {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const idx = Math.floor(Math.random() * candidates.length);
  return candidates[idx] || null;
};

const httpGet = async (url, config = {}) => {
  return await axios.get(url, {
    timeout: 15000,
    proxy: false,
    validateStatus: () => true,
    ...config,
  });
};

const httpGetViaProxy = async (url, config = {}, proxyUrl) => {
  const proxy = parseAxiosProxy(proxyUrl);
  return await axios.get(url, {
    timeout: 20000,
    proxy,
    validateStatus: () => true,
    ...config,
  });
};

const withOptionalProxy = async ({ url, config, containsCredentials, allowCredentialProxy, explicitProxyUrl, rotate }) => {
  const canUseProxy = Boolean(explicitProxyUrl || rotate);
  if (!canUseProxy) {
    return { response: await httpGet(url, config), proxyUsed: null };
  }

  if (containsCredentials && !allowCredentialProxy) {
    return { response: await httpGet(url, config), proxyUsed: null };
  }

  const candidates = rotate ? loadProxyCandidates() : [];
  const chosen = explicitProxyUrl || pickProxy(candidates);
  if (!chosen) {
    return { response: await httpGet(url, config), proxyUsed: null };
  }

  try {
    return { response: await httpGetViaProxy(url, config, chosen), proxyUsed: chosen };
  } catch {
    return { response: await httpGet(url, config), proxyUsed: null };
  }
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage:');
    console.log('  node scripts/polymarket_account_check.js <authAddress> <depositAddress> [makerAddress]');
    console.log('');
    console.log('Flags:');
    console.log('  --auth 0x...        Polymarket auth/signer address (expected)');
    console.log('  --funder 0x...      Deposit/profile address (USDC lives here)');
    console.log('  --maker 0x...       Address to query trades for (optional)');
    console.log('  --proxy-url http://host:port   Use a specific HTTP proxy (DANGEROUS for auth unless --proxy-auth)');
    console.log('  --proxy-rotate      Pick a random proxy from scripts/proxy/workingproxies.txt');
    console.log('  --proxy-auth        Allow proxy usage for authenticated CLOB calls');
    process.exitCode = 0;
    return;
  }

  const authAddress = normalizeEnvValue(args.auth || process.env.POLYMARKET_AUTH_ADDRESS || process.env.POLYMARKET_ADDRESS);
  const funderAddress = normalizeEnvValue(
    args.funder ||
      process.env.POLYMARKET_FUNDER_ADDRESS ||
      process.env.POLYMARKET_PROFILE_ADDRESS ||
      ''
  );
  const makerAddress = normalizeEnvValue(args.maker || authAddress || '');
  const signatureType = parseSignatureType(
    process.env.POLYMARKET_SIGNATURE_TYPE || process.env.POLYMARKET_ORDER_SIGNATURE_TYPE
  );

  console.log('[Polymarket Account Check]');
  console.log('- CLOB host:', CLOB_HOST);
  console.log('- data-api host:', DATA_API_HOST);
  console.log('- auth address:', authAddress || '(missing)');
  console.log('- deposit/funder address:', funderAddress || '(missing)');
  console.log('- maker (trades query) address:', makerAddress || '(missing)');
  console.log('- signature type:', signatureType);
  console.log('- proxy rotate enabled:', Boolean(args.proxyRotate));
  console.log('- explicit proxy url set:', Boolean(args.proxyUrl));
  console.log('- proxy allowed for auth calls:', Boolean(args.proxyAuth));

  const apiKey = decryptIfEncrypted(process.env.POLYMARKET_API_KEY || process.env.CLOB_API_KEY);
  const secret = decryptIfEncrypted(process.env.POLYMARKET_SECRET || process.env.CLOB_SECRET);
  const passphrase = decryptIfEncrypted(process.env.POLYMARKET_PASSPHRASE || process.env.CLOB_PASS_PHRASE);

  console.log('- L2 creds present:', Boolean(apiKey && secret && passphrase));
  console.log('- L2 apiKey fp:', buildFingerprint(apiKey));
  console.log('- L2 secret fp:', buildFingerprint(secret));
  console.log('- L2 passphrase fp:', buildFingerprint(passphrase));

  try {
    const { getPolymarketExecutionDebugInfo } = require('../services/polymarketExecutionService');
    const debugInfo = getPolymarketExecutionDebugInfo();
    console.log('- env execution mode:', debugInfo.mode);
    console.log('- env private key present:', Boolean(debugInfo.privateKey?.rawPresent));
    if (debugInfo.privateKey?.derivedAddress) {
      console.log('- env signer address:', debugInfo.privateKey.derivedAddress);
    }
    console.log('- env authMatchesPrivateKey:', Boolean(debugInfo.authMatchesPrivateKey));
  } catch (error) {
    console.log('- env execution debug: error', String(error?.message || error));
  }

  const geoToken = normalizeEnvValue(process.env.POLYMARKET_GEO_BLOCK_TOKEN || process.env.GEO_BLOCK_TOKEN) || null;
  const buildGeoParams = (params = {}) => (geoToken ? { ...params, geo_block_token: geoToken } : params);

  // 1) CLOB /time
  const timeUrl = `${CLOB_HOST}/time`;
  const timeResult = await withOptionalProxy({
    url: timeUrl,
    config: { params: buildGeoParams() },
    containsCredentials: false,
    allowCredentialProxy: args.proxyAuth === true,
    explicitProxyUrl: args.proxyUrl,
    rotate: args.proxyRotate,
  });
  const ts = Number(timeResult.response?.data);
  console.log('- CLOB /time:', timeResult.response.status, Number.isFinite(ts) ? ts : String(timeResult.response.data).slice(0, 120));

  // 2) CLOB /auth/api-keys (signed)
  const hasL2Creds = Boolean(apiKey && secret && passphrase && isValidHexAddress(authAddress));
  if (!hasL2Creds) {
    console.log('- CLOB /auth/api-keys: skipped (missing L2 creds or auth address)');
  } else {
    const endpoint = '/auth/api-keys';
    const safeTs = Number.isFinite(ts) ? ts : Math.floor(Date.now() / 1000);
    const sig = signL2({ ts: safeTs, method: 'GET', requestPath: endpoint, secret });
    const headers = {
      POLY_ADDRESS: authAddress,
      POLY_SIGNATURE: sig,
      POLY_TIMESTAMP: String(safeTs),
      POLY_API_KEY: apiKey,
      POLY_PASSPHRASE: passphrase,
    };

    const keysRes = await withOptionalProxy({
      url: `${CLOB_HOST}${endpoint}`,
      config: { headers, params: buildGeoParams() },
      containsCredentials: true,
      allowCredentialProxy: args.proxyAuth === true,
      explicitProxyUrl: args.proxyUrl,
      rotate: args.proxyRotate,
    });
    const ok = keysRes.response.status >= 200 && keysRes.response.status < 300;
    const summary = ok ? '(ok)' : keysRes.response.data?.error || keysRes.response.data?.message || '(failed)';
    console.log('- CLOB /auth/api-keys:', keysRes.response.status, summary, keysRes.proxyUsed ? `(proxy=${keysRes.proxyUsed})` : '');
  }

  // 3) CLOB /data/trades (signed)
  const canQueryTrades = hasL2Creds && isValidHexAddress(makerAddress);
  if (!canQueryTrades) {
    console.log('- CLOB /data/trades: skipped (missing maker address or L2 creds)');
  } else {
    const endpoint = '/data/trades';
    const safeTs = Number.isFinite(ts) ? ts : Math.floor(Date.now() / 1000);
    const sig = signL2({ ts: safeTs, method: 'GET', requestPath: endpoint, secret });
    const headers = {
      POLY_ADDRESS: authAddress,
      POLY_SIGNATURE: sig,
      POLY_TIMESTAMP: String(safeTs),
      POLY_API_KEY: apiKey,
      POLY_PASSPHRASE: passphrase,
    };
    const tradesRes = await withOptionalProxy({
      url: `${CLOB_HOST}${endpoint}`,
      config: {
        headers,
        params: buildGeoParams({
          next_cursor: 'MA==',
          maker_address: makerAddress,
        }),
      },
      containsCredentials: true,
      allowCredentialProxy: args.proxyAuth === true,
      explicitProxyUrl: args.proxyUrl,
      rotate: args.proxyRotate,
    });
    const ok = tradesRes.response.status >= 200 && tradesRes.response.status < 300;
    const count = ok && Array.isArray(tradesRes.response.data?.data) ? tradesRes.response.data.data.length : null;
    const err = ok ? '(ok)' : tradesRes.response.data?.error || tradesRes.response.data?.message || '(failed)';
    console.log('- CLOB /data/trades:', tradesRes.response.status, ok ? `count=${count ?? 'n/a'}` : err);
  }

  // 3b) CLOB /balance-allowance (signed, collateral)
  if (!hasL2Creds) {
    console.log('- CLOB /balance-allowance: skipped (missing L2 creds or auth address)');
  } else {
    const endpoint = '/balance-allowance';
    const safeTs = Number.isFinite(ts) ? ts : Math.floor(Date.now() / 1000);
    const sig = signL2({ ts: safeTs, method: 'GET', requestPath: endpoint, secret });
    const headers = {
      POLY_ADDRESS: authAddress,
      POLY_SIGNATURE: sig,
      POLY_TIMESTAMP: String(safeTs),
      POLY_API_KEY: apiKey,
      POLY_PASSPHRASE: passphrase,
    };
    const balanceRes = await withOptionalProxy({
      url: `${CLOB_HOST}${endpoint}`,
      config: { headers, params: buildGeoParams({ asset_type: 'COLLATERAL', signature_type: signatureType }) },
      containsCredentials: true,
      allowCredentialProxy: args.proxyAuth === true,
      explicitProxyUrl: args.proxyUrl,
      rotate: args.proxyRotate,
    });
    const ok = balanceRes.response.status >= 200 && balanceRes.response.status < 300;
    const payload = balanceRes.response?.data || null;
    const balanceBaseUnits = payload && typeof payload === 'object' ? payload.balance : null;
    const balanceNumber = Number(balanceBaseUnits);
    const balanceUsdc = Number.isFinite(balanceNumber) ? balanceNumber / 1e6 : null;
    const allowances =
      payload && typeof payload === 'object' && payload.allowances && typeof payload.allowances === 'object'
        ? payload.allowances
        : null;
    const shorten = (value) => {
      const raw = value === undefined || value === null ? '' : String(value).trim();
      if (!raw) return null;
      if (raw.length <= 18) return raw;
      return `${raw.slice(0, 8)}…${raw.slice(-8)}`;
    };
    const knownSpenders = [
      '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
      '0xC5d563A36AE78145C45a50134d48A1215220f80a',
      '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
    ];
    const allowanceSummary = allowances
      ? knownSpenders
        .map((spender) => {
          const val = allowances[spender];
          const short = shorten(val);
          return short === null ? null : `${spender}=${short}`;
        })
        .filter(Boolean)
        .join(' ')
      : null;
    const err = ok ? '(ok)' : payload?.error || payload?.message || '(failed)';
    console.log(
      '- CLOB /balance-allowance:',
      balanceRes.response.status,
      ok
        ? `balance=${balanceUsdc !== null ? balanceUsdc : balanceBaseUnits ?? 'n/a'}${
          balanceUsdc !== null && balanceBaseUnits !== null ? ` (base=${balanceBaseUnits})` : ''
        }${allowanceSummary ? ` allowances=${allowanceSummary}` : allowances ? ` allowancesKeys=${Object.keys(allowances).length}` : ''}`
        : err
    );
  }

  // 4) data-api positions (public)
  if (!isValidHexAddress(authAddress)) {
    console.log('- data-api /positions: skipped (invalid auth address)');
  } else {
    const positionsRes = await withOptionalProxy({
      url: `${DATA_API_HOST}/positions`,
      config: { params: { user: authAddress } },
      containsCredentials: false,
      allowCredentialProxy: args.proxyAuth === true,
      explicitProxyUrl: args.proxyUrl,
      rotate: args.proxyRotate,
    });
    const ok = positionsRes.response.status >= 200 && positionsRes.response.status < 300;
    const list = ok && Array.isArray(positionsRes.response.data) ? positionsRes.response.data : [];
    const proxyWallet = list.find((row) => row && row.proxyWallet)?.proxyWallet || null;
    console.log('- data-api /positions:', positionsRes.response.status, `count=${list.length}`, proxyWallet ? `proxyWallet=${proxyWallet}` : '');
  }

  // 5) onchain USDC + allowance for funder address (Polygon)
  if (!isValidHexAddress(funderAddress)) {
    console.log('- onchain USDC balance/allowance: skipped (invalid funder address)');
  } else {
    const originalFunder = process.env.POLYMARKET_FUNDER_ADDRESS;
    const originalProfile = process.env.POLYMARKET_PROFILE_ADDRESS;
    process.env.POLYMARKET_FUNDER_ADDRESS = funderAddress;
    delete process.env.POLYMARKET_PROFILE_ADDRESS;
    try {
      const { getPolymarketBalanceAllowance } = require('../services/polymarketExecutionService');
      const snapshot = await getPolymarketBalanceAllowance();
      console.log(
        '- onchain USDC (funder):',
        `balance=${snapshot.balance}`,
        `allowance=${snapshot.allowance}`,
        `spender=${snapshot.spender}`
      );
    } catch (error) {
      console.log('- onchain USDC (funder): error', String(error?.message || error));
    } finally {
      if (originalFunder === undefined) {
        delete process.env.POLYMARKET_FUNDER_ADDRESS;
      } else {
        process.env.POLYMARKET_FUNDER_ADDRESS = originalFunder;
      }
      if (originalProfile === undefined) {
        delete process.env.POLYMARKET_PROFILE_ADDRESS;
      } else {
        process.env.POLYMARKET_PROFILE_ADDRESS = originalProfile;
      }
    }
  }

  // 5b) onchain USDC + allowance for auth address (Polygon) when funder differs
  if (
    isValidHexAddress(authAddress) &&
    isValidHexAddress(funderAddress) &&
    authAddress.toLowerCase() !== funderAddress.toLowerCase()
  ) {
    const originalFunder = process.env.POLYMARKET_FUNDER_ADDRESS;
    const originalProfile = process.env.POLYMARKET_PROFILE_ADDRESS;
    const originalAuth = process.env.POLYMARKET_AUTH_ADDRESS;
    delete process.env.POLYMARKET_FUNDER_ADDRESS;
    delete process.env.POLYMARKET_PROFILE_ADDRESS;
    process.env.POLYMARKET_AUTH_ADDRESS = authAddress;
    try {
      const { getPolymarketBalanceAllowance } = require('../services/polymarketExecutionService');
      const snapshot = await getPolymarketBalanceAllowance();
      console.log(
        '- onchain USDC (auth):',
        `balance=${snapshot.balance}`,
        `allowance=${snapshot.allowance}`,
        `spender=${snapshot.spender}`
      );
      if (Number(snapshot.balance) > 0 && Number(snapshot.allowance) > 0) {
        console.log(
          '- hint:',
          'Auth wallet has USDC+allowance; if you expected funding to come from the deposit/funder address, update POLYMARKET_FUNDER_ADDRESS.'
        );
      }
    } catch (error) {
      console.log('- onchain USDC (auth): error', String(error?.message || error));
    } finally {
      if (originalFunder === undefined) {
        delete process.env.POLYMARKET_FUNDER_ADDRESS;
      } else {
        process.env.POLYMARKET_FUNDER_ADDRESS = originalFunder;
      }
      if (originalProfile === undefined) {
        delete process.env.POLYMARKET_PROFILE_ADDRESS;
      } else {
        process.env.POLYMARKET_PROFILE_ADDRESS = originalProfile;
      }
      if (originalAuth === undefined) {
        delete process.env.POLYMARKET_AUTH_ADDRESS;
      } else {
        process.env.POLYMARKET_AUTH_ADDRESS = originalAuth;
      }
    }
  }

  // 6) CLOB balance/allowance via clob-client (requires live mode + private key)
  if (!isValidHexAddress(funderAddress)) {
    console.log('- clob-client getBalanceAllowance: skipped (invalid funder address)');
  } else {
    const originalFunder = process.env.POLYMARKET_FUNDER_ADDRESS;
    const originalProfile = process.env.POLYMARKET_PROFILE_ADDRESS;
    process.env.POLYMARKET_FUNDER_ADDRESS = funderAddress;
    delete process.env.POLYMARKET_PROFILE_ADDRESS;
    try {
      const { getPolymarketClobBalanceAllowance } = require('../services/polymarketExecutionService');
      const snapshot = await getPolymarketClobBalanceAllowance();
      console.log('- clob-client balance/allowance:', `balance=${snapshot.balance}`, `allowance=${snapshot.allowance}`);
    } catch (error) {
      console.log('- clob-client balance/allowance: error', String(error?.message || error));
    } finally {
      if (originalFunder === undefined) {
        delete process.env.POLYMARKET_FUNDER_ADDRESS;
      } else {
        process.env.POLYMARKET_FUNDER_ADDRESS = originalFunder;
      }
      if (originalProfile === undefined) {
        delete process.env.POLYMARKET_PROFILE_ADDRESS;
      } else {
        process.env.POLYMARKET_PROFILE_ADDRESS = originalProfile;
      }
    }
  }
};

main().catch((err) => {
  console.error('[Polymarket Account Check] Failed:', err?.message || err);
  process.exitCode = 1;
});
