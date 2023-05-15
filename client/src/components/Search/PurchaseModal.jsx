import React, { useState, useContext, useEffect } from "react";
import UserContext from "../../context/UserContext";
import io from 'socket.io-client';

import {
  Container,
  Typography,
  Box,
  Button,
  TextField,
  CardContent,
  CardHeader,
  IconButton,
  Grid,
  Card,
  Slider,
} from "@mui/material/";
import CloseIcon from "@mui/icons-material/Close";
import styles from "./Search.module.css";
import { motion } from "framer-motion";
import Axios from "axios";
import config from "../../config/Config";

const PurchaseModal = ({
  setSelected,
  stockInfo,
  pastDay,
  today,
  setPurchasedStocks,
  purchasedStocks,
}) => {
  return (
    <motion.div
      className={styles.backdrop}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      id="backdrop"
    >
      <Container>
        <motion.div animate={{ opacity: 1, y: -20 }}>
          <PurchaseModalContent
            stockInfo={stockInfo}
            today={today}
            pastDay={pastDay}
            setSelected={setSelected}
            setPurchasedStocks={setPurchasedStocks}
            purchasedStocks={purchasedStocks}
          />
        </motion.div>
      </Container>
    </motion.div>
  );
};

const PurchaseModalContent = ({
  setSelected,
  stockInfo,
  pastDay,
  today,
  setPurchasedStocks,
  purchasedStocks,
}) => {
  // const [trail_percent, setTrailPercent] = useState(1);
  const [stopPrice, setStopPrice] = useState(Math.round(
    Number(1) / 100 * Number(today.lastPrice)) );
  const [quantity, setQuantity] = useState(1);
  const [total, setTotal] = useState(Number(today.lastPrice));
  const { userData, setUserData } = useContext(UserContext);
  const [stockData, setStockData] = useState(null);
  const { ticker } = stockInfo;
  // const [marketOpen, setMarketOpen] = useState(null);
  // const [hoursUntilOpen, setHoursUntilOpen] = useState(null);



  // useEffect(() => {
  //   const headers = {
  //     "x-auth-token": userData.token,
  //   };
  
  //   Axios.get(config.base_url + `/api/stock/market-status/${userData.user.id}`, {
  //     headers
  //   })
  //   .then((response) => {
  //     const { is_open, next_open } = response.data;
  //     setMarketOpen(is_open);
  //     if (!is_open) {
  //       const now = new Date();
  //       const marketOpenTime = new Date(now.toISOString().split("T")[0] + "T" + next_open.substring(11));
  //       const diff = marketOpenTime - now;
  //       setHoursUntilOpen(Math.ceil(diff / (1000 * 60 * 60)));
  //     }
  //   })
  //   .catch((error) => {
  //     console.error("Error fetching market status:", error);
  //   });
  // }, []);
  
  
  useEffect(() => {
    // if (marketOpen) {
      const socket = io(config.base_url, { transports: ["websocket"] });
  
      // emit event to subscribe to real-time data for specific ticker
      socket.emit("subscribe", { ticker });
      console.log(ticker);
  
      // listen for real-time data from server
      socket.on("stockData", (data) => {
        setStockData(data.BidPrice);
        setStopPrice(
          Number(data.BidPrice) * (1 - (Number(trail_percent) / 100))
        );
      });
  
      return () => {
        // clean up socket connection
        socket.disconnect();
        socket.off();
      };
    // }
  }, [ticker]);
// }, [ticker, trail_percent]);
// }, [ticker, marketOpen, trail_percent]);

  


  const handleQuantityChange = (e) => {
    if (!isNaN(e.target.value)) {
      if (
        userData.user.balance -
          Number(stockData) * Number(e.target.value) <
        0
      ) {
        return;
      }

      setQuantity(e.target.value);
      setTotal(
        Math.round(
          (Number(stockData) * Number(e.target.value) + Number.EPSILON) *
            100
        ) / 100
      );
    }
  };

  // const handleTrailPercentChange = (e, newValue) => {
  //   setTrailPercent(newValue);
  //   setStopPrice(Number(stockData) * (1 - (Number(newValue) / 100)));
  // };

  const handleClick = (e) => {
    setSelected(false);
    const socket = io(config.base_url, { transports: ['websocket'] });
    socket.disconnect();
    socket.off();


   
  };

  const handlePurchase = async (e) => {
    e.preventDefault();

    const headers = {
      "x-auth-token": userData.token,
    };

    // const trail_percent_value = parseFloat(trail_percent);

    const purchase = {
      userId: userData.user.id,
      ticker: stockInfo.ticker,
      quantity: Number(quantity),
      price: stockData,
      // trail_percent: trail_percent_value,

    };

    const url = config.base_url + "/api/stock";
    const response = await Axios.post(url, purchase, {
      headers,
    });

    

    if (response.data.status === "success") {
      setUserData({
        token: userData.token,
        user: response.data.user,
      });
      setSelected(false);

      const newStock = {
        id: response.data.stockId,
        ticker: stockInfo.ticker,
        name: stockInfo.name,
        purchasePrice: stockData,
        purchaseDate: new Date(),
        quantity: Number(quantity),
        currentDate: new Date(),
        currentPrice: today.lastPrice,
      };
      const newPurchasedStocks = [...purchasedStocks, newStock];
      setPurchasedStocks(newPurchasedStocks);
    }
  };

  return (
    <Grid
    container
    spacing={0}
    direction="column"
    alignItems="center"
    justify="center"
    style={{ minHeight: "100vh", marginTop: "95px" }} 
  >
      <Box width="60vh" boxShadow={1}>
        <Card className={styles.paper}>
          <CardHeader
            action={
              <IconButton aria-label="Close" onClick={handleClick}>
                <CloseIcon />
              </IconButton>
            }
          />

        <CardContent>
          {/* {marketOpen ? ( */}
            <>
              

                    <Typography component="h1" variant="h6" align="center">
                    Purchase {stockInfo.name} Stock
                    </Typography>
                    <form className={styles.form} onSubmit={(e) => e.preventDefault()}>
                    <TextField
                      variant="outlined"
                      margin="normal"
                      fullWidth
                      disabled
                      id="stock"
                      label="Stock Name"
                      name="stock"
                      autoComplete="stock"
                      value={stockInfo.name}
                    />
                    <TextField
                      variant="outlined"
                      margin="normal"
                      fullWidth
                      disabled
                      id="price"
                      label="Market Price"
                      name="price"
                      autoComplete="price"
                      value={stockData ?? (
                        <div>Loading...</div>
                      )}
                    />
                    <TextField
                      variant="outlined"
                      margin="normal"
                      required
                      fullWidth
                      id="quantity"
                      label="Quantity"
                      name="quantity"
                      autoComplete="quantity"
                      value={quantity}
                      onChange={handleQuantityChange}
                    />
                    {/* <Typography id="trail-percent-slider" gutterBottom>
                        Trail Percent
                      </Typography>
                      <Slider
                        value={trail_percent}
                        min={0}
                        max={25}
                        step={1}
                        onChange={handleTrailPercentChange}
                        valueLabelDisplay="auto"
                        aria-labelledby="trail-percent-slider"
                      /> */}
                    {/* <TextField
                      variant="outlined"
                      margin="normal"
                      fullWidth
                      disabled
                      id="stopPrice"
                      label="Stop Price"
                      name="stopPrice"
                      autoComplete="stopPrice"
                      value={stopPrice}
                    /> */}
                    <Typography
                      variant="body2"
                      align="center"
                      className={styles.addMargin}
                    >
                      Total = ${total.toLocaleString()}
                    </Typography>
                    <Typography variant="body2" align="center">
                      Cash Balance after purchase:{" "}
                      {userData
                        ? "$" + (userData.user.balance - total).toLocaleString()
                        : "Balance Unavailable"}
                    </Typography>
                    <Box display="flex" justifyContent="center">
                      <Button
                        type="submit"
                        variant="contained"
                        color="primary"
                        className={styles.submit}
                        onClick={handlePurchase}
                      >
                        Confirm
                      </Button>
                    </Box>
                    </form>
                    <br />
                    <br />



              
            </>
          {/* ) : (
            <Typography variant="h6" align="center">
              Market is closed now. It will open in {hoursUntilOpen} hours.
            </Typography>
          )} */}
        </CardContent>



          <CardContent>
            
          </CardContent>
        </Card>
      </Box>
    </Grid>
  );
};

export default PurchaseModal;
