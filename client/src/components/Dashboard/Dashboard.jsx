import React, { useState, useEffect } from "react";
import Axios from "axios";
import config from "../../config/Config";
import styles from "../Template/PageTemplate.module.css";
import clsx from "clsx";
import { styled } from "@mui/system";
import { Box, Container, Grid, Paper } from "@mui/material";
import Chart from "./Chart";
import Balance from "./Balance";
import Purchases from "./Purchases";
import Portfolios from "./Portfolios";
import Orders from "./Orders";
import Copyright from "../Template/Copyright";
import { logDebug, logWarn, logError } from "../../utils/logger";

const StyledPaper = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(2),
  display: "flex",
  overflow: "auto",
  flexDirection: "column",
}));

const FixedHeightPaper = styled(StyledPaper)({
  height: 350,
});

const Dashboard = ({ userData, setUserData, onViewStrategyLogs }) => {
  const [purchasedStocks, setPurchasedStocks] = useState([]);
  const [accountBalance, setAccountBalance] = useState([]);
  const [orderList, setOrderList] = useState({ orders: [], positions: [] });
  const [portfolios, setPortfolios] = useState([]);

  // Function to get the list of purchased stocks from the server using Alpacas API
  const getPurchasedStocks = async () => {
    try {
      logDebug('Fetching stocks for user:', userData.user.id);
      const url = config.base_url + `/api/stock/${userData.user.id}`;
      const headers = {
        "x-auth-token": userData.token,
      };

      const response = await Axios.get(url, { headers });
      logDebug('Stocks API Response:', response.data);

      if (response.data.status === "success") {
        setPurchasedStocks(response.data.stocks);
        setAccountBalance(response.data.cash);
      } else {
        logWarn('Failed to fetch stocks:', response.data);
        setPurchasedStocks([]);
        setAccountBalance(0);
      }
    } catch (error) {
      logError('Error in getPurchasedStocks:', error);
      setPurchasedStocks([]);
      setAccountBalance(0);
    }
  };

  // Function to get the list of orders from the server using Alpacas API
  const getOrderList = async () => {
    try {
      logDebug('Fetching orders for user:', userData.user.id);
      const url = config.base_url + `/api/order/${userData.user.id}`;
      const headers = {
        "x-auth-token": userData.token,
      };

      const response = await Axios.get(url, { headers });
      logDebug('Orders API Response:', response.data);

      if (response.data.status === "success") {
        setOrderList({
          orders: response.data.orders || [],
          positions: response.data.positions || []
        });
      } else {
        logWarn('Failed to fetch orders:', response.data);
        setOrderList({ orders: [], positions: [] });
      }
    } catch (error) {
      logError('Error in getOrderList:', error);
      setOrderList({ orders: [], positions: [] });
    }
  };

  // Function to get the Strategy Portfolios from the server using MangoDB
  const getPortfolio = async () => {
    try {
      const url = config.base_url + `/api/strategies/portfolios/${userData.user.id}`;
      const headers = {
        "x-auth-token": userData.token,
      };
  
      const response = await Axios.get(url, { headers });
  
      if (response.data.status === "success") {
        setPortfolios(response.data.portfolios);
        logDebug("Portfolios ", response.data.portfolios);
      }
    } catch (error) {
      logError('Error fetching portfolios:', error);
    }
  };

  useEffect(() => {
    getPurchasedStocks();
    getOrderList();
    getPortfolio();
  }, []);

  return (
    <Container maxWidth="lg" className={styles.container}>
      <Grid container spacing={3} marginTop="15px">
        {/* Chart */}
        <Grid item xs={12} md={8} lg={9}>
          <FixedHeightPaper>
            <Chart />
          </FixedHeightPaper>
        </Grid>

        {/* Balance */}
        <Grid item xs={12} md={4} lg={3}>
          <FixedHeightPaper>
          <Balance accountBalance={accountBalance} purchasedStocks={purchasedStocks} />
          </FixedHeightPaper>
        </Grid>

        {/* General Portfolio */}
        <Grid item xs={12}>
          <StyledPaper>
            <Purchases accountBalance={accountBalance} purchasedStocks={purchasedStocks}/>
          </StyledPaper>
        </Grid>

        {/* Strategy Portfolio */}
        {portfolios && portfolios.length > 0 && (
          <Grid item xs={12}>
            <StyledPaper>
              <Portfolios
                accountBalance={accountBalance}
                portfolios={portfolios}
                onViewStrategyLogs={onViewStrategyLogs}
              />
            </StyledPaper>
          </Grid>
        )}

        {/* Orders History */}
        <Grid item xs={12}>
          <StyledPaper>
            <Orders orderList={orderList} />
          </StyledPaper>
        </Grid>
      </Grid>
      <Box pt={4}>
        <Copyright />
      </Box>
    </Container>
  );
};

export default Dashboard;
