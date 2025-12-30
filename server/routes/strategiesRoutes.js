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
  getStrategyEquityHistory,
  getEquityBackfillStatus,
  triggerEquityBackfill,
  updateStrategyRecurrence,
  updateStrategyMetadata,
  streamStrategyProgress,
  resendCollaborativeOrders,
  updateNextRebalanceDate,
  updateComposerHoldings,
  getComposerHoldings,
  compareComposerHoldings,
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
router.route("/all/:userId").get(auth, getStrategies);
router.route("/templates/:userId").get(auth, getStrategyTemplates);
router.route("/logs/:userId/:strategyId").get(auth, getStrategyLogs);
router.route("/equity/:userId/:strategyId").get(auth, getStrategyEquityHistory);
router.route("/equity/backfill-status/:userId").get(auth, getEquityBackfillStatus);
router.route("/equity/backfill/:userId").post(auth, triggerEquityBackfill);
router.route("/recurrence/:userId/:strategyId").patch(auth, updateStrategyRecurrence);
router.route("/metadata/:userId/:strategyId").patch(auth, updateStrategyMetadata);
router.route("/rebalance-date/:userId/:strategyId").patch(auth, updateNextRebalanceDate);
router.route("/composer-holdings/:userId/:strategyId").get(auth, getComposerHoldings).patch(auth, updateComposerHoldings);
router.route("/composer-holdings/compare/:userId/:strategyId").get(auth, compareComposerHoldings);
router.route("/progress/:jobId").get(streamStrategyProgress);











module.exports = router;
