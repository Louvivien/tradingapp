const express = require("express");
const router = express.Router();
const auth = require("../controllers/authMiddleware");
const {
  getStockInfo,
  getStockHistoricData,
  getRandomStockData,
  getPortfolioData,
  getWorkflowIndicators,
  evaluateComposerStrategy,
} = require("../controllers/dataController");

router.route("/prices/:ticker").get(getStockInfo);
router.route("/prices/:ticker/full").get(getStockHistoricData);
router.route("/random").get(getRandomStockData);
router.route("/portfolio/:userId").get(auth, getPortfolioData);
router.route("/analytics/:ticker").get(getWorkflowIndicators);
router.route("/composer/evaluate").post(evaluateComposerStrategy);

console.log('[Routes] Data routes registered:', router.stack.map((layer) => layer.route?.path).filter(Boolean));

module.exports = router;
