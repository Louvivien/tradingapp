const User = require("../models/userModel");
const Strategy = require("../models/strategyModel");
const Portfolio = require("../models/portfolioModel");
const News = require("../models/newsModel");
const setAlpaca = require('../config/alpaca');
const Alpaca = require('@alpacahq/alpaca-trade-api');
const axios = require("axios");
const moment = require('moment');
const crypto = require('crypto');
const extractGPT = require("../utils/ChatGPTplugins");
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { distance } = require('fastest-levenshtein');
const Axios = require("axios");




//Work in progress: prompt engineering (see jira https://ai-trading-bot.atlassian.net/browse/AI-76)



exports.createCollaborative = async (req, res) => {
  return new Promise(async (resolve, reject) => {
    try {

      // console.log ('req.body', req.body);
      let input = req.body.collaborative;
      let UserID = req.body.userID;
      // console.log ('UserID', UserID);
      //We will use those 2 variables to create a new portfolio
      let strategyName = req.body.strategyName;
      let strategy = input;

      if (/Below is a trading[\s\S]*strategy does\?/.test(input)) {
        input = input.replace(/Below is a trading[\s\S]*strategy does\?/, "");
      }


      // Function to parse the JSON data from GPT plugins
      const parseJsonData = (fullMessage) => {

        let jsonStart = fullMessage.indexOf('```json\n') + 8;
        let jsonEnd = fullMessage.indexOf('\n```', jsonStart);
        if (jsonStart !== -1 && jsonEnd !== -1) {
          let jsonString = fullMessage.substring(jsonStart, jsonEnd);
          let jsonData = JSON.parse(jsonString);
          return jsonData;
        } else {
          console.error('No JSON in the response')
        }
      };

      // Call the functions : ChatGPT and parse the data
      let parsedJson;
      try {
        parsedJson = await extractGPT(input).then(fullMessage => {
          return parseJsonData(fullMessage);
        });
      } catch (error) {
        console.error('Error in extractGPT:', error);
        return res.status(400).json({
          status: "fail",
          message: error.message,
        });
      }


      //send the orders to the trading platform

      console.log('Order: ', JSON.stringify(parsedJson, null, 2));

      const alpacaConfig = await setAlpaca(UserID);
      console.log("config key done");

      const alpacaApi = new Alpaca(alpacaConfig);
      console.log("connected to alpaca");

      //send the orders to alpaca
      let orderPromises = parsedJson.map(asset => {
        let symbol = asset['Asset ticker'];
        if (!/^[A-Za-z]+$/.test(symbol)) {
          symbol = asset['Asset ticker'].match(/^[A-Za-z]+/)[0];
        }
        let qty = Math.floor(asset['Quantity']);

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
                side: 'buy',
                type: 'market',
                time_in_force: 'gtc'
              }
            }).then((response) => {
              // console.log(response.data);
              console.log(`Order of ${qty} shares for ${symbol} has been placed. Order ID: ${response.data.client_order_id}`);
              return { qty: qty, symbol: symbol, orderID: response.data.client_order_id};
            });
          }, 5, 2000).catch((error) => { // Retry up to 5 times, with a delay of 2 seconds between attempts
            console.error(`Failed to place order for ${symbol}: ${error}`)
            return null;
          })
        } else {
          console.log(`Quantity for ${symbol} is ${qty}. Order not placed.`);
          return null;
        }
      })

      //get the response from alpaca
      Promise.all(orderPromises).then(orders => {
        // Filter out any null values
        orders = orders.filter(order => order !== null);
        
        // If all orders failed, return an error message
        if (orders.length === 0) {
          console.error('Failed to place all orders.');
          return res.status(400).json({
            status: "fail",
            message: "Failed to place orders. Try again.",
          });
        }
      
        // If some orders were successful, continue with the rest of the code
        this.addPortfolio(strategy, strategyName, orders, UserID);
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
      return res.status(200).json({
        status: "fail",
        message: `Something unexpected happened: ${error.message}`,
      });
    }

  });

  }

 


  exports.deleteCollaborative = async (req, res) => {
    console.log('deleting strategy');
    try {
      // Get the strategy ID from the request parameters
      const strategyId = req.params.strategyId;
      const UserID = req.params.userId;
  
      console.log('strategyId', strategyId);
  
      // Find the strategy in the database
      const strategy = await Strategy.findOne({ strategy_id: strategyId });
  
      if (!strategy) {
        return res.status(404).json({
          status: "fail",
          message: "Strategy not found",
        });
      }
  
      // Find the portfolio in the database
      const portfolio = await Portfolio.findOne({ strategy_id: strategyId });
  
      if (!portfolio) {
        return res.status(404).json({
          status: "fail",
          message: "Portfolio not found",
        });
      }
  
      // Delete the strategy
      await Strategy.deleteOne({ strategy_id: strategyId })
      .catch(error => {
        console.error(`Error deleting strategy: ${error}`);
        return res.status(500).json({
          status: "fail",
          message: "An error occurred while deleting the strategy",
        });
      });
  
      // Delete the portfolio
      await Portfolio.deleteOne({ strategy_id: strategyId })
      .catch(error => {
        console.error(`Error deleting portfolio: ${error}`);
        return res.status(500).json({
          status: "fail",
          message: "An error occurred while deleting the portfolio",
        });
      });
  
      // Send a sell order for all the stocks in the portfolio
      const alpacaConfig = await setAlpaca(UserID);
      const alpacaApi = new Alpaca(alpacaConfig);
  
      let sellOrderPromises = portfolio.stocks.map(stock => {
        return alpacaApi.createOrder({
          symbol: stock.symbol,
          qty: stock.quantity,
          side: 'sell',
          type: 'market',
          time_in_force: 'gtc'
        }).then((response) => {
          console.log(`Sell order of ${stock.quantity} shares for ${stock.symbol} has been placed. Order ID: ${response.client_order_id}`);
          return { qty: stock.quantity, symbol: stock.symbol, orderID: response.client_order_id};
        }).catch((error) => {
          console.error(`Failed to place sell order for ${stock.symbol}: ${error}`)
          return null;
        });
      });
  
      Promise.all(sellOrderPromises).then(sellOrders => {
        // Filter out any null values
        sellOrders = sellOrders.filter(order => order !== null);
  
        // If all sell orders failed, return an error message
        if (sellOrders.length === 0) {
          console.error('Failed to place all sell orders.');
          return res.status(400).json({
            status: "fail",
            message: "Failed to place sell orders. Try again.",
          });
        }
  
        // If some sell orders were successful, return a success message
        return res.status(200).json({
          status: "success",
          message: "Strategy and portfolio deleted successfully, and sell orders placed.",
          sellOrders: sellOrders,
        });





        
      }).catch(error => {
        console.error(`Error: ${error}`);
        return res.status(400).json({
          status: "fail",
          message: `Something unexpected happened: ${error.message}`,
        });
      });
  
    } catch (error) {
      console.error(`Error deleting strategy and portfolio: ${error}`);
      return res.status(500).json({
        status: "fail",
        message: "An error occurred while deleting the strategy and portfolio",
      });
    }
  };
 
  exports.enableAIFund = async (req, res) => {
    return new Promise(async (resolve, reject) => {
      try {
        let budget = req.body.budget;
        let UserID = req.body.userID;
        let strategyName = req.body.strategyName;
        let strategy = "AiFund";
  
        // Scoring
        let scoreResults = require('../data/scoreResults.json');
        scoreResults.sort((a, b) => b.Score - a.Score); // Sort by score in descending order
        let topAssets = scoreResults.slice(0, 5); // Get the top 5 assets
  
        // Creating orders
        let orderList = topAssets.map(asset => {
          return {
            'Asset ticker': asset.Ticker,
            'Quantity': 0, // Quantity will be calculated later
            'Current Price': 0 // Current price will be updated later
          };
        });
  
        console.log('orderList', orderList);
  
        // Calculating investing amounts
        let totalScore = topAssets.reduce((total, asset) => total + asset.Score, 0);
        let remainingBudget = budget;
  
        const alpacaConfig = await setAlpaca(UserID);
        console.log("config key done");
  
        for (let i = 0; i < orderList.length; i++) {
          let asset = orderList[i];
          let symbol = asset['Asset ticker'];
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
          asset['Current Price'] = currentPrice; // Update the current price in the order list

  
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
  
          // Calculate the quantity based on the score of the asset
          let assetScore = topAssets.find(a => a.Ticker === originalSymbol).Score; // Use the original symbol here
          let allocatedBudget = (assetScore / totalScore) * budget;
  
          // Calculate the quantity to buy
          let quantity = Math.floor(allocatedBudget / currentPrice);
  
          // Update the remaining budget
          remainingBudget -= quantity * currentPrice;
  
          // Update the order list with the calculated quantity
          orderList[i]['Quantity'] = quantity;
        }
  
        // If there's remaining budget, distribute it to the assets again
        if (remainingBudget > 0) {
                for (let i = 0; i < orderList.length; i++) {
                  let asset = orderList[i];
                  let symbol = asset['Asset ticker'];
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

                  // Calculate the quantity to buy with the remaining budget
                  let quantity = Math.floor(remainingBudget / currentPrice);

                  // Update the remaining budget
                  remainingBudget -= quantity * currentPrice;

                  // Update the order list with the additional quantity
                  orderList[i]['Quantity'] += quantity;

                  // If there's no remaining budget, break the loop
                  if (remainingBudget <= 0) {
                    break;
                  }
                }
              }

        
              // Send the orders to the trading platform
              console.log('Order: ', JSON.stringify(orderList, null, 2));
        
              // Send the orders to alpaca
              let orderPromises = orderList.map(asset => {
                let symbol = asset['Asset ticker'];
                let qty = Math.floor(asset['Quantity']);
        
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
                        side: 'buy',
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
        Promise.all(orderPromises).then(orders => {
          orders = orders.filter(order => order !== null);
  
          if (orders.length === 0) {
            console.error('Failed to place all orders.');
            return res.status(400).json({
              status: "fail",
              message: "Failed to place orders. Try again.",
            });
          }
  
          // If some orders were successful, and the portfolio does not exist, create it
          this.addPortfolio(strategy, strategyName, orders, UserID, budget);
          return res.status(200).json({
            status: "success",
            orders: orders,
          });
  
          // If some orders were successful, and the portfolio does exist update the portfolio
        }).catch(error => {
          console.error(`Error: ${error}`);
          return res.status(400).json({
            status: "fail",
            message: `Something unexpected happened: ${error.message}`,
          });
        });
      } catch (error) {
        console.error(`Error: ${error}`);
        return res.status(200).json({
          status: "fail",
          message: `Something unexpected happened: ${error.message}`,
        });
      }
    });
  }




exports.disableAIFund = async (req, res) => {
      console.log('deleting strategy');
      try {
        // Get the strategy ID 
        const strategyId = "01";
        const UserID = req.params.userId;
    
        console.log('strategyId', strategyId);
    
        // Find the strategy in the database
        const strategy = await Strategy.findOne({ strategy_id: strategyId });
    
        if (!strategy) {
          return res.status(404).json({
            status: "fail",
            message: "Strategy not found",
          });
        }
    
        // Find the portfolio in the database
        const portfolio = await Portfolio.findOne({ strategy_id: strategyId });
    
        if (!portfolio) {
          return res.status(404).json({
            status: "fail",
            message: "Portfolio not found",
          });
        }
    
        // Delete the strategy
        await Strategy.deleteOne({ strategy_id: strategyId })
        .catch(error => {
          console.error(`Error deleting strategy: ${error}`);
          return res.status(500).json({
            status: "fail",
            message: "An error occurred while deleting the strategy",
          });
        });
    
        // Delete the portfolio
        await Portfolio.deleteOne({ strategy_id: strategyId })
        .catch(error => {
          console.error(`Error deleting portfolio: ${error}`);
          return res.status(500).json({
            status: "fail",
            message: "An error occurred while deleting the portfolio",
          });
        });
    
        // Send a sell order for all the stocks in the portfolio
        const alpacaConfig = await setAlpaca(UserID);
        const alpacaApi = new Alpaca(alpacaConfig);
    
        let sellOrderPromises = portfolio.stocks.map(stock => {
          return alpacaApi.createOrder({
            symbol: stock.symbol,
            qty: stock.quantity,
            side: 'sell',
            type: 'market',
            time_in_force: 'gtc'
          }).then((response) => {
            console.log(`Sell order of ${stock.quantity} shares for ${stock.symbol} has been placed. Order ID: ${response.client_order_id}`);
            return { qty: stock.quantity, symbol: stock.symbol, orderID: response.client_order_id};
          }).catch((error) => {
            console.error(`Failed to place sell order for ${stock.symbol}: ${error}`)
            return null;
          });
        });
    
        Promise.all(sellOrderPromises).then(sellOrders => {
          // Filter out any null values
          sellOrders = sellOrders.filter(order => order !== null);
    
          // If all sell orders failed, return an error message
          if (sellOrders.length === 0) {
            console.error('Failed to place all sell orders.');
            return res.status(400).json({
              status: "fail",
              message: "Failed to place sell orders. Try again.",
            });
          }
    
          // If some sell orders were successful, return a success message
          return res.status(200).json({
            status: "success",
            message: "Strategy and portfolio deleted successfully, and sell orders placed.",
            sellOrders: sellOrders,
          });
  
  
  
  
  
          
        }).catch(error => {
          console.error(`Error: ${error}`);
          return res.status(400).json({
            status: "fail",
            message: `Something unexpected happened: ${error.message}`,
          });
        });
    
      } catch (error) {
        console.error(`Error deleting strategy and portfolio: ${error}`);
        return res.status(500).json({
          status: "fail",
          message: "An error occurred while deleting the strategy and portfolio",
        });
      }
    };
  


exports.addPortfolio = async (strategyinput, strategyName, orders, UserID, budget) => {
  console.log('strategyName', strategyName);
  console.log('orders', orders);
  console.log('UserID', UserID);

  try {
    const numberOfOrders = orders.length;
    console.log('numberOfOrders', numberOfOrders);

    const alpacaConfig = await setAlpaca(UserID);
    const alpacaApi = new Alpaca(alpacaConfig);

// Check if the market is open
const clock = await alpacaApi.getClock();
if (!clock.is_open) {
            console.log('Market is closed.');



            let strategy_id;
            if (strategyName === "AI Fund") {
              strategy_id = "01";
            } else {
              const crypto = require("crypto");
              strategy_id = crypto.randomBytes(16).toString("hex");
            }
            console.log('strategy_id:', strategy_id);
            


            // Create a new strategy
            const strategy = new Strategy({
              name: strategyName,
              strategy: strategyinput, 
              strategy_id: strategy_id, 
            });

            // Save the strategy
            await strategy.save();
            console.log(`Strategy ${strategyName} has been created.`);


            // Create a new portfolio
            const portfolio = new Portfolio({
              name: strategyName,
              strategy_id: strategy_id,
              budget: budget,
              stocks: orders.map(order => ({
                symbol: order.symbol,
                avgCost: null, 
                quantity: order.qty,
                orderID: order.orderID,
              })),
            });

            // Save the portfolio
            await portfolio.save();

            console.log(`Portfolio for strategy ${strategyName} has been created. Market is closed so the orders are not filled yet.`);
            return;
          }

else {        
  
              console.log('Market is open.');
              // Function to get the orders if market is open
              const getOrders = async () => {
                const ordersResponse = await axios({
                  method: 'get',
                  url: alpacaConfig.apiURL + '/v2/orders',
                  headers: {
                    'APCA-API-KEY-ID': alpacaConfig.keyId,
                    'APCA-API-SECRET-KEY': alpacaConfig.secretKey
                  },
                  params: {
                    limit: numberOfOrders,
                    status: 'all',
                    nested: true
                  }
                });

                console.log('ordersResponse', ordersResponse.data);

                // Check if all orders are filled
                const filledOrders = ordersResponse.data.filter(order => order.filled_qty !== '0');
                      if (!filledOrders || filledOrders.length !== numberOfOrders) {
                        // If not all orders are closed or not all orders have been filled, throw an error to trigger a retry
                        throw new Error("Not all orders are closed or filled yet.");
                      }
                      return filledOrders;
                    };


              let ordersResponse;
              try {
                ordersResponse = await retry(getOrders, 5, 4000);

              } catch (error) {
                console.error(`Error: ${error}`);
                throw error;
              }


                // Create an object to store orders by symbol
                const ordersBySymbol = {};

                ordersResponse.forEach((order) => {
                  if (order.side === 'buy' && !ordersBySymbol[order.symbol]) {
                    ordersBySymbol[order.symbol] = {
                      symbol: order.symbol,
                      avgCost: order.filled_avg_price,
                      filled_qty: order.filled_qty,
                      orderID: order.client_order_id
                    };
                  }
                });



                let strategy_id;
                if (strategyName === "AI Fund") {
                  strategy_id = "01";
                } else {
                  const crypto = require("crypto");
                  strategy_id = crypto.randomBytes(16).toString("hex");
                }
                console.log('strategy_id:', strategy_id);
                
              console.log('strategy_id:', strategy_id);
            

              // Create a new strategy
              const strategy = new Strategy({
                name: strategyName,
                strategy: strategyinput,
                strategy_id: strategy_id, 
              });

              // Save the strategy
              await strategy.save();
              console.log(`Strategy ${strategyName} has been created.`);


              // Create a new portfolio
              const portfolio = new Portfolio({
                name: strategyName,
                strategy_id: strategy_id,
                stocks: Object.values(ordersBySymbol).map(order => ({
                  symbol: order.symbol,
                  avgCost: order.filled_avg_price ? Number(order.filled_avg_price) : null, // Convert the avgCost to a number or set it to null
                  quantity: order.filled_qty,
                  orderID: order.orderID || null, // Set the orderID to null if it's not provided
                })),
              });


              // Save the portfolio
              await portfolio.save();

              console.log(`Portfolio for strategy ${strategyName} has been created.`);


  }} catch (error) {
    console.error(`Error: ${error}`);
  }


}

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

      const alpacaConfig = await setAlpaca(UserID);
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

        // If there's remaining budget, distribute it to the assets again
        if (remainingBudget > 0) {
          // Sort the order list by asset price in ascending order
          orderList.sort((a, b) => a['Current Price'] - b['Current Price']);
        
          while (remainingBudget > orderList[0]['Current Price']) {
            for (let i = 0; i < orderList.length; i++) {
              let asset = orderList[i];
              let symbol = asset['Asset ticker'];
              let currentPrice = asset['Current Price'];
        
              // Calculate the quantity to buy with the remaining budget
              let quantity = Math.floor(remainingBudget / currentPrice);
        
              // If quantity is 0, continue to the next asset
              if (quantity === 0) continue;
        
              // Update the remaining budget
              remainingBudget -= quantity * currentPrice;
        
              // Update the order list with the additional quantity
              orderList[i]['Quantity'] += quantity;
        
              // If there's no remaining budget, break the loop
              if (remainingBudget <= 0) {
                break;
              }
            }
          }
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





exports.getPortfolios = async (req, res) => {
  try {
    if (req.user !== req.params.userId) {
      return res.status(200).json({
        status: "fail",
        message: "Credentials couldn't be validated.",
      });
    }

    let UserID = req.params.userId;    

    const portfolios = await Portfolio.find(); // Removed .populate('strategy_id')
    console.log('portfolios:', portfolios);

    const marketOpen = await isMarketOpen(UserID);

    const portfoliosData = await Promise.all(portfolios.map(async (portfolio) => {
      const strategy = await Strategy.findOne({ strategy_id: portfolio.strategy_id });    
      const stocksData = await getPricesData(portfolio.stocks, marketOpen, UserID);

      const modifiedStocks = portfolio.stocks.map(async (stock) => {
        let currentPrice;
        let currentDate;
        let name;
        let avgCost = stock.avgCost;



        stocksData.forEach((stockData) => {
          if (stockData.ticker.toLowerCase() === stock.symbol.toLowerCase()) {
            currentDate = stockData.date;
            currentPrice = stockData.adjClose;
            name = stockData.name;
          }
        });

        // If avgCost is null and market is open, get the filled orders and update avgCost
        if (avgCost === null && marketOpen) {
          console.log('Updating portfolio to check if orders are filled');
          const alpacaConfig = await setAlpaca(UserID);
          const response = await axios.get(alpacaConfig.apiURL + '/v2/orders', {
            headers: {
              'APCA-API-KEY-ID': alpacaConfig.keyId,
              'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
            },
            params: {
              status: 'filled',
              symbols: [stock.symbol],
              limit: 10,
              direction: 'desc'
            }
          });   
          const orders = response.data;

          if (orders && orders.length > 0) {
            // Find the order that matches the quantity
            
            const matchingOrder = orders.find(order => order.client_order_id === stock.orderID);
            
            console.log('stock.quantity:', stock.orderID);


            if (matchingOrder) {

              console.log('Found matching order:', matchingOrder);

              avgCost = matchingOrder.filled_avg_price;

              // Update the avgCost in the database
              await Portfolio.updateOne(
                { _id: portfolio._id, 'stocks.symbol': stock.symbol },
                { $set: { 'stocks.$.avgCost': avgCost } }
              );
              console.log('Portfolio updated with cost for orders');
            }

            else {
              console.log('No matching order found');
            }

          }
        }

        return {
          symbol: stock.symbol,
          name,
          avgCost,
          quantity: stock.quantity,
          currentDate,
          currentPrice,
        };
      });

      return {
        name: portfolio.name,
        strategy: strategy ? strategy.strategy : null, 
        strategy_id: portfolio.strategy_id, 
        stocks: await Promise.all(modifiedStocks),
      };


    }))

    // Send the response
    return res.status(200).json({
      status: "success",
      portfolios: portfoliosData
    });

  } catch (error) {
    console.error('Error fetching portfolios:', error);
    return res.status(200).json({
      status: "fail",
      message: "Something unexpected happened.",
    });
  }
};

exports.getStrategies = async (req, res) => {
  try {
    if (req.user !== req.params.userId) {
      return res.status(200).json({
        status: "fail",
        message: "Credentials couldn't be validated.",
      });
    }

    // Query all strategies
    const strategies = await Strategy.find();

    // Send the response
    return res.status(200).json({
      status: "success",
      strategies: strategies
    });

  } catch (error) {
    console.error('Error fetching strategies:', error);
    return res.status(200).json({
      status: "fail",
      message: "Something unexpected happened.",
    });
  }
};



exports.getNewsHeadlines = async (req, res) => {
  const ticker = req.body.ticker;
  const period = req.body.period;

  const python = spawn('python3', ['./scripts/news.py', '--ticker', ticker, '--period', period]);

  let python_output = "";
  let python_log = "";

  const pythonPromise = new Promise((resolve, reject) => {
      python.stdout.on('data', (data) => {
          python_output += data.toString();
      });

      python.stderr.on('data', (data) => {
          python_log += data.toString();
      });

      python.on('close', (code) => {
          if (code !== 0) {
              console.log(`Python script exited with code ${code}`);
              reject(`Python script exited with code ${code}`);
          } else {
              resolve(python_output);
          }
      });
  });

  try {
      const python_output = await pythonPromise;
      console.log('Python output:', python_output);

      let newsData;
      try {
          newsData = JSON.parse(python_output);
          console.log('newsData:', newsData);

      } catch (err) {
          console.error(`Error parsing JSON in nodejs: ${err}`);
          console.error(`Invalid  JSON in nodejs: ${python_output}`);
          newsData = [];
      }

      // Extract headlines from newsData
      const newsHeadlines = newsData.map(news => news["title"]);

      const stockKeywords = ["stock", "jumped", "intraday", "pre-market", "uptrend", "position", "increased", "gains", "loss", "up", "down", "rise", "fall", "bullish", "bearish", "nasdaq", "nyse", "percent", "%"];

      for (const news of newsData) {
          // Check if the headline contains any of the stock keywords
          const lowerCaseTitle = news.title.toLowerCase();
          if (stockKeywords.some(keyword => lowerCaseTitle.includes(keyword))) {
              continue;  // Skip this headline
          }

          const existingNews = await News.find({ "Stock name": ticker, Date: news.date }).catch(err => {
              console.error('Error finding news:', err);
              throw err;
          });

          let isSimilar = false;
          for (const existing of existingNews) {
              const similarity = 1 - distance(existing["News headline"], news.title) / Math.max(existing["News headline"].length, news.title.length);
              if (similarity > 0.6) {
                  isSimilar = true;
                  break;
              }
          }

          if (!isSimilar) {
              const newNews = new News({
                  newsId: news.id,
                  "News headline": news.title,
                  Date: news.date,
                  Ticker: news.ticker,
                  "Stock name": ticker, 
                  Source: news.source,
              });
              try {
                  await newNews.save();
                  console.log(`Saved: ${newNews["News headline"]}`);
              } catch (err) {
                  console.log('Error saving news: ', err);
              }
          }
      }
      res.send(newsHeadlines);
  } catch (err) {
      console.error('Error:', err);
      res.status(500).send(err);
  }
};
exports.getScoreHeadlines = async (req, res) => {
  try {
    const newsData = await News.find({});
    const newsDataJson = JSON.stringify(newsData);
    const inputFilePath = './data/newsData.json';
    const outputFilePath = './data/sentimentResults.json';
    const output2FilePath = './data/scoreResults.json';

    fs.writeFileSync(inputFilePath, newsDataJson);

    const python = spawn('python3', ['-u', './scripts/sentiment_claude5.py', inputFilePath, outputFilePath, output2FilePath]);

    python.stdout.on('data', (data) => {
      const message = data.toString();
      if (message.trim() !== '') {  // Only print the message if it's not an empty string
        console.log(message);  // Stream the Python output immediately
      }
    });

    python.stderr.on('data', (data) => {
      console.error('Python error:', data.toString());  // Log the Python errors immediately
    });

    const pythonPromise = new Promise((resolve, reject) => {
      python.on('close', (code) => {
        if (code !== 0) {
          console.log(`Python script exited with code ${code}`);
          reject(`Python script exited with code ${code}`);
        } else {
          resolve();
        }
      });
    });

    try {
      await pythonPromise;  // Wait for the Python script to finish
      res.send('Sentiment analysis completed successfully');
    } catch (err) {
      console.error('Error:', err);
      res.status(500).send(err);
    }
  } catch (err) {
    console.error('Error in getScoreHeadlines:', err);
    res.status(500).send('Error in getScoreHeadlines');
  }
};




exports.testPython = async (req, res) => {
  console.log('testPython called');
  const { spawn } = require('child_process');
  let input = req.body.input;

  // Call a Python script
  const runPythonScript = async (input) => {
    return new Promise((resolve, reject) => {
      let python_process = spawn('python3', ['scripts/test.py', input]);
      let python_output = "";

      python_process.stdout.on('data', (data) => {
        console.log(`stdout: ${data}`);
        python_output += data.toString();
      });

      python_process.stderr.on('data', (data) => {
        console.error(`stderr: ${data}`);
      });

      python_process.on('close', (code) => {
        console.log(`child process exited with code ${code}`);
        resolve(python_output);
      });
    });
  }

  const getPython = async (input) => {
    let python_output = await runPythonScript(input);
    console.log('python_output:'+'\n\n'+python_output);
    return python_output.toString();
  }

  // Call the getPython function and send the result back to the client
  try {
    let result = await getPython(input);
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'An error occurred while running the Python script.' });
  }
};

  



// Debugging function to retry a promise-based function
const retry = (fn, retriesLeft = 5, interval = 1000) => {
  return new Promise((resolve, reject) => {
    fn().then(resolve)
      .catch((error) => {
        setTimeout(() => {
          if (retriesLeft === 1) {
            // reject('maximum retries exceeded');
            reject(error);
          } else {
            console.log(`Retrying... attempts left: ${retriesLeft - 1}`); // Log message at each retry
            // Try again with one less retry attempt left
            retry(fn, retriesLeft - 1, interval).then(resolve, reject);
          }
        }, interval);
      });
  });
};


//this is also in strockController can be put in utils
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
//not exactly here it is symbol not ticker
const getPricesData = async (stocks, marketOpen, userId) => {
  try {
    const alpacaConfig = await setAlpaca(userId);

    const promises = stocks.map(async (stock) => {
      // console.log('Stock ticker:', stock.symbol);

      let url;
      if (marketOpen) {
        url = `https://data.alpaca.markets/v2/stocks/${stock.symbol}/quotes/latest`;
      } else {
        url = `https://data.alpaca.markets/v2/stocks/${stock.symbol}/trades/latest`;
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

      const asset = await alpacaApi.getAsset(stock.symbol);
      const assetName = asset.name;
      

      return {
        ticker: stock.symbol,
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



// // Mock the Alpaca client when market is closed:

// const Mock = require('jest-mock');
// const Alpaca = Mock.fn(() => ({
//   getClock: Mock.fn(() => Promise.resolve({ is_open: true, next_open: '2023-05-14T13:30:00Z' })),
//   createOrder: Mock.fn(({ symbol, qty, side, type, time_in_force }, { price = 999 } = {}) => {
//     return Promise.resolve({ id: 'mock_order_id', status: 'accepted', price });
//   }),  
//   getPositions: Mock.fn(() => Promise.resolve([])),
// }));



// // Debugging function to log all axios requests as curl commands
// axios.interceptors.request.use((request) => {
//   let data = request.data ? JSON.stringify(request.data) : '';
//   let headers = '';
//   for (let header in request.headers) {
//     headers += `-H '${header}: ${request.headers[header]}' `;
//   }

//   let params = '';
//   if (request.params) {
//     params = Object.keys(request.params)
//       .map(key => `${key}=${encodeURIComponent(request.params[key])}`)
//       .join('&');
//   }

//   console.log(`curl -X ${request.method.toUpperCase()} '${request.url}${params ? `?${params}` : ''}' ${headers}${data ? ` -d '${data}'` : ''}` + '\n');
//   return request;
// });


        //Check if a portfolio with the same name already exists
            //if it does, get the tickers of the stocks in this portfolio
            //and compare it with the ones from the scoring model

            //if they are the same, do nothing
            //if some are in the scoring model but not in the portfolio, add them to the buying list
            //if some are in the portfolio but not in the scoring model, add them to the selling list


                    //if the portfolio exists, get the current value of the portfolio
          //then check the unitary value of each stocks that are in the selling list
          //then check the unitary value of each stocks that are in the buying list
          //allocate the budget to each buy stock so that you try to buy all the stocks in the buying list





// exports.updatePortfolio = async (strategyinput, strategyName, orders, UserID) => {
//   console.log('strategyName', strategyName);
//   console.log('orders', orders);
//   console.log('UserID', UserID);

//   try {
//     const numberOfOrders = orders.length;
//     console.log('numberOfOrders', numberOfOrders);

//     const alpacaConfig = await setAlpaca(UserID);
//     const alpacaApi = new Alpaca(alpacaConfig);

// // Check if the market is open
// const clock = await alpacaApi.getClock();
// if (!clock.is_open) {
//             console.log('Market is closed.');

//             const strategy_id = crypto.randomBytes(16).toString("hex");
//             console.log('strategy_id:', strategy_id);

//             // Find the existing strategy


//             // update the existing portfolio


//             // Save the portfolio
//             await portfolio.save();

//             console.log(`Portfolio for strategy ${strategyName} has been updated. Market is closed so the orders are not filled yet.`);
//             return;
//           }

// else {        
  
//               console.log('Market is open.');
//               // Function to get the orders if market is open
//               const getOrders = async () => {
//                 const ordersResponse = await axios({
//                   method: 'get',
//                   url: alpacaConfig.apiURL + '/v2/orders',
//                   headers: {
//                     'APCA-API-KEY-ID': alpacaConfig.keyId,
//                     'APCA-API-SECRET-KEY': alpacaConfig.secretKey
//                   },
//                   params: {
//                     limit: numberOfOrders,
//                     status: 'all',
//                     nested: true
//                   }
//                 });

//                 console.log('ordersResponse', ordersResponse.data);

//                 // Check if all orders are filled
//                 const filledOrders = ordersResponse.data.filter(order => order.filled_qty !== '0');
//                       if (!filledOrders || filledOrders.length !== numberOfOrders) {
//                         // If not all orders are closed or not all orders have been filled, throw an error to trigger a retry
//                         throw new Error("Not all orders are closed or filled yet.");
//                       }
//                       return filledOrders;
//                     };


//               let ordersResponse;
//               try {
//                 ordersResponse = await retry(getOrders, 5, 4000);

//               } catch (error) {
//                 console.error(`Error: ${error}`);
//                 throw error;
//               }


//                 // Create an object to store orders by symbol
//                 const ordersBySymbol = {};

//                 ordersResponse.forEach((order) => {
//                   if (order.side === 'buy' && !ordersBySymbol[order.symbol]) {
//                     ordersBySymbol[order.symbol] = {
//                       symbol: order.symbol,
//                       avgCost: order.filled_avg_price,
//                       filled_qty: order.filled_qty,
//                       orderID: order.client_order_id
//                     };
//                   }
//                 });


//               console.log('ordersBySymbol:', ordersBySymbol);
//               const strategy_id = crypto.randomBytes(16).toString("hex");
//               console.log('strategy_id:', strategy_id);
            

//               // Find the existing strategy




//               // Update the existing portfolio



//               // Save the portfolio
//               await portfolio.save();

//               console.log(`Portfolio for strategy ${strategyName} has been updated.`);


//   }} catch (error) {
//     console.error(`Error: ${error}`);
//   }


// }

