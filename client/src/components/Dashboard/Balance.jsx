import React, { useContext } from "react";
import UserContext from "../../context/UserContext";
import { Link, Typography } from "@material-ui/core/";
import Title from "../Template/Title.jsx";
import styles from "./Balance.module.css";

function preventDefault(event) {
  event.preventDefault();
}

const Balance = () => {
  const { userData } = useContext(UserContext);

  return (
    <React.Fragment>
      <Title>Current Balance</Title>
      <br />
      <br />
      <Typography
        component="p"
        variant="h4"
        align="center"
        className={
          Number(userData.user.balance) >= 0 ? styles.positive : styles.negative
        }
      >
        ${userData ? userData.user.balance.toLocaleString() : "$---"}
      </Typography>
      <div className={styles.depositContext}>
        <Typography color="textSecondary" align="center">
          {new Date().toDateString()}
        </Typography>
      </div>
      <div>
        <Link color="primary" href="#" onClick={preventDefault}>
          View detailed report
        </Link>
      </div>
    </React.Fragment>
  );
};

export default Balance;
