const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const userSchema = new Schema(
  {
    username: {
      type: String,
      required: [true, "Please provide a username"],
      unique: true,
      minlength: [4, "Username must be at least 4 characters"],
      maxlength: [30, "Username cannot be more than 30 characters"],
      trim: true,
    },
    name: {
      type: String,
      required: false,
      maxlength: [40, "Name cannot be more than 40 characters"],
      trim: true,
    },
    email: {
      type: String,
      required: false,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      match: [
        /^([\w-\.]+@([\w-]+\.)+[\w-]{2,4})?$/,
        "Please provide a valid email",
      ],
    },
    password: {
      type: String,
      required: [true, "Please provide a password"],
      minlength: [6, "Password cannot be less than 6 characters"],
      select: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    balance: {
      type: Number,
      required: true,
      default: 100000
    },
    // Paper trading API keys (for trading operations)
    ALPACA_API_KEY_ID: {
      type: String,
      required: false,
    },
    ALPACA_API_SECRET_KEY: {
      type: String,
      required: false,
    },
    // Live trading API keys (for market data)
    ALPACA_LIVE_API_KEY_ID: {
      type: String,
      required: false,
    },
    ALPACA_LIVE_API_SECRET_KEY: {
      type: String,
      required: false,
    },
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },
    resetPasswordToken: String,
    resetPasswordExpire: Date,
  },
  {
    timestamps: true,
  }
);

const User = mongoose.model("User", userSchema);

module.exports = User;
