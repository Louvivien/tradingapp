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
  getCachedHistoricalPrices,
  evaluateComposerStrategyLocal,
  backtestComposerStrategyLocal,
  listComposerEvaluations,
} = require("../controllers/dataController");

// Data routes use 3rd party APIs and can be expensive; require auth by default.
router.use(auth);

router.route("/prices/:ticker").get(getStockInfo);
router.route("/prices/:ticker/full").get(getStockHistoricData);
router.route("/random").get(getRandomStockData);
router.route("/portfolio/:userId").get(getPortfolioData);
router.route("/analytics/:ticker").get(getWorkflowIndicators);
router.route("/composer/evaluate").post(evaluateComposerStrategy);
router.route("/cache/prices/:symbol").get(getCachedHistoricalPrices);
router.route("/composer/evaluate-local").post(evaluateComposerStrategyLocal);
router.route("/composer/backtest-local").post(backtestComposerStrategyLocal);
router.route("/composer/evaluations").get(listComposerEvaluations);

console.log('[Routes] Data routes registered:', router.stack.map((layer) => layer.route?.path).filter(Boolean));

module.exports = router;
