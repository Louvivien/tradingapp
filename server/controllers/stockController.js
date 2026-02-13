const mongoose = require("mongoose");
const User = require("../models/userModel");
const Stock = require("../models/stockModel");
const data = require("../config/stocksData");
const Alpaca = require('@alpacahq/alpaca-trade-api');
const Axios = require("axios");
const moment = require('moment');
const AlpacaClient = require('../utils/alpacaClient');
const { getAlpacaConfig } = require('../config/alpacaConfig');

// // Mock the Alpaca client when market is closed:
// const Mock = require('jest-mock');
// const Alpaca = Mock.fn(() => ({
//   getClock: Mock.fn(() => Promise.resolve({ is_open: true, next_open: '2023-05-14T13:30:00Z' })),
//   createOrder: Mock.fn(({ symbol, qty, side, type, time_in_force }, { price = 999 } = {}) => {
//     return Promise.resolve({ id: 'mock_order_id', status: 'accepted', price });
//   }),  
//   getPositions: Mock.fn(() => Promise.resolve([])),
// }));


exports.purchaseStock = async (req, res) => {
  try {
    const { userId, ticker, quantity, price } = req.body;
    const parsedPrice = price === null ? 999 : price;

    if (req.user !== userId) {
      return res.status(401).json({
        status: "fail",
        message: "Unauthorized access",
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        status: "fail",
        message: "User not found",
      });
    }

    const totalPrice = quantity * parsedPrice;
    if (user.balance - totalPrice < 0) {
      return res.status(400).json({
        status: "fail",
        message: `Insufficient balance. Required: $${totalPrice}, Available: $${user.balance}`,
      });
    }

    const alpacaConfig = await getAlpacaConfig(userId, 'paper');
    if (!alpacaConfig.hasValidKeys) {
      return res.status(403).json({
        status: 'fail',
        message: alpacaConfig.error || 'Invalid API keys. Please check your Alpaca account settings.',
      });
    }

    const tradingKeys = alpacaConfig.getTradingKeys();
    console.log('Using paper trading API:', tradingKeys.apiUrl);

    // Create the order using the configured client
    const order = await tradingKeys.client.post(`${tradingKeys.apiUrl}/v2/orders`, {
      symbol: ticker,
      qty: quantity,
      side: 'buy',
      type: 'market',
      time_in_force: 'gtc',
    }, {
      headers: {
        'APCA-API-KEY-ID': tradingKeys.keyId,
        'APCA-API-SECRET-KEY': tradingKeys.secretKey,
      }
    });

    // Update user balance
    const newBalance = Math.round((user.balance - totalPrice + Number.EPSILON) * 100) / 100;
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { balance: newBalance },
      { new: true }
    );

    return res.status(200).json({
      status: "success",
      order: order.data,
      user: {
        username: updatedUser.username,
        id: updatedUser._id,
        balance: updatedUser.balance
      }
    });

  } catch (error) {
    console.error('Error in purchaseStock:', error.message);
    if (error.response) {
      console.error('API Response:', error.response.status, error.response.data);
    }
    
    return res.status(error.response?.status || 500).json({
      status: "fail",
      message: error.message || "Failed to purchase stock",
    });
  }
};

exports.sellStock = async (req, res) => {
  try {
    const { userId, stockId, quantity, price } = req.body;

    if (req.user !== userId) {
      return res.status(401).json({
        status: "fail",
        message: "Unauthorized access",
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        status: "fail",
        message: "User not found",
      });
    }

    const alpacaConfig = await getAlpacaConfig(userId, 'paper');
    if (!alpacaConfig.hasValidKeys) {
      return res.status(403).json({
        status: 'fail',
        message: alpacaConfig.error || 'Invalid API keys. Please check your Alpaca account settings.',
      });
    }

    const tradingKeys = alpacaConfig.getTradingKeys();
    console.log('Using paper trading API:', tradingKeys.apiUrl);

    // Create the sell order using the configured client
    const order = await tradingKeys.client.post(`${tradingKeys.apiUrl}/v2/orders`, {
      symbol: stockId,
      qty: quantity,
      side: 'sell',
      type: 'market',
      time_in_force: 'gtc',
    }, {
      headers: {
        'APCA-API-KEY-ID': tradingKeys.keyId,
        'APCA-API-SECRET-KEY': tradingKeys.secretKey,
      }
    });

    // Calculate sale profit and update user balance
    const saleProfit = order.data.filled_avg_price * order.data.filled_qty;
    const newBalance = Math.round((user.balance + saleProfit + Number.EPSILON) * 100) / 100;
    
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { balance: newBalance },
      { new: true }
    );

    return res.status(200).json({
      status: "success",
      order: order.data,
      user: {
        username: updatedUser.username,
        id: updatedUser._id,
        balance: updatedUser.balance
      }
    });

  } catch (error) {
    console.error('Error in sellStock:', error.message);
    if (error.response) {
      console.error('API Response:', error.response.status, error.response.data);
    }
    
    return res.status(error.response?.status || 500).json({
      status: "fail",
      message: error.message || "Failed to sell stock",
    });
  }
};

// exports.getMarketStatus = async (req, res) => {
//   console.log("getMarketStatus");
//   try {
//     const userId = req.params.userId;
//     const alpacaConfig = await setAlpaca(userId);
//     const alpacaApi = new Alpaca(alpacaConfig);

//     const clock = await alpacaApi.getClock();
//     res.json({ is_open: clock.is_open, next_open: clock.next_open });
//   } catch (error) {
//     res.status(500).json({ message: "Error fetching market status" });
//   }
// };

exports.searchStocks = async (req, res) => {
  try {
    const { userId, value } = req.params;

    if (req.user !== userId) {
      return res.status(401).json({
        status: "fail",
        message: "Unauthorized access",
      });
    }

    const alpacaConfig = await getAlpacaConfig(userId);
    if (!alpacaConfig.hasValidKeys) {
      return res.status(403).json({
        status: 'fail',
        message: alpacaConfig.error || 'Invalid API keys. Please check your Alpaca account settings.',
      });
    }

    const client = new AlpacaClient(alpacaConfig);

    // Search for stocks using Tiingo API
    const url = `https://api.tiingo.com/tiingo/utilities/search?query=${value}&token=${process.env.TIINGO_API_KEY2}`;
    const response = await Axios.get(url, {
      timeout: 5000,
    });

    if (!response.data || !Array.isArray(response.data)) {
      return res.status(404).json({
        status: "fail",
        message: "No stocks found matching the search criteria",
      });
    }

    const securities = response.data.slice(0, 20).map(security => ({
      name: security.name,
      ticker: security.ticker,
      assetType: security.assetType,
      exchange: security.exchange,
      country: security.country
    }));

    return res.status(200).json({
      status: "success",
      data: securities,
      count: securities.length
    });

  } catch (error) {
    console.error('Error in searchStocks:', error.message);
    if (error.response) {
      console.error('API Response:', error.response.status, error.response.data);
    }
    
    return res.status(error.response?.status || 500).json({
      status: "fail",
      message: error.message || "Failed to search for stocks",
    });
  }
};



exports.getStockForUser = async (req, res) => {
  try {
    const userId = req.params.userId;

    console.log('[Stocks] getStockForUser called', {
      userId,
      authUser: req.user,
      mongoState: mongoose.connection.readyState,
    });

    if (req.user !== userId) {
      return res.status(401).json({
        status: "fail",
        message: "Unauthorized access",
      });
    }

    console.log('[Stocks] Fetching user document');
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        status: "fail",
        message: "User not found",
      });
    }

    console.log('[Stocks] User document loaded', { userId: user._id });

    const alpacaConfig = await getAlpacaConfig(userId, 'paper');
    if (!alpacaConfig.hasValidKeys) {
      return res.status(403).json({
        status: 'fail',
        message: alpacaConfig.error || 'Invalid API keys. Please check your Alpaca account settings.',
      });
    }

    const tradingKeys = alpacaConfig.getTradingKeys();
    console.log('Using paper trading API:', tradingKeys.apiUrl);

    const [positionsResponse, accountResponse] = await Promise.all([
      tradingKeys.client.get(`${tradingKeys.apiUrl}/v2/positions`, {
        headers: {
          'APCA-API-KEY-ID': tradingKeys.keyId,
          'APCA-API-SECRET-KEY': tradingKeys.secretKey,
        }
      }),
      tradingKeys.client.get(`${tradingKeys.apiUrl}/v2/account`, {
        headers: {
          'APCA-API-KEY-ID': tradingKeys.keyId,
          'APCA-API-SECRET-KEY': tradingKeys.secretKey,
        }
      })
    ]);

    const rawPositions = Array.isArray(positionsResponse.data) ? positionsResponse.data : [];
    const stocks = rawPositions.map((position) => ({
      id: position.asset_id,
      ticker: position.symbol,
      name: position.symbol,
      quantity: Number(position.qty),
      purchasePrice: position.avg_entry_price ? Number(position.avg_entry_price) : null,
      currentPrice: position.current_price ? Number(position.current_price) : null,
      marketValue: position.market_value ? Number(position.market_value) : null,
      costBasis: position.cost_basis ? Number(position.cost_basis) : null,
      exchange: position.exchange,
      assetClass: position.asset_class,
      side: position.side,
    }));

    const cash = accountResponse?.data?.cash ? Number(accountResponse.data.cash) : null;

    return res.status(200).json({
      status: "success",
      stocks,
      positions: rawPositions,
      cash,
      user: {
        username: user.username,
        id: user._id,
        balance: user.balance
      }
    });

  } catch (error) {
    console.error('Error in getStockForUser:', error.message);
    if (error.response) {
      console.error('API Response:', error.response.status, error.response.data);
    }
    
    return res.status(error.response?.status || 500).json({
      status: "fail",
      message: error.response?.data?.message || 'Error fetching positions',
    });
  }
};


exports.editAccount = async (req, res) => {
  try {
    const { ALPACA_API_KEY_ID, ALPACA_API_SECRET_KEY } = req.body || {};

    if (req.user !== req.params.userId) {
      return res.status(401).json({
        status: "fail",
        message: "Unauthorized access",
      });
    }

    const { decryptIfEncrypted, encryptIfPlaintext, maskKey } = require('../utils/secretUtils');
    const { clearAlpacaConfigCache } = require('../config/alpacaConfig');

    const keyIdPlain = decryptIfEncrypted(ALPACA_API_KEY_ID);
    const secretPlain = decryptIfEncrypted(ALPACA_API_SECRET_KEY);

    if (!keyIdPlain || !secretPlain) {
      return res.status(400).json({
        status: "fail",
        message: "Missing Alpaca API keys.",
      });
    }

    // Validate API keys by trying to connect to Alpaca
    const testConfig = {
      keyId: keyIdPlain,
      secretKey: secretPlain,
      tradingApiURL: keyIdPlain.startsWith('PK') ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets",
      dataApiURL: "https://data.alpaca.markets"
    };

    const client = new AlpacaClient(testConfig);
    try {
      await client.getAccount();
    } catch (error) {
      return res.status(403).json({
        status: "fail",
        message: "Invalid API keys. Please check your Alpaca account settings.",
      });
    }

    // Update user with new API keys
    const updatedUser = await User.findByIdAndUpdate(
      req.params.userId,
      {
        ALPACA_API_KEY_ID: encryptIfPlaintext(keyIdPlain),
        ALPACA_API_SECRET_KEY: encryptIfPlaintext(secretPlain),
      },
      { new: true }
    );

    if (!updatedUser) {
      return res.status(404).json({
        status: "fail",
        message: "User not found",
      });
    }

    clearAlpacaConfigCache(req.params.userId);

    return res.status(200).json({
      status: "success",
      user: {
        username: updatedUser.username,
        id: updatedUser._id,
        balance: updatedUser.balance,
        alpacaKeysPresent: true,
        alpacaKeyIdMasked: maskKey(keyIdPlain),
      },
    });

  } catch (error) {
    console.error('Error in editAccount:', error.message);
    if (error.response) {
      console.error('API Response:', error.response.status, error.response.data);
    }
    
    return res.status(error.response?.status || 500).json({
      status: "fail",
      message: error.message || "Failed to update account settings",
    });
  }
};



//this is also in strategiesController can be put in utils
const isMarketOpen = async (userId) => {
  try {
    const alpacaConfig = await getAlpacaConfig(userId);
    if (!alpacaConfig.hasValidKeys) {
      console.error('Invalid API keys in isMarketOpen');
      return false;
    }

    const response = await Axios.get(`${alpacaConfig.tradingApiURL}/v2/clock`, {
      headers: {
        'APCA-API-KEY-ID': alpacaConfig.keyId,
        'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
      },
      timeout: 5000,
    });
    return response.data.is_open;
  } catch (error) {
    console.error('Error fetching market status:', error.message);
    if (error.response) {
      console.error('API Response:', error.response.status, error.response.data);
    }
    return false;
  }
};

//this is also in strategiesController can be put in utils
const getPricesData = async (stocks, marketOpen, userId) => {
  try {
    if (!stocks || !Array.isArray(stocks) || stocks.length === 0) {
      return [];
    }

    const alpacaConfig = await getAlpacaConfig(userId);
    if (!alpacaConfig.hasValidKeys) {
      throw new Error(alpacaConfig.error || 'Invalid API keys');
    }

    const dataKeys = alpacaConfig.getDataKeys();
    const validStocks = stocks.filter(stock => stock && stock.ticker);

    // First try to get real-time data if market is open
    const results = await Promise.all(
      validStocks.map(async (stock) => {
        try {
          // Try real-time data first
          const response = await dataKeys.client.get(`${dataKeys.apiUrl}/v2/stocks/${stock.ticker}/trades/latest`, {
            headers: {
              'APCA-API-KEY-ID': dataKeys.keyId,
              'APCA-API-SECRET-KEY': dataKeys.secretKey,
            }
          });

          if (response.data && response.data.trade) {
            const trade = response.data.trade;
            return {
              ticker: stock.ticker,
              date: trade.t,
              price: trade.p,
              size: trade.s,
              exchange: trade.x,
              isDelayed: false,
              delayMessage: null
            };
          }
        } catch (error) {
          if (error.response?.status === 403) {
            console.warn(`No real-time data access for ${stock.ticker}, falling back to delayed data`);
          } else {
            console.error(`Error fetching real-time data for ${stock.ticker}:`, error.message);
          }
        }

        // Fall back to delayed data
        try {
          const delayedResponse = await dataKeys.client.get(`${dataKeys.apiUrl}/v2/stocks/${stock.ticker}/bars?timeframe=1D&limit=1`, {
            headers: {
              'APCA-API-KEY-ID': dataKeys.keyId,
              'APCA-API-SECRET-KEY': dataKeys.secretKey,
            }
          });

          if (delayedResponse.data && delayedResponse.data.bars && delayedResponse.data.bars.length > 0) {
            const bar = delayedResponse.data.bars[0];
            return {
              ticker: stock.ticker,
              date: bar.t,
              open: bar.o,
              high: bar.h,
              low: bar.l,
              close: bar.c,
              volume: bar.v,
              isDelayed: true,
              delayMessage: 'Using delayed market data'
            };
          }
        } catch (error) {
          console.error(`Error fetching delayed data for ${stock.ticker}:`, error.message);
          return null;
        }

        return null;
      })
    );

    const validResults = results.filter(Boolean);
    if (validResults.length === 0) {
      console.warn('No valid data returned for any stocks');
    }

    return validResults;
  } catch (error) {
    console.error('Error in getPricesData:', error.message);
    if (error.response) {
      console.error('API Response:', error.response.status, error.response.data);
    }
    throw error;
  }
};


  
