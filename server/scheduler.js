// scheduler.js

const cron = require('node-cron');
const { spawn } = require('child_process');
const mongoose = require('mongoose');
const { runDueRebalances } = require('./services/rebalanceService');

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

function schedulePortfolioRebalances() {
  cron.schedule('* * * * *', async () => {
    try {
      if (mongoose.connection.readyState !== 1) {
        console.warn('[Scheduler] MongoDB not connected; skipping rebalance check.');
        return;
      }
      console.log('[Scheduler] Checking for portfolios due for rebalancing...');
      await runDueRebalances();
    } catch (error) {
      console.error('[Scheduler] Portfolio rebalance check failed:', error.message);
    }
  });
}

module.exports = {
  scheduleNewsFromStocksList,
  scheduleSentimentVertex,
  schedulePortfolioRebalances,
};
