const express = require("express");
const router = express.Router();
const auth = require("../controllers/authMiddleware");
const { createCollaborative, getPortfolios, deleteCollaborative} = require("../controllers/strategiesController");


router.route("/collaborative/").post(auth, createCollaborative);
router.route("/portfolios/:userId").get(auth, getPortfolios);
router.route("/delete/:userId/:strategyId").delete(auth, deleteCollaborative);










module.exports = router;
