/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const axios = require('axios');
const { Wallet } = require('ethers');

dotenv.config({ path: path.resolve(__dirname, '../config/.env') });

const CLOB_HOST = String(process.env.POLYMARKET_CLOB_HOST || 'https://clob.polymarket.com').replace(/\/+$/, '');
const GEO_BLOCK_TOKEN = (process.env.POLYMARKET_GEO_BLOCK_TOKEN || process.env.GEO_BLOCK_TOKEN || '').trim() || null;
const POLYMARKET_CLOB_USER_AGENT = String(
  process.env.POLYMARKET_CLOB_USER_AGENT || process.env.POLYMARKET_HTTP_USER_AGENT || 'tradingapp/1.0'
).trim();
const CHAIN_ID = (() => {
  const raw = Number(process.env.POLYMARKET_CHAIN_ID || process.env.CLOB_CHAIN_ID);
  if (Number.isFinite(raw)) return raw;
  return 137; // Polygon mainnet
})();

const request = async (method, url, config = {}) =>
  axios({
    method,
    url,
    timeout: 15000,
    proxy: false,
    validateStatus: () => true,
    ...config,
  });

const withGeoParams = (params = {}) => (GEO_BLOCK_TOKEN ? { ...params, geo_block_token: GEO_BLOCK_TOKEN } : params);

const mask = (value, head = 6, tail = 4) => {
  const raw = String(value || '');
  if (!raw) return '(empty)';
  if (raw.length <= head + tail + 3) return `${raw.slice(0, 2)}…${raw.slice(-1)}`;
  return `${raw.slice(0, head)}…${raw.slice(-tail)}`;
};

const escapeRegExp = (input) => String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const upsertEnvVar = (content, key, value) => {
  const lineRegex = new RegExp(`^(\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=).*?$`, 'm');
  if (lineRegex.test(content)) {
    return content.replace(lineRegex, (_match, prefix) => `${prefix}${value}`);
  }
  const suffix = content.endsWith('\n') ? '' : '\n';
  return `${content}${suffix}${key}=${value}\n`;
};

const writeEnvFile = ({ envPath, updates, backup }) => {
  const original = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  if (backup && original) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${envPath}.bak.${stamp}`;
    fs.copyFileSync(envPath, backupPath);
  }
  const next = Object.entries(updates).reduce((acc, [key, value]) => upsertEnvVar(acc, key, value), original);
  fs.writeFileSync(envPath, next, 'utf8');
};

const normalizePrivateKey = (raw) => {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value;
  if (/^[0-9a-fA-F]{64}$/.test(value)) return `0x${value}`;
  return null;
};

const readPrivateKey = () => {
  const direct = normalizePrivateKey(process.env.POLYMARKET_PRIVATE_KEY || process.env.POLYMARKET_WALLET_PRIVATE_KEY);
  if (direct) return { privateKey: direct, source: 'env' };

  const keyPath = String(process.env.POLYMARKET_PRIVATE_KEY_FILE || process.env.POLYMARKET_PRIVATE_KEY_PATH || '').trim();
  if (!keyPath) return { privateKey: null, source: null };
  try {
    const fileContents = fs.readFileSync(keyPath, 'utf8');
    const firstNonEmptyLine = String(fileContents || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0];
    const fromFile = normalizePrivateKey(firstNonEmptyLine);
    return { privateKey: fromFile, source: fromFile ? 'file' : 'file_invalid' };
  } catch {
    return { privateKey: null, source: 'file_missing' };
  }
};

const sanitizeBase64Secret = (value) =>
  String(value || '')
    .trim()
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/[^A-Za-z0-9+/=]/g, '');

const decodeBase64Secret = (value) => Buffer.from(sanitizeBase64Secret(value), 'base64');

const makeUrlSafeBase64 = (base64) => String(base64 || '').replace(/\+/g, '-').replace(/\//g, '_');

const signL2 = ({ ts, method, requestPath, body, secret }) => {
  const message = `${ts}${String(method).toUpperCase()}${requestPath}${body ?? ''}`;
  const key = decodeBase64Secret(secret);
  const signature = crypto.createHmac('sha256', key).update(message).digest('base64');
  return makeUrlSafeBase64(signature);
};

const parseArgs = (argv) => {
  const args = argv.slice(2);
  const opts = {
    dryRun: false,
    verify: true,
    backup: true,
    outputPath: path.resolve(__dirname, '../config/.env'),
    nonce: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run') {
      opts.dryRun = true;
      continue;
    }
    if (arg === '--no-verify') {
      opts.verify = false;
      continue;
    }
    if (arg === '--no-backup') {
      opts.backup = false;
      continue;
    }
    if (arg === '--output') {
      const next = args[i + 1];
      if (!next) throw new Error('--output requires a path');
      opts.outputPath = path.resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    if (arg === '--nonce') {
      const next = Number(args[i + 1]);
      if (!Number.isFinite(next) || next < 0) throw new Error('--nonce requires a non-negative number');
      opts.nonce = Math.floor(next);
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  return opts;
};

const main = async () => {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log('Usage:');
    console.log('  POLYMARKET_PRIVATE_KEY=0x... node scripts/polymarket_create_or_derive_api_key.js');
    console.log('');
    console.log('Options:');
    console.log('  --dry-run      Do not write env file');
    console.log('  --no-verify    Skip L2 verification request');
    console.log('  --no-backup    Do not create .env.bak.* before writing');
    console.log('  --output PATH  Write credentials to PATH instead of config/.env');
    console.log('  --nonce N      Use a fixed L1 nonce instead of random');
    return;
  }

  const { privateKey, source } = readPrivateKey();
  if (!privateKey) {
    console.error('[Polymarket] Missing wallet private key for L1 auth.');
    console.error('Set POLYMARKET_PRIVATE_KEY (preferred) or POLYMARKET_PRIVATE_KEY_FILE to run this script.');
    console.error('Nothing was written.');
    if (source) console.error(`Detected private key source: ${source}`);
    process.exitCode = 1;
    return;
  }

  const wallet = new Wallet(privateKey);
  const address = await wallet.getAddress();
  const nonce = Number.isFinite(opts.nonce) ? opts.nonce : Math.floor(Math.random() * 1e9);

  console.log('[Polymarket] createOrDeriveApiKey');
  console.log('- host:', CLOB_HOST);
  console.log('- chainId:', CHAIN_ID);
  console.log('- address:', address);
  console.log('- nonce:', nonce);
  if (GEO_BLOCK_TOKEN) console.log('- geoBlockToken: (set)');

  const { createL1Headers } = await import('@polymarket/clob-client');

  const timeRes = await request('GET', `${CLOB_HOST}/time`, {
    params: withGeoParams({}),
    headers: POLYMARKET_CLOB_USER_AGENT ? { 'User-Agent': POLYMARKET_CLOB_USER_AGENT } : undefined,
  });
  const ts = Number(timeRes.data);
  if (!Number.isFinite(ts)) {
    throw new Error(`Failed to fetch server time (status=${timeRes.status})`);
  }

  const createHeaders = await createL1Headers(wallet, CHAIN_ID, nonce, ts);
  const createRes = await request('POST', `${CLOB_HOST}/auth/api-key`, {
    headers: {
      ...(POLYMARKET_CLOB_USER_AGENT ? { 'User-Agent': POLYMARKET_CLOB_USER_AGENT } : {}),
      ...createHeaders,
    },
    params: withGeoParams({}),
  });

  const asCreds = (data) => ({
    key: data?.apiKey ? String(data.apiKey) : '',
    secret: data?.secret ? String(data.secret) : '',
    passphrase: data?.passphrase ? String(data.passphrase) : '',
  });
  let creds = asCreds(createRes.data);
  let action = 'create';

  if (!creds.key || !creds.secret || !creds.passphrase) {
    const deriveHeaders = await createL1Headers(wallet, CHAIN_ID, nonce + 1, ts);
    const deriveRes = await request('GET', `${CLOB_HOST}/auth/derive-api-key`, {
      headers: {
        ...(POLYMARKET_CLOB_USER_AGENT ? { 'User-Agent': POLYMARKET_CLOB_USER_AGENT } : {}),
        ...deriveHeaders,
      },
      params: withGeoParams({}),
    });
    creds = asCreds(deriveRes.data);
    action = 'derive';
  }

  if (!creds.key || !creds.secret || !creds.passphrase) {
    const error = createRes.data?.error || createRes.data?.message || '(unknown error)';
    throw new Error(`Failed to create/derive API key. status=${createRes.status} error=${String(error)}`);
  }

  console.log(`- action: ${action}`);
  console.log(`- apiKey: ${mask(creds.key)}`);
  console.log(`- secret: (hidden, len=${String(creds.secret || '').length})`);
  console.log(`- passphrase: (hidden, len=${String(creds.passphrase || '').length})`);

  if (!opts.dryRun) {
    writeEnvFile({
      envPath: opts.outputPath,
      backup: opts.backup,
      updates: {
        POLYMARKET_AUTH_ADDRESS: address,
        POLYMARKET_API_KEY: creds.key,
        POLYMARKET_SECRET: creds.secret,
        POLYMARKET_PASSPHRASE: creds.passphrase,
      },
    });
    console.log(`- wrote: ${opts.outputPath}`);
  } else {
    console.log('- dryRun: true (nothing written)');
  }

  if (opts.verify) {
    const time2 = await request('GET', `${CLOB_HOST}/time`, {
      params: withGeoParams({}),
      headers: POLYMARKET_CLOB_USER_AGENT ? { 'User-Agent': POLYMARKET_CLOB_USER_AGENT } : undefined,
    });
    const ts2 = Number(time2.data);
    if (!Number.isFinite(ts2)) {
      throw new Error(`Failed to fetch server time for verify (status=${time2.status})`);
    }

    const endpoint = '/data/trades';
    const sig = signL2({ ts: ts2, method: 'GET', requestPath: endpoint, secret: creds.secret });
    const verifyRes = await request('GET', `${CLOB_HOST}${endpoint}`, {
      headers: {
        ...(POLYMARKET_CLOB_USER_AGENT ? { 'User-Agent': POLYMARKET_CLOB_USER_AGENT } : {}),
        POLY_ADDRESS: address,
        POLY_SIGNATURE: sig,
        POLY_TIMESTAMP: String(ts2),
        POLY_API_KEY: creds.key,
        POLY_PASSPHRASE: creds.passphrase,
      },
      params: withGeoParams({
        next_cursor: 'MA==',
        maker_address: address,
      }),
    });
    console.log('- verify /data/trades:', verifyRes.status, verifyRes.data?.error || '(ok)');
  }
};

main().catch((err) => {
  console.error('[Polymarket] Failed:', err?.message || err);
  process.exitCode = 1;
});
