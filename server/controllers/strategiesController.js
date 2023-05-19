const User = require("../models/userModel");
const Stock = require("../models/stockModel");
const setAlpaca = require('../config/alpaca');
const data = require("../config/stocksData");
const Alpaca = require('@alpacahq/alpaca-trade-api');
const Axios = require("axios");
const moment = require('moment');
const { spawn } = require('child_process');



// // Mock the Alpaca client when market is closed:
// const Mock = require('jest-mock');
// const Alpaca = Mock.fn(() => ({
//   getClock: Mock.fn(() => Promise.resolve({ is_open: true, next_open: '2023-05-14T13:30:00Z' })),
//   createOrder: Mock.fn(({ symbol, qty, side, type, time_in_force }, { price = 999 } = {}) => {
//     return Promise.resolve({ id: 'mock_order_id', status: 'accepted', price });
//   }),  
//   getPositions: Mock.fn(() => Promise.resolve([])),
// }));





async function runPythonScript(input) {
  return new Promise((resolve, reject) => {
    let prompt = input;
    // console.log('prompt', prompt);

    let login = process.env.OPENAI_API_LOGIN;
    let password = process.env.OPENAI_API_PASSWORD;
    
    let python_process = spawn('python3', ['scripts/chatgpt.py', prompt, login, password]);
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
      console.log(`Script output: ${python_output}`);
      resolve(python_output);
    });
  });
}



exports.createCollaborative = async (req, res) => {
  return new Promise(async (resolve, reject) => {
    try {

      // console.log('req.body', req.body);
      let input = req.body.collaborative;
      let UserID = req.body.UserID;

      if (/Below is a trading[\s\S]*strategy does\?/.test(input)) {
        input = input.replace(/Below is a trading[\s\S]*strategy does\?/, "");
      }
      async function extractGPT() {
        let python_output = await runPythonScript (
          process.env.Collaborative_Prompt1+'\n\n'+input
        );
        // console.log('python_output', python_output);
        return python_output.toString();
      }
      
      //extract json
      let parsedJson = await extractGPT().then(python_output => { 
        let jsonStart = python_output.indexOf('[');
        let jsonEnd = python_output.lastIndexOf(']') + 1;
        let json1 = python_output.slice(jsonStart, jsonEnd);
      
        //clean json
        function fixUnfinishedJson(json1) {
          if (json1.trim() === '') {
            console.error('JSON string is empty');
            return null;
          }
          try {
            JSON.parse(json1);
            console.log('JSON is OK');
            return json1;
          } catch (e) {
            console.error('Error parsing JSON:', e);
            // If the JSON is not properly formatted, add a closing bracket and try again
            if (json1[json1.length - 1] !== ']') {
              console.warn('JSON string does not end with a closing bracket. Adding a closing bracket and trying again.');
              json1 += ']';
              try {
                JSON.parse(json1);
                console.log('JSON is OK');
                return json1;
              } catch (e) {
                console.error('Error parsing JSON:', e);
                return null;
              }
            }
            return null;
          }
        }
      
        let fixedJson = fixUnfinishedJson(json1);
        if (fixedJson) {
          let parsedJson = JSON.parse(fixedJson);
          console.log('parsedJson', parsedJson);
          return parsedJson;
        }
      }).catch(error => {
        console.error('Error in extractGPT:', error);
        return [];
      });
      
      


      //send it to trading platform


      const alpacaConfig = await setAlpaca(UserID);
      console.log("config key done");

      const alpacaApi = new Alpaca(alpacaConfig);
      console.log("connected to alpaca");


      let orderPromises = parsedJson.map(asset => {
        let symbol = asset['Asset ticker']
        let qty = asset['Quantity']
        
        if (qty > 0) {
          return alpacaApi.createOrder({
            symbol: symbol,
            qty: qty,
            side: 'buy',
            type: 'market',
            time_in_force: 'gtc'
          }).then((response) => {
            console.log(`Order of ${qty} shares for ${symbol} has been placed.`)
            // Return the quantity and symbol for the order
            return { qty: qty, symbol: symbol };
          }).catch((error) => {
            console.error(`Failed to place order for ${symbol}: ${error}`)
          })
        } else {
          console.log(`Quantity for ${symbol} is ${qty}. Order not placed.`);
          return null;
        }
      })
      
      Promise.all(orderPromises).then(orders => {
        // Filter out any null values
        orders = orders.filter(order => order !== null);
        // Once all orders have been processed, send the response
        return res.status(200).json({
          status: "success",
          orders: orders, // This will return the array of orders
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
