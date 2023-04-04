const Axios = require("axios");
const data = require("../config/stocksData");
const setAlpaca = require('../config/alpaca');

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


exports.getStockInfo = async (req, res) => {
  const { ticker } = req.params;
  const apiUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=summaryDetail%2CsummaryProfile%2CdefaultKeyStatistics%2CassetProfile%2Cprice`;

  try {
    const response = await Axios.get(apiUrl);
    const data = response.data.quoteSummary.result[0];

    const stockInfo = {
      description: data.assetProfile.longBusinessSummary || "N/A",
      name: data.price.longName || "N/A",
      exchangeCode: data.price.exchangeName || "N/A",
      startDate: data.assetProfile.startDate || "N/A",
      endDate: "N/A",
      ticker: ticker
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

    // Get the last price for the stock using the Alpaca API
    const alpacaUrl = `https://data.alpaca.markets/v2/stocks/${req.params.ticker}/quotes/latest`;
    const alpacaResponse = await Axios.get(alpacaUrl, {
      headers: {
        'APCA-API-KEY-ID': process.env.ALPACA_API_KEY_ID,
        'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET_KEY,
      },
    });
    const lastPrice = alpacaResponse.data.quote.ap;


    // Get the historical stock data for the given ticker from the Tiingo API
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 2);
    const year = startDate.getFullYear();
    const month = startDate.getMonth() + 1;
    const day = startDate.getDate();

    const url = `https://api.tiingo.com/tiingo/daily/${req.params.ticker}/prices?startDate=${year}-${month}-${day}&token=${process.env.TIINGO_API_KEY2}`;

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

  const alpacaConfig = await setAlpaca(userId);
  const alpacaApi = Axios.create({
    headers: {
      'APCA-API-KEY-ID': alpacaConfig.keyId,
      'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
    },
  });

  try {
    const response = await alpacaApi.get('https://paper-api.alpaca.markets/v2/account/portfolio/history?period=12M');


    return res.status(200).json({
      status: 'success',
      data: response.data,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      status: 'fail',
      message: 'Error fetching portfolio history',
    });
  }
};