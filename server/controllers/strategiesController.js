const User = require("../models/userModel");
const Strategy = require("../models/strategyModel");
const Portfolio = require("../models/portfolioModel");
const setAlpaca = require('../config/alpaca');
const data = require("../config/stocksData");
const Alpaca = require('@alpacahq/alpaca-trade-api');
const axios = require("axios");
const moment = require('moment');
const { spawn } = require('child_process');
const { Transform } = require('stream');
const crypto = require('crypto');



// Debugging function to log all axios requests as curl commands
axios.interceptors.request.use((request) => {
  let data = request.data ? JSON.stringify(request.data) : '';
  let headers = '';
  for (let header in request.headers) {
    headers += `-H '${header}: ${request.headers[header]}' `;
  }

  let params = '';
  if (request.params) {
    params = Object.keys(request.params)
      .map(key => `${key}=${encodeURIComponent(request.params[key])}`)
      .join('&');
  }

  console.log(`curl -X ${request.method.toUpperCase()} '${request.url}${params ? `?${params}` : ''}' ${headers}${data ? ` -d '${data}'` : ''}` + '\n');
  return request;
});



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

      //Function to call ChatGPT
      const extractGPT = async () => {
        const stream = new Transform({
          transform(chunk, encoding, callback) {
            this.push(chunk);
            callback();
          }
        });

        try {
          // console.log('prompt:', '\n'+process.env.Collaborative_Prompt1+'\n\n'+input);
          const response = await axios({
            method: 'post',
            url: process.env.GPTSERVER + "/api/conversation",
            headers: {
              'Authorization': process.env.OPENAI_API_AUTHORIZATION,
              'Content-Type': 'application/json'
            },
            data: {
              "action": "next",
              "messages": [
                {
                  "id": "cd465ab7-3ee4-40e7-8e48-ade9926ad68e",
                  "role": "user",
                  "content": {
                    "content_type": "text",
                    "parts": [
                      process.env.Collaborative_Prompt1 + '\n\n' + input
                    ]
                  }
                }
              ],
              "parent_message_id": "572aca1b-59e5-4262-85b6-b258fa5a38b8",
              "model": "gpt-4-plugins",
              "temperature": 0,
              "stream": "false",
              "plugin_ids": [
                "plugin-8701f253-5910-4d4c-8057-8265b1ec587e",
                "plugin-f4c74dea-7bee-4f77-9717-34668bbd05b9",
                "plugin-ec68cb54-acee-4330-8d94-f97b8347d525"
              ]
            },
            responseType: 'stream'
          });

          let fullMessage = '';
          return new Promise((resolve, reject) => {
            response.data.pipe(stream).on('data', chunk => {
              const message = chunk.toString();
              fullMessage += message;
            }).on('end', () => {


              let lines = fullMessage.split('\n');
              let doneIndex = lines.findIndex(line => line.trim() === 'data: [DONE]');
              console.log('doneIndex', doneIndex);

              let dataLine;

              if (doneIndex !== -1 && doneIndex > 0) {
                dataLine = lines[doneIndex - 2];
                console.log('dataLine', dataLine);
              } else {
                let dataLine0 = lines[lines.length - 1];  // get last line if 'data: [DONE]' not found
                dataLine = lines[lines.length - 2]; // get second-to-last line if 'data: [DONE]' not found
                let dataLine2 = lines[lines.length - 3] // get third-to-last line if 'data: [DONE]' not found
                console.log('dataLine0', dataLine0);
                console.log('dataLine', dataLine);
                console.log('dataLine2', dataLine2);
              }


              fullMessage = dataLine.replace('data: ', '');
              const contentStartIndex = fullMessage.indexOf('"content"');
              const contentEndIndex = fullMessage.indexOf('"status"');
              const content = fullMessage.substring(contentStartIndex, contentEndIndex);

              const partsStartIndex = content.indexOf('"parts":');
              const partsEndIndex = content.indexOf(']}');
              const partsArray = content.substring(partsStartIndex, partsEndIndex);

              const result = partsArray.replace(/\\"/g, '"').replace(/\\n/g, '\n');
              fullMessage = result;


              console.log('fullMessage', '\n' + fullMessage);
              resolve(fullMessage);

            }).on('error', reject);

          });
        } catch (error) {
          console.error('Request Error: check keys and cookies', error);
        }
      };

      // Function to parse the JSON data
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
        parsedJson = await extractGPT().then(fullMessage => {
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
  try {
    // Get the strategy ID from the request parameters
    const strategyId = req.params.strategy;

    // Find the strategy in the database
    const strategy = await Strategy.findById(strategyId);

    if (!strategy) {
      return res.status(404).json({
        status: "fail",
        message: "Strategy not found",
      });
    }

    // Find the portfolio in the database
    const portfolio = await Portfolio.findOne({ strategy: strategy._id });

    if (!portfolio) {
      return res.status(404).json({
        status: "fail",
        message: "Portfolio not found",
      });
    }

    // Delete the strategy
    await Strategy.deleteOne({ _id: strategy._id });

    // Delete the portfolio
    await Portfolio.deleteOne({ strategy: strategy._id });

    return res.status(200).json({
      status: "success",
      message: "Strategy and portfolio deleted successfully",
    });
  } catch (error) {
    console.error(`Error deleting strategy and portfolio: ${error}`);
    return res.status(500).json({
      status: "fail",
      message: "An error occurred while deleting the strategy and portfolio",
    });
  }
};




exports.addPortfolio = async (strategyinput, strategyName, orders, UserID) => {
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

            // Create a new strategy
            const strategy = new Strategy({
              name: strategyName,
              strategy: strategyinput, // Convert the strategy object to a string
            });

            // Save the strategy
            await strategy.save();
            console.log(`Strategy ${strategyName} has been created.`);


            // Create a new portfolio
            const portfolio = new Portfolio({
              name: strategyName,
              strategy: strategy._id,
              stocks: orders.map(order => ({
                symbol: order.symbol,
                avgCost: null, // Set the average cost to null
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


              console.log('ordersBySymbol:', ordersBySymbol);
              const strategy_id = crypto.randomBytes(16).toString("hex");
            

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
                  avgCost: order.filled_avg_price || 'null', 
                  quantity: order.filled_qty,
                  orderID: order.client_order_id,
                })),
              });

              // Save the portfolio
              await portfolio.save();

              console.log(`Portfolio for strategy ${strategyName} has been created.`);


  }} catch (error) {
    console.error(`Error: ${error}`);
  }


}




const isMarketOpen = async (userId) => {
  try {
    const alpacaConfig = await setAlpaca(userId);
    const response = await axios.get(alpacaConfig.apiURL+'/v2/clock', {
      headers: {
        'APCA-API-KEY-ID': alpacaConfig.keyId,
        'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
      },
    });
    return response.data.is_open;
  } catch (error) {
    console.error('Error fetching market status:', error);
    return false;
  }
};



const getPricesData = async (stocks, marketOpen, userId) => {
  try {
    const alpacaConfig = await setAlpaca(userId);

    const promises = stocks.map(async (stock) => {
      let url;
      if (marketOpen) {
        url = `https://data.alpaca.markets/v2/stocks/${stock.symbol}/quotes/latest`;
      } else {
        url = `https://data.alpaca.markets/v2/stocks/${stock.symbol}/trades/latest`;
      }

      const response = await axios.get(url, {
        headers: {
          'APCA-API-KEY-ID': alpacaConfig.keyId,
          'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
        },
      });

      const currentPrice = marketOpen ? response.data.quote.ap : response.data.trade.p;
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



exports.getPortfolios = async (req, res) => {
  try {
    if (req.user !== req.params.userId) {
      return res.status(200).json({
        status: "fail",
        message: "Credentials couldn't be validated.",
      });
    }

    let UserID = req.params.userId;    

    const portfolios = await Portfolio.find().populate('strategy');
    console.log('portfolios:', portfolios);

    const marketOpen = await isMarketOpen(UserID);

    const portfoliosData = await Promise.all(portfolios.map(async (portfolio) => {
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
        strategy: portfolio.strategy.name,
        stocks: await Promise.all(modifiedStocks),
      };
    }));

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


// // Mock the Alpaca client when market is closed:

// const Mock = require('jest-mock');
// const Alpaca = Mock.fn(() => ({
//   getClock: Mock.fn(() => Promise.resolve({ is_open: true, next_open: '2023-05-14T13:30:00Z' })),
//   createOrder: Mock.fn(({ symbol, qty, side, type, time_in_force }, { price = 999 } = {}) => {
//     return Promise.resolve({ id: 'mock_order_id', status: 'accepted', price });
//   }),  
//   getPositions: Mock.fn(() => Promise.resolve([])),
// }));


// Call a Python script

// async function runPythonScript(input) {
//   return new Promise((resolve, reject) => {
//     let prompt = input;
//     // console.log('prompt', prompt);

//     let login = process.env.OPENAI_API_LOGIN;
//     let password = process.env.OPENAI_API_PASSWORD;

//     let python_process = spawn('python3', ['scripts/chatgpt.py', prompt, login, password]);
//     let python_output = "";

//     python_process.stdout.on('data', (data) => {
//       console.log(`stdout: ${data}`);
//       python_output += data.toString();
//     });

//     python_process.stderr.on('data', (data) => {
//       console.error(`stderr: ${data}`);
//     });

//     python_process.on('close', (code) => {
//       console.log(`child process exited with code ${code}`);
//       // console.log(`Script output: ${python_output}`);
//       resolve(python_output);
//     });
//   });
// }

      // async function extractGPT() {
      //   let python_output = await runPythonScript (
      //     process.env.Collaborative_Prompt1+'\n\n'+input
      //   );

      //   console.log('python_output:'+'\n\n'+python_output);
      //   return python_output.toString();
      // }


