import React, { useState, useEffect } from "react";
import { Link, Collapse, IconButton } from "@mui/material";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Title from "../Template/Title.jsx";
import SaleModal from "./SaleModal.jsx";
import styles from "./Dashboard.module.css";
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';


const Portfolios = ({ portfolios }) => {
  const [saleOpen, setSaleOpen] = useState(false);
  const [stock, setStock] = useState(undefined);
  const [openStrategies, setOpenStrategies] = useState(false);
  const [openPortfolio, setOpenPortfolio] = useState({});


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
        {portfolios.map((portfolio) => (
          <div style={{ minHeight: "2px", margin: "2px 0" }} key={portfolio.name}>
            <h5>
              <IconButton
                onClick={() => handlePortfolioClick(portfolio.name)}
                aria-expanded={openPortfolio[portfolio.name]}
                aria-label="show more"
              >
                <ExpandMoreIcon />
              </IconButton>
              Strategy: {portfolio.name}
            </h5>

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
                </TableBody>

              </Table>
            </Collapse>
          </div>
        ))}
      </Collapse>

      {saleOpen && stock && (
        <SaleModal setSaleOpen={setSaleOpen} stock={stock} />
      )}
    </React.Fragment>
  );
};

export default Portfolios;
