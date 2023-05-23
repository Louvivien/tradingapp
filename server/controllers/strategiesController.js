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



      // Function to retry a promise-based function
      const retry = (fn, retriesLeft = 5, interval = 1000) => {
        return new Promise((resolve, reject) => {
          fn().then(resolve)
            .catch((error) => {
              setTimeout(() => {
                if (retriesLeft === 1) {
                  // reject('maximum retries exceeded');
                  reject(error);
                } else {
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

      // console.log('req.body', req.body);
      let input = req.body.collaborative;
      let UserID = req.body.UserID;
      let strategyName = req.body.strategyName;


      if (/Below is a trading[\s\S]*strategy does\?/.test(input)) {
        input = input.replace(/Below is a trading[\s\S]*strategy does\?/, "");
      }

      let strategy = input;



      //Function to call ChatGPT
      const extractGPT = async () => {
        const stream = new Transform({
          transform(chunk, encoding, callback) {
            this.push(chunk);
            callback();
          }
        });
      
        try {
          console.log('prompt:', '\n'+process.env.Collaborative_Prompt1+'\n\n'+input);
          const response = await axios({
            method: 'post',
            url: process.env.GPTPROXYSERVER+"/api/conversation",
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
                      process.env.Collaborative_Prompt1+'\n\n'+input
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
              // console.log('doneIndex', doneIndex);
              if (doneIndex !== -1 && doneIndex > 0) {
                let dataLine = lines[doneIndex - 2];
                // console.log('dataLine', dataLine);
                fullMessage = dataLine.replace('data: ', '');
                const contentStartIndex = fullMessage.indexOf('"content"');
                const contentEndIndex = fullMessage.indexOf('"status"');
                const content = fullMessage.substring(contentStartIndex, contentEndIndex);
                // console.log('content', content);
                const partsStartIndex = content.indexOf('"parts":');
                const partsEndIndex = content.indexOf(']}');
                const partsArray = content.substring(partsStartIndex, partsEndIndex);
                // console.log('partsArray', partsArray);
                const result = partsArray.replace(/\\"/g, '"').replace(/\\n/g, '\n');
                fullMessage = result;
              }
              console.log('fullMessage', '\n'+fullMessage);
              resolve(fullMessage);
            }).on('error', reject);
          });
        } catch (error) {
          console.error('Request Error: check keys and cookies');
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

      // async function extractGPT() {
      //   let python_output = await runPythonScript (
      //     process.env.Collaborative_Prompt1+'\n\n'+input
      //   );

      //   console.log('python_output:'+'\n\n'+python_output);
      //   return python_output.toString();
      // }
      

      // Call ChatGPT and parse the data
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


      //send it to trading platform


      const alpacaConfig = await setAlpaca(UserID);
      console.log("config key done");

      const alpacaApi = new Alpaca(alpacaConfig);
      console.log("connected to alpaca");


      let orderPromises = parsedJson.map(asset => {
        let symbol = asset['Asset ticker'].substring(0, 3)
        let qty = asset['Quantity']
      
        if (qty > 0) {
          return retry(() => {
            return alpacaApi.createOrder({
              symbol: symbol,
              qty: qty,
              side: 'buy',
              type: 'market',
              time_in_force: 'gtc'
            }).then((response) => {
              console.log(`Order of ${qty} shares for ${symbol} has been placed.`)
              return { qty: qty, symbol: symbol };
            });
          }).catch((error) => {
            console.error(`Failed to place order for ${symbol}: ${error}`)
            return null; 
          })
        } else {
          console.log(`Quantity for ${symbol} is ${qty}. Order not placed.`);
          return null;
        }
      })

      Promise.all(orderPromises).then(orders => {
        // Filter out any null values
        orders = orders.filter(order => order !== null);
        //add to DB
        // this.addPortfolio(strategy, strategyName, orders, UserID);
        // Once all orders have been processed, send the response
        return res.status(200).json({
          status: "success",
          orders: orders, 
        });
      }).catch(error => {
        console.error(`Error: ${error}`);
        return res.status(200).json({
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

exports.addPortfolio = async (strategyinput, strategyName, orders, UserID) => {
  console.log('strategyName', strategyName);
  console.log('orders', orders);
  console.log('UserID', UserID);
  try {
    // Get the number of different orders placed by the strategy
    const numberOfOrders = orders.length;
    console.log('numberOfOrders', numberOfOrders);

    // Call the Alpaca API to get the last X orders filled
    const alpacaConfig = await setAlpaca(UserID);
    const apiUrl = alpacaConfig.apiURL;
    const ordersResponse = await axios.get(`${apiUrl}/v2/orders`, {
      headers: {
        'APCA-API-KEY-ID': alpacaConfig.keyId,
        'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
      },
      params: {
        limit: numberOfOrders,
      },
    });

    // Check if all orders are filled
    const lastOrders = ordersResponse.data.slice(-numberOfOrders);
    console.log('lastOrders', lastOrders);

    const orderSymbols = orders.map(order => order.symbol);
    console.log('orderSymbols:', orderSymbols);

    const checkOrders = () => {
      for (const order of lastOrders) {
        if (order.status !== 'closed' || !orderSymbols.includes(order.symbol)) {
          throw new Error("order not filled yet or symbol not found");
        }
      }
    };

    // Retry the checkOrders function 3 times if it throws an error
    await retry(checkOrders, 3);

    // Create an object to store orders by symbol
    const ordersBySymbol = {};

    ordersResponse.data.forEach((order) => {
      if (order.side === 'buy' && !ordersBySymbol[order.symbol]) {
        ordersBySymbol[order.symbol] = order;
      }
    });

    console.log('ordersBySymbol:', ordersBySymbol);

    // Create a new strategy
    const strategy = new Strategy({
      name: strategyName,
      strategy: strategyinput, // Convert the strategy object to a string
    });

    // Save the strategy
    await strategy.save();

    // Create a new portfolio
    const portfolio = new Portfolio({
      name: strategyName,
      strategy: strategy._id,
      stocks: Object.values(ordersBySymbol).map(order => ({
        symbol: order.symbol,
        avgCost: order.filled_avg_price,
        quantity: order.filled_qty,
      })),
    });

    // Save the portfolio
    await portfolio.save();

    console.log(`Portfolio for strategy ${strategyName} has been created.`);
  } catch (error) {
    console.error(`Error: ${error}`);
  }
}
