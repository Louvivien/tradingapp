import React, { useState } from "react";
import { Link } from "@mui/material";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Title from "../Template/Title.jsx";
import styles from "./Dashboard.module.css";

const Orders = ({ orderList = { orders: [], positions: [] } }) => {
  const [cancelOpen, setCancelOpen] = useState(false);
  const [order, setOrder] = useState(undefined);

  const formatDate = (dateString) => {
    if (!dateString) return "----";
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  const formatPrice = (price) => {
    if (price === undefined || price === null) return "----";
    return `$${Number(price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <React.Fragment>
      <div style={{ minHeight: "200px" }}>
        <Title>Order History</Title>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Asset</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Side</TableCell>
              <TableCell>Quantity</TableCell>
              <TableCell>Price</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Submitted At</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {orderList.orders?.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{row.symbol || "----"}</TableCell>
                <TableCell>{row.order_type || "----"}</TableCell>
                <TableCell>{row.side || "----"}</TableCell>
                <TableCell>{row.qty || "----"}</TableCell>
                <TableCell>{formatPrice(row.filled_avg_price)}</TableCell>
                <TableCell>{row.status || "----"}</TableCell>
                <TableCell>{formatDate(row.submitted_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <Title style={{ marginTop: "2rem" }}>Current Positions</Title>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Asset</TableCell>
              <TableCell>Quantity</TableCell>
              <TableCell>Avg Entry Price</TableCell>
              <TableCell>Current Price</TableCell>
              <TableCell>Market Value</TableCell>
              <TableCell>Unrealized P/L</TableCell>
              <TableCell>Unrealized P/L %</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {orderList.positions?.map((position) => (
              <TableRow key={position.asset_id}>
                <TableCell>{position.symbol}</TableCell>
                <TableCell>{position.qty}</TableCell>
                <TableCell>{formatPrice(position.avg_entry_price)}</TableCell>
                <TableCell>{formatPrice(position.current_price)}</TableCell>
                <TableCell>{formatPrice(position.market_value)}</TableCell>
                <TableCell className={position.unrealized_pl >= 0 ? styles.positive : styles.negative}>
                  {formatPrice(position.unrealized_pl)}
                </TableCell>
                <TableCell className={position.unrealized_plpc >= 0 ? styles.positive : styles.negative}>
                  {(position.unrealized_plpc * 100).toFixed(2)}%
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </React.Fragment>
  );
};

export default Orders;

