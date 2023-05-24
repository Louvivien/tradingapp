const express = require("express");
const router = express.Router();
const auth = require("../controllers/authMiddleware");
const { createCollaborative, getPortfolios} = require("../controllers/strategiesController");


router.route("/collaborative/").post(auth, createCollaborative);
router.route("/portfolios").get(auth, getPortfolios);





module.exports = router;
