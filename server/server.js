const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const cookieParser = require("cookie-parser");
const path = require("path");

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
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("Connected to DB");
  })
  .catch((err) => console.log(err));

// STREAM DATA
const http = require('http');
const server = http.createServer(app);
const io = require('socket.io')(server);
let stream = null;


const Alpaca = require('@alpacahq/alpaca-trade-api');
const alpaca = new Alpaca({
  keyId: process.env.ALPACA_API_KEY_ID,
  secretKey: process.env.ALPACA_API_SECRET_KEY,
  paper: true, //change to false for real trading
});

io.on('connection', (socket) => {
  console.log(`Client connected with ID: ${socket.id}`);
  const stream = alpaca.data_stream_v2;


  //when client sends a ticker
  socket.on('subscribe', (ticker) => {

    let symbol;
    if (typeof ticker === 'string') {
      symbol = ticker;
    } else if (Array.isArray(ticker)) {
      symbol = ticker[0];
    } else if (typeof ticker === 'object' && ticker.ticker) {
      symbol = ticker.ticker;
    } else {
      console.error('Invalid ticker:', ticker);
      return;
    }

    console.log(`Subscribing to data for ${symbol}`);

    stream.onConnect(function () {
        console.log("Connected");
        stream.subscribeForQuotes([(symbol)]);
      });

      stream.onError((err) => {
        console.log(err);
      });
  
      stream.onStockQuote((quote) => {
        console.log(quote);
        socket.emit('stockData', quote);
      });

      stream.onDisconnect(() => {
        console.log("Disconnected");
      });

      stream.connect();

  });

  //when client disconnects
  socket.on('disconnect', () => {
    console.log(`Client disconnected with ID: ${socket.id}`);
      // console.log(`Unsubscribing from data for ${ticker}`);
       stream.disconnect();
  });


});

// ROUTES
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

if (process.env.NODE_ENV === "production") {
  app.use(express.static("client/build"));

  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname + "/../client/build/index.html"));
  });
}

// APP
server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
