const User = require("../models/userModel");
const Stock = require("../models/stockModel");
const data = require("../config/stocksData");
const Axios = require("axios");

exports.purchaseStock = async (req, res) => {
  try {
    const { userId, ticker, quantity, price } = req.body;

    if (req.user !== userId) {
      return res.status(200).json({
        status: "fail",
        message: "Credentials couldn't be validated.",
      });
    }

    const user = await User.findById(userId);

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

    const purchase = new Stock({ userId, ticker, quantity, price });
    await purchase.save();
    const updatedUser = await User.findByIdAndUpdate(userId, {
      balance:
        Math.round((user.balance - totalPrice + Number.EPSILON) * 100) / 100,
    });

    return res.status(200).json({
      status: "success",
      stockId: purchase._id,
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

    if (req.user !== userId) {
      return res.status(200).json({
        status: "fail",
        message: "Credentials couldn't be validated.",
      });
    }

    const stock = await Stock.findById(stockId);

    if (!stock) {
      return res.status(200).json({
        status: "fail",
        message: "Credentials couldn't be validated.",
      });
    }

    const user = await User.findById(userId);

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

    if (quantity === stock.quantity) {
      await Stock.findByIdAndDelete(stockId);
    } else {
      await Stock.findByIdAndUpdate(stockId, {
        quantity: stock.quantity - quantity,
      });
    }

    const saleProfit = quantity * price;

    const updatedUser = await User.findByIdAndUpdate(userId, {
      balance:
        Math.round((user.balance + saleProfit + Number.EPSILON) * 100) / 100,
    });

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
    return res.status(200).json({
      status: "fail",
      message: "Something unexpected happened.",
    });
  }
};

const getPricesData = async (stocks) => {
  try {
    const promises = stocks.map(async (stock) => {
      const url = `https://api.tiingo.com/tiingo/daily/${stock.ticker}/prices?token=${process.env.TIINGO_API_KEY}`;
      const response = await Axios.get(url);
      return {
        ticker: stock.ticker,
        date: response.data[0].date,
        adjClose: response.data[0].adjClose,
      };
    });

    return Promise.all(promises);
  } catch (error) {
    return [];
  }
};

exports.getStockForUser = async (req, res) => {
  try {
    if (req.user !== req.params.userId) {
      return res.status(200).json({
        status: "fail",
        message: "Credentials couldn't be validated.",
      });
    }

    const stocks = await Stock.find({ userId: req.params.userId });
    const stocksData = await getPricesData(stocks);
    const modifiedStocks = stocks.map((stock) => {
      let name;
      let currentPrice;
      let currentDate;
      data.stockData.forEach((stockData) => {
        if (stockData.ticker.toLowerCase() === stock.ticker.toLowerCase()) {
          name = stockData.name;
        }
      });

      stocksData.forEach((stockData) => {
        if (stockData.ticker.toLowerCase() === stock.ticker.toLowerCase()) {
          currentDate = stockData.date;
          currentPrice = stockData.adjClose;
        }
      });

      return {
        id: stock._id,
        ticker: stock.ticker,
        name,
        purchasePrice: stock.price,
        purchaseDate: stock.date,
        quantity: stock.quantity,
        currentDate,
        currentPrice,
      };
    });

    return res.status(200).json({
      status: "success",
      stocks: modifiedStocks,
    });
  } catch (error) {
    return res.status(200).json({
      status: "fail",
      message: "Something unexpected happened.",
    });
  }
};

exports.resetAccount = async (req, res) => {
  try {
    if (req.user !== req.params.userId) {
      return res.status(200).json({
        status: "fail",
        message: "Credentials couldn't be validated.",
      });
    }

    const stocks = await Stock.find({ userId: req.params.userId });
    stocks.forEach(async (stock) => {
      await Stock.findByIdAndDelete(stock._id);
    });

    const updatedUser = await User.findByIdAndUpdate(req.params.userId, {
      balance: 100000,
    });

    return res.status(200).json({
      status: "success",
      user: {
        username: updatedUser.username,
        id: updatedUser._id,
        balance: 100000,
      },
    });
  } catch (error) {
    return res.status(200).json({
      status: "fail",
      message: "Something unexpected happened.",
    });
  }
};
