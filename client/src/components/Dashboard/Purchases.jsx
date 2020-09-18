import React, { useState } from "react";
import { Link } from "@material-ui/core";
import Table from "@material-ui/core/Table";
import TableBody from "@material-ui/core/TableBody";
import TableCell from "@material-ui/core/TableCell";
import TableHead from "@material-ui/core/TableHead";
import TableRow from "@material-ui/core/TableRow";
import Title from "../Template/Title.jsx";
import SaleModal from "./SaleModal";

const Purchases = ({ purchasedStocks }) => {
  const [saleOpen, setSaleOpen] = useState(false);
  const [stock, setStock] = useState(undefined);

  const roundNumber = (num) => {
    return Math.round((num + Number.EPSILON) * 100) / 100;
  };

  const openSaleModal = (stock) => {
    setStock(stock);
    setSaleOpen(true);
  };

  return (
    <React.Fragment>
      <div style={{ minHeight: "200px" }}>
        <Title>Stocks in your Portfolio</Title>
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
            </TableRow>
          </TableHead>
          <TableBody>
            {purchasedStocks.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Link onClick={() => openSaleModal(row)}>{row.ticker}</Link>
                </TableCell>
                <TableCell>{row.name || "----"}</TableCell>
                <TableCell>{row.quantity || "----"}</TableCell>
                <TableCell>${row.purchasePrice || "----"}</TableCell>
                <TableCell>
                  $
                  {roundNumber(
                    Number(row.quantity) * Number(row.purchasePrice)
                  ) || "----"}
                </TableCell>
                <TableCell align="right">
                  ${row.currentPrice || "----"}
                </TableCell>
                <TableCell align="right">
                  $
                  {roundNumber(
                    Number(row.quantity) * Number(row.currentPrice)
                  ) || "----"}
                </TableCell>
              </TableRow>
            ))}
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
