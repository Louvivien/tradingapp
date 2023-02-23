const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const userSchema = new Schema(
  {
    username: {
      type: String,
      required: [true, "Username is required."],
      unique: [true, "An account with this username already exists."],
      minlength: [4, "Username must be 4-15 characters."],
      maxlength: [15, "Username must be 4-15 characters."],
      lowercase: true,
    },
    password: {
      type: String,
      required: [true, "Password is required."],
    },
    balance:{
      type: Number,
      required: true,
      default: 100000
    },
    ALPACA_API_KEY_ID:{
      type: String,
      required: true,
      default: process.env.ALPACA_API_KEY_ID
    },
    ALPACA_API_SECRET_KEY:{
      type: String,
      required: true,
      default: process.env.ALPACA_API_SECRET_KEY
    },
  },
  {
    timestamps: true,
  }
);

const User = mongoose.model("User", userSchema);

module.exports = User;
