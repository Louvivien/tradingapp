const axios = require("axios");
const { Transform } = require('stream');

const extractGPT = async (input) => {
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      this.push(chunk);
      callback();
    }
  });

  try {
    // console.log('prompt:', '\n'+process.env.Collaborative_Prompt1+'\n\n'+input);
    console.log('Sending request to ChatGPT...');

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

module.exports = extractGPT;



// You can use this module in another file by requiring it:


// const extractGPT = require("../utils/ChatGPTplugins");
// // Use the function
// let output = await extractGPT(input);


//Work to do: add the plugins as parameters to the function
//if you do this you need to update where the function is called in the code (strategiesController.js)
