import React, { useState, useEffect, useContext } from "react";
import UserContext from "../../context/UserContext";
import { TextField, Container, Grid, Box, Card } from "@mui/material";
import Autocomplete from "@mui/material/Autocomplete";
import { makeStyles } from "@mui/styles";
import LineChart from "../Template/LineChart";
import BarChart from "./BarChart";
import Copyright from "../Template/Copyright";
import styles from "./Search.module.css";
import Axios from "axios";
import InfoCard from "./InfoCard";
import PriceCard from "./PriceCard";
import PurchaseCard from "./PurchaseCard";
import PurchaseModal from "./PurchaseModal";
import config from "../../config/Config";



const useStyles = makeStyles({
  paper: {
    padding: '16px',
    display: "flex",
    overflow: "auto",
    flexDirection: "column",
    marginBottom: "40px",
  },
  container: {
    marginTop: "64px", 
    width: "100%", 
    paddingLeft: 0, 
    paddingRight: 0, 
  },
});

const LineChartCard = ({ pastDataPeriod, stockInfo, duration }) => {
  return (
    <Grid
      item
      xs={12}
      sm={7}
      component={Card}
      className={styles.card}
      style={{ minHeight: "350px" }}
    >
      <LineChart
        pastDataPeriod={pastDataPeriod}
        stockInfo={stockInfo}
        duration={duration}
      />
    </Grid>
  );
};

const BarChartCard = ({ sixMonthAverages, stockInfo }) => {
  return (
    <Grid item xs={12} sm component={Card} className={styles.card}>
      <BarChart sixMonthAverages={sixMonthAverages} stockInfo={stockInfo} />
    </Grid>
  );
};

const StockCard = ({ setPurchasedStocks, purchasedStocks, currentStock, accountBalance }) => {
  const { userData } = useContext(UserContext);
  const [selected, setSelected] = useState(false);
  const [stockInfo, setStockInfo] = useState(undefined);
  const [sixMonthAverages, setSixMonthAverages] = useState(undefined);
  const [pastDay, setPastDay] = useState(undefined);
  const [today, setToday] = useState(undefined);
  const [pastMonth, setPastMonth] = useState(undefined);
  const [pastTwoYears, setPastTwoYears] = useState(undefined);
  const [currentTicker, setCurrentTicker] = useState(null);

  useEffect(() => {
    if (!currentStock) return;
    if (!userData?.token) return;

    const headers = {
      "x-auth-token": userData.token,
    };

    const getInfo = async () => {
      const url = config.base_url + `/api/data/prices/${currentStock.ticker}`;
      const response = await Axios.get(url, { headers });
      if (response.data.status === "success") {
        setStockInfo(response.data.data);
      }
    };

    const getData = async () => {
      const url =
        config.base_url + `/api/data/prices/${currentStock.ticker}/full`;
      const response = await Axios.get(url, { headers });
      if (response.data.status === "success") {
        setSixMonthAverages(response.data.sixMonthAverages);
        setPastDay(response.data.pastDay);
        setToday(response.data.today);
        setPastMonth(response.data.pastMonth);
        setPastTwoYears(response.data.pastTwoYears);
      }
    };

    getInfo();
    getData();
  }, [currentStock, userData?.token]);

  return (
    <div className={styles.root}>
      {stockInfo && pastDay && (
        <InfoCard stockInfo={stockInfo} price={pastDay.adjClose} />
      )}
      {stockInfo && sixMonthAverages && pastDay && pastMonth && pastTwoYears && (
        <div>
          <Grid container spacing={3}>


            <LineChartCard
              pastDataPeriod={pastTwoYears}
              stockInfo={stockInfo}
              duration={"2 years"}
            />
            <BarChartCard
              sixMonthAverages={sixMonthAverages}
              stockInfo={stockInfo}
            />
          </Grid>
          <PriceCard pastDay={pastDay} />
          <Grid container spacing={3}>
            <PurchaseCard
              setSelected={setSelected}
              accountBalance={accountBalance}
            />
            <LineChartCard
              pastDataPeriod={pastMonth}
              stockInfo={stockInfo}
              duration={"month"}
            />
          </Grid>
          <Box pt={4}>
            <Copyright />
          </Box>
          {selected && (
            <PurchaseModal
              stockInfo={stockInfo}
              today={today}
              pastDay={pastDay}
              setSelected={setSelected}
              setPurchasedStocks={setPurchasedStocks}
              purchasedStocks={purchasedStocks}
              accountBalance={accountBalance}


            />
          )}
        </div>
      )}
    </div>
  );
};

const Search = ({ setPurchasedStocks, purchasedStocks, accountBalance }) => {
  const classes = useStyles();
  const { userData } = useContext(UserContext);
  const [value, setValue] = useState(null);
  const [currentStock, setCurrentStock] = useState(null);
  const [options, setOptions] = useState([]);
  const [inputValue, setInputValue] = useState('');

  const onInputChange = (event, newValue) => {
    setInputValue(newValue);
  };


  useEffect(() => {
    if (inputValue !== '') {
      fetchOptions(inputValue);
    }
  }, [inputValue]);

  const onSearchChange = (event, newValue) => {
    setValue(newValue);
    if (newValue) {
      setCurrentStock(newValue);
    } else {
      setCurrentStock(null);
    }
  };


  const fetchOptions = async (value) => {
    const headers = {
      "x-auth-token": userData.token,
    };
    const url = config.base_url + `/api/stock/search/${userData.user.id}/${value || ''}`;
    const response = await Axios.get(url, { headers });
    if (response.data.status === 'success') {
      setOptions(response.data.data);
    }
  };



  return (
    <Container className={`${classes.container} ${classes.addMargin}`}> 

      <Autocomplete
        value={value}
        onChange={onSearchChange}
        onInputChange={onInputChange}
        filterOptions={(options, params) => {
          return options.filter(
            (option) =>
              option.name.toLowerCase().includes(params.inputValue.toLowerCase()) ||
              option.ticker.toLowerCase().includes(params.inputValue.toLowerCase())
          );
        }}

        selectOnFocus
        clearOnBlur
        handleHomeEndKeys
        id="stock-search-bar"
        options={options}
        getOptionLabel={(option) => {
          return option.name || "";
        }}
        isOptionEqualToValue={(option, value) => option.ticker === value.ticker}
        renderOption={(props, option, { selected }) => (
          <li {...props}>
            {option.name}
          </li>
        )}
        style={{
          maxWidth: "700px",
          margin: "30px auto",
          marginBottom: "60px",
          maxHeight: 200
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Search for a stock"
            variant="outlined"
          />
        )}

      />



      {currentStock && (
        <StockCard
          setPurchasedStocks={setPurchasedStocks}
          purchasedStocks={purchasedStocks}
          currentStock={currentStock}
          accountBalance={accountBalance}


        />
      )}
      <br />

      <br />
      <br />
    </Container>
  );
};



export default Search;
