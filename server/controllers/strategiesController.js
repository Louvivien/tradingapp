const User = require("../models/userModel");
const Stock = require("../models/stockModel");
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



exports.createCollaborative = async (req, res) => {
  return new Promise(async (resolve, reject) => {
    try {

      // console.log('req.body', req.body);
      let input = req.body.collaborative;
      let UserID = req.body.UserID;

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
              if (doneIndex !== -1 && doneIndex > 0) {
                let dataLine = lines[doneIndex - 2];
                let dataObj = JSON.parse(dataLine.replace('data: ', ''));
                fullMessage = dataObj.message.content.parts[0];
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
