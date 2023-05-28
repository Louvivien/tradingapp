
// This code calls the python script chatgpt.py and passes the prompt and the user input to it.


const { spawn } = require('child_process');

// Call a Python script
const runPythonScript = async (input) => {
  return new Promise((resolve, reject) => {
    let prompt = input;

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
      resolve(python_output);
    });
  });
}

const extractGPT = async (input) => {
  let python_output = await runPythonScript (
    process.env.Collaborative_Prompt1+'\n\n'+input
  );

  console.log('python_output:'+'\n\n'+python_output);
  return python_output.toString();
}

module.exports = extractGPT;


// You can use this module in another file by requiring it:


// const extractGPT = require('../utils/ChatGPTbrowserautomation');

// // Use the function
// let output = await extractGPT(input);



