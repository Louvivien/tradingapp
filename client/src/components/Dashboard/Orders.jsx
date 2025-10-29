import React from "react";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Title from "../Template/Title.jsx";
import styles from "./Dashboard.module.css";

const Orders = ({ orderList = { orders: [] } }) => {

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
      </div>
    </React.Fragment>
  );
};

export default Orders;
