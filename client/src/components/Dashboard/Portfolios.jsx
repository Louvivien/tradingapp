import React, { useContext, useState } from "react";
import { Link, Collapse, IconButton, Modal, Button, useTheme } from "@mui/material";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Title from "../Template/Title.jsx";
import SaleModal from "./SaleModal.jsx";
import styles from "./Dashboard.module.css";
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Axios from "axios";
import config from "../../config/Config";
import UserContext from "../../context/UserContext";
import HighlightOffIcon from '@mui/icons-material/HighlightOff';





const Portfolios = ({ portfolios }) => {
  const [saleOpen, setSaleOpen] = useState(false);
  const { userData, setUserData } = useContext(UserContext);
  const [stock, setStock] = useState(undefined);
  const [openStrategies, setOpenStrategies] = useState(false);
  const [openPortfolio, setOpenPortfolio] = useState({});
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [strategyToDelete, setStrategyToDelete] = useState(null);
  const theme = useTheme();





  const roundNumber = (num) => {
    return Math.round((num + Number.EPSILON) * 100) / 100;
  };

  const openSaleModal = (stock) => {
    setStock(stock);
    setSaleOpen(true);
  };


  const handleStrategiesClick = () => {
    setOpenStrategies(!openStrategies);
  };

  const handlePortfolioClick = (name) => {
    setOpenPortfolio(prevState => ({ ...prevState, [name]: !prevState[name] }));
  };



  const openDeleteModal = (strategyId) => {
    // console.log('strategyId:', strategyId);
    setStrategyToDelete(strategyId);
    setDeleteOpen(true);
};



  const closeDeleteModal = () => {
    setDeleteOpen(false);
  };


  const deleteStrategy = async (strategyId) => {
    try {
      const url = config.base_url + `/api/strategies/delete/${userData.user.id}/${strategyId}`;
      const headers = {
        "x-auth-token": userData.token,
      };

      const response = await Axios.delete(url, { headers });

      if (response.data.status === "success") {
        // console.log("Strategy deleted successfully");
        // You might want to update the state or redirect the user here
      } else {
        console.error('Error deleting strategy:', response.data.message);
      }
    } catch (error) {
      console.error('Error deleting strategy:', error);
    }
  };





  return (
    <React.Fragment>
      <Title>
        <IconButton
          onClick={handleStrategiesClick}
          aria-expanded={openStrategies}
          aria-label="show more"
        >
          <ExpandMoreIcon />
        </IconButton>
        Strategies portfolios
      </Title>

      <Collapse in={openStrategies}>
        {portfolios.map((portfolio) => {
          // console.log('Portfolio:', portfolio);
          
          // Calculate totals for each portfolio
          let totalQuantity = 0;
          let totalPurchaseTotal = 0;
          let totalCurrentTotal = 0;
          let totalDifference = 0;
          let allStocksHaveAvgCost = true;

          portfolio.stocks.forEach((stock) => {
            if (stock.avgCost === null) {
              allStocksHaveAvgCost = false;
            } else {
              totalQuantity += Number(stock.quantity);
              totalPurchaseTotal += Number(stock.quantity) * Number(stock.avgCost);
              totalCurrentTotal += Number(stock.quantity) * Number(stock.currentPrice);
              totalDifference += (stock.currentPrice - stock.avgCost) / stock.currentPrice;
            }
          });





          return (
            <div style={{ minHeight: "2px", margin: "2px 0" }} key={portfolio.name}>

              <div style={{ color: theme.palette.info.light }}>
                <IconButton
                  onClick={() => handlePortfolioClick(portfolio.name)}
                  aria-expanded={openPortfolio[portfolio.name]}
                  aria-label="show more"
                >
                  <ExpandMoreIcon />
                </IconButton>
                {portfolio.name}

                <IconButton color="error" onClick={() => openDeleteModal(portfolio.strategy_id)}>
                  <HighlightOffIcon fontSize="small"/>
                </IconButton>




              </div>

                  <Modal
                    open={deleteOpen}
                    onClose={closeDeleteModal}
                    aria-labelledby="delete-strategy-modal-title"
                    aria-describedby="delete-strategy-modal-description"
                  >
                    <div style={{ padding: '20px', backgroundColor: 'white', margin: 'auto', marginTop: '20%', width: '50%' }}>
                      <h2 id="delete-strategy-modal-title">Delete Strategy</h2>
                      <p id="delete-strategy-modal-description">
                        Are you sure that you want to delete this strategy? This will liquidate the assets.
                      </p>
                      <Button variant="contained" color="primary" onClick={closeDeleteModal} style={{ marginRight: '20px' }}>
                        Cancel
                      </Button>
                      <Button variant="contained" color="secondary" onClick={async () => {
                        await deleteStrategy(strategyToDelete);
                        closeDeleteModal();
                        window.location.reload();
                      }}>
                        Proceed
                      </Button>
                    </div>
                  </Modal>



              <Collapse in={openPortfolio[portfolio.name]}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Company Ticker</TableCell>
                      <TableCell>Name</TableCell>
                      <TableCell>Quantity</TableCell>
                      <TableCell>Price of Purchase</TableCell>
                      <TableCell>Purchase Total</TableCell>
                      <TableCell align="right">Current Price</TableCell>
                      <TableCell align="right">Current Total</TableCell>
                      <TableCell align="right">Difference</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {portfolio.stocks.map((stock) => {
                      const purchaseTotal = Number(stock.quantity) * Number(stock.avgCost);
                      const currentTotal = Number(stock.quantity) * Number(stock.currentPrice);
                      const difference = (stock.currentPrice - stock.avgCost) / stock.currentPrice;

                      if (stock.avgCost === null) {
                        return (
                          <TableRow key={stock.symbol}>
                            <TableCell>
                              <Link onClick={() => openSaleModal(stock)}>{stock.symbol}</Link>
                            </TableCell>
                            <TableCell>{stock.name || "----"}</TableCell>
                            <TableCell>{stock.quantity || "----"}</TableCell>
                            <TableCell colSpan={5}>Order not filled yet.</TableCell>
                          </TableRow>
                        );
                      } else {
                        return (
                          <TableRow key={stock.symbol}>
                            <TableCell>
                              <Link onClick={() => openSaleModal(stock)}>{stock.symbol}</Link>
                            </TableCell>
                            <TableCell>{stock.name || "----"}</TableCell>
                            <TableCell>{stock.quantity || "----"}</TableCell>
                            <TableCell align="right">
                              ${stock.avgCost ? stock.avgCost.toLocaleString() : "----"}
                            </TableCell>
                            <TableCell align="right">
                              ${roundNumber(purchaseTotal).toLocaleString() || "----"}
                            </TableCell>
                            <TableCell
                              align="right"
                              className={
                                stock.currentPrice >= stock.avgCost
                                  ? styles.positive
                                  : styles.negative
                              }
                            >
                              ${stock.currentPrice ? stock.currentPrice.toLocaleString() : "----"}
                            </TableCell>
                            <TableCell
                              align="right"
                              className={
                                currentTotal >= purchaseTotal
                                  ? styles.positive
                                  : styles.negative
                              }
                            >
                              ${roundNumber(currentTotal).toLocaleString() || "----"}
                            </TableCell>
                            <TableCell
                              align="right"
                              className={
                                difference >= 0 ? styles.positive : styles.negative
                              }
                            >
                              {difference >= 0 ? "▲" : "▼"}{" "}
                              {Math.abs(difference * 100).toFixed(2)}%
                            </TableCell>
                          </TableRow>
                        );
                      }
                    })}


                      {/* Add totals row if all stocks have avgCost */}
                      {allStocksHaveAvgCost && (
                      <TableRow>
                        <TableCell>Total</TableCell>
                        <TableCell></TableCell>
                        <TableCell>{totalQuantity}</TableCell>
                        <TableCell></TableCell>
                        <TableCell align="right">${roundNumber(totalPurchaseTotal).toLocaleString()}</TableCell>
                        <TableCell></TableCell>
                        <TableCell
                          align="right"
                          className={
                            totalCurrentTotal >= totalPurchaseTotal
                              ? styles.positive
                              : styles.negative
                          }
                        >
                          ${roundNumber(totalCurrentTotal).toLocaleString()}
                        </TableCell>
                        <TableCell
                          align="right"
                          className={
                            totalDifference >= 0 ? styles.positive : styles.negative
                          }
                        >
                          {Math.abs(totalDifference * 100).toFixed(2)}%
                        </TableCell>
                      </TableRow>
                    )}



                    
                  </TableBody>

                </Table>
              </Collapse>
            </div>
          );
        })}
      </Collapse>

      {saleOpen && stock && (
        <SaleModal setSaleOpen={setSaleOpen} stock={stock} />
      )}
    </React.Fragment>
  );
};

export default Portfolios;
