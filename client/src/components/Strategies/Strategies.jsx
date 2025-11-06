import React, { useState, useContext, useEffect, useCallback, useMemo } from "react";
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
  const [collaborativeCashLimit, setCollaborativeCashLimit] = useState("");
  const [responseReceived, setResponseReceived] = useState(false);
  const { userData, setUserData } = useContext(UserContext);
  const authToken = userData?.token;
  const userId = userData?.user?.id;
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
  const [savedStrategies, setSavedStrategies] = useState([]);
  const [librarySelection, setLibrarySelection] = useState("");
  const [activeLibraryStrategyId, setActiveLibraryStrategyId] = useState(null);
  const [loadedStrategyContent, setLoadedStrategyContent] = useState("");

  const fetchStrategies = useCallback(async () => {
    if (!authToken || !userId) {
      setSavedStrategies([]);
      setAiFundStrategyEnabled(false);
      return;
    }

    const headers = {
      "x-auth-token": authToken,
    };

    const url = `${config.base_url}/api/strategies/all/${userId}`;

    try {
      const response = await Axios.get(url, { headers });

      if (response.status === 200 && response.data.status === "success") {
        const strategies = Array.isArray(response.data.strategies) ? response.data.strategies : [];
        setSavedStrategies(strategies);
        const aiFundStrategy = strategies.find((strategy) => strategy.isAIFund);
        setAiFundStrategyEnabled(Boolean(aiFundStrategy));
      } else if (response.data?.message) {
        console.warn(response.data.message);
      }
    } catch (err) {
      console.error("Failed to fetch strategies:", err);
    }
  }, [authToken, userId]);

  useEffect(() => {
    fetchStrategies();
  }, [fetchStrategies]);

  const collaborativeLibrary = useMemo(
    () => savedStrategies.filter((item) => !item.isAIFund),
    [savedStrategies]
  );

  const selectedLibraryStrategy = useMemo(
    () => collaborativeLibrary.find((item) => item.id === librarySelection) || null,
    [collaborativeLibrary, librarySelection]
  );

  useEffect(() => {
    if (librarySelection && !collaborativeLibrary.some((item) => item.id === librarySelection)) {
      setLibrarySelection("");
    }
  }, [librarySelection, collaborativeLibrary]);

  useEffect(() => {
    if (activeLibraryStrategyId && !collaborativeLibrary.some((item) => item.id === activeLibraryStrategyId)) {
      setActiveLibraryStrategyId(null);
      setLoadedStrategyContent("");
    }
  }, [activeLibraryStrategyId, collaborativeLibrary]);


  const handleLibrarySelect = (event) => {
    const { value } = event.target;
    setLibrarySelection(value);
  };

  const handleLoadSavedStrategy = () => {
    if (!selectedLibraryStrategy) {
      return;
    }
    setcollaborative(selectedLibraryStrategy.strategy || "");
    setstrategyName(selectedLibraryStrategy.name || "");
    if (selectedLibraryStrategy.recurrence) {
      setCollaborativeRecurrence(selectedLibraryStrategy.recurrence);
    }
    setActiveLibraryStrategyId(selectedLibraryStrategy.id);
    setLoadedStrategyContent(selectedLibraryStrategy.strategy || "");
  };

  const handleCollaborativeChange = (event) => {
    const { value } = event.target;
    setcollaborative(value);
    if (activeLibraryStrategyId && value !== loadedStrategyContent) {
      setActiveLibraryStrategyId(null);
      setLoadedStrategyContent("");
    }
  };

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
          await fetchStrategies();
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
          await fetchStrategies();
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
    if (!strategyName || !strategyName.trim()) {
      setError("Please provide a strategy name.");
      return;
    }

    if (!collaborativeCashLimit || Number(collaborativeCashLimit) <= 0) {
      setError("Please provide a positive cash limit for this strategy.");
      return;
    }

    setError(null);
    setResponseReceived(false);
    setStrategySummary("");
    setStrategyDecisions([]);
    setOutput([]);
    setCollaborativeSchedule(null);
    setLoading(true);

    if (!authToken || !userId) {
      setError("Please log in again.");
      setLoading(false);
      return;
    }

    const headers = {
      "x-auth-token": authToken,
    };
    const url = config.base_url + "/api/strategies/collaborative/";

    try {
      const payload = {
        collaborative,
        userID: userId,
        strategyName,
        recurrence: collaborativeRecurrence,
        cashLimit: collaborativeCashLimit,
      };
      if (activeLibraryStrategyId) {
        payload.sourceStrategyId = activeLibraryStrategyId;
      }
      const response = await Axios.post(url, payload, {headers});
    
      if (response.status === 200) {
        if (response.data.status === "success") {
          setResponseReceived(true);
          setOutput(response.data.orders || []); 
          setStrategySummary(response.data.summary || "");
          setStrategyDecisions(response.data.decisions || []);
          setCollaborativeSchedule(response.data.schedule || null);
          const newStrategyId = response.data.strategyId || null;
          await fetchStrategies();
          if (newStrategyId) {
            setLibrarySelection(newStrategyId);
            setActiveLibraryStrategyId(newStrategyId);
            setLoadedStrategyContent(collaborative);
          }
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
    <Typography variant="body1" size="small">
      Here you can copy paste a strategy from{" "}  
      <Link href="https://app.composer.trade/discover?sort=annualized_return&dir=desc" target="_blank" rel="noopener noreferrer">
         Composer
      </Link>
    </Typography>
          
          <>
            {collaborativeLibrary.length > 0 && (
              <Box>
                <Typography variant="body2" color="textSecondary" gutterBottom>
                  Start from one of your saved strategies
                </Typography>
                <TextField
                  select
                  variant="outlined"
                  label="Saved strategies"
                  value={librarySelection}
                  onChange={handleLibrarySelect}
                  fullWidth
                  margin="normal"
                >
                  <MenuItem value="">
                    Select a saved strategy
                  </MenuItem>
                  {collaborativeLibrary.map((strategyOption) => (
                    <MenuItem key={strategyOption.id} value={strategyOption.id}>
                      {strategyOption.name}
                    </MenuItem>
                  ))}
                </TextField>
                {selectedLibraryStrategy && (
                  <Box mt={2} p={2} sx={{ border: '1px solid #e0e0e0', borderRadius: 1 }}>
                    <Typography variant="subtitle2" gutterBottom>
                      Saved Strategy Overview
                    </Typography>
                    <Typography variant="body2">
                      <strong>Rebalance:</strong> {formatRecurrenceLabel(selectedLibraryStrategy.recurrence)}
                    </Typography>
                    <Typography variant="body2">
                      <strong>Last updated:</strong> {formatDateTime(selectedLibraryStrategy.updatedAt)}
                    </Typography>
                    {selectedLibraryStrategy.summary && (
                      <Box mt={1}>
                        <Typography variant="body2" fontWeight={600}>Summary</Typography>
                        <Typography variant="body2" sx={{ whiteSpace: 'pre-line' }}>
                          {selectedLibraryStrategy.summary}
                        </Typography>
                      </Box>
                    )}
                    <Box
                      mt={1}
                      sx={{
                        maxHeight: 220,
                        overflowY: 'auto',
                        whiteSpace: 'pre-line',
                        backgroundColor: '#fafafa',
                        borderRadius: 1,
                        p: 1.5,
                      }}
                    >
                      <Typography variant="body2">
                        {selectedLibraryStrategy.strategy || "No strategy content available."}
                      </Typography>
                    </Box>
                    {selectedLibraryStrategy.decisions && selectedLibraryStrategy.decisions.length > 0 && (
                      <Box mt={1}>
                        <Typography variant="body2" fontWeight={600}>Decision Breakdown</Typography>
                        {selectedLibraryStrategy.decisions.map((decision, index) => (
                          <Box key={index} mb={0.5}>
                            <Typography variant="body2" fontWeight={600}>
                              {decision["Asset ticker"] || decision.symbol || `Decision ${index + 1}`}
                            </Typography>
                            <Typography variant="body2">
                              {decision.Rationale || decision.rationale || decision.reason || "No rationale provided."}
                            </Typography>
                          </Box>
                        ))}
                      </Box>
                    )}
                    <Box mt={2} display="flex" alignItems="center" gap={2} flexWrap="wrap">
                      <Button variant="outlined" onClick={handleLoadSavedStrategy}>
                        Load into editor
                      </Button>
                      {activeLibraryStrategyId === selectedLibraryStrategy.id && (
                        <Typography variant="caption" color="success.main">
                          Loaded in editor
                        </Typography>
                      )}
                    </Box>
                  </Box>
                )}
              </Box>
            )}
            <TextField
              multiline
              rows={4}
              variant="outlined"
              label="Paste your strategy here"
              value={collaborative}
              onChange={handleCollaborativeChange}
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
              variant="outlined"
              label="Cash limit for this strategy"
              value={collaborativeCashLimit}
              onChange={(e) => setCollaborativeCashLimit(e.target.value)}
              fullWidth
              margin="normal"
              type="number"
              inputProps={{ min: 0, step: "0.01" }}
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

            <Button
              variant="contained"
              color="primary"
              className={styles.submit}
              onClick={handlecollaborativeSubmit}
              disabled={loading}
            >
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
