// scheduler.js

const cron = require('node-cron');
const { spawn } = require('child_process');

// Function to run the proxy machine
function startProxies(scriptPath) {
  console.log(`Starting Proxy Rotator ${scriptPath}...`);
  const python = spawn('python3', [scriptPath]);
  
  python.stdout.on('data', (data) => {
    console.log(`stdout: ${data}`);
  });
  
  python.stderr.on('data', (data) => {
    console.error(`stderr: ${data}`);
  });
  
  python.on('close', (code) => {
    console.log(`Python Script at ${scriptPath} finished with code ${code}`);
  });
}

// Schedule news_fromstockslist.py to run every day at 1:00 AM
function scheduleNewsFromStocksList() {
  cron.schedule('0 1 * * *', () => {
    console.log('Running news_fromstockslist.py...');
    const python = spawn('python3', ['./scripts//news_fromstockslist.py']);
    
    python.stdout.on('data', (data) => {
      console.log(`stdout: ${data}`);
    });
    
    python.stderr.on('data', (data) => {
      console.error(`stderr: ${data}`);
    });
    
    python.on('close', (code) => {
      console.log(`news_fromstockslist.py finished with code ${code}`);
    });
  });
}

// Schedule sentiment_vertex.py to run every day at 1:30 AM
function scheduleSentimentVertex() {
  cron.schedule('30 1 * * *', () => {
    console.log('Running sentiment_vertex.py...');
    const python = spawn('python3', ['./scripts/sentiment_vertex.py']);
    
    python.stdout.on('data', (data) => {
      console.log(`stdout: ${data}`);
    });
    
    python.stderr.on('data', (data) => {
      console.error(`stderr: ${data}`);
    });
    
    python.on('close', (code) => {
      console.log(`sentiment_vertex.py finished with code ${code}`);
    });
  });
}

module.exports = {
  startProxies,
  scheduleNewsFromStocksList,
  scheduleSentimentVertex
};
