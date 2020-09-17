const express = require("express");
const router = express.Router();
const {
  getStockInfo,
  getStockHistoricData,
} = require("../controllers/dataController");

router.route("/:ticker").get(getStockInfo);
router.route("/:ticker/full").get(getStockHistoricData);

module.exports = router;
