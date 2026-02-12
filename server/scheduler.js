// scheduler.js

const cron = require('node-cron');
const { spawn } = require('child_process');
const mongoose = require('mongoose');
const { runDueRebalances } = require('./services/rebalanceService');
const { refreshPolymarketProxyPool } = require('./services/polymarketProxyPoolService');

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
  const defaultSchedule = '*/10 * * * * *'; // every 10 seconds
  const schedule = String(process.env.REBALANCE_SCHEDULER_CRON || '').trim() || defaultSchedule;
  console.log('[Scheduler] Portfolio rebalance schedule:', schedule);

  cron.schedule(schedule, async () => {
    try {
      if (mongoose.connection.readyState !== 1) {
        console.warn('[Scheduler] MongoDB not connected; skipping rebalance check.');
        return;
      }
      const result = await runDueRebalances();
      if (result?.skipped) {
        return;
      }
      if (result?.due > 0) {
        console.log('[Scheduler] Ran due portfolio rebalances:', {
          due: result.due,
          processed: result.processed,
          checkedAt: result.checkedAt,
        });
      }
    } catch (error) {
      console.error('[Scheduler] Portfolio rebalance check failed:', error.message);
    }
  });
}

function schedulePolymarketProxyPoolRefresh() {
  // Warm the pool once at startup (non-blocking).
  void refreshPolymarketProxyPool({ force: false, reason: 'startup' }).then((result) => {
    if (!result?.ok) {
      console.warn('[Scheduler] Polymarket proxy pool refresh failed:', result?.error || result?.reason);
      return;
    }
    if (!result?.skipped) {
      console.log('[Scheduler] Polymarket proxy pool refreshed:', {
        proxies: result?.proxies ?? null,
        refreshedAt: result?.refreshedAt ?? null,
      });
    }
  });

  cron.schedule('15 0 * * *', async () => {
    try {
      const result = await refreshPolymarketProxyPool({ force: true, reason: 'cron' });
      if (!result?.ok) {
        console.warn('[Scheduler] Polymarket proxy pool refresh failed:', result?.error || result?.reason);
      } else {
        console.log('[Scheduler] Polymarket proxy pool refreshed:', {
          proxies: result?.proxies ?? null,
          refreshedAt: result?.refreshedAt ?? null,
        });
      }
    } catch (error) {
      console.warn('[Scheduler] Polymarket proxy pool refresh threw unexpectedly:', error?.message || error);
    }
  });
}

module.exports = {
  scheduleNewsFromStocksList,
  scheduleSentimentVertex,
  schedulePortfolioRebalances,
  schedulePolymarketProxyPoolRefresh,
};
