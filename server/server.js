const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const cookieParser = require("cookie-parser");
const path = require("path");
const cors = require("cors");
const cron = require('node-cron');
const { spawn } = require('child_process');
const { startProxies, scheduleNewsFromStocksList, scheduleSentimentVertex, schedulePortfolioRebalances } = require('./scheduler');
const fs = require('fs');
const { getAlpacaConfig } = require('./config/alpacaConfig');

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
const {getStrategies} = require("./controllers/strategiesController");

// Load environment variables from .env file when available; otherwise rely on existing env vars (useful for Render)
const envPath = path.resolve(__dirname, './config/.env');
console.log(`[Config] Loading environment variables from: ${envPath}`);
if (fs.existsSync(envPath)) {
  const result = dotenv.config({ path: envPath });
  if (result.error) {
    console.error('[Config Error] Failed to load .env file:', result.error);
    process.exit(1);
  }
} else {
  console.warn('[Config] .env file not found. Falling back to environment variables provided at runtime.');
}

// Validate required environment variables
const requiredEnvVars = [
  'ALPACA_API_KEY_ID',
  'ALPACA_API_SECRET_KEY',
  'MONGO_URI',
  'MONGO_PASSWORD',
  'CryptoJS_secret_key'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName] || process.env[varName].includes('your_'));
if (missingVars.length > 0) {
  console.error('[Config Error] Missing or invalid environment variables:');
  missingVars.forEach(varName => {
    const currentValue = process.env[varName];
    if (currentValue && currentValue.includes('your_')) {
      console.error(`[Config Error] - ${varName}: Value not updated (still using placeholder)`);
    } else {
      console.error(`[Config Error] - ${varName}: Not set`);
    }
  });
  process.exit(1);
}

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

// Connect to MongoDB
const DB = process.env.MONGO_URI.replace(
  "<password>",
  process.env.MONGO_PASSWORD
);

logConnectionState('Initial readyState before connect');

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

// Initialize the server
const startServer = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(DB, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("[MongoDB] Connected to MongoDB");
    logConnectionState('Post-connect');

    // Initialize Alpaca client
    const success = await initializeAlpaca();
    if (!success) {
      console.error('[API Error] Failed to initialize Alpaca client. Some features may not work.');
    }

    // Start the server
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
    });
  } catch (error) {
    console.error("[Server Error] Failed to start server:", error.message);
    process.exit(1);
  }
};

startServer();

schedulePortfolioRebalances();
