const jwt = require("jsonwebtoken");

const errorMessage = (res) => {
  return res.status(401).json({
    status: "fail",
    message: "Authorization denied, user is not logged in.",
  });
};

const auth = async (req, res, next) => {
  try {
    const token = req.header("x-auth-token");
    if (!token) {
      return errorMessage(res);
    }

    const verified = jwt.verify(token, process.env.JWT_SECRET);
    if (!verified) {
      return errorMessage(res);
    }

    req.user = verified.id;
    next();
  } catch {
    return errorMessage(res);
  }
};

module.exports = auth;
