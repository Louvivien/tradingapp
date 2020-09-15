const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const cookieParser = require("cookie-parser");

// SETUP
dotenv.config({ path: "./server/config/.env" });

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser("secretcode"));

// DATABASE
const DB = process.env.MONGO_URI.replace(
  "<password>",
  process.env.MONGO_PASSWORD
);

mongoose
  .connect(DB, {
    useNewUrlParser: true,
    useCreateIndex: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("Connected to DB");
  })
  .catch((err) => console.log(err));

// ROUTES
const authRouter = require("./routes/authRoutes");
const stockRouter = require("./routes/stockRoutes");
app.use("/api/auth", authRouter);
app.use("/api/", stockRouter);

// APP
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
