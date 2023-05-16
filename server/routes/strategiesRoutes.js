const express = require("express");
const router = express.Router();
const auth = require("../controllers/authMiddleware");
const { createComposer} = require("../controllers/strategiesController");


router.route("/collaborative/").post(auth, createComposer);

// router.route("/").post(auth, purchaseStock);
// router.route("/").patch(auth, sellStock)
// router.route("/market-status/:userId").get(auth, getMarketStatus);
// router.route("/search/:userId/:value").get(auth, searchStocks);
// router.route("/:userId").get(auth, getStockForUser);
// router.route("/:userId").post(auth, editAccount);




module.exports = router;
