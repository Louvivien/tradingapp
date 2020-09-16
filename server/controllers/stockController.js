const Axios = require("axios");
const data = require("../config/stocksData");

exports.getStockMetaData = async (req, res) => {
  try {
    const url = `https://api.tiingo.com/tiingo/daily/${req.params.ticker}?token=${process.env.TIINGO_API_KEY}`;

    const response = await Axios.get(url);
    return res.status(200).json({
      status: "success",
      data: response.data,
    });
  } catch (error) {
    console.log(error);
    return res.status(200).json({
      status: "fail",
    });
  }
};

exports.getStockInfo = (req, res) => {
  let info;
  data.stockData.forEach((stock) => {
    if (stock.ticker.toLowerCase() === req.params.ticker.toLowerCase()) {
      info = stock;
    }
  });

  if (info) {
    return res.status(200).json({
      status: "success",
      data: info,
    });
  } else {
    return res.status(200).json({
      status: "fail",
    });
  }
};

exports.getStockHistoricData = async (req, res) => {
  try {
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 2);
    const year = startDate.getFullYear();
    const month = startDate.getMonth();
    const day = startDate.getDate();
    console.log(year, month, day, startDate.toDateString());
    const url = `https://api.tiingo.com/tiingo/daily/${req.params.ticker}/prices?startDate=${year}-${month}-${day}&token=${process.env.TIINGO_API_KEY}&resampleFreq=weekly`;
    console.log(url);
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
