const express = require("express");
const router = express.Router();
const auth = require("../controllers/authMiddleware");
const { purchaseStock, sellStock, getStockForUser, editAccount } = require("../controllers/stockController");

router.route("/").post(auth, purchaseStock);
router.route("/").patch(auth, sellStock)
router.route("/:userId").get(auth, getStockForUser);
router.route("/:userId").post(auth, editAccount);

module.exports = router;
