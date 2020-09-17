const express = require("express");
const router = express.Router();
const { getNewsData } = require("../controllers/newsController");

router.route("/").get(getNewsData);

module.exports = router;
