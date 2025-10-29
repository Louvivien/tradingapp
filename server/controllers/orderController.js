const User = require("../models/userModel");
const Stock = require("../models/stockModel");
const { getAlpacaConfig } = require('../config/alpacaConfig');
const Alpaca = require('@alpacahq/alpaca-trade-api');
const Axios = require("axios");




exports.purchaseStock = async (req, res) => {    
  try {
    const { userId, ticker, quantity, price } = req.body;
    
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

    const totalPrice = quantity * price;
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
        balance: newBalance,
      },
    });

  } catch (error) {
    console.error('Error in purchaseStock:', error.message);
    if (error.response) {
      console.error('API Response:', error.response.status, error.response.data);
    }
    return res.status(error.response?.status || 500).json({
      status: "fail",
      message: error.response?.data?.message || 'Error creating order',
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

    const stock = await Stock.findOne({ticker: stockId});
    if (!stock) {
      return res.status(404).json({
        status: "fail",
        message: "Stock not found",
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        status: "fail",
        message: "User not found",
      });
    }

    if (quantity > stock.quantity) {
      return res.status(400).json({
        status: "fail",
        message: `Invalid quantity. You only own ${stock.quantity} shares.`,
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
      symbol: stock.ticker,
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
    
    // Update stock quantity or delete if all sold
    if (quantity === stock.quantity) {
      await Stock.findOneAndDelete({ ticker: stockId });
    } else {
      await Stock.findOneAndUpdate(
        { ticker: stockId },
        { quantity: stock.quantity - quantity }
      );
    }

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
        balance: newBalance,
      },
    });
  } catch (error) {
    console.error('Error in sellStock:', error.message);
    if (error.response) {
      console.error('API Response:', error.response.status, error.response.data);
    }
    return res.status(error.response?.status || 500).json({
      status: "fail",
      message: error.response?.data?.message || 'Error creating order',
    });
  }
};


exports.getOrders = async (req, res) => {
  try {
    const userId = req.params.userId;

    console.log('[Orders] Incoming request for user', userId, 'authenticated as', req.user);

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

    // Get orders
    const ordersResponse = await tradingKeys.client.get(`${tradingKeys.apiUrl}/v2/orders`, {
      headers: {
        'APCA-API-KEY-ID': tradingKeys.keyId,
        'APCA-API-SECRET-KEY': tradingKeys.secretKey,
      },
      params: {
        status: 'all',
        limit: 200,
        direction: 'desc',
        nested: true,
      },
    });

    // Get positions
    const positionsResponse = await tradingKeys.client.get(`${tradingKeys.apiUrl}/v2/positions`, {
      headers: {
        'APCA-API-KEY-ID': tradingKeys.keyId,
        'APCA-API-SECRET-KEY': tradingKeys.secretKey,
      }
    });

    // Get account
    const accountResponse = await tradingKeys.client.get(`${tradingKeys.apiUrl}/v2/account`, {
      headers: {
        'APCA-API-KEY-ID': tradingKeys.keyId,
        'APCA-API-SECRET-KEY': tradingKeys.secretKey,
      }
    });

    const ordersPayload = Array.isArray(ordersResponse.data) ? ordersResponse.data : [];
    console.log('[Orders] Retrieved', ordersPayload.length, 'orders for user', userId);

    return res.status(200).json({
      status: "success",
      orders: ordersPayload,
      positions: positionsResponse.data,
      account: accountResponse.data,
    });

  } catch (error) {
    console.error('Error in getOrders:', error);
    console.error('Error details:', error.response?.data || error.message);
    return res.status(500).json({
      status: "fail",
      message: "Error fetching orders",
      error: error.message,
    });
  }
};



exports.editAccount = async (req, res) => {
  try {
    const { ALPACA_API_KEY_ID, ALPACA_API_SECRET_KEY, } = req.body;
    if (req.user !== req.params.userId) {
      return res.status(200).json({
        status: "fail",
        message: "Credentials couldn't be validated.",
      });
    }

    const updatedUser = await User.findByIdAndUpdate(req.params.userId, {
      balance: User.balance,
      ALPACA_API_KEY_ID: ALPACA_API_KEY_ID,
      ALPACA_API_SECRET_KEY: ALPACA_API_SECRET_KEY
    });

    return res.status(200).json({
      status: "success",
      user: {
        username: updatedUser.username,
        id: updatedUser._id,
        balance: updatedUser.balance,
        ALPACA_API_KEY_ID: updatedUser.ALPACA_API_KEY_ID,
        ALPACA_API_SECRET_KEY: updatedUser.ALPACA_API_SECRET_KEY
      },
    });
  } catch (error) {
    return res.status(200).json({
      status: "fail",
      message: "Something unexpected happened.",
    });
  }
};
