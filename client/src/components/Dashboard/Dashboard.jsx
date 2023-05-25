import React from "react";
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

const StyledPaper = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(2),
  display: "flex",
  overflow: "auto",
  flexDirection: "column",
}));

const FixedHeightPaper = styled(StyledPaper)({
  height: 350,
});

const Dashboard = ({ accountBalance, purchasedStocks, orderList, portfolios }) => {
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
              <Portfolios accountBalance={accountBalance} portfolios={portfolios} />
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
