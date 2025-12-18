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
  updateStrategyRecurrence,
  streamStrategyProgress,
  resendCollaborativeOrders,
  updateNextRebalanceDate,
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
router.route("/recurrence/:userId/:strategyId").patch(auth, updateStrategyRecurrence);
router.route("/rebalance-date/:userId/:strategyId").patch(auth, updateNextRebalanceDate);
router.route("/progress/:jobId").get(streamStrategyProgress);











module.exports = router;
