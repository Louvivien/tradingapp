import React from "react";
import { Typography } from "@material-ui/core";
import PageTemplate from "../Template/PageTemplate";
import styles from "../Dashboard/Dashboard.module.css";
import { makeStyles } from "@material-ui/core/styles";

const useStyles = makeStyles((theme) => ({
  appBarSpacer: theme.mixins.toolbar,
}));

const News = () => {
  const classes = useStyles();

  return <Typography>News</Typography>;
};

export default News;
