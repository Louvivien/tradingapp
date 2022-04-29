import React, { useState, useContext } from "react";
import UserContext from "../../context/UserContext";
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
} from "@material-ui/core/";
import CloseIcon from "@material-ui/icons/Close";
import styles from "./Search.module.css";
import { motion } from "framer-motion";
import Axios from "axios";
import config from "../../config/Config";

const PurchaseModal = ({
  setSelected,
  stockInfo,
  pastDay,
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
  setPurchasedStocks,
  purchasedStocks,
}) => {
  const [quantity, setQuantity] = useState(1);
  const [total, setTotal] = useState(Number(pastDay.adjClose));
  const { userData, setUserData } = useContext(UserContext);

  const handleQuantityChange = (e) => {
    if (!isNaN(e.target.value)) {
      if (
        userData.user.balance -
          Number(pastDay.adjClose) * Number(e.target.value) <
        0
      ) {
        return;
      }

      setQuantity(e.target.value);
      setTotal(
        Math.round(
          (Number(pastDay.adjClose) * Number(e.target.value) + Number.EPSILON) *
            100
        ) / 100
      );
    }
  };

  const handleClick = (e) => {
    setSelected(false);
  };

  const handlePurchase = async (e) => {
    e.preventDefault();

    const headers = {
      "x-auth-token": userData.token,
    };

    const purchase = {
      userId: userData.user.id,
      ticker: stockInfo.ticker,
      quantity: Number(quantity),
      price: pastDay.adjClose,
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
        purchasePrice: pastDay.adjClose,
        purchaseDate: new Date(),
        quantity: Number(quantity),
        currentDate: new Date(),
        currentPrice: pastDay.adjClose,
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
      style={{ minHeight: "100vh" }}
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
                label="Stock Price"
                name="price"
                autoComplete="price"
                value={pastDay.adjClose}
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
          </CardContent>
        </Card>
      </Box>
    </Grid>
  );
};

export default PurchaseModal;
