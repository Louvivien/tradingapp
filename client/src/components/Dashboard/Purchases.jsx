import React, { useState, useEffect, useContext } from "react";
import UserContext from "../../context/UserContext";
import Link from "@material-ui/core/Link";
import { makeStyles } from "@material-ui/core/styles";
import Table from "@material-ui/core/Table";
import TableBody from "@material-ui/core/TableBody";
import TableCell from "@material-ui/core/TableCell";
import TableHead from "@material-ui/core/TableHead";
import TableRow from "@material-ui/core/TableRow";
import Title from "../Template/Title.jsx";
import Axios from "axios";

const useStyles = makeStyles((theme) => ({
  seeMore: {
    marginTop: theme.spacing(3),
  },
}));

const Purchases = () => {
  const classes = useStyles();
  const { userData, setUserData } = useContext(UserContext);
  const [purchases, setPurchases] = useState([]);

  useEffect(() => {
    const getPurchases = async () => {
      const url = `http://127.0.0.1:5000/api/stock/${userData.user.id}`;
      const headers = {
        "x-auth-token": userData.token,
      };

      const response = await Axios.get(url, {
        headers,
      });

      if (response.data.status === "success") {
        setPurchases(response.data.stocks);
      }
    };

    getPurchases();
  }, []);

  const preventDefault = (e) => {
    e.preventDefault();
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
              <TableCell align="right">Price of Purchase</TableCell>
              <TableCell align="right">Current Price</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {purchases.map((row) => (
              <TableRow key={row._id}>
                <TableCell>{row.ticker}</TableCell>
                <TableCell>XXX</TableCell>
                <TableCell>{row.quantity}</TableCell>
                <TableCell align="right">${row.price}</TableCell>
                <TableCell align="right">XXX</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className={classes.seeMore}>
          <Link color="primary" href="#" onClick={preventDefault}>
            See more orders
          </Link>
        </div>
      </div>
    </React.Fragment>
  );
};

export default Purchases;
