import React, { useContext, useState, useEffect } from "react";
import UserContext from "../../context/UserContext";
import { Typography } from "@mui/material/";
import Title from "../Template/Title.jsx";
import styles from "./Dashboard.module.css";

const Balance = ({ purchasedStocks = [], accountBalance = 0, polymarketVirtualFunds = 0 }) => {
  const { userData } = useContext(UserContext);
  const [portfolioBalance, setPortfolioBalance] = useState(0);
  const cashBalance = Number(accountBalance) || 0;
  const polymarketBalance = Number(polymarketVirtualFunds) || 0;
  const totalBalance = cashBalance + portfolioBalance + polymarketBalance;

  const getPortfolioBalance = () => {
    let total = 0;
    if (Array.isArray(purchasedStocks)) {
      purchasedStocks.forEach((stock) => {
        if (stock && stock.currentPrice && stock.quantity) {
          total += Number(stock.currentPrice) * Number(stock.quantity);
        }
      });
    }
    return Math.round((total + Number.EPSILON) * 100) / 100;
  };

  useEffect(() => {
    setPortfolioBalance(getPortfolioBalance());
  }, [purchasedStocks]);

  return (
    <React.Fragment>
      <Title>Current Balance</Title>
      <br />
      <div className={styles.depositContext}>
        <Typography color="textSecondary" align="center">
          Cash Balance:
        </Typography>

        <Typography component="p" variant="h6" align="center">
          ${accountBalance ? (+accountBalance).toLocaleString() : "$---"}
        </Typography>
        <Typography color="textSecondary" align="center">
          Portfolio Balance:
        </Typography>

        <Typography component="p" variant="h6" align="center" gutterBottom>
          ${portfolioBalance.toLocaleString()}
        </Typography>
        <Typography color="textSecondary" align="center">
          Polymarket Virtual Funds:
        </Typography>

        <Typography component="p" variant="h6" align="center" gutterBottom>
          ${polymarketBalance ? polymarketBalance.toLocaleString() : "$---"}
        </Typography>
        <div className={styles.addMargin}>
          <Typography color="textSecondary" align="center">
            Total:
          </Typography>

          <Typography
            component="p"
            variant="h4"
            align="center"
            className={
              totalBalance >= 100000
                ? styles.positive
                : styles.negative
            }
          >
            ${totalBalance ? totalBalance.toLocaleString() : "---"}
          </Typography>
        </div>
      </div>
      <div>
        <Typography color="textSecondary" align="center">
          {new Date().toDateString()}
        </Typography>
      </div>
    </React.Fragment>
  );
};

export default Balance;
