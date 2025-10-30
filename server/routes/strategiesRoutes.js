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
  getStrategyLogs,
  updateStrategyRecurrence,
} = require("../controllers/strategiesController");


router.route("/collaborative/").post(auth, createCollaborative);
router.route("/portfolios/:userId").get(auth, getPortfolios);
router.route("/delete/:userId/:strategyId").delete(auth, deleteCollaborative);
router.route("/news/:userId").post(auth, getNewsHeadlines);
router.route("/score/:userId").get(auth, getScoreHeadlines);
router.route("/aifund/").post(auth, createCollaborative);
router.route("/aifund/enable").post(auth, enableAIFund);
router.route("/aifund/disable").post(auth, disableAIFund);
router.route("/all/:userId").get(auth, getStrategies);
router.route("/logs/:userId/:strategyId").get(auth, getStrategyLogs);
router.route("/recurrence/:userId/:strategyId").patch(auth, updateStrategyRecurrence);











module.exports = router;
