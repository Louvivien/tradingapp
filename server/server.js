const path = require("path");
const fs = require('fs');
const dotenv = require("dotenv");
const crypto = require("crypto");
const Axios = require("axios");
const CryptoJS = require("crypto-js");

// Load environment variables from .env file when available; otherwise rely on existing env vars (useful for Render)
const envPath = path.resolve(__dirname, './config/.env');
console.log(`[Config] Loading environment variables from: ${envPath}`);
if (fs.existsSync(envPath)) {
  const result = dotenv.config({ path: envPath });
  if (result.error) {
    console.error('[Config Error] Failed to load .env file:', result.error);
    console.warn('[Config] Continuing with runtime environment variables.');
  }
} else {
  console.warn('[Config] .env file not found. Falling back to environment variables provided at runtime.');
}

const express = require("express");
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const { schedulePortfolioRebalances } = require('./scheduler');
const { getAlpacaConfig } = require('./config/alpacaConfig');
const {
  getClobAuthCooldownStatus,
  resetClobAuthCooldown,
  normalizeTradesSourceSetting,
} = require('./services/polymarketCopyService');

mongoose.set('bufferCommands', false);

const readyStateLabels = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

const logConnectionState = (context) => {
  const state = mongoose.connection.readyState;
  console.log(`[MongoDB] ${context} | state=${state} (${readyStateLabels[state] || 'unknown'})`);
};

mongoose.connection.on('connected', () => logConnectionState('Event: connected'));
mongoose.connection.on('error', (err) => {
  console.error('[MongoDB] Event: error', err);
  logConnectionState('Post-error state check');
});
mongoose.connection.on('disconnected', () => logConnectionState('Event: disconnected'));
mongoose.connection.on('reconnected', () => logConnectionState('Event: reconnected'));
mongoose.connection.on('connecting', () => logConnectionState('Event: connecting'));
mongoose.connection.on('disconnecting', () => logConnectionState('Event: disconnecting'));

const app = express();
const port = process.env.PORT || 3000;

const normalizeEnvValue = (value) => String(value || '').trim();
const isPlaceholder = (value) => normalizeEnvValue(value).includes('your_');

const runtimeEnv = {
  mongoUri: normalizeEnvValue(process.env.MONGO_URI || process.env.MONGODB_URI),
  mongoPassword: normalizeEnvValue(process.env.MONGO_PASSWORD || process.env.MONGODB_PASSWORD),
  jwtSecret: normalizeEnvValue(process.env.JWT_SECRET),
  encryptionKey: normalizeEnvValue(process.env.ENCRYPTION_KEY || process.env.CryptoJS_secret_key),
  alpacaKeyId: normalizeEnvValue(process.env.ALPACA_API_KEY_ID),
  alpacaSecretKey: normalizeEnvValue(process.env.ALPACA_API_SECRET_KEY),
};

const missingCriticalVars = [];
if (!runtimeEnv.mongoUri || isPlaceholder(runtimeEnv.mongoUri)) missingCriticalVars.push('MONGO_URI');
if (!runtimeEnv.mongoPassword || isPlaceholder(runtimeEnv.mongoPassword)) missingCriticalVars.push('MONGO_PASSWORD');
if (!runtimeEnv.jwtSecret || isPlaceholder(runtimeEnv.jwtSecret)) missingCriticalVars.push('JWT_SECRET');
if (!runtimeEnv.encryptionKey || isPlaceholder(runtimeEnv.encryptionKey)) {
  missingCriticalVars.push('ENCRYPTION_KEY/CryptoJS_secret_key');
}

const missingOptionalVars = [];
if (!runtimeEnv.alpacaKeyId || isPlaceholder(runtimeEnv.alpacaKeyId)) missingOptionalVars.push('ALPACA_API_KEY_ID');
if (!runtimeEnv.alpacaSecretKey || isPlaceholder(runtimeEnv.alpacaSecretKey)) missingOptionalVars.push('ALPACA_API_SECRET_KEY');

// Log API key configuration (without exposing actual keys)
console.log('[Config] API Key Configuration:');
console.log('[Config] - Paper Trading API Key ID:', process.env.ALPACA_API_KEY_ID ? 'Set' : 'Missing');
console.log('[Config] - Paper Trading Secret Key:', process.env.ALPACA_API_SECRET_KEY ? 'Set' : 'Missing');
if (process.env.ALPACA_LIVE_API_KEY_ID && process.env.ALPACA_LIVE_API_SECRET_KEY) {
  console.log('[Config] - Live Trading API Key ID: Set');
  console.log('[Config] - Live Trading Secret Key: Set');
} else {
  console.warn('[Config] Live trading keys not set; running in paper-only mode.');
}

// Middleware
const bodyParserLimit = process.env.REQUEST_BODY_LIMIT || '5mb';
app.use(express.urlencoded({ extended: true, limit: bodyParserLimit }));
app.use(express.json({ limit: bodyParserLimit }));
app.use(cookieParser("secretcode"));
app.use(cors());
app.options('*', cors());

// Logs
app.use((req, res, next) => {
  if (req.url.startsWith('//')) {
    const originalUrl = req.url;
    req.url = req.url.replace(/^\/+/, '/');
    console.warn(`[HTTP] Normalized leading slashes: ${originalUrl} -> ${req.url}`);
  }
  console.log(`[HTTP] Incoming ${req.method} request for ${req.url}`);
  next();
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "tradingapp-api",
    timestamp: Date.now(),
  });
});

app.get("/api/health", (req, res) => {
  const polymarketTradesSource = String(process.env.POLYMARKET_TRADES_SOURCE || 'auto').trim().toLowerCase();
  const polymarketApiKey = String(process.env.POLYMARKET_API_KEY || process.env.CLOB_API_KEY || '').trim();
  const polymarketSecret = String(process.env.POLYMARKET_SECRET || process.env.CLOB_SECRET || '').trim();
  const polymarketPassphrase = String(process.env.POLYMARKET_PASSPHRASE || process.env.CLOB_PASS_PHRASE || '').trim();
  const polymarketAuthAddress = String(
    process.env.POLYMARKET_AUTH_ADDRESS || process.env.POLYMARKET_ADDRESS || ''
  ).trim();
  const polymarketAuthAddressValid = /^0x[a-fA-F0-9]{40}$/.test(polymarketAuthAddress);

  res.json({
    status: missingCriticalVars.length === 0 ? "ok" : "degraded",
    timestamp: Date.now(),
    uptime: process.uptime(),
    mongodb: {
      readyState: mongoose.connection.readyState,
      state: readyStateLabels[mongoose.connection.readyState] || 'unknown',
    },
    polymarket: {
      tradesSource: polymarketTradesSource,
      clobHost: String(process.env.POLYMARKET_CLOB_HOST || 'https://clob.polymarket.com').replace(/\/+$/, ''),
      dataApiHost: String(process.env.POLYMARKET_DATA_API_HOST || 'https://data-api.polymarket.com').replace(
        /\/+$/,
        ''
      ),
      geoTokenSet: Boolean(String(process.env.POLYMARKET_GEO_BLOCK_TOKEN || process.env.GEO_BLOCK_TOKEN || '').trim()),
      envCredsPresent: Boolean(polymarketApiKey && polymarketSecret && polymarketPassphrase),
      authAddressPresent: Boolean(polymarketAuthAddress),
      authAddressValid: polymarketAuthAddressValid,
    },
    env: {
      missingCritical: missingCriticalVars,
      missingOptional: missingOptionalVars,
      hasAlpacaKeys: Boolean(runtimeEnv.alpacaKeyId && runtimeEnv.alpacaSecretKey),
    },
  });
});

app.get("/api/health/polymarket", async (req, res) => {
  const startedAt = Date.now();

  const debugToken = normalizeEnvValue(process.env.POLYMARKET_DEBUG_TOKEN || process.env.DEBUG_TOKEN);
  if (debugToken) {
    const provided = normalizeEnvValue(req.header("x-debug-token"));
    if (!provided || provided !== debugToken) {
      return res.status(401).json({
        status: "fail",
        message: "Missing/invalid x-debug-token.",
      });
    }
  }

  const clobHost = normalizeEnvValue(
    process.env.POLYMARKET_CLOB_HOST || process.env.CLOB_API_URL || "https://clob.polymarket.com"
  ).replace(/\/+$/, "");
  const dataApiHost = normalizeEnvValue(process.env.POLYMARKET_DATA_API_HOST || "https://data-api.polymarket.com").replace(
    /\/+$/,
    ""
  );

  const geoToken =
    normalizeEnvValue(process.env.POLYMARKET_GEO_BLOCK_TOKEN || process.env.GEO_BLOCK_TOKEN) || null;

  const httpTimeoutMs = (() => {
    const raw = Number(process.env.POLYMARKET_HTTP_TIMEOUT_MS || process.env.POLYMARKET_TIMEOUT_MS);
    if (!Number.isFinite(raw) || raw <= 0) {
      return 15000;
    }
    return Math.max(1000, Math.min(Math.floor(raw), 120000));
  })();

  const isValidHexAddress = (value) => /^0x[a-fA-F0-9]{40}$/.test(String(value || "").trim());

  const encryptionKey = normalizeEnvValue(process.env.ENCRYPTION_KEY || process.env.CryptoJS_secret_key) || null;
  const decryptIfEncrypted = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (!raw.startsWith("U2Fsd")) return raw;
    if (!encryptionKey) {
      throw new Error("Encrypted Polymarket credentials provided but ENCRYPTION_KEY/CryptoJS_secret_key is not set.");
    }
    const bytes = CryptoJS.AES.decrypt(raw, encryptionKey);
    const decrypted = bytes.toString(CryptoJS.enc.Utf8);
    return String(decrypted || "").trim();
  };

  const rawApiKeyEnv = normalizeEnvValue(process.env.POLYMARKET_API_KEY || process.env.CLOB_API_KEY);
  const rawSecretEnv = normalizeEnvValue(process.env.POLYMARKET_SECRET || process.env.CLOB_SECRET);
  const rawPassphraseEnv = normalizeEnvValue(
    process.env.POLYMARKET_PASSPHRASE || process.env.CLOB_PASS_PHRASE
  );

  const decryptEnvValue = (raw, label) => {
    const cleaned = String(raw || "").trim();
    const looksEncrypted = cleaned.startsWith("U2Fsd");
    if (!cleaned) {
      return { value: "", rawPresent: false, looksEncrypted: false, error: null };
    }
    if (!looksEncrypted) {
      return { value: cleaned, rawPresent: true, looksEncrypted: false, error: null };
    }
    try {
      const value = decryptIfEncrypted(cleaned);
      return { value, rawPresent: true, looksEncrypted: true, error: null };
    } catch (error) {
      return { value: "", rawPresent: true, looksEncrypted: true, error: `${label}: ${String(error?.message || error)}` };
    }
  };

  const apiKeyEnv = decryptEnvValue(rawApiKeyEnv, "apiKey");
  const secretEnv = decryptEnvValue(rawSecretEnv, "secret");
  const passphraseEnv = decryptEnvValue(rawPassphraseEnv, "passphrase");

  const apiKey = apiKeyEnv.value;
  const secret = secretEnv.value;
  const passphrase = passphraseEnv.value;

  const decryptError = apiKeyEnv.error || secretEnv.error || passphraseEnv.error || null;

  const authAddress = normalizeEnvValue(process.env.POLYMARKET_AUTH_ADDRESS || process.env.POLYMARKET_ADDRESS);
  const makerAddress = normalizeEnvValue(req.query.maker || process.env.POLYMARKET_TEST_MAKER_ADDRESS || authAddress);

  const tradesSourceRaw = normalizeEnvValue(process.env.POLYMARKET_TRADES_SOURCE || "auto");
  const tradesSourceSetting = normalizeTradesSourceSetting(tradesSourceRaw);

  const buildGeoParams = (params = {}) => {
    if (!geoToken) return params;
    return { ...params, geo_block_token: geoToken };
  };

  const httpGet = async (url, config = {}) => {
    return await Axios.get(url, {
      timeout: httpTimeoutMs,
      proxy: false,
      validateStatus: () => true,
      ...config,
    });
  };

  const sanitizeBase64Secret = (value) => {
    const cleaned = String(value || "")
      .trim()
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .replace(/[^A-Za-z0-9+/=]/g, "");

    const pad = cleaned.length % 4;
    if (!pad) return cleaned;
    return cleaned + "=".repeat(4 - pad);
  };

  const decodeBase64Secret = (value) => Buffer.from(sanitizeBase64Secret(value), "base64");

  const makeUrlSafeBase64 = (value) => String(value || "").replace(/\+/g, "-").replace(/\//g, "_");

  const sign = ({ ts, method, requestPath, body }) => {
    const timestamp = Math.floor(Number(ts));
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      throw new Error("Invalid timestamp for signature.");
    }
    const message = `${timestamp}${String(method || "").toUpperCase()}${requestPath}${body ?? ""}`;
    const key = decodeBase64Secret(secret);
    const signature = crypto.createHmac("sha256", key).update(message).digest("base64");
    return makeUrlSafeBase64(signature);
  };

  const report = {
    ok: false,
    checkedAt: new Date().toISOString(),
    config: {
      tradesSource: tradesSourceSetting || "auto",
      timeoutMs: httpTimeoutMs,
      geoTokenSet: Boolean(geoToken),
      rawEnvCredsPresent: Boolean(rawApiKeyEnv && rawSecretEnv && rawPassphraseEnv),
      envCredsPresent: Boolean(apiKey && secret && passphrase),
      decryptError,
      envCreds: {
        apiKey: {
          rawPresent: apiKeyEnv.rawPresent,
          looksEncrypted: apiKeyEnv.looksEncrypted,
          length: apiKey ? apiKey.length : 0,
          sha256_12: apiKey ? crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 12) : null,
          looksUuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(apiKey),
        },
        secret: (() => {
          const info = {
            rawPresent: secretEnv.rawPresent,
            looksEncrypted: secretEnv.looksEncrypted,
            length: secret ? secret.length : 0,
            sha256_12: secret ? crypto.createHash("sha256").update(secret).digest("hex").slice(0, 12) : null,
            decodedBytes: null,
          };
          if (secret) {
            try {
              info.decodedBytes = decodeBase64Secret(secret).length;
            } catch {
              info.decodedBytes = null;
            }
          }
          return info;
        })(),
        passphrase: {
          rawPresent: passphraseEnv.rawPresent,
          looksEncrypted: passphraseEnv.looksEncrypted,
          length: passphrase ? passphrase.length : 0,
          sha256_12: passphrase ? crypto.createHash("sha256").update(passphrase).digest("hex").slice(0, 12) : null,
          looksHex64: /^[0-9a-f]{64}$/i.test(passphrase),
        },
      },
      authAddressPresent: Boolean(authAddress),
      authAddressValid: isValidHexAddress(authAddress),
      makerAddress,
    },
    copyTrader: {
      clobAuthCooldown: getClobAuthCooldownStatus(),
      clobAuthCooldownReset: false,
    },
    clob: {
      host: clobHost,
      time: { ok: false, status: null, serverTime: null, latencyMs: null, error: null },
      authApiKeys: { ok: false, status: null, latencyMs: null, error: null },
      dataTrades: { ok: false, status: null, tradesCount: null, nextCursor: null, latencyMs: null, error: null },
    },
    dataApi: {
      host: dataApiHost,
      trades: { ok: false, status: null, count: null, latencyMs: null, error: null },
    },
    durationMs: null,
  };

  const shouldResetCooldown = (() => {
    if (req.query.resetClobCooldown === true) return true;
    const raw = normalizeEnvValue(req.query.resetClobCooldown).toLowerCase();
    return raw === "true" || raw === "1" || raw === "yes";
  })();
  if (shouldResetCooldown && debugToken) {
    resetClobAuthCooldown();
    report.copyTrader.clobAuthCooldown = getClobAuthCooldownStatus();
    report.copyTrader.clobAuthCooldownReset = true;
  }

  try {
    const t0 = Date.now();
    const timeRes = await httpGet(`${clobHost}/time`, { params: buildGeoParams() });
    report.clob.time.latencyMs = Date.now() - t0;
    report.clob.time.status = timeRes.status;
    const ts = Math.floor(Number(timeRes.data));
    if (timeRes.status >= 200 && timeRes.status < 300 && Number.isFinite(ts) && ts > 0) {
      report.clob.time.ok = true;
      report.clob.time.serverTime = ts;
    } else {
      report.clob.time.error = typeof timeRes.data === "string" ? timeRes.data : JSON.stringify(timeRes.data ?? null);
    }
  } catch (error) {
    report.clob.time.error = String(error?.message || error);
  }

  const hasL2Creds = Boolean(apiKey && secret && passphrase && isValidHexAddress(authAddress));
  const canQueryTrades = hasL2Creds && isValidHexAddress(makerAddress);

  const createL2Headers = (requestPath) => {
    const ts = report.clob.time.serverTime || Math.floor(Date.now() / 1000);
    return {
      POLY_ADDRESS: authAddress,
      POLY_SIGNATURE: sign({ ts, method: "GET", requestPath }),
      POLY_TIMESTAMP: String(ts),
      POLY_API_KEY: apiKey,
      POLY_PASSPHRASE: passphrase,
    };
  };

  if (hasL2Creds) {
    try {
      const t0 = Date.now();
      const endpoint = "/auth/api-keys";
      const keysRes = await httpGet(`${clobHost}${endpoint}`, {
        headers: createL2Headers(endpoint),
        params: buildGeoParams(),
      });
      report.clob.authApiKeys.latencyMs = Date.now() - t0;
      report.clob.authApiKeys.status = keysRes.status;
      report.clob.authApiKeys.ok = keysRes.status >= 200 && keysRes.status < 300;
      if (!report.clob.authApiKeys.ok) {
        report.clob.authApiKeys.error =
          typeof keysRes.data === "string" ? keysRes.data : JSON.stringify(keysRes.data ?? null);
      }
    } catch (error) {
      report.clob.authApiKeys.error = String(error?.message || error);
    }
  } else {
    report.clob.authApiKeys.error = decryptError
      ? "Unable to decrypt env creds."
      : "Missing/invalid POLYMARKET_* L2 env creds (or auth address).";
  }

  if (canQueryTrades) {
    try {
      const t0 = Date.now();
      const endpoint = "/data/trades";
      const tradesRes = await httpGet(`${clobHost}${endpoint}`, {
        headers: createL2Headers(endpoint),
        params: buildGeoParams({ maker_address: makerAddress, next_cursor: "MA==" }),
      });
      report.clob.dataTrades.latencyMs = Date.now() - t0;
      report.clob.dataTrades.status = tradesRes.status;
      report.clob.dataTrades.ok = tradesRes.status >= 200 && tradesRes.status < 300;
      if (report.clob.dataTrades.ok) {
        const trades = Array.isArray(tradesRes.data?.data) ? tradesRes.data.data : [];
        report.clob.dataTrades.tradesCount = trades.length;
        report.clob.dataTrades.nextCursor = tradesRes.data?.next_cursor ? String(tradesRes.data.next_cursor) : null;
      } else {
        report.clob.dataTrades.error =
          typeof tradesRes.data === "string" ? tradesRes.data : JSON.stringify(tradesRes.data ?? null);
      }
    } catch (error) {
      report.clob.dataTrades.error = String(error?.message || error);
    }
  } else if (hasL2Creds) {
    report.clob.dataTrades.error = "Missing/invalid maker address (provide ?maker=0x...).";
  } else {
    report.clob.dataTrades.error = report.clob.authApiKeys.error;
  }

  const dataApiUser = isValidHexAddress(makerAddress) ? makerAddress : isValidHexAddress(authAddress) ? authAddress : "";
  if (!dataApiUser) {
    report.dataApi.trades.error = "Missing/invalid user address for data-api check.";
  } else {
    try {
      const t0 = Date.now();
      const dataTradesRes = await httpGet(`${dataApiHost}/trades`, {
        headers: { "User-Agent": process.env.POLYMARKET_DATA_API_USER_AGENT || "tradingapp/1.0" },
        params: { user: dataApiUser, limit: 5, offset: 0, takerOnly: false },
      });
      report.dataApi.trades.latencyMs = Date.now() - t0;
      report.dataApi.trades.status = dataTradesRes.status;
      report.dataApi.trades.ok = dataTradesRes.status >= 200 && dataTradesRes.status < 300;
      if (Array.isArray(dataTradesRes.data)) {
        report.dataApi.trades.count = dataTradesRes.data.length;
      } else if (Array.isArray(dataTradesRes.data?.data)) {
        report.dataApi.trades.count = dataTradesRes.data.data.length;
      } else {
        report.dataApi.trades.count = null;
      }
      if (!report.dataApi.trades.ok) {
        report.dataApi.trades.error =
          typeof dataTradesRes.data === "string" ? dataTradesRes.data : JSON.stringify(dataTradesRes.data ?? null);
      }
    } catch (error) {
      report.dataApi.trades.error = String(error?.message || error);
    }
  }

  report.ok = Boolean(report.clob.time.ok && report.clob.authApiKeys.ok && report.clob.dataTrades.ok);
  report.durationMs = Date.now() - startedAt;

  return res.status(report.ok ? 200 : 503).json(report);
});

app.use("/api", (req, res, next) => {
  const pathName = req.path || "";
  if (pathName === "/ping" || pathName === "/health") {
    return next();
  }

  if (missingCriticalVars.length > 0) {
    return res.status(503).json({
      status: "fail",
      message: "Server is missing required configuration.",
      missing: missingCriticalVars,
    });
  }

  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      status: "fail",
      message: "Database connection is not ready.",
      mongoState: mongoose.connection.readyState,
    });
  }

  return next();
});

const buildMongoUri = () => {
  const uri = runtimeEnv.mongoUri;
  const encodedPassword = encodeURIComponent(runtimeEnv.mongoPassword);
  if (uri.includes('<password>')) {
    return uri.replace('<password>', encodedPassword);
  }
  return uri;
};

const mongoOptions = {
  serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 15000),
  connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 15000),
};

const connectToMongo = async () => {
  if (missingCriticalVars.length > 0) {
    console.warn('[MongoDB] Skipping connection attempt (missing critical env vars).');
    return;
  }
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
    return;
  }

  const DB = buildMongoUri();
  logConnectionState('Attempting connect');
  await mongoose.connect(DB, mongoOptions);
  console.log("[MongoDB] Connected to MongoDB");
  logConnectionState('Post-connect');
};

// Initialize Alpaca client
let alpacaConfig = null;

const initializeAlpaca = async () => {
  try {
    alpacaConfig = await getAlpacaConfig();
    if (!alpacaConfig.hasValidKeys) {
      console.error('[API Error] Failed to initialize Alpaca client:', alpacaConfig.error);
      return false;
    }

    // Get the appropriate keys for trading and data
    const tradingKeys = alpacaConfig.getTradingKeys();
    const dataKeys = alpacaConfig.getDataKeys();

    console.log('[API] Initializing Alpaca client with', 
      tradingKeys.keyId.startsWith('PK') ? 'paper trading' : 'live trading', 'keys');
    console.log('[API] Using base URL:', tradingKeys.apiUrl);
    console.log('[API] Using data URL:', dataKeys.apiUrl);

    // Test the trading client
    try {
      const response = await tradingKeys.client.get(`${tradingKeys.apiUrl}/v2/account`, {
        headers: {
          'APCA-API-KEY-ID': tradingKeys.keyId,
          'APCA-API-SECRET-KEY': tradingKeys.secretKey,
        }
      });
      console.log('[API Success] Connected to Alpaca API. Account status:', response.data.status);
      return true;
    } catch (error) {
      console.error('[API Error] Failed to connect to Alpaca API:', error.message);
      if (error.response) {
        console.error('[API Response] Status:', error.response.status);
        console.error('[API Response] Data:', error.response.data);
      }
      return false;
    }
  } catch (error) {
    console.error('[API Error] Error initializing Alpaca client:', error.message);
    return false;
  }
};

// Import route handlers
const authRouter = require("./routes/authRoutes");
const dataRouter = require("./routes/dataRoutes");
const newsRouter = require("./routes/newsRoutes");
const stockRouter = require("./routes/stockRoutes");
const orderRouter = require("./routes/orderRoutes");
const strategiesRouter = require("./routes/strategiesRoutes");

// Set up routes
app.use("/api/auth", authRouter);
app.use("/api/data", dataRouter);
app.use("/api/news", newsRouter);
app.use("/api/stock", stockRouter);
app.use("/api/order", orderRouter);
app.use("/api/strategies", strategiesRouter);
app.get("/api/ping", (req, res) => {
  res.json({
    status: "ok",
    timestamp: Date.now(),
  });
});

// Start HTTP server immediately (Render expects your process to bind to $PORT quickly).
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

logConnectionState('Initial readyState before connect');
if (missingCriticalVars.length > 0) {
  console.error('[Config Error] Missing or invalid environment variables:', missingCriticalVars);
}
if (missingOptionalVars.length > 0) {
  console.warn('[Config] Optional environment variables missing:', missingOptionalVars);
}

// Background initialization: Mongo + Alpaca (do not block server start).
const scheduleMongoConnect = (attempt = 0) => {
  void connectToMongo()
    .catch((error) => {
      console.error('[MongoDB] Connection attempt failed:', error.message);
      const backoffMs = Math.min(30000, 1000 * Math.max(1, 2 ** attempt));
      console.warn(`[MongoDB] Retrying connection in ${backoffMs}ms`);
      setTimeout(() => scheduleMongoConnect(attempt + 1), backoffMs);
    });
};

scheduleMongoConnect();

void initializeAlpaca()
  .then((success) => {
    if (!success) {
      console.error('[API Error] Failed to initialize Alpaca client. Some features may not work.');
    }
  })
  .catch((error) => {
    console.error('[API Error] Alpaca init threw unexpectedly:', error?.message || error);
  });

schedulePortfolioRebalances();
