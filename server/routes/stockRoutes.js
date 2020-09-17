const express = require("express");
const router = express.Router();
const auth = require("../controllers/authMiddleware");
const { purchaseStock, getStock, resetAccount } = require("../controllers/stockController");

router.route("/").post(auth, purchaseStock);
router.route("/:userId").get(auth, getStock);
router.route("/:userId").delete(auth, resetAccount);

module.exports = router;
