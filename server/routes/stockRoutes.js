const express = require("express");
const router = express.Router();
const { getNewsData } = require("../controllers/newsController");
const {
  getStockInfo,
  getStockHistoricData,
} = require("../controllers/stockController");

router.route("/news").get(getNewsData);
router.route("/stock/:ticker").get(getStockInfo);
router.route("/stock/:ticker/data").get(getStockHistoricData);

module.exports = router;
