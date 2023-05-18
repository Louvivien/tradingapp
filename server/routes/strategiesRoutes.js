const express = require("express");
const router = express.Router();
const auth = require("../controllers/authMiddleware");
const { createCollaborative} = require("../controllers/strategiesController");


router.route("/collaborative/").post(auth, createCollaborative);




module.exports = router;
