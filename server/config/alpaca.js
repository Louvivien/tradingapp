const User = require("../models/userModel");

async function setAlpaca(userId) {
  const user = await User.findById(userId).exec();

  let keyId = user?.ALPACA_API_KEY_ID;
  let secretKey = user?.ALPACA_API_SECRET_KEY;  

  // If the keys are not present in the user database, fallback to process.env values
  if (!keyId || !secretKey) {
    keyId = process.env.ALPACA_API_KEY_ID;
    secretKey = process.env.ALPACA_API_SECRET_KEY;
  }

  return {
    keyId,
    secretKey,
    paper: true,
  };
}

module.exports = setAlpaca;
