import React, { useState } from "react";
import { Link } from "@mui/material";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Title from "../Template/Title.jsx";
import SaleModal from "./SaleModal";
import styles from "./Dashboard.module.css";

const Purchases = ({ purchasedStocks = [], showTitle = true }) => {
  const [saleOpen, setSaleOpen] = useState(false);
  const [stock, setStock] = useState(undefined);
  

  const roundNumber = (num) => {
    return Math.round((num + Number.EPSILON) * 100) / 100;
  };

  const openSaleModal = (stock) => {
    setStock(stock);
    setSaleOpen(true);
  };

let totalQuantity = 0;
let totalPurchaseTotal = 0;
let totalCurrentTotal = 0;
let totalDifference = 0;
let allStocksHaveAvgCost = true;


  return (
    <React.Fragment>
      <div style={{ minHeight: "200px" }}>
        {showTitle && <Title>Stocks in Your Portfolio</Title>}
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
          {purchasedStocks?.filter(stock => stock.purchasePrice).map((row) => {

            if (row.purchasePrice === null) {
              allStocksHaveAvgCost = false;
            } else {
              totalQuantity += Number(row.quantity);
              totalPurchaseTotal += Number(row.quantity) * Number(row.purchasePrice);
              totalCurrentTotal += Number(row.quantity) * Number(row.currentPrice);
              totalDifference += (row.currentPrice - row.purchasePrice) / row.currentPrice;
            }




              const difference =
                (row.currentPrice - row.purchasePrice) / row.currentPrice;
              const purchaseTotal =
                Number(row.quantity) * Number(row.purchasePrice);
              const currentTotal =
                Number(row.quantity) * Number(row.currentPrice);
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Link onClick={() => openSaleModal(row)}>{row.ticker}</Link>
                    </TableCell>
                    <TableCell>{row.name || "----"}</TableCell>
                    <TableCell>{row.quantity || "----"}</TableCell>
                    <TableCell align="right">
                      ${row.purchasePrice ? row.purchasePrice.toLocaleString() : "----"}
                    </TableCell>
                    <TableCell align="right">
                      ${roundNumber(purchaseTotal).toLocaleString() || "----"}
                    </TableCell>
                    <TableCell
                      align="right"
                      className={
                        row.currentPrice >= row.purchasePrice
                          ? styles.positive
                          : styles.negative
                      }
                    >
                      ${row.currentPrice ? row.currentPrice.toLocaleString() : "----"}
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
              })}

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
        {saleOpen && stock && (
          <SaleModal setSaleOpen={setSaleOpen} stock={stock} />
        )}
      </div>
    </React.Fragment>
  );
};

export default Purchases;
