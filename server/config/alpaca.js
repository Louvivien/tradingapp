const User = require("../models/userModel");

async function setAlpaca(userId) {
  let keyId = process.env.ALPACA_API_KEY_ID;
  let secretKey = process.env.ALPACA_API_SECRET_KEY;

  if (userId) {
    const user = await User.findById(userId).exec();

    keyId = user.ALPACA_API_KEY_ID || keyId;
    secretKey = user.ALPACA_API_SECRET_KEY || secretKey;
  }

  if (!keyId || !secretKey) {
    throw new Error("API keys are missing.");
  }

  return {
    keyId,
    secretKey,
    paper: true,
    apiURL: "https://paper-api.alpaca.markets"
  };
}

module.exports = setAlpaca;
