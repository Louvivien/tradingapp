import React from "react";
import { Grid, Typography, Card } from "@material-ui/core/";
import styles from "./Search.module.css";

const PriceCard = ({ pastDay }) => {
  return (
    <Grid container spacing={3}>
      <Grid item xs sm component={Card} className={styles.card}>
        <Typography color="textSecondary" align="center">
          Opening:
        </Typography>
        <Typography variant="h6" align="center">
          ${pastDay.adjOpen}
        </Typography>
      </Grid>
      <Grid item xs sm component={Card} className={styles.card}>
        <Typography color="textSecondary" align="center">
          High:
        </Typography>
        <Typography variant="h6" align="center">
          ${pastDay.adjHigh}
        </Typography>
      </Grid>
      <Grid item xs sm component={Card} className={styles.card}>
        <Typography color="textSecondary" align="center">
          Low:
        </Typography>
        <Typography variant="h6" align="center">
          ${pastDay.adjLow}
        </Typography>
      </Grid>
      <Grid item xs sm component={Card} className={styles.card}>
        <Typography color="textSecondary" align="center">
          Closing:
        </Typography>
        <Typography variant="h6" align="center">
          ${pastDay.adjClose}
        </Typography>
      </Grid>
    </Grid>
  );
};

export default PriceCard;
