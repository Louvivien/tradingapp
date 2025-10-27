const express = require("express");
const router = express.Router();
const auth = require("../controllers/authMiddleware");
const { purchaseStock, sellStock, getOrders, editAccount } = require("../controllers/orderController");

router.route("/").post(auth, purchaseStock);
router.route("/").patch(auth, sellStock);
router.route("/:userId").get(auth, getOrders);
router.route("/:userId").post(auth, editAccount);

module.exports = router;
