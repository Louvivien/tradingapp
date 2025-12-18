const Axios = require("axios");
const { getAlpacaConfig } = require("../config/alpacaConfig");
const { computeWorkflowIndicators } = require('../services/indicatorService');
const { runComposerStrategy } = require("../utils/openaiComposerStrategy");
const { getCachedPrices } = require('../services/priceCacheService');
const { evaluateDefsymphonyStrategy } = require('../services/defsymphonyEvaluator');
const {
  runTrackedEvaluation,
  listActiveEvaluations,
  summarizeStrategy,
} = require('../services/evaluationTrackingService');

exports.getStockMetaData = async (req, res) => {
  try {
    const url = `https://api.tiingo.com/tiingo/daily/${req.params.ticker}?token=${process.env.TIINGO_API_KEY2}`;

    const response = await Axios.get(url);
    return res.status(200).json({
      status: "success",
      data: response.data,
    });
  } catch (error) {
    return res.status(200).json({
      status: "fail",
    });
  }
};



// Does not work since Yahoo Finance API is no longer available
      // exports.getStockInfo = async (req, res) => {
      //   const { ticker } = req.params;
      //   const apiUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=summaryDetail%2CsummaryProfile%2CdefaultKeyStatistics%2CassetProfile%2Cprice`;

      //   try {
      //     const response = await Axios.get(apiUrl);
      //     const data = response.data.quoteSummary.result[0];

      //     const stockInfo = {
      //       description: data.assetProfile.longBusinessSummary || "N/A",
      //       name: data.price.longName || "N/A",
      //       exchangeCode: data.price.exchangeName || "N/A",
      //       startDate: data.assetProfile.startDate || "N/A",
      //       endDate: "N/A",
      //       ticker: ticker
      //     };

      //     return res.status(200).json({
      //       status: "success",
      //       data: stockInfo
      //     });
      //   } catch (error) {
      //     console.error(error);
      //     return res.status(500).json({
      //       status: "error",
      //       message: "Failed to retrieve stock information"
      //     });
      //   }
      // };


exports.getStockInfo = async (req, res) => {
  const { ticker } = req.params;
  const apiUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`;

  try {
    const response = await Axios.get(apiUrl);
    const result = response.data.chart.result[0];
    const meta = result.meta;

    const stockInfo = {
      description: "N/A",
      name: meta.symbol || "N/A",
      exchangeCode: meta.exchangeName || "N/A",
      startDate: new Date(meta.firstTradeDate * 1000).toISOString().split('T')[0] || "N/A",
      endDate: "N/A",
      ticker: ticker,
      currency: meta.currency || "N/A",
      instrumentType: meta.instrumentType || "N/A",
      regularMarketPrice: meta.regularMarketPrice || "N/A",
      previousClose: meta.previousClose || "N/A",
      timezone: meta.timezone || "N/A",
      exchangeTimezoneName: meta.exchangeTimezoneName || "N/A"
    };

    return res.status(200).json({
      status: "success",
      data: stockInfo
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      status: "error",
      message: "Failed to retrieve stock information"
    });
  }
};


// Data needed: average for each of the last 6 months + latest daily data + last month of data points + last 2 years of data points, sampled weekly
exports.getStockHistoricData = async (req, res) => {
  try {
    const userId = req.params.userId;
    const alpacaConfig = await getAlpacaConfig(userId, 'live');

    // Get the last price for the stock using the Alpaca API
    const alpacaUrl = `https://data.alpaca.markets/v2/stocks/${req.params.ticker}/quotes/latest`;
    const alpacaResponse = await Axios.get(alpacaUrl, {
      headers: {
        'APCA-API-KEY-ID': alpacaConfig.keyId,
        'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
      },
    });
    const lastPrice = alpacaResponse.data.quote.ap;

    // Get the historical stock data for the given ticker from the Tiingo API
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 2);
    const year = startDate.getFullYear();
    const month = startDate.getMonth() + 1;
    const day = startDate.getDate();

    const url = `https://api.tiingo.com/tiingo/daily/${req.params.ticker}/prices?startDate=${year}-${month}-${day}&token=${process.env.TIINGO_API_KEY1}`;

    const response = await Axios.get(url);
    const data = response.data;
    
    // Last month
    const pastMonth = [];

    for (let i = 0; i < 25; i++) {
      pastMonth.push({
        date: data[data.length - 1 - i].date,
        adjClose: data[data.length - 1 - i].adjClose,
      });
    }

    // Average of last 6 months:
    const sixMonthAverages = [];
    let latestMonth = new Date(data[data.length - 1].date).getMonth();
    let index = data.length - 1;

    for (let i = 0; i < 6; i++) {
      let monthAverage = data[index].adjClose;
      let dataPoints = 1;
      index -= 1;
      while (new Date(data[index].date).getMonth() === latestMonth) {
        monthAverage += data[index].adjClose;
        dataPoints += 1;
        index -= 1;
      }

      sixMonthAverages.push({
        value:
          Math.round((monthAverage / dataPoints + Number.EPSILON) * 100) / 100,
        month: latestMonth,
      });
      latestMonth = new Date(data[index].date).getMonth();
    }

    // Past 2 years
    const pastTwoYears = [];
    for (let i = data.length - 1; i >= 0; i -= 5) {
      pastTwoYears.push({
        date: data[i].date,
        adjClose: Math.round((data[i].adjClose + Number.EPSILON) * 100) / 100,
      });
    }

    sixMonthAverages.reverse();
    pastMonth.reverse();
    pastTwoYears.reverse();

    // Return response
    return res.status(200).json({
      status: "success",
      pastDay: {
        date: data[data.length - 1].date,
        adjClose: data[data.length - 1].adjClose,
        adjOpen: data[data.length - 1].adjOpen,
        adjHigh: data[data.length - 1].adjHigh,
        adjLow: data[data.length - 1].adjLow,
      },
      pastMonth,
      pastTwoYears,
      sixMonthAverages,
      today: {
        lastPrice: lastPrice,
      },
    });
  } catch (error) {
    console.log(error);
    return res.status(200).json({
      status: "fail",
    });
  }
};

const getRandomTicker = () => {
  const randomIndex = Math.floor(
    Math.random() * Math.floor(data.stockData.length)
  );
  return {
    ticker: data.stockData[randomIndex].ticker,
    name: data.stockData[randomIndex].name,
  };
};

exports.getWorkflowIndicators = async (req, res) => {
  try {
    const { ticker } = req.params;
    if (!ticker) {
      return res.status(400).json({
        status: "fail",
        message: "Ticker is required.",
      });
    }

    const upperTicker = String(ticker).trim().toUpperCase();

    const output = await computeWorkflowIndicators(upperTicker);

    const result = {
      symbol: output.symbol || upperTicker,
      ma10_return: output.ma10_return ?? null,
      stdev63_return: output.stdev63_return ?? null,
      ma100_close: output.ma100_close ?? null,
      data_source: output.data_source || null,
    };

    return res.status(200).json({
      status: "success",
      data: result,
      raw: output,
    });
  } catch (error) {
    console.error('[WorkflowIndicators]', error);
    return res.status(500).json({
      status: "fail",
      message: error.message || "Failed to compute indicators via workflow.",
    });
  }
};

exports.evaluateComposerStrategy = async (req, res) => {
  try {
    const { strategyText, budget } = req.body || {};
    if (!strategyText || typeof strategyText !== 'string' || !strategyText.trim()) {
      return res.status(400).json({
        status: 'fail',
        message: 'strategyText (Composer defsymphony script) is required.',
      });
    }

    const parsedBudget = Number.isFinite(Number(budget)) && Number(budget) > 0 ? Number(budget) : 1000;

    const composerResult = await runComposerStrategy({
      strategyText,
      budget: parsedBudget,
    });

    if (!composerResult || !Array.isArray(composerResult.positions) || !composerResult.positions.length) {
      return res.status(502).json({
        status: 'fail',
        message: 'Composer evaluation returned no positions.',
        raw: composerResult,
      });
    }

    return res.status(200).json({
      status: 'success',
      data: composerResult,
    });
  } catch (error) {
    console.error('[ComposerStrategy]', error);
    return res.status(500).json({
      status: 'fail',
      message: error.message || 'Composer evaluation failed.',
    });
  }
};

exports.evaluateComposerStrategyLocal = async (req, res) => {
  try {
    const { strategyText, budget, clientRequestId } = req.body || {};
    if (!strategyText || typeof strategyText !== 'string' || !strategyText.trim()) {
      return res.status(400).json({
        status: 'fail',
        message: 'strategyText (Composer defsymphony script) is required.',
      });
    }

    const parsedBudget = Number.isFinite(Number(budget)) && Number(budget) > 0 ? Number(budget) : 1000;
    const summary = summarizeStrategy(strategyText);
    const mode = summary.hasGroup ? 'historical-simulation' : 'direct';
    const requester = (req.user && (req.user.id || req.user._id)) || req.ip || 'anonymous';

    const { id: jobId, job, result } = await runTrackedEvaluation({
      metadata: {
        requester,
        mode,
        strategyName: summary.name,
        hasGroup: summary.hasGroup,
        budget: parsedBudget,
        clientRequestId: clientRequestId || null,
      },
      handler: () =>
        evaluateDefsymphonyStrategy({
          strategyText,
          budget: parsedBudget,
        }),
    });

    return res.status(200).json({
      status: 'success',
      data: result,
      job: {
        id: jobId,
        status: job?.status || 'completed',
        mode,
        hasGroup: summary.hasGroup,
        submittedAt: job?.submittedAt?.toISOString?.() || job?.submittedAt || null,
        clientRequestId: clientRequestId || null,
      },
    });
  } catch (error) {
    console.error('[ComposerLocal]', error);
    return res.status(500).json({
      status: 'fail',
      message: error.message || 'Local Composer evaluation failed.',
    });
  }
};

exports.listComposerEvaluations = (req, res) => {
  try {
    const evaluations = listActiveEvaluations().map((entry) => ({
      ...entry,
      submittedAt: entry.submittedAt?.toISOString?.() || entry.submittedAt || null,
      startedAt: entry.startedAt?.toISOString?.() || entry.startedAt || null,
      completedAt: entry.completedAt?.toISOString?.() || entry.completedAt || null,
      lastUpdatedAt: entry.lastUpdatedAt?.toISOString?.() || entry.lastUpdatedAt || null,
    }));
    return res.status(200).json({
      status: 'success',
      data: evaluations,
    });
  } catch (error) {
    console.error('[ComposerEvaluations]', error);
    return res.status(500).json({
      status: 'fail',
      message: error.message || 'Unable to list evaluations.',
    });
  }
};

exports.getCachedHistoricalPrices = async (req, res) => {
  try {
    const { symbol } = req.params;
    if (!symbol) {
      return res.status(400).json({
        status: "fail",
        message: "Symbol is required.",
      });
    }

    const { start, end } = req.query || {};
    const result = await getCachedPrices({
      symbol,
      startDate: start,
      endDate: end,
    });

    return res.status(200).json({
      status: "success",
      data: result,
    });
  } catch (error) {
    console.error('[PriceCache]', error.message);
    return res.status(500).json({
      status: "fail",
      message: error.message || 'Failed to fetch historical prices.',
    });
  }
};

exports.getRandomStockData = async (req, res) => {
  try {
    const stock = getRandomTicker();

    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 3);
    const year = startDate.getFullYear();
    const month = startDate.getMonth() + 1;
    const day = startDate.getDate();

    const url = `https://api.tiingo.com/tiingo/daily/${stock.ticker}/prices?startDate=${year}-${month}-${day}&token=${process.env.TIINGO_API_KEY}`;

    const response = await Axios.get(url);
    
    const data = [];
    for (let i = response.data.length - 1; i >= 0; i -= 5) {
      data.push({
        date: response.data[i].date,
        adjClose:
          Math.round((response.data[i].adjClose + Number.EPSILON) * 100) / 100,
      });
    }

    data.reverse();

    return res.status(200).json({
      status: "success",
      ticker: stock.ticker,
      name: stock.name,
      data,
    });
  } catch (error) {
    return res.status(200).json({
      status: "fail",
    });
  }
};

exports.getPortfolioData = async (req, res) => {
  const userId = req.params.userId;

  if (req.user !== userId) {
    return res.status(401).json({
      status: 'fail',
      message: 'Unauthorized access',
    });
  }

  try {
    const alpacaConfig = await getAlpacaConfig(userId, 'live');
    
    if (!alpacaConfig.hasValidKeys) {
      return res.status(403).json({
        status: 'fail',
        message: alpacaConfig.error || 'Invalid API keys. Please check your Alpaca account settings.',
      });
    }

    const tradingKeys = alpacaConfig.getTradingKeys();
    const response = await tradingKeys.client.get(`${tradingKeys.apiUrl}/v2/account/portfolio/history?period=12M`, {
      headers: {
        'APCA-API-KEY-ID': tradingKeys.keyId,
        'APCA-API-SECRET-KEY': tradingKeys.secretKey,
      }
    });

    return res.status(200).json({
      status: 'success',
      portfolio: response.data,
    });
  } catch (error) {
    console.error('Error fetching portfolio data:', error.message);
    if (error.response) {
      console.error('API Response:', error.response.status, error.response.data);
    }
    
    return res.status(error.response?.status || 500).json({
      status: 'fail',
      message: error.response?.data?.message || 'Error fetching portfolio history',
    });
  }
};
