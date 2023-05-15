const CryptoJS = require('crypto-js');
const User = require("../models/userModel");

async function setAlpaca(userId) {
  let keyId = process.env.ALPACA_API_KEY_ID;
  let secretKey = process.env.ALPACA_API_SECRET_KEY;

  if (userId) {
    const user = await User.findById(userId).exec();

    // Check if the keys are encrypted
    if (!user.ALPACA_API_KEY_ID.includes('U2FsdGVkX1')) {
      // Encrypt the keys if not
      const encryptedKeyId = CryptoJS.AES.encrypt(user.ALPACA_API_KEY_ID, process.env.CryptoJS_secret_key).toString();
      const encryptedSecretKey = CryptoJS.AES.encrypt(user.ALPACA_API_SECRET_KEY, process.env.CryptoJS_secret_key).toString();
      // Update the user with the encrypted keys
      user.ALPACA_API_KEY_ID = encryptedKeyId;
      user.ALPACA_API_SECRET_KEY = encryptedSecretKey;
      await user.save();


      const bytes1  = CryptoJS.AES.decrypt(user.ALPACA_API_KEY_ID, process.env.CryptoJS_secret_key);
      const bytes2  = CryptoJS.AES.decrypt(user.ALPACA_API_SECRET_KEY, process.env.CryptoJS_secret_key);
      keyId = bytes1.toString(CryptoJS.enc.Utf8) || keyId;
      secretKey = bytes2.toString(CryptoJS.enc.Utf8) || secretKey;
    } else {
      // Decrypt the keys
      const bytes3  = CryptoJS.AES.decrypt(user.ALPACA_API_KEY_ID, process.env.CryptoJS_secret_key);
      const bytes4  = CryptoJS.AES.decrypt(user.ALPACA_API_SECRET_KEY, process.env.CryptoJS_secret_key);
      keyId = bytes3.toString(CryptoJS.enc.Utf8) || keyId;
      secretKey = bytes4.toString(CryptoJS.enc.Utf8) || secretKey;
    }
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
