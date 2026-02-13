const User = require("../models/userModel");
const { decryptIfEncrypted, maskKey } = require('../utils/secretUtils');

exports.getUser = async (req, res) => {
  const user = await User.findById(req.user);
  const keyIdPlain = (() => {
    try {
      return decryptIfEncrypted(user?.ALPACA_API_KEY_ID);
    } catch {
      return '';
    }
  })();
  const hasUserPaperKeys = Boolean(user?.ALPACA_API_KEY_ID && user?.ALPACA_API_SECRET_KEY);
  const hasEnvPaperKeys = Boolean(process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY);
  const alpacaKeysPresent = hasUserPaperKeys || hasEnvPaperKeys;

  res.status(200).json({
    username: user.username,
    id: user._id,
    balance: user.balance,
    alpacaKeysPresent,
    alpacaKeyIdMasked: keyIdPlain ? maskKey(keyIdPlain) : null,
  });
};
