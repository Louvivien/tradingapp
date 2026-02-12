const express = require("express");
const router = express.Router();
const auth = require("../controllers/authMiddleware");
const {
  createCollaborative,
  getPortfolios,
  deleteCollaborative,
  getNewsHeadlines,
  getScoreHeadlines,
  enableAIFund,
  disableAIFund,
  getStrategies,
  getStrategyTemplates,
  getStrategyLogs,
  getAllStrategyLogs,
  getStrategyEquityHistory,
  getEquityBackfillStatus,
  triggerEquityBackfill,
  updateStrategyRecurrence,
  updateStrategyCashLimit,
  updateStrategyMetadata,
  streamStrategyProgress,
  resendCollaborativeOrders,
  updateNextRebalanceDate,
  updateComposerHoldings,
  getComposerHoldings,
  compareComposerHoldings,
  compareComposerHoldingsAll,
  diagnoseAllocationMismatch,
  rebalanceNow,
  createPolymarketCopyTrader,
  getPolymarketBalanceAllowance,
} = require("../controllers/strategiesController");


router.route("/collaborative/").post(auth, createCollaborative);
router.route("/portfolios/:userId").get(auth, getPortfolios);
router.route("/delete/:userId/:strategyId").delete(auth, deleteCollaborative);
router.route("/resend/:userId/:strategyId").post(auth, resendCollaborativeOrders);
router.route("/news/:userId").post(auth, getNewsHeadlines);
router.route("/score/:userId").get(auth, getScoreHeadlines);
router.route("/aifund/").post(auth, createCollaborative);
router.route("/aifund/enable").post(auth, enableAIFund);
router.route("/aifund/disable").post(auth, disableAIFund);
router.route("/polymarket/").post(auth, createPolymarketCopyTrader);
router.route("/polymarket/balance/:userId").get(auth, getPolymarketBalanceAllowance);
router.route("/all/:userId").get(auth, getStrategies);
router.route("/templates/:userId").get(auth, getStrategyTemplates);
router.route("/logs/all/:userId").get(auth, getAllStrategyLogs);
router.route("/logs/:userId/:strategyId").get(auth, getStrategyLogs);
router.route("/equity/:userId/:strategyId").get(auth, getStrategyEquityHistory);
router.route("/equity/backfill-status/:userId").get(auth, getEquityBackfillStatus);
router.route("/equity/backfill/:userId").post(auth, triggerEquityBackfill);
router.route("/recurrence/:userId/:strategyId").patch(auth, updateStrategyRecurrence);
router.route("/cash-limit/:userId/:strategyId").patch(auth, updateStrategyCashLimit);
router.route("/metadata/:userId/:strategyId").patch(auth, updateStrategyMetadata);
router.route("/rebalance-date/:userId/:strategyId").patch(auth, updateNextRebalanceDate);
// NOTE: place more-specific routes before parameterized catch-alls like `:userId/:strategyId`.
router.route("/composer-holdings/compare-all/:userId").get(auth, compareComposerHoldingsAll);
router.route("/composer-holdings/compare/:userId/:strategyId").get(auth, compareComposerHoldings);
router.route("/composer-holdings/:userId/:strategyId").get(auth, getComposerHoldings).patch(auth, updateComposerHoldings);
router.route("/diagnose/:userId/:strategyId").get(auth, diagnoseAllocationMismatch);
router.route("/rebalance-now/:userId/:strategyId").post(auth, rebalanceNow);
router.route("/progress/:jobId").get(streamStrategyProgress);











module.exports = router;
