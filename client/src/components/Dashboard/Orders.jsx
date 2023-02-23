import React, { useState } from "react";
import { Link } from "@material-ui/core";
import Table from "@material-ui/core/Table";
import TableBody from "@material-ui/core/TableBody";
import TableCell from "@material-ui/core/TableCell";
import TableHead from "@material-ui/core/TableHead";
import TableRow from "@material-ui/core/TableRow";
import Title from "../Template/Title.jsx";
import styles from "./Dashboard.module.css";

const Orders = ({ orderList }) => {
  const [cancelOpen, setCancelOpen] = useState(false);
  const [order, setOrder] = useState(undefined);

  return (
    <React.Fragment>
      <div style={{ minHeight: "200px" }}>
        <Title>Order History</Title>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Asset</TableCell>
              <TableCell>Order</TableCell>
              <TableCell>Quantity</TableCell>
              <TableCell>Average Cost</TableCell>
              <TableCell align="right">Status</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {orderList.map((row) => {
              return (
                <TableRow key={row.id}>
                  <TableCell>
                    {row.symbol}
                  </TableCell>
                  <TableCell>
                    {row.order_type || "----"}
                    {row.side || "----"}
                    {row.submitted_at || "----"}
                    </TableCell>
                  <TableCell>{row.qty || "----"}</TableCell>
                  <TableCell align="right">
                  {row.filled_avg_price || "----"}
                  </TableCell>
                  <TableCell>
                  {row.status || "----"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </React.Fragment>
  );
};

export default Orders;

