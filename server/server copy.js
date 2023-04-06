const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const cookieParser = require("cookie-parser");
const path = require("path");
const setAlpaca = require('./config/alpaca');
const Alpaca = require('@alpacahq/alpaca-trade-api');
const cors = require("cors");


const app = express();
const port = process.env.PORT || 5000;


// Load environment variables from .env file
dotenv.config({ path: "./config/.env" });

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser("secretcode"));
app.use(cors())


// Logs
app.use((req, res, next) => {
  console.log(`Incoming ${req.method} request for ${req.url}`);
  next();
});




// Connect to MongoDB
const DB = process.env.MONGO_URI.replace(
  "<password>",
  process.env.MONGO_PASSWORD
);

mongoose
  .connect(DB, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("Connected to MongoDB");
  })
  .catch((err) => console.log(err));

// // Create an HTTP server and listen for socket connections
// const server = require('http').createServer(app);
// const io = require('socket.io')(server);

// // Connect to Alpaca API and handle socket events
// setAlpaca().then(alpacaConfig => {
//   const alpaca = new Alpaca({
//     keyId: alpacaConfig.keyId,
//     secretKey: alpacaConfig.secretKey,
//     paper: true, // change to false for real trading
//   });

//   let currentSubscription = null;

//   io.on("connection", (socket) => {
//     console.log(`Client connected with ID: ${socket.id}`);

//     socket.on('subscribe', (ticker) => {
//       let symbol;
//       if (typeof ticker === 'string') {
//         symbol = ticker;
//       } else if (Array.isArray(ticker)) {
//         symbol = ticker[0];
//       } else if (typeof ticker === 'object' && ticker.ticker) {
//         symbol = ticker.ticker;
//       } else {
//         console.error('Invalid ticker:', ticker);
//         return;
//       }

//       if (currentSubscription !== symbol) {
//         console.log(`Subscribing to data for ${symbol}`);

//         if (currentSubscription) {
//           alpaca.data_stream_v2.unsubscribeFromQuotes([currentSubscription]);
//         }

//         alpaca.data_stream_v2.onConnect(() => {
//           console.log("Connected to Alpaca data stream");
//           alpaca.data_stream_v2.subscribeForQuotes([symbol]);
//         });

//         alpaca.data_stream_v2.onError((err) => {
//           console.log(err);
//         });

//         alpaca.data_stream_v2.onStockQuote((quote) => {
//           console.log(quote);
//           socket.emit('stockData', quote);
//         });

//         alpaca.data_stream_v2.onDisconnect(() => {
//           console.log("Disconnected from Alpaca data stream");
//         });

//         alpaca.data_stream_v2.connect();

//         currentSubscription = symbol;
//       }
//     });

//     socket.on("disconnect", () => {
//       console.log(`Client disconnected with ID: ${socket.id}`);
//       alpaca.data_stream_v2.disconnect();
//     });
//   });
// }).catch((err) => {
//   console.log(err);
// });

// Routes
const authRouter = require("./routes/authRoutes");
const dataRouter = require("./routes/dataRoutes");
const newsRouter = require("./routes/newsRoutes");
const stockRouter = require("./routes/stockRoutes");
const orderRouter = require("./routes/orderRoutes");

app.use("/api/auth", authRouter);
app.use("/api/data", dataRouter);
app.use("/api/news", newsRouter);
app.use("/api/stock", stockRouter);
app.use("/api/order", orderRouter);

// Serve static files in production
if (process.env.NODE_ENV === "production") {
app.use(express.static("client/build"));

app.get("*", (req, res) => {
res.sendFile(path.join(__dirname + "/../client/build/index.html"));
});
}

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});








