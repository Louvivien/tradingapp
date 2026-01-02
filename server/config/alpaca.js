const CryptoJS = require('crypto-js');
const User = require("../models/userModel");
const Axios = require('axios');

const ENABLE_ALPACA_HTTP_DEBUG =
  String(process.env.ALPACA_HTTP_DEBUG ?? '').trim().toLowerCase() === 'true';

// Create a custom Axios instance for Alpaca API calls
const createAlpacaClient = (config) => {
  const client = Axios.create({
    proxy: false,
    // Give Alpaca a bit more time before timing out to reduce spurious failures on slower networks.
    timeout: 15000,
  });

  if (ENABLE_ALPACA_HTTP_DEBUG) {
    // Add request interceptor for detailed logging (never log secrets/keys).
    client.interceptors.request.use(
      (reqConfig) => {
        console.log('[Alpaca HTTP] Request', {
          method: String(reqConfig.method || '').toUpperCase(),
          url: reqConfig.url,
        });
        return reqConfig;
      },
      (error) => {
        console.error('[Alpaca HTTP] Request Error', error?.message || error);
        return Promise.reject(error);
      }
    );

    // Add response interceptor for detailed error logging.
    client.interceptors.response.use(
      (response) => {
        console.log('[Alpaca HTTP] Response', {
          status: response.status,
          statusText: response.statusText,
        });
        return response;
      },
      (error) => {
        if (error.response) {
          console.error('[Alpaca HTTP] Error Response', {
            status: error.response.status,
            statusText: error.response.statusText,
          });
        } else if (error.request) {
          console.error('[Alpaca HTTP] Error Request', {
            message: error.message,
            code: error.code,
            url: error.config?.url,
            method: error.config?.method,
          });
        } else {
          console.error('[Alpaca HTTP] Error', error.message);
        }
        return Promise.reject(error);
      }
    );
  }

  return client;
};

// Helper function to decrypt API keys
const decryptKey = (encryptedKey) => {
  if (!encryptedKey) return null;
  
  // If the key starts with 'U2Fsd', it's encrypted
  if (encryptedKey.startsWith('U2Fsd')) {
    if (!process.env.ENCRYPTION_KEY) {
      console.error('[Decryption Error] ENCRYPTION_KEY is not set in environment variables');
      return null;
    }
    try {
      const bytes = CryptoJS.AES.decrypt(encryptedKey, process.env.ENCRYPTION_KEY);
      return bytes.toString(CryptoJS.enc.Utf8);
    } catch (error) {
      console.error('[Decryption Error] Failed to decrypt key:', error.message);
      return null;
    }
  }
  
  // If the key doesn't start with 'U2Fsd', assume it's already decrypted
  return encryptedKey;
};

// Main function to set up Alpaca configuration
const setAlpaca = async (userId, forceMode = null) => {
  try {
    // Get keys from environment variables first
    let paperKeyId = process.env.ALPACA_API_KEY_ID;
    let paperSecretKey = process.env.ALPACA_API_SECRET_KEY;
    let liveKeyId = process.env.ALPACA_LIVE_API_KEY_ID;
    let liveSecretKey = process.env.ALPACA_LIVE_API_SECRET_KEY;

    // Debug logging for environment variables
    console.log('[Debug] Environment variables loaded:');
    console.log('[Debug] - Paper Key ID:', paperKeyId ? paperKeyId.substring(0, 5) + '...' : 'missing');
    console.log('[Debug] - Paper Secret:', paperSecretKey ? paperSecretKey.substring(0, 5) + '...' : 'missing');
    console.log('[Debug] - Live Key ID:', liveKeyId ? liveKeyId.substring(0, 5) + '...' : 'missing');
    console.log('[Debug] - Live Secret:', liveSecretKey ? liveSecretKey.substring(0, 5) + '...' : 'missing');

    // If userId is provided, try to get keys from user document
    if (userId) {
      const user = await User.findById(userId);
      if (user) {
        console.log('[Debug] User document found, checking for API keys');
        // Only use user document keys if environment variables are not set
        paperKeyId = paperKeyId || user.ALPACA_API_KEY_ID;
        paperSecretKey = paperSecretKey || user.ALPACA_API_SECRET_KEY;
        liveKeyId = liveKeyId || user.ALPACA_LIVE_API_KEY_ID;
        liveSecretKey = liveSecretKey || user.ALPACA_LIVE_API_SECRET_KEY;
        
        console.log('[Debug] After user document check:');
        console.log('[Debug] - Paper Key ID:', paperKeyId ? paperKeyId.substring(0, 5) + '...' : 'missing');
        console.log('[Debug] - Paper Secret:', paperSecretKey ? paperSecretKey.substring(0, 5) + '...' : 'missing');
      }
    }

    // Try to decrypt keys if they appear to be encrypted
    paperKeyId = decryptKey(paperKeyId);
    paperSecretKey = decryptKey(paperSecretKey);
    liveKeyId = decryptKey(liveKeyId);
    liveSecretKey = decryptKey(liveSecretKey);

    // Define API URLs
    const paperApiUrl = "https://paper-api.alpaca.markets";
    const liveApiUrl = "https://api.alpaca.markets";
    const dataApiUrl = "https://data.alpaca.markets";

    // Validate paper trading keys
    const hasValidPaperKeys = paperKeyId && paperSecretKey;
    if (hasValidPaperKeys) {
      console.log('[API Info] Paper trading keys are present');
    } else {
      console.log('[API Warning] Paper trading keys are missing');
    }

    // Validate live trading keys
    const hasValidLiveKeys = liveKeyId && liveKeyId.startsWith('AK');
    if (hasValidLiveKeys) {
      console.log('[API Info] Live trading key format is valid (starts with AK)');
    } else {
      console.log('[API Warning] Live trading key format is invalid or missing');
    }

    // Treat presence of keys as valid to avoid blocking on upstream validation.
    const paperKeysValid = Boolean(paperKeyId && paperSecretKey);
    const liveKeysValid = Boolean(liveKeyId && liveSecretKey);

    // Log final configuration
    console.log('[API Info] Final configuration:');
    console.log('[API Info] - Paper trading keys valid:', paperKeysValid);
    console.log('[API Info] - Live trading keys valid:', liveKeysValid);
    console.log('[API Info] - Trading API URL:', paperApiUrl);
    console.log('[API Info] - Data API URL:', dataApiUrl);

    // Create Axios instances for trading and data APIs
    const tradingClient = createAlpacaClient();
    const dataClient = createAlpacaClient();

    const resolveTradingKeys = (mode = forceMode) => {
      const buildResult = (keyId, secretKey, apiUrl) => ({
        keyId,
        secretKey,
        apiUrl,
        client: tradingClient
      });

      if (mode === 'paper') {
        if (!paperKeysValid) {
          console.log('[API Warning] Paper trading mode requested but keys are invalid. Falling back to live trading.');
          return buildResult(liveKeyId, liveSecretKey, liveApiUrl);
        }
        console.log('[API Info] Forcing paper trading mode');
        return buildResult(paperKeyId, paperSecretKey, paperApiUrl);
      }

      if (mode === 'live' && hasValidLiveKeys) {
        console.log('[API Info] Forcing live trading mode');
        return buildResult(liveKeyId, liveSecretKey, liveApiUrl);
      }

      if (paperKeysValid) {
        console.log('[API Info] Using paper trading keys for trading operations');
        return buildResult(paperKeyId, paperSecretKey, paperApiUrl);
      }

      console.log('[API Info] Using live trading keys for trading operations (paper trading keys not valid)');
      return buildResult(liveKeyId, liveSecretKey, liveApiUrl);
    };

    const defaultTradingKeys = resolveTradingKeys();

    // Return configuration with validation results
    return {
      paperKeyId,
      paperSecretKey,
      liveKeyId,
      liveSecretKey,
      paperApiUrl,
      liveApiUrl,
      dataApiUrl,
      keyId: defaultTradingKeys.keyId,
      secretKey: defaultTradingKeys.secretKey,
      apiURL: defaultTradingKeys.apiUrl,
      paper: defaultTradingKeys.apiUrl === paperApiUrl,
      tradingClient: defaultTradingKeys.client,
      hasValidPaperKeys: paperKeysValid,
      hasValidLiveKeys: liveKeysValid,
      hasValidKeys: paperKeysValid || liveKeysValid,
      error: !paperKeysValid && !liveKeysValid ? 'No valid API keys found' : null,
      getTradingKeys: (mode = forceMode) => resolveTradingKeys(mode),
      getDataKeys: () => ({
        keyId: liveKeysValid ? liveKeyId : paperKeyId,
        secretKey: liveKeysValid ? liveSecretKey : paperSecretKey,
        apiUrl: dataApiUrl,
        client: dataClient
      })
    };
  } catch (error) {
    console.error('[API Error] Error in setAlpaca:', error.message);
    return {
      hasValidKeys: false,
      error: error.message
    };
  }
};

// Export the functions
module.exports = {
  setAlpaca
};
