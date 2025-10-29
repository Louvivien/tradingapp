import React, { useEffect, useMemo, useState } from "react";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TablePagination from "@mui/material/TablePagination";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import Title from "../Template/Title.jsx";

const Orders = ({ orderList = { orders: [] }, loading = false, error = null }) => {
  const orders = Array.isArray(orderList.orders) ? orderList.orders : [];
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);

  useEffect(() => {
    setPage(0);
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.log("[Orders] received order count:", orders.length, "loading:", loading, "error:", error);
    }
  }, [orders.length, loading, error]);

  const sortedOrders = useMemo(() => {
    const parseDate = (value) => {
      if (!value) return 0;
      const time = Date.parse(value);
      return Number.isNaN(time) ? 0 : time;
    };
    return orders
      .slice()
      .sort(
        (a, b) =>
          parseDate(b.submitted_at || b.created_at || b.updated_at) -
          parseDate(a.submitted_at || a.created_at || a.updated_at)
      );
  }, [orders]);

  const paginatedOrders =
    rowsPerPage > 0
      ? sortedOrders.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage)
      : sortedOrders;

  const formatDate = (dateString) => {
    if (!dateString) return "----";
    const date = new Date(dateString);
    return Number.isNaN(date.getTime()) ? "----" : date.toLocaleString();
  };

  const formatPrice = (price) => {
    if (price === undefined || price === null) return "----";
    const numeric = Number(price);
    return Number.isNaN(numeric)
      ? "----"
      : `$${numeric.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`;
  };

  const handleChangePage = (_event, newPage) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = (event) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  const showTable = !loading && !error;

  return (
    <React.Fragment>
      <div style={{ minHeight: "200px", display: "flex", flexDirection: "column" }}>
        <Title>Order History</Title>

        {loading && (
          <Box sx={{ display: "flex", justifyContent: "center", py: 2 }}>
            <CircularProgress size={24} />
          </Box>
        )}

        {!loading && error && (
          <Typography color="error" sx={{ py: 2 }}>
            {error}
          </Typography>
        )}

        {showTable && (
          <React.Fragment>
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
                {paginatedOrders.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{row.symbol || "----"}</TableCell>
                    <TableCell>{row.order_type || "----"}</TableCell>
                    <TableCell>{row.side || "----"}</TableCell>
                    <TableCell>{row.qty || "----"}</TableCell>
                    <TableCell>{formatPrice(row.filled_avg_price)}</TableCell>
                    <TableCell>{row.status || "----"}</TableCell>
                    <TableCell>{formatDate(row.submitted_at || row.created_at)}</TableCell>
                  </TableRow>
                ))}
                {sortedOrders.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7}>
                      <Typography align="center">No orders available yet.</Typography>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>

            {sortedOrders.length > 0 && (
              <TablePagination
                component="div"
                count={sortedOrders.length}
                page={page}
                onPageChange={handleChangePage}
                rowsPerPage={rowsPerPage}
                onRowsPerPageChange={handleChangeRowsPerPage}
                rowsPerPageOptions={[5, 10, 25, 50]}
              />
            )}
          </React.Fragment>
        )}
      </div>
    </React.Fragment>
  );
};

export default Orders;
