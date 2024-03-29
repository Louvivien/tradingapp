const User = require("../models/userModel");
const Stock = require("../models/stockModel");
const setAlpaca = require('../config/alpaca');
const Alpaca = require('@alpacahq/alpaca-trade-api');
const Axios = require("axios");




exports.purchaseStock = async (req, res) => {    
  try {
    const { userId, ticker, quantity, price } = req.body;
    // console.log(req.body);
    
    if (req.user !== userId) {
      return res.status(200).json({
        status: "fail",
        message: "Credentials couldn't be validated.",
      });
    }

    const user = await User.findById(userId);
    // console.log(user);


    if (!user) {
      return res.status(200).json({
        status: "fail",
        message: "Credentials couldn't be validated.",
      });
    }

    const totalPrice = quantity * price;
    if (user.balance - totalPrice < 0) {
      return res.status(200).json({
        status: "fail",
        message: `You don't have enough cash to purchase this stock.`,
      });
    }

    const alpacaConfig = await setAlpaca(userId);
    console.log("config key done");

    const alpacaApi = new Alpaca(alpacaConfig);
    console.log("connected to alpaca");

    const order = await alpacaApi.createOrder({
      symbol: ticker,
      qty: quantity,
      side: 'buy',
      type: 'market',
      time_in_force: 'gtc',
    });
    console.log("order sent");


    const updatedUser = await User.findByIdAndUpdate(userId, {
      balance:
        Math.round((user.balance - totalPrice + Number.EPSILON) * 100) / 100,
    });
        
    return res.status(200).json({
      status: "success",
      stockId: ticker,
      user: {
        username: updatedUser.username,
        id: updatedUser._id,
        balance:
          Math.round((user.balance - totalPrice + Number.EPSILON) * 100) / 100,
      },
    });

  } catch (error) {
    return res.status(200).json({
      status: "fail",
      message: "Something unexpected happened.",
    });
  }
};


exports.sellStock = async (req, res) => {
  try {
    const { userId, stockId, quantity, price } = req.body;
    // console.log(req.body);


    if (req.user !== userId) {
      return res.status(200).json({
        status: "fail",
        message: "Credentials couldn't be validated.",
      });
    }

    const stock = await Stock.findOne({ticker: stockId});
    // console.log(stock);


    if (!stock) {
      return res.status(200).json({
        status: "fail",
        message: "Credentials couldn't be validated.",
      });
    }

    const user = await User.findById(userId);
    // console.log(user);


    if (!user) {
      return res.status(200).json({
        status: "fail",
        message: "Credentials couldn't be validated.",
      });
    }

    if (quantity > stock.quantity) {
      return res.status(200).json({
        status: "fail",
        message: "Invalid quantity.",
      });
    }

    const alpacaConfig = await setAlpaca(userId);
    console.log("config key done");

    const alpacaApi = new Alpaca(alpacaConfig);
    console.log("connected to Alpaca");



    const order = await alpacaApi.createOrder({
      symbol: stock.ticker,
      qty: quantity,
      side: 'sell',
      type: 'market',
      time_in_force: 'gtc',
    });
    console.log("order sent");


    const saleProfit = order.filled_avg_price * order.filled_qty;

    const updatedUser = await User.findByIdAndUpdate(userId, {
      balance:
        Math.round((user.balance + saleProfit + Number.EPSILON) * 100) / 100,
    });

    if (quantity === stock.quantity) {
      await Stock.findOneAndDelete({ ticker: stockId });
    } else {
      await Stock.findOneAndUpdate(
        { ticker: stockId },
        { quantity: stock.quantity - quantity }
      );
    }

    return res.status(200).json({
      status: "success",
      user: {
        username: updatedUser.username,
        id: updatedUser._id,
        balance:
          Math.round((user.balance + saleProfit + Number.EPSILON) * 100) / 100,
      },
    });
  } catch (error) {
    console.log(error);
    return res.status(200).json({
      status: "fail",
      message: "Something unexpected happened.",
    });
  }
};


exports.getOrderForUser = async (req, res) => {
  try {
    if (req.user !== req.params.userId) {
      return res.status(200).json({
        status: "fail",
        message: "Credentials couldn't be validated.",
      });
    }

    // Set up Alpaca API client for the user
    const alpacaConfig = await setAlpaca(req.params.userId);
    const apiUrl = alpacaConfig.apiURL;

    // Retrieve all orders for the user
    const ordersResponse = await Axios.get(`${apiUrl}/v2/orders`, {
      headers: {
        'APCA-API-KEY-ID': alpacaConfig.keyId,
        'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
      },
      params: {
        status: 'all',
      },
    });

    // Return the user's orders
    return res.status(200).json({
      status: "success",
      orders: ordersResponse.data,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      status: "error",
      message: "An error occurred while retrieving the user's orders.",
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
