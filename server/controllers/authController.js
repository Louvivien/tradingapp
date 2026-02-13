const mongoose = require("mongoose");
const User = require("../models/userModel");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getAlpacaConfig } = require('../config/alpacaConfig');
const { decryptIfEncrypted, maskKey } = require('../utils/secretUtils');



const errorMessage = (res, error) => {
  return res.status(400).json({ status: "fail", message: error.message });
};
exports.registerUser = async (req, res) => {
  try {
    const { username, password } = req.body;

    console.log('[Auth] Register attempt received', { username });

    if (!username || !password) {
      return res.status(200).json({
        status: "fail",
        message: "Not all fields have been entered",
      });
    }
    if (password.length < 6 || password.length > 25) {
      return res.status(200).json({
        status: "fail",
        message: "Password must be between 6-25 characters",
        type: "password",
      });
    }

    console.log('[Auth] Checking existing user document');
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(200).json({
        status: "fail",
        message: "An account with this username already exists.",
        type: "username",
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    console.log('[Auth] Saving new user to database');
    const newUser = new User({ username, password: hashedPassword });
    const savedUser = await newUser.save();
    console.log('[Auth] User saved successfully', { userId: savedUser._id });
    res.status(201).json(savedUser);
  } catch (error) {
    console.error('[Auth] Register error', error);
    return errorMessage(res, error);
  }
};

exports.loginUser = async (req, res) => {
  try {
    const { username, password } = req.body;

    console.log('[Auth] Login attempt received', { username });

    if (!username || !password) {
      return res.status(200).json({
        status: "fail",
        message: "Not all fields have been entered.",
      });
    }

    console.log('[Auth] Querying user document');
    const user = await User.findOne({ username }).select("+password");

    if (!user) {
      console.warn('[Auth] User not found', { username });
      return res.status(200).json({
        status: "fail",
        message: "Invalid credentials. Please try again.",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      console.warn('[Auth] Password mismatch', { username });
      return res.status(200).json({
        status: "fail",
        message: "Invalid credentials. Please try again.",
      });
    }

    let ALPACA_API_KEY_ID = user.ALPACA_API_KEY_ID;
    let ALPACA_API_SECRET_KEY = user.ALPACA_API_SECRET_KEY;

    // If user does not have ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY, use the ones from environment variables and update the user
    if (!ALPACA_API_KEY_ID || !ALPACA_API_SECRET_KEY) {
      console.log('[Auth] User missing Alpaca keys, using environment fallback (not persisted)');
      ALPACA_API_KEY_ID = process.env.ALPACA_API_KEY_ID;
      ALPACA_API_SECRET_KEY = process.env.ALPACA_API_SECRET_KEY;
    }

    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    let userBalance = user.balance;
    try {
      const alpacaConfig = await getAlpacaConfig(user._id);
      if (alpacaConfig?.hasValidKeys) {
        const tradingKeys = alpacaConfig.getTradingKeys();
        const response = await tradingKeys.client.get(`${tradingKeys.apiUrl}/v2/account`, {
          timeout: Number(process.env.ALPACA_ACCOUNT_TIMEOUT_MS || 5000),
          headers: {
            'APCA-API-KEY-ID': tradingKeys.keyId,
            'APCA-API-SECRET-KEY': tradingKeys.secretKey,
          },
        });
        if (response?.data?.cash != null) {
          userBalance = response.data.cash;
        }
      }
    } catch (error) {
      console.warn('[Auth] Alpaca balance fetch failed; continuing with stored balance.', error.message);
    }

    console.log('[Auth] Login successful', {
      username,
      userId: user._id,
      mongoState: mongoose.connection.readyState,
    });

    const keyIdPlain = (() => {
      try {
        return decryptIfEncrypted(ALPACA_API_KEY_ID);
      } catch {
        return '';
      }
    })();
    const alpacaKeysPresent = Boolean(ALPACA_API_KEY_ID && ALPACA_API_SECRET_KEY);

    return res.status(200).json({
      token,
      user: {
        username,
        id: user._id,
        balance: userBalance,
        alpacaKeysPresent,
        alpacaKeyIdMasked: keyIdPlain ? maskKey(keyIdPlain) : null,
      },
    });
  } catch (error) {
    console.error('[Auth] Login error', error);
    return errorMessage(res, error);
  }
};


exports.validate = async (req, res) => {
  try {
    const token = req.header("x-auth-token");
    if (!token) {
      return res.json(false);
    }
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    if (!verified) {
      return res.json(false);
    }
    const requireExp = String(process.env.JWT_REQUIRE_EXP ?? "true").trim().toLowerCase() !== "false";
    if (requireExp && !verified.exp) {
      return res.json(false);
    }

    const user = await User.findById(verified.id);
    if (!user) {
      return res.json(false);
    }

    return res.json(true);
  } catch (error) {
    return res.json(false);
  }
};
