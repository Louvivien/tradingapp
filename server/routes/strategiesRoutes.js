const express = require("express");
const router = express.Router();
const auth = require("../controllers/authMiddleware");
const { createCollaborative, getPortfolios, deleteCollaborative, getNewsHeadlines, getScoreHeadlines} = require("../controllers/strategiesController");


router.route("/collaborative/").post(auth, createCollaborative);
router.route("/portfolios/:userId").get(auth, getPortfolios);
router.route("/delete/:userId/:strategyId").delete(auth, deleteCollaborative);
router.route("/news/:userId").post(auth, getNewsHeadlines);
router.route("/score/:userId").get(auth, getScoreHeadlines);








module.exports = router;
