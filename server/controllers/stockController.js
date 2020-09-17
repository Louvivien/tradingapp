const mongoose = require("mongoose");
const User = require("../models/userModel");
const Stock = require("../models/stockModel");

exports.purchaseStock = async (req, res) => {
  try {
    const { userId, ticker, quantity, price } = req.body;
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

exports.getStock = async (req, res) => {
  try {
    const stocks = await Stock.find({ userId: req.params.userId });
    return res.status(200).json({
      status: "success",
      stocks,
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
