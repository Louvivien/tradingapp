import React, { useState, useEffect } from "react";
import {
  TextField,
  Container,
  Typography,
  Grid,
  Box,
  Card,
  CardHeader,
  CardContent,
  Button,
  IconButton,
} from "@material-ui/core/";
import Autocomplete, {
  createFilterOptions,
} from "@material-ui/lab/Autocomplete";
import { makeStyles } from "@material-ui/core/styles";
import LineChart from "./LineChart";
import BarChart from "./BarChart";
import Copyright from "../Template/Copyright";
import Title from "../Template/Title";
import styles from "./Search.module.css";
import clsx from "clsx";
import { motion } from "framer-motion";
import CloseIcon from "@material-ui/icons/Close";
import Axios from "axios";

const filter = createFilterOptions();

const useStyles = makeStyles((theme) => ({
  paper: {
    padding: theme.spacing(2),
    display: "flex",
    overflow: "auto",
    flexDirection: "column",
    marginBottom: "40px",
  },
}));

const BodyText = ({ text }) => {
  return (
    <Typography variant="body2" color="inherit" align="center" display="block">
      {text}
    </Typography>
  );
};

const HeaderText = ({ text }) => {
  return (
    <Typography variant="body1" color="inherit" align="center" display="block">
      {text}
    </Typography>
  );
};

const InfoCard = ({ stockInfo }) => {
  return (
    <Grid container spacing={3}>
      <Grid
        item
        xs={12}
        component={Card}
        className={clsx(styles.card, styles.cardBorder)}
      >
        <CardContent>
          <Title>{stockInfo.name}</Title>
          <Typography variant="body2">{stockInfo.description}</Typography>
          <Grid container spacing={3} className={styles.addMargin}>
            <Grid item sm={3} xs={4} className={styles.centerGrid}>
              <div className={styles.information}>
                <HeaderText text={"Stock Symbol:"} />
                <BodyText text={stockInfo.ticker} />
              </div>
            </Grid>
            <Grid item sm={3} xs={4} className={styles.centerGrid}>
              <div className={styles.information}>
                <HeaderText text={"Current Price:"} />
                <BodyText text={"$126.47"} />
              </div>
            </Grid>
            <Grid item sm={3} xs={4} className={styles.centerGrid}>
              <div className={styles.information}>
                <HeaderText text={"Exchange:"} />
                <BodyText text={stockInfo.exchangeCode} />
              </div>
            </Grid>
          </Grid>
        </CardContent>
      </Grid>
    </Grid>
  );
};

const LineChartCard = () => {
  return (
    <Grid
      item
      xs={12}
      sm={7}
      component={Card}
      className={styles.card}
      style={{ minHeight: "300px" }}
    >
      <LineChart />
    </Grid>
  );
};

const BarChartCard = () => {
  return (
    <Grid item xs={12} sm component={Card} className={styles.card}>
      <BarChart />
    </Grid>
  );
};

const PriceCard = () => {
  return (
    <Grid container spacing={3}>
      <Grid item xs sm component={Card} className={styles.card}>
        <Typography color="textSecondary" align="center">
          Opening:
        </Typography>
        <Typography variant="h6" align="center">
          $169.34
        </Typography>
      </Grid>
      <Grid item xs sm component={Card} className={styles.card}>
        <Typography color="textSecondary" align="center">
          High:
        </Typography>
        <Typography variant="h6" align="center">
          $169.34
        </Typography>
      </Grid>
      <Grid item xs sm component={Card} className={styles.card}>
        <Typography color="textSecondary" align="center">
          Low:
        </Typography>
        <Typography variant="h6" align="center">
          $169.34
        </Typography>
      </Grid>
      <Grid item xs sm component={Card} className={styles.card}>
        <Typography color="textSecondary" align="center">
          Closing:
        </Typography>
        <Typography variant="h6" align="center">
          $169.34
        </Typography>
      </Grid>
    </Grid>
  );
};

const PurchaseCard = ({ setSelected }) => {
  return (
    <Grid item xs={12} sm component={Card} className={styles.card}>
      <br />
      <Typography
        color="textSecondary"
        align="center"
        className={styles.addMargin}
      >
        Your Cash Balance:
      </Typography>
      <Typography variant="h6" align="center">
        $57,257.23
      </Typography>
      <br />
      <Typography variant="body2" align="center" className={styles.addMargin}>
        You have sufficient funds to buy this stock.
      </Typography>
      <Box display="flex" justifyContent="center">
        <Button
          type="submit"
          variant="contained"
          color="primary"
          className={styles.submit}
          onClick={() => setSelected(true)}
        >
          Open Purchase System
        </Button>
      </Box>
    </Grid>
  );
};

const PurchaseModal = ({ setSelected }) => {
  return (
    <motion.div
      className={styles.backdrop}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      id="backdrop"
    >
      <Container>
        <motion.div animate={{ opacity: 1, y: -20 }}>
          <PurchaseModalContent setSelected={setSelected} />
        </motion.div>
      </Container>
    </motion.div>
  );
};

const PurchaseModalContent = ({ setSelected }) => {
  const [quantity, setQuantity] = useState(1);

  const handleQuantityChange = (e) => {
    setQuantity(e.target.value);
  };

  const handleClick = (e) => {
    setSelected(false);
  };

  return (
    <Grid
      container
      spacing={0}
      direction="column"
      alignItems="center"
      justify="center"
      style={{ minHeight: "100vh" }}
    >
      <Box width="60vh" boxShadow={1}>
        <Card className={styles.paper}>
          <CardHeader
            action={
              <IconButton aria-label="Close" onClick={handleClick}>
                <CloseIcon />
              </IconButton>
            }
          />
          <CardContent>
            <Typography component="h1" variant="h6" align="center">
              Purchase Amazon Stock
            </Typography>
            <form className={styles.form} onSubmit={(e) => e.preventDefault()}>
              <TextField
                variant="outlined"
                margin="normal"
                fullWidth
                disabled
                id="stock"
                label="Stock Name"
                name="stock"
                autoComplete="stock"
                value={"Amazon"}
              />
              <TextField
                variant="outlined"
                margin="normal"
                fullWidth
                disabled
                id="price"
                label="Stock Price"
                name="price"
                autoComplete="price"
                value={"123.34"}
              />
              <TextField
                variant="outlined"
                margin="normal"
                required
                fullWidth
                id="quantity"
                label="Quantity"
                name="quantity"
                autoComplete="quantity"
                value={quantity}
                onChange={handleQuantityChange}
              />
              <Typography
                variant="body2"
                align="center"
                className={styles.addMargin}
              >
                Total = 123.34
              </Typography>
              <Typography variant="body2" align="center">
                Cash Balance after purchase: 52,378.29
              </Typography>
              <Box display="flex" justifyContent="center">
                <Button
                  type="submit"
                  variant="contained"
                  color="primary"
                  className={styles.submit}
                >
                  Confirm
                </Button>
              </Box>
            </form>
            <br />
            <br />
          </CardContent>
        </Card>
      </Box>
    </Grid>
  );
};

const StockCard = ({ currentStock }) => {
  const [selected, setSelected] = useState(false);
  const [stockInfo, setStockInfo] = useState(undefined);

  useEffect(() => {
    const getInfo = async () => {
      const url = `http://127.0.0.1:5000/api/stock/${currentStock.ticker}`;
      const response = await Axios.get(url);
      if (response.data.status === "success") {
        setStockInfo(response.data.data);
      }
    };

    getInfo();
  });

  if (stockInfo) {
    return (
      <div className={styles.root}>
        <InfoCard stockInfo={stockInfo} />
        <Grid container spacing={3}>
          <LineChartCard />
          <BarChartCard />
        </Grid>
        <PriceCard />
        <Grid container spacing={3}>
          <PurchaseCard setSelected={setSelected} />
          <LineChartCard />
        </Grid>
        <Box pt={4}>
          <Copyright />
        </Box>
        {selected && (
          <PurchaseModal selected={selected} setSelected={setSelected} />
        )}
      </div>
    );
  } else {
    return <Typography>Loading...</Typography>;
  }
};

const Search = () => {
  const classes = useStyles();
  const [value, setValue] = useState(null);
  const [currentStock, setCurrentStock] = useState(null);

  const onSearchChange = (event, newValue) => {
    setValue(newValue);
    if (newValue) {
      setCurrentStock(newValue);
    } else {
      setCurrentStock(null);
    }
  };

  return (
    <Container className={classes.addMargin}>
      <Autocomplete
        value={value}
        onChange={onSearchChange}
        filterOptions={(options, params) => {
          let filtered = filter(options, params);
          if (currentStock) {
            filtered = filtered.slice(0, 4);
          }
          return filtered;
        }}
        selectOnFocus
        clearOnBlur
        handleHomeEndKeys
        id="stock-search-bar"
        options={stocks}
        getOptionLabel={(option) => {
          return option.name;
        }}
        renderOption={(option) => option.name}
        style={{
          maxWidth: "700px",
          margin: "30px auto",
          marginBottom: "60px",
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Search for a stock"
            variant="outlined"
          />
        )}
      />
      {currentStock && <StockCard currentStock={currentStock} />}
      <br />
      <br />
      <br />
    </Container>
  );
};

const stocks = [
  { name: "Apple", ticker: "AAPL" },
  { name: "Amazon", ticker: "AMZN" },
  { name: "Google", ticker: "GOOG" },
  { name: "Microsoft", ticker: "MSFT" },
  { name: "Walmart", ticker: "WMT" },
  { name: "Intel", ticker: "INTC" },
  { name: "American Express", ticker: "AXP" },
  { name: "Boeing", ticker: "BA" },
  { name: "Cisco", ticker: "CSCO" },
  { name: "Goldman Sachs", ticker: "GS" },
  { name: "Johson & Johnson", ticker: "JNJ" },
  { name: "Coca-Cola", ticker: "KO" },
  { name: "McDonald's", ticker: "MCD" },
  { name: "Nike", ticker: "NKE" },
  { name: "Procters & Gamble", ticker: "PG" },
  { name: "Verizon", ticker: "VZ" },
  { name: "Salesforce", ticker: "CRM" },
  { name: "Visa", ticker: "V" },
  { name: "UnitedHealth", ticker: "UNH" },
  { name: "IBM", ticker: "IBM" },
  { name: "Chevron", ticker: "CVX" },
];

export default Search;
