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
  Alert,
  Tabs,
  MenuItem,
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

const RECURRENCE_OPTIONS = [
  { value: "every_minute", label: "Every minute" },
  { value: "every_5_minutes", label: "Every 5 minutes" },
  { value: "every_15_minutes", label: "Every 15 minutes" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

const Strategies = () => {
  const [collaborative, setcollaborative] = useState("");
  const [aifundbudget, setAiFundBudget] = useState("");

  const [strategyName, setstrategyName] = useState("");
  const [responseReceived, setResponseReceived] = useState(false);
  const { userData, setUserData } = useContext(UserContext);
  const [output, setOutput] = useState([]); 
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [value, setValue] = useState(0);
  const [aiFundStrategyEnabled, setAiFundStrategyEnabled] = useState(false);
  const [strategySummary, setStrategySummary] = useState("");
  const [strategyDecisions, setStrategyDecisions] = useState([]);
  const [collaborativeRecurrence, setCollaborativeRecurrence] = useState("daily");
  const [aiFundRecurrence, setAiFundRecurrence] = useState("daily");
  const [collaborativeSchedule, setCollaborativeSchedule] = useState(null);
  const [aiFundSchedule, setAiFundSchedule] = useState(null);

  useEffect(() => {
    const fetchStrategies = async () => {
      const headers = {
        "x-auth-token": userData.token,
      };

      const userID = userData.user.id;
      const url = config.base_url + `/api/strategies/all/${userID}`;

      try {
        const response = await Axios.get(url, { headers });

        if (response.status === 200) {
          if (response.data.status === "success") {
            const aiFundStrategy = response.data.strategies.find(strategy => strategy.strategy_id === "01");
            if (aiFundStrategy) {
              setAiFundStrategyEnabled(true);
            }
          } else {
            setError(response.data.message);
          }
        }
      } catch (err) {
        setError(err.message);
      }
    };

    fetchStrategies();
  }, []); // Empty array means this effect runs once on component mount


  const handleChange = (event, newValue) => {
    setValue(newValue);
  };


  const handleAIFundSubmit = async () => {
    setLoading(true);
    setAiFundSchedule(null);
  
    const headers = {
      "x-auth-token": userData.token,
    };
  
    const userID = userData.user.id;
    const url = config.base_url + "/api/strategies/aifund/enable";
  
    try {
    const response = await Axios.post(
      url,
      {
        userID,
        strategyName: "AI Fund",
        budget: aifundbudget,
        recurrence: aiFundRecurrence,
      },
      {headers}
    );
    
      if (response.status === 200) {
        if (response.data.status === "success") {
          setResponseReceived(true);
          setOutput(response.data.orders || []); 
          setAiFundSchedule(response.data.schedule || null);
        } else {
          setError(response.data.message);
        }
      }
      
    } catch (err) {
      setError(err.message);
      setAiFundSchedule(null);
    } finally {
      setLoading(false);
    }
  
    setAiFundStrategyEnabled(true);
  };
  
  
  const handleAIFundDisable = async () => {
    setLoading(true);
  
    const headers = {
      "x-auth-token": userData.token,
    };
  
    const userID = userData.user.id;
    const url = config.base_url + "/api/strategies/aifund/disable";
  
    try {
      const response = await Axios.post(url, {userID, strategyName: "AI Fund"}, {headers});
    
      if (response.status === 200) {
        if (response.data.status === "success") {
          setResponseReceived(true);
          setOutput(response.data.orders || []); 
        } else {
          setError(response.data.message);
        }
      }
      
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  
    setAiFundStrategyEnabled(false);
  };
  



  const handlecollaborativeSubmit = async (e) => {
    setError(null);
    setResponseReceived(false);
    setStrategySummary("");
    setStrategyDecisions([]);
    setOutput([]);
    setLoading(true);
    setCollaborativeSchedule(null);

    const headers = {
      "x-auth-token": userData.token,
    };

    const userID = userData.user.id;
    const url = config.base_url + "/api/strategies/collaborative/";

    try {
      const payload = {
        collaborative,
        userID,
        strategyName,
        recurrence: collaborativeRecurrence,
      };
      const response = await Axios.post(url, payload, {headers});
    
      if (response.status === 200) {
        if (response.data.status === "success") {
          setResponseReceived(true);
          setOutput(response.data.orders || []); 
          setStrategySummary(response.data.summary || "");
          setStrategyDecisions(response.data.decisions || []);
          setCollaborativeSchedule(response.data.schedule || null);
        } else {
          setError(response.data.message);
        }
      }
      
    } catch (err) {
      setError(err.message);
      setStrategySummary("");
      setStrategyDecisions([]);
      setCollaborativeSchedule(null);
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
                  variant="outlined"
                  label="Enter here the amount of money you want to invest in this strategy"
                  value={aifundbudget}
                  onChange={(e) => setAiFundBudget(e.target.value)}
                  fullWidth
                  margin="normal"
                />
              <TextField
                select
                variant="outlined"
                label="Rebalance frequency"
                value={aiFundRecurrence}
                onChange={(e) => setAiFundRecurrence(e.target.value)}
                fullWidth
                margin="normal"
              >
                {RECURRENCE_OPTIONS.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuItem>
                ))}
              </TextField>
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
                <p>The portfolio is automatically rebalanced based on market news headlines.</p>
                {aiFundSchedule && (
                  <p>
                    Frequency: {formatRecurrenceLabel(aiFundSchedule.recurrence)} · Next reallocation: {formatDateTime(aiFundSchedule.nextRebalanceAt)}
                  </p>
                )}
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
      <StyledPaper>
        
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
            {strategySummary && (
              <Box mt={2}>
                <Typography variant="subtitle1" gutterBottom>Strategy Overview</Typography>
                {strategySummary.split(/\n+/).map((paragraph, index) => (
                  <Typography key={index} variant="body2" paragraph>
                    {paragraph}
                  </Typography>
                ))}
              </Box>
            )}
            {collaborativeSchedule && (
              <Box mt={2}>
                <Typography variant="subtitle1" gutterBottom>Automation</Typography>
                <Typography variant="body2">
                  Frequency: {formatRecurrenceLabel(collaborativeSchedule.recurrence)} · Next reallocation: {formatDateTime(collaborativeSchedule.nextRebalanceAt)}
                </Typography>
              </Box>
            )}
            {strategyDecisions.length > 0 && (
              <Box mt={2}>
                <Typography variant="subtitle1" gutterBottom>Decision Breakdown</Typography>
                {strategyDecisions.map((decision, index) => (
                  <Box key={index} mb={1}>
                    <Typography variant="body2" fontWeight={600}>
                      {decision["Asset ticker"] || decision.symbol || `Asset ${index + 1}`}
                    </Typography>
                    <Typography variant="body2">
                      {decision.Rationale || decision.rationale || decision.reason || "No rationale provided."}
                    </Typography>
                  </Box>
                ))}
              </Box>
            )}
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
          <br />
          <Alert severity="warning">We are currently experiencing technical{" "}         
          <Link href="https://github.com/Louvivien/tradingapp/issues/4" target="_blank" rel="noopener noreferrer">
          issues
      </Link> with this feature </Alert>
          <br />
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
        <TextField
          select
          variant="outlined"
          label="Rebalance frequency"
          value={collaborativeRecurrence}
          onChange={(e) => setCollaborativeRecurrence(e.target.value)}
          fullWidth
          margin="normal"
        >
          {RECURRENCE_OPTIONS.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              {option.label}
            </MenuItem>
          ))}
        </TextField>
        <br />
        <br />

          <Button variant="contained" color="primary" className={styles.submit} onClick={handlecollaborativeSubmit}>
            Create this strategy
          </Button>
        </>
        </div>

        )}

    </Box>
    </StyledPaper>
    )}

  </Container>
);
};

export default Strategies;
  const formatRecurrenceLabel = (value) => {
    const option = RECURRENCE_OPTIONS.find((opt) => opt.value === value);
    return option ? option.label : value;
  };

  const formatDateTime = (value) => {
    if (!value) {
      return "—";
    }
    try {
      return new Date(value).toLocaleString();
    } catch (error) {
      return value;
    }
  };
