const express = require("express");
const router = express.Router();
const {
  getStockInfo,
  getStockHistoricData,
  getRandomStockData,
} = require("../controllers/dataController");

router.route("/prices/:ticker").get(getStockInfo);
router.route("/prices/:ticker/full").get(getStockHistoricData);
router.route("/random").get(getRandomStockData);

module.exports = router;
