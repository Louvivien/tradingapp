const { setAlpaca } = require('./alpaca');

const getAlpacaConfig = async (userId, forceMode = null) => {
  try {
    const config = await setAlpaca(userId, forceMode);
    if (!config.hasValidKeys) {
      throw new Error(config.error || 'No valid API keys found');
    }
    return config;
  } catch (error) {
    console.error('[API Error] Failed to get Alpaca config:', error.message);
    throw error;
  }
};

module.exports = {
  getAlpacaConfig
}; 