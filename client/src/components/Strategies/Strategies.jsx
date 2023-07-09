import React, { useState, useContext, useEffect } from "react";
import UserContext from "../../context/UserContext";
import {
  Typography,
  Container,
  Grid,
  Card,
  CardMedia,
  CardContent,
  Link,
  Box,
  TextField,
  Paper,
  Button,
  Tab,
  Tabs
} from "@mui/material";
import { styled } from "@mui/system";
import Skeleton from "@mui/lab/Skeleton";
import Axios from "axios";
import config from "../../config/Config";
import Title from "../Template/Title.jsx";
import styles from "./Strategies.module.css";



const StyledPaper = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(2),
  display: "flex",
  overflow: "auto",
  flexDirection: "column",
}));

const FixedHeightPaper = styled(StyledPaper)({
  height: 450,
});


const Strategies = () => {
  const [collaborative, setcollaborative] = useState("");
  const [aifundparams, setaifundparams] = useState("");

  const [strategyName, setstrategyName] = useState("");
  const [responseReceived, setResponseReceived] = useState(false);
  const { userData, setUserData } = useContext(UserContext);
  const [output, setOutput] = useState(""); 
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [value, setValue] = useState(0);
  const [aiFundStrategyEnabled, setAiFundStrategyEnabled] = useState(false);



  const handleChange = (event, newValue) => {
    setValue(newValue);
  };


  const handleAIFundSubmit = () => {
    setAiFundStrategyEnabled(true);
  };

  const handleAIFundDisable = () => {
    setAiFundStrategyEnabled(false);
  };



  const handlecollaborativeSubmit = async (e) => {
    setLoading(true);


    const headers = {
      "x-auth-token": userData.token,
    };

    const userID = userData.user.id;
    const url = config.base_url + "/api/strategies/collaborative/";

    try {
      // console.log("About to send request:", url, {collaborative, userID, strategyName}, {headers});
      const response = await Axios.post(url, {collaborative, userID, strategyName}, {headers});
    
      if (response.status === 200) {
        if (response.data.status === "success") {
          setResponseReceived(true);
          setOutput(response.data.orders); 
          // console.log(response);
        } else {
          setError(response.data.message);
        }
      }
      
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    



};


return (
  <Container sx={{ pt: 8, pb: 8 }}>
    <Typography variant="subtitle1">Add a trading strategy for automated trading</Typography>

    <br />
    <br />

    <Tabs value={value} onChange={handleChange} aria-label="strategy tabs">
      <Tab label="AI Fund Strategy" />
      <Tab label="Collaborative Strategy" />
    </Tabs>
    {value === 0 && (
      <StyledPaper>
        <Box>
          <Title>AI Fund Strategy</Title>
          {!aiFundStrategyEnabled ? (
            <>
              <Typography color="textSecondary" align="left">Setup your AI fund strategy</Typography>
              <Typography variant="body1" size="small">
                Here you can setup your AI fund strategy:
              </Typography>
              <TextField
                  multiline
                  rows={4}
                  variant="outlined"
                  label="Set up the parameters for your AI fund strategy here"
                  value={aifundparams}
                  onChange={(e) => setaifundparams(e.target.value)}
                  fullWidth
                  margin="normal"
                />
              <br />
              <Button variant="contained" color="primary" className={styles.submit} onClick={handleAIFundSubmit}>
                Create this strategy
              </Button>
            </>
          ) : (
            <>
              <div style={{border: '1px solid #ccc', padding: '10px', borderRadius: '5px'}}>
                <p>This strategy is enabled, you can find the stocks from this strategy in your dashboard</p>
                <p>It buys and sell stocks selected by AI based on a sentiment analysis of news headlines</p>
                <p>Based on the sentiment analysis, a scoring is done of the stocks</p>
                <p>The strategy buys only the stocks with the most positve headlines</p>
                <p>The portfolio is automatically rebalanced every day base on market news headlines.</p>
              </div>
              <br />
              <Button variant="contained" color="success" className={styles.submit} >
                Strategy Enabled
              </Button>
              <Button variant="contained" color="error" className={styles.submit} onClick={handleAIFundDisable}>
                X
              </Button>
            </>



          )}
        </Box>
      </StyledPaper>
    )}

    {value === 1 && (
      <FixedHeightPaper>
        
    <Box>
      <Title>Collaborative strategy</Title>
              <Typography color="textSecondary" align="left">Add a collaborative strategy</Typography>
        {loading ? (
          <div> 
          <br />
          <br />
            <div>Loading... It usually takes around 4 minutes to create the strategy</div>
          </div>  
        ) : responseReceived ? (
          <div>
          <br />
          <br />
            <Typography variant="h6">Strategy successfully added. Here are the orders:</Typography>
            {output.map((order, index) => (
              <Typography key={index} variant="body2">
                Quantity: {order.qty}, Symbol: {order.symbol}
              </Typography>
            ))}
          </div>
        ) : error ? (
          <div> 
        <br />
        <br />
          <div style={{color: 'red'}}>Error: {error}</div>

          </div>  

        ) : (

        <div>
    <Typography variant="body1" size="small">
      Here you can copy paste a strategy from{" "}  
      <Link href="https://www.composer.trade/" target="_blank" rel="noopener noreferrer">
         Composer
      </Link>
    </Typography>
          
          <>
          <TextField
            multiline
            rows={4}
            variant="outlined"
            label="Paste your strategy here"
            value={collaborative}
            onChange={(e) => setcollaborative(e.target.value)}
            fullWidth
            margin="normal"
          />
        <br />

        <TextField
              variant="outlined"
              id="strategyName"
              label="Give a name to your strategy"
              name="strategyName"
              value={strategyName}
              onChange={(e) => setstrategyName(e.target.value)}
              fullWidth

              />
        <br />
        <br />

          <Button variant="contained" color="primary" className={styles.submit} onClick={handlecollaborativeSubmit}>
            Create this strategy
          </Button>
        </>
        </div>

        )}

    </Box>
      </FixedHeightPaper>
    )}

  </Container>
);
};

export default Strategies;
