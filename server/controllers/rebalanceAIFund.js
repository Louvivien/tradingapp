(async function() {
    const axios = require('axios');
    const Portfolio = require('./Portfolio'); // replace with the actual path to your Portfolio model
    const retry = require('retry'); // replace with the actual path to your retry function
    const { getAlpacaConfig } = require('../config/alpacaConfig');
    const process = require('process');
  
         // Work in progress
         exports.rebalanceAIFund = async (req, res) => {
            return new Promise(async (resolve, reject) => {
              try {
                let UserID = "6477cf0011fcccfa0365bc87";
                let strategyName = "AI Fund";
                let strategy = "AiFund";
          
          
                    // Get the strategy and portfolio
          
                  //get the portfolio for this specific strategy
                  //if nothing found end the function
                  //get the tickers in the portfolio related to this strategy
                  //get the value of the stocks in the portfolio 
                  //get the budget of the portfolio
          
                const portfolio = await Portfolio.findOne({ strategy: strategyName, userID: UserID });
                if (!portfolio) {
                  console.error('No portfolio found for this strategy');
                  return res.status(400).json({
                    status: "fail",
                    message: "No portfolio found for this strategy.",
                  });
                }
          
                const portfolioTickers = portfolio.stocks.map(stock => stock.symbol);
          
                      // Scoring
          
                let scoreResults = require('../data/scoreResults.json');
                scoreResults.sort((a, b) => b.Score - a.Score);
                let topAssets = scoreResults.slice(0, 5);
                let topAssetsTickers = topAssets.map(asset => asset.Ticker);
          
          
                    // Creating orders
          
                      //check if the top assets are in the portfolio
          
                      //if they are already all in the portfolio, end the function
          
                      //if some top assets are not in the portfolio, add the missing ones to the orderList to buy, quantities will be calculated later
                      //if the portfolio contains some assets that are not in the top assets, add them to the orderList to sell with the quantities in the portfolio, we do not want to keep those stocks
          
                // check if the top assets are in the portfolio
                const portfolioContainsAllTopAssets = topAssetsTickers.every(ticker => portfolioTickers.includes(ticker));
                if (portfolioContainsAllTopAssets) {
                  console.log('The portfolio already contains all top assets. No need to rebalance.');
                  return res.status(200).json({
                    status: "success",
                    message: "The portfolio already contains all top assets. No need to rebalance.",
                  });
                }
          
                let orderList = [];
          
                // Add missing top assets to the orderList to buy
                for (let asset of topAssets) {
                  if (!portfolioTickers.includes(asset.Ticker)) {
                    orderList.push({
                      'Asset ticker': asset.Ticker,
                      'Quantity': 0,
                      'Side': 'buy'
                    });
                  }
                }
          
                // Add assets not in top assets to the orderList to sell
                for (let stock of portfolio.stocks) {
                  if (!topAssetsTickers.includes(stock.symbol)) {
                    orderList.push({
                      'Asset ticker': stock.symbol,
                      'Quantity': stock.quantity,
                      'Side': 'sell'
                    });
                  }
                }
          
                      // Calculating investing amounts
          
                      //get the value of the stocks in the portfolio that are not in the order list
          
                      //get the value of the stocks in the order list :
                      //the one that are in the order list to sell it, using the quantities in the order list
                      //for the one that are in the order list to buy it, get the currentPrice of the stock
          
                      //calculate the quantities to buy so that the total value of the portfolio do not goes over the budget
           
                  // Update the order list with the calculated quantity for the stocks to buy
          
                // Calculating investing amounts
                let totalScore = topAssets.reduce((total, asset) => total + asset.Score, 0);
                let budget = portfolio.budget;
          
                const alpacaConfig = await getAlpacaConfig(UserID);
                console.log("config key done");
          
                for (let i = 0; i < orderList.length; i++) {
                  let order = orderList[i];
                  let symbol = order['Asset ticker'];
                  let originalSymbol = symbol; // Save the original symbol for later use
          
                  let currentPrice = 0;
          
                  // Get the last price for the stock using the Alpaca API
                  const alpacaUrl = `https://data.alpaca.markets/v2/stocks/${symbol}/quotes/latest`;
                  const alpacaResponse = await Axios.get(alpacaUrl, {
                    headers: {
                      'APCA-API-KEY-ID': alpacaConfig.keyId,
                      'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
                    },
                  });
                  currentPrice = alpacaResponse.data.quote.ap;
          
                  // If the current price is still 0, get the adjClose from the past day
                    if (currentPrice === 0) {
            
                      // Get the historical stock data for the given ticker from the Tiingo API
                      const startDate = new Date();
                      startDate.setFullYear(startDate.getFullYear() - 2);
                      const year = startDate.getFullYear();
                      const month = startDate.getMonth() + 1;
                      const day = startDate.getDate();
            
                      let url = `https://api.tiingo.com/tiingo/daily/${symbol}/prices?startDate=${year}-${month}-${day}&token=${process.env.TIINGO_API_KEY1}`;
                      let response;
                      try {
                        response = await Axios.get(url);
                      } catch (error) {
                        if (symbol.includes('.')) {
                          symbol = symbol.replace('.', '-');
                          url = `https://api.tiingo.com/tiingo/daily/${symbol}/prices?startDate=${year}-${month}-${day}&token=${process.env.TIINGO_API_KEY1}`;
                          response = await Axios.get(url);
                        } else {
                          throw error;
                        }
                      }
                      const data = response.data;
                      currentPrice = data[data.length - 1].adjClose;
                    }
          
                  console.log(`Current price of ${symbol} is ${currentPrice}`);
          
                  if (order.Side === 'buy') {
                    // Calculate the quantity based on the score of the asset
                    let assetScore = topAssets.find(a => a.Ticker === originalSymbol).Score; // Use the original symbol here
                    let allocatedBudget = (assetScore / totalScore) * budget;
          
                    // Calculate the quantity to buy
                    let quantity = Math.floor(allocatedBudget / currentPrice);
          
                    // Update the remaining budget
                    budget -= quantity * currentPrice;
          
                    // Update the order list with the calculated quantity
                    orderList[i]['Quantity'] = quantity;
                  }
                }
          
                // Send the orders to alpaca
                let orderPromises = orderList.map(order => {
                  let symbol = order['Asset ticker'];
                  let qty = Math.floor(order['Quantity']);
          
                  if (qty > 0) {
                    return retry(() => {
                      return axios({
                        method: 'post',
                        url: alpacaConfig.apiURL + '/v2/orders',
                        headers: {
                          'APCA-API-KEY-ID': alpacaConfig.keyId,
                          'APCA-API-SECRET-KEY': alpacaConfig.secretKey
                        },
                        data: {
                          symbol: symbol,
                          qty: qty,
                          side: order.Side,
                          type: 'market',
                          time_in_force: 'gtc'
                        }
                      }).then((response) => {
                        console.log(`Order of ${qty} shares for ${symbol} has been placed. Order ID: ${response.data.client_order_id}`);
                        return { qty: qty, symbol: symbol, orderID: response.data.client_order_id};
                      });
                    }, 5, 2000).catch((error) => {
                      console.error(`Failed to place order for ${symbol}: ${error}`)
                      return null;
                    })
                  } else {
                    console.log(`Quantity for ${symbol} is ${qty}. Order not placed.`);
                    return null;
                  }
                })
                // Get the response from alpaca
                Promise.all(orderPromises).then(async orders => {
                  orders = orders.filter(order => order !== null);
          
                  if (orders.length === 0) {
                    console.error('Failed to place all orders.');
                    return res.status(400).json({
                      status: "fail",
                      message: "Failed to place orders. Try again.",
                    });
                  }
          
                  // If some orders were successful, update the portfolio
                  let updatedStocks = portfolio.stocks.map(stock => {
                    let order = orders.find(order => order.symbol === stock.symbol);
                    if (order) {
                      return {
                        symbol: stock.symbol,
                        quantity: stock.quantity + order.qty, // update quantity
                        avgCost: stock.avgCost, // you may want to update the average cost
                        orderID: order.orderID
                      };
                    } else {
                      return stock;
                    }
                  });
          
                  // Add new stocks to the portfolio
                  for (let order of orders) {
                    if (!portfolioTickers.includes(order.symbol)) {
                      updatedStocks.push({
                        symbol: order.symbol,
                        quantity: order.qty,
                        avgCost: null, // you may want to update the average cost
                        orderID: order.orderID
                      });
                    }
                  }
          
                  // Update the portfolio in the database
                  await Portfolio.updateOne(
                    { _id: portfolio._id },
                    { $set: { stocks: updatedStocks } }
                  );
          
                  console.log('Portfolio updated');
                  return res.status(200).json({
                    status: "success",
                    orders: orders,
                  });
                }).catch(error => {
                  console.error(`Error: ${error}`);
                  return res.status(400).json({
                    status: "fail",
                    message: `Something unexpected happened: ${error.message}`,
                  });
                });
              } catch (error) {
                console.error(`Error: ${error}`);
                return res.status(400).json({
                  status: "fail",
                  message: `Something unexpected happened: ${error.message}`,
                });
              }
            });
          }
          
  
  })();
  