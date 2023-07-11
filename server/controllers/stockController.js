const User = require("../models/userModel");
const Stock = require("../models/stockModel");
const setAlpaca = require('../config/alpaca');
const data = require("../config/stocksData");
const Alpaca = require('@alpacahq/alpaca-trade-api');
const Axios = require("axios");
const moment = require('moment');

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
    // console.log(req.body);
    // const trail_percent = parseFloat(req.body.trail_percent);
    // console.log('req.body:', req.body);

    const parsedPrice = price === null ? 999 : price;

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

const totalPrice = quantity * parsedPrice;
if (user.balance - totalPrice < 0) {
  return res.status(200).json({
    status: "fail",
    message: `You don't have enough cash to purchase this stock.`,
  });
}

console.log('Old balance:', user.balance);
console.log('Total price:', totalPrice);

const newBalance = Math.round((user.balance - totalPrice + Number.EPSILON) * 100) / 100;
console.log('New balance:', newBalance);

try {
  const updatedUser = await User.findByIdAndUpdate(userId, { balance: newBalance }, { new: true });
  console.log('Updated user:', updatedUser);
} catch (error) {
  console.log('Error updating balance:', error);
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

// // Create a trailing stop order
// await alpacaApi.createOrder({
//   symbol: ticker,
//   qty: quantity,
//   side: 'sell',
//   type: 'trailing_stop',
//   trail_percent: trail_percent,
//   time_in_force: 'gtc',
// });
// console.log("trailing stop order sent");

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
  console.error('Error:', error);
  return res.status(200).json({
  status: "fail",
  message: "Something unexpected happened.",
  });
  }
  
  }

   

exports.sellStock = async (req, res) => {
  try {
    const { userId, stockId, quantity, price } = req.body;
    console.log("req.body:", req.body);


    if (req.user !== userId) {
      return res.status(200).json({
        status: "fail",
        message: "Credentials couldn't be validated.",
      });
    }

    const stock = stockId;


    // const stock = await Stock.findOne({ticker: stockId});
    console.log("stock:", stock);

    const user = await User.findById(userId);
    console.log("user:", user);


    // if (!user) {
    //   return res.status(200).json({
    //     status: "fail",
    //     message: "Credentials couldn't be validated.",
    //   });
    // }

    // if (quantity > stock.quantity) {
    //   return res.status(200).json({
    //     status: "fail",
    //     message: "Invalid quantity.",
    //   });
    // }

    const alpacaConfig = await setAlpaca(userId);
    console.log("config key done");

    const alpacaApi = new Alpaca(alpacaConfig);
    console.log("connected to Alpaca");



    const order = await alpacaApi.createOrder({
      symbol: stock,
      // symbol: stock.ticker,
      qty: quantity,
      side: 'sell',
      type: 'market',
      time_in_force: 'gtc',
    });
    console.log("sell order sent");


    const saleProfit = order.filled_avg_price * order.filled_qty;

    const updatedUser = await User.findByIdAndUpdate(userId, {
      balance:
        Math.round((user.balance + saleProfit + Number.EPSILON) * 100) / 100,
    });

    // if (quantity === stock.quantity) {
    //   await Stock.findOneAndDelete({ ticker: stockId });
    // } else {
    //   await Stock.findOneAndUpdate(
    //     { ticker: stockId },
    //     { quantity: stock.quantity - quantity }
    //   );
    // }

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
      return res.status(200).json({
        status: "fail",
        message: "Credentials couldn't be validated.",
      });
    }

    const url = `https://api.tiingo.com/tiingo/utilities/search?query=${value}&token=${process.env.TIINGO_API_KEY2}`;
    const response = await Axios.get(url);

    const securities = response.data;
    
    const filteredSecurities = securities.slice(0, 20);

    return res.status(200).json({
      status: "success",
      data: filteredSecurities.map(security => ({ name: security.name, ticker: security.ticker, assetType: security.assetType })),
    });
  } catch (error) {
    console.error('Error:', error);
    return res.status(200).json({
      status: "fail",
      message: "Something unexpected happened.",
    });
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

    const alpacaConfig = await setAlpaca(req.params.userId);
    const apiUrl = alpacaConfig.apiURL;


    // Fetch account information and get cash balance
    const accountInfo = await Axios.get(`${apiUrl}/v2/account`, {
      headers: {
        'APCA-API-KEY-ID': alpacaConfig.keyId,
        'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
      },
    });
    const cashBalance = accountInfo.data.cash;




    const positionsResponse = await Axios.get(`${apiUrl}/v2/positions`, {
      headers: {
        'APCA-API-KEY-ID': alpacaConfig.keyId,
        'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
      },
    });



    //how the order history is calculated
    const ordersResponse = await Axios.get(`${apiUrl}/v2/orders`, {
      headers: {
        'APCA-API-KEY-ID': alpacaConfig.keyId,
        'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
      },
      params: {
        status: 'closed',
      },
    });

    const ordersBySymbol = {};

    ordersResponse.data.forEach((order) => {
      if (order.side === 'buy' && !ordersBySymbol[order.symbol]) {
        ordersBySymbol[order.symbol] = order;
      }
    });

    //how the stocks prices are calculated
    const stocks = positionsResponse.data.map((position) => {
      const order = ordersBySymbol[position.symbol];
      const purchaseDate = order ? moment(order.filled_at).format('YYYY-MM-DD') : null;

      return {
        id: position.symbol,
        ticker: position.symbol,
        price: position.avg_entry_price,
        quantity: position.qty,
        purchaseDate,
      };
    });

    const marketOpen = await isMarketOpen();
    const stocksData = await getPricesData(stocks, marketOpen);

    //how the stocks prices are calculated
    const modifiedStocks = stocks.map((stock) => {
      let currentPrice;
      let currentDate;

      let name;
      stocksData.forEach((stockData) => {
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
        id: stock.id,
        ticker: stock.ticker,
        name,
        purchasePrice: stock.price,
        purchaseDate: stock.purchaseDate,
        quantity: stock.quantity,
        currentDate,
        currentPrice,
      };
    });

    return res.status(200).json({
      status: "success",
      stocks: modifiedStocks,
      cash: cashBalance
    });


  } catch (error) {
    console.error(error);
    return res.status(200).json({
      status: "fail",
      message: "Something unexpected happened.",
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

    // const stocks = await Stock.find({ userId: req.params.userId });
    // stocks.forEach(async (stock) => {
    //   await Stock.findByIdAndDelete(stock._id);
    // });

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



//this is also in strategiesController can be put in utils
const isMarketOpen = async (userId) => {
  try {
    const alpacaConfig = await setAlpaca(userId);
    const response = await Axios.get(alpacaConfig.apiURL+'/v2/clock', {
      headers: {
        'APCA-API-KEY-ID': alpacaConfig.keyId,
        'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
      },
    });
    // console.log("response.data.is_open: ", response.data.is_open);
    return response.data.is_open;
  } catch (error) {
    console.error('Error fetching market status:', error);
    return false;
  }
};

//this is also in strategiesController can be put in utils
const getPricesData = async (stocks, marketOpen, userId) => {
  try {
    const alpacaConfig = await setAlpaca(userId);

    const promises = stocks.map(async (stock) => {
      let url;
      if (marketOpen) {
        url = `https://data.alpaca.markets/v2/stocks/${stock.ticker}/quotes/latest`;
      } else {
        url = `https://data.alpaca.markets/v2/stocks/${stock.ticker}/trades/latest`;
      }

      const response = await Axios.get(url, {
        headers: {
          'APCA-API-KEY-ID': alpacaConfig.keyId,
          'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
        },
      });

      // console.log("response.data: ",response.data);
      // console.log("response.data.quote.ap: ",response.data.quote.ap);
      // console.log("response.data.trade.p: ",response.data.trade.p);



      const currentPrice = marketOpen ? response.data.quote.bp : response.data.trade.p;
      const date = marketOpen ? response.data.quote.t : response.data.trade.t;


      const alpacaApi = new Alpaca(alpacaConfig);

      const asset = await alpacaApi.getAsset(stock.ticker);
      const assetName = asset.name;
      

      return {
        ticker: stock.ticker,
        date: date,
        adjClose: currentPrice,
        name: assetName, 

      };
    });

    return Promise.all(promises);
  } catch (error) {
    return [];
  }
};

