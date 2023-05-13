import React, { useContext, useState, useEffect } from "react";
import UserContext from "../../context/UserContext";
import { Typography } from "@mui/material/";
import Title from "../Template/Title.jsx";
import styles from "./Dashboard.module.css";

const Balance = ({ purchasedStocks, accountBalance }) => {
  const { userData } = useContext(UserContext);
  const [portfolioBalance, setPortfolioBalance] = useState(0);

  const getPortfolioBalance = () => {
    let total = 0;
    purchasedStocks.forEach((stock) => {
      total += Number(stock.currentPrice) * Number(stock.quantity);
    });

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
        <div className={styles.addMargin}>
          <Typography color="textSecondary" align="center">
            Total:
          </Typography>

          <Typography
            component="p"
            variant="h4"
            align="center"
            className={
              +(accountBalance + portfolioBalance) >= 100000
                ? styles.positive
                : styles.negative
            }
          >
            ${accountBalance ? (+(accountBalance/1 + portfolioBalance)).toLocaleString() : "---"}
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
