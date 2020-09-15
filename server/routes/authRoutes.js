const express = require("express");
const router = express.Router();
const auth = require("../controllers/authMiddleware");
const {
  registerUser,
  loginUser,
  validate,
} = require("../controllers/authController");
const { getUser } = require("../controllers/userController");

router.route("/register").post(registerUser);
router.route("/login").post(loginUser);
router.post("/validate", validate);

router.get("/user", auth, getUser);

module.exports = router;
