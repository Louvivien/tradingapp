import React, { useState } from "react";
import { Link } from "@mui/material";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
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

