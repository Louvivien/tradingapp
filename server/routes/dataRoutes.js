const express = require("express");
const router = express.Router();
const auth = require("../controllers/authMiddleware");
const {
  getStockInfo,
  getStockHistoricData,
  getRandomStockData,
  getPortfolioData,
} = require("../controllers/dataController");

router.route("/prices/:ticker").get(getStockInfo);
router.route("/prices/:ticker/full").get(getStockHistoricData);
router.route("/random").get(getRandomStockData);
router.route("/portfolio/:userId").get(auth, getPortfolioData);

module.exports = router;
