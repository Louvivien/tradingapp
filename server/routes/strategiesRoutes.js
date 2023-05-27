const express = require("express");
const router = express.Router();
const auth = require("../controllers/authMiddleware");
const { createCollaborative, getPortfolios, deleteCollaborative, testPython} = require("../controllers/strategiesController");


router.route("/collaborative/").post(auth, createCollaborative);
router.route("/portfolios/:userId").get(auth, getPortfolios);
router.route("/delete/:userId/:strategyId").delete(auth, deleteCollaborative);
router.route("/testpython/:userId").post(auth, testPython);








module.exports = router;
