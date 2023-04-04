const express = require("express");
const router = express.Router();
const auth = require("../controllers/authMiddleware");
const { purchaseStock, sellStock, getStockForUser, editAccount, getMarketStatus, searchStocks } = require("../controllers/stockController");

router.route("/").post(auth, purchaseStock);
router.route("/").patch(auth, sellStock)
router.route("/market-status/:userId").get(auth, getMarketStatus);
router.route("/search/:userId/:value").get(auth, searchStocks);
router.route("/:userId").get(auth, getStockForUser);
router.route("/:userId").post(auth, editAccount);


module.exports = router;
