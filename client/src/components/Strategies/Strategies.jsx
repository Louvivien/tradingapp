import React, { useState, useContext, useEffect, useCallback, useMemo, useRef } from "react";
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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress,
  Divider,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from "@mui/material";
import { styled } from "@mui/system";
import Skeleton from "@mui/lab/Skeleton";
import Axios from "axios";
import config from "../../config/Config";
import Title from "../Template/Title.jsx";
import LineChartPort from "../Template/LineChartPort.jsx";
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
  const [symphonyUrl, setSymphonyUrl] = useState("");
  const [collaborativeCashLimit, setCollaborativeCashLimit] = useState("");
  const [polymarketStrategyName, setPolymarketStrategyName] = useState("");
  const [polymarketAddress, setPolymarketAddress] = useState("");
  const [polymarketCashLimit, setPolymarketCashLimit] = useState("");
  const [polymarketApiKey, setPolymarketApiKey] = useState("");
  const [polymarketSecret, setPolymarketSecret] = useState("");
  const [polymarketPassphrase, setPolymarketPassphrase] = useState("");
  const [polymarketRecurrence, setPolymarketRecurrence] = useState("every_minute");
  const [polymarketSchedule, setPolymarketSchedule] = useState(null);
  const [polymarketResponseReceived, setPolymarketResponseReceived] = useState(false);
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
  const [strategyTemplates, setStrategyTemplates] = useState([]);
  const [librarySelection, setLibrarySelection] = useState("");
  const [activeLibraryStrategyId, setActiveLibraryStrategyId] = useState(null);
  const [loadedStrategyContent, setLoadedStrategyContent] = useState("");
  const [currentJobId, setCurrentJobId] = useState(null);
  const [progressEvents, setProgressEvents] = useState([]);
  const [localEvalLoading, setLocalEvalLoading] = useState(false);
  const [localEvalResult, setLocalEvalResult] = useState(null);
  const [evaluationJobs, setEvaluationJobs] = useState([]);
  const [evaluationError, setEvaluationError] = useState(null);
  const progressSourceRef = useRef(null);
  const evaluationPollRef = useRef(null);
  const [backtestOpen, setBacktestOpen] = useState(false);
  const [backtestStartDate, setBacktestStartDate] = useState("");
  const [backtestEndDate, setBacktestEndDate] = useState("");
  const [backtestCostBps, setBacktestCostBps] = useState("1");
  const [backtestLoading, setBacktestLoading] = useState(false);
  const [backtestResult, setBacktestResult] = useState(null);
  const [backtestError, setBacktestError] = useState(null);

  const toISODateInput = (value) => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    return date.toISOString().slice(0, 10);
  };

  const formatPct = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return "—";
    }
    return `${(num * 100).toFixed(1)}%`;
  };

  const formatNumber = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return "—";
    }
    return num.toFixed(3);
  };

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
        /* eslint-disable-next-line no-console */
        console.warn(response.data.message);
      }
    } catch (err) {
      /* eslint-disable-next-line no-console */
      console.error("Failed to fetch strategies:", err);
    }
  }, [authToken, userId]);

  useEffect(() => {
    fetchStrategies();
  }, [fetchStrategies]);

  const fetchStrategyTemplates = useCallback(async () => {
    if (!authToken || !userId) {
      setStrategyTemplates([]);
      return;
    }

    const headers = {
      "x-auth-token": authToken,
    };

    const url = `${config.base_url}/api/strategies/templates/${userId}`;

    try {
      const response = await Axios.get(url, { headers });
      if (response.status === 200 && response.data.status === "success") {
        setStrategyTemplates(
          Array.isArray(response.data.templates) ? response.data.templates : []
        );
      }
    } catch (err) {
      /* eslint-disable-next-line no-console */
      console.error("Failed to fetch strategy templates:", err);
    }
  }, [authToken, userId]);

  useEffect(() => {
    fetchStrategyTemplates();
  }, [fetchStrategyTemplates]);

  const collaborativeLibrary = useMemo(() => {
    const templates = strategyTemplates.map((item) => ({
      ...item,
      sourceType: item.sourceType || "template",
    }));
    const portfolios = savedStrategies
      .filter((item) => !item.isAIFund && item.provider !== "polymarket")
      .map((item) => ({
        ...item,
        sourceType: "portfolio",
      }));

    const seen = new Set();
    const merged = [...templates, ...portfolios].filter((item) => {
      const key = `${item.sourceType}:${item.id}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    return merged;
  }, [strategyTemplates, savedStrategies]);

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

  useEffect(() => {
    return () => {
      if (progressSourceRef.current) {
        progressSourceRef.current.close();
      }
      if (evaluationPollRef.current) {
        clearInterval(evaluationPollRef.current);
        evaluationPollRef.current = null;
      }
    };
  }, []);

  const closeProgressStream = () => {
    if (progressSourceRef.current) {
      progressSourceRef.current.close();
      progressSourceRef.current = null;
    }
  };

  const fetchEvaluationJobs = useCallback(async () => {
    try {
      const headers = {};
      if (authToken) {
        headers["x-auth-token"] = authToken;
      }
      const { data } = await Axios.get(`${config.base_url}/api/data/composer/evaluations`, {
        headers,
      });
      if (data?.status === "success" && Array.isArray(data.data)) {
        setEvaluationJobs(data.data);
      }
    } catch (err) {
      /* eslint-disable-next-line no-console */
      console.error("Failed to fetch evaluation queue:", err);
      setEvaluationError(err.message || "Unable to fetch evaluation queue.");
    }
  }, [authToken]);

  useEffect(() => {
    fetchEvaluationJobs();
  }, [fetchEvaluationJobs]);

  useEffect(() => {
    if (localEvalLoading) {
      if (!evaluationPollRef.current) {
        evaluationPollRef.current = setInterval(() => {
          fetchEvaluationJobs();
        }, 5000);
      }
      return () => {};
    }
    if (evaluationPollRef.current) {
      clearInterval(evaluationPollRef.current);
      evaluationPollRef.current = null;
    }
    return () => {};
  }, [localEvalLoading, fetchEvaluationJobs]);

  const handleLocalEvaluation = async () => {
    if (!collaborative || !collaborative.trim()) {
      setError("Please provide a strategy before running a local simulation.");
      return;
    }
    if (!collaborativeCashLimit || Number(collaborativeCashLimit) <= 0) {
      setError("Please provide a positive cash limit before running a local simulation.");
      return;
    }
    setEvaluationError(null);
    setLocalEvalResult(null);
    setLocalEvalLoading(true);
    const clientRequestId =
      (window.crypto && typeof window.crypto.randomUUID === "function"
        ? window.crypto.randomUUID()
        : `local-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const payload = {
      strategyText: collaborative,
      budget: Number(collaborativeCashLimit),
      clientRequestId,
    };
    const headers = {};
    if (authToken) {
      headers["x-auth-token"] = authToken;
    }
    try {
      const response = await Axios.post(
        `${config.base_url}/api/data/composer/evaluate-local`,
        payload,
        { headers }
      );
      if (response.status === 200 && response.data?.status === "success") {
        setLocalEvalResult(response.data.data);
        fetchEvaluationJobs();
      } else {
        setEvaluationError(response.data?.message || "Local evaluation failed.");
      }
    } catch (err) {
      setEvaluationError(err.response?.data?.message || err.message || "Local evaluation failed.");
    } finally {
      setLocalEvalLoading(false);
    }
  };

  const openBacktestDialog = () => {
    setBacktestError(null);
    setBacktestResult(null);
    const today = new Date();
    const oneYearAgo = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000);
    setBacktestStartDate(toISODateInput(oneYearAgo));
    setBacktestEndDate(toISODateInput(today));
    setBacktestOpen(true);
  };

  const closeBacktestDialog = () => {
    setBacktestOpen(false);
  };

  const runBacktest = async () => {
    if (!collaborative || !collaborative.trim()) {
      setBacktestError("Please paste a strategy before running a backtest.");
      return;
    }
    if (!backtestStartDate || !backtestEndDate) {
      setBacktestError("Please select a start and end date.");
      return;
    }
    setBacktestLoading(true);
    setBacktestError(null);
    setBacktestResult(null);
    const headers = {};
    if (authToken) {
      headers["x-auth-token"] = authToken;
    }
    const payload = {
      strategyText: collaborative,
      startDate: backtestStartDate,
      endDate: backtestEndDate,
      initialCapital: Number(collaborativeCashLimit) > 0 ? Number(collaborativeCashLimit) : 10000,
      transactionCostBps: Number(backtestCostBps) || 0,
      includeBenchmark: true,
      benchmarkSymbol: "SPY",
    };
    try {
      const response = await Axios.post(`${config.base_url}/api/data/composer/backtest-local`, payload, { headers });
      if (response.status === 200 && response.data?.status === "success") {
        setBacktestResult(response.data.data);
      } else {
        setBacktestError(response.data?.message || "Backtest failed.");
      }
    } catch (err) {
      setBacktestError(err.response?.data?.message || err.message || "Backtest failed.");
    } finally {
      setBacktestLoading(false);
    }
  };

  const openProgressStream = (jobId) => {
    if (!jobId || !userData?.token) {
      return;
    }
    closeProgressStream();
    setProgressEvents([]);
    const tokenParam = encodeURIComponent(userData.token);
    const source = new EventSource(`${config.base_url}/api/strategies/progress/${jobId}?token=${tokenParam}`);
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        setProgressEvents((prev) => [...prev, payload]);
        if (payload.step === 'finished') {
          closeProgressStream();
        }
      } catch (error) {
        // ignore malformed events
      }
    };
    source.onerror = () => {
      closeProgressStream();
    };
    progressSourceRef.current = source;
  };

  const handleLoadSavedStrategy = () => {
    if (!selectedLibraryStrategy) {
      return;
    }
    setcollaborative(selectedLibraryStrategy.strategy || "");
    setstrategyName(selectedLibraryStrategy.name || "");
    setSymphonyUrl(selectedLibraryStrategy.symphonyUrl || "");
    if (selectedLibraryStrategy.recurrence) {
      setCollaborativeRecurrence(selectedLibraryStrategy.recurrence);
    }
    if (selectedLibraryStrategy.sourceType === "portfolio") {
      setActiveLibraryStrategyId(selectedLibraryStrategy.id);
      setLoadedStrategyContent(selectedLibraryStrategy.strategy || "");
    } else {
      setActiveLibraryStrategyId(null);
      setLoadedStrategyContent(selectedLibraryStrategy.strategy || "");
    }
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
    setError(null);
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
      const jobId =
        (window.crypto && typeof window.crypto.randomUUID === "function"
          ? window.crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      setCurrentJobId(jobId);
      openProgressStream(jobId);

      const payload = {
        collaborative,
        userID: userId,
        strategyName,
        symphonyUrl,
        recurrence: collaborativeRecurrence,
        cashLimit: collaborativeCashLimit,
        jobId,
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
          await fetchStrategyTemplates();
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
      closeProgressStream();
      setLoading(false);
    }
    



};




  const handlePolymarketSubmit = async () => {
    if (!polymarketStrategyName || !polymarketStrategyName.trim()) {
      setError("Please provide a strategy name.");
      return;
    }

    if (!polymarketAddress || !polymarketAddress.trim()) {
      setError("Please provide a Polymarket address.");
      return;
    }

    if (!polymarketCashLimit || Number(polymarketCashLimit) <= 0) {
      setError("Please provide a positive cash limit.");
      return;
    }

    const apiKeyValue = String(polymarketApiKey || "").trim();
    const secretValue = String(polymarketSecret || "").trim();
    const passphraseValue = String(polymarketPassphrase || "").trim();
    const providedAnyCredential = Boolean(apiKeyValue || secretValue || passphraseValue);
    if (providedAnyCredential && !(apiKeyValue && secretValue && passphraseValue)) {
      setError("Provide apiKey, secret, and passphrase together (or leave all blank to use server .env keys).");
      return;
    }

    if (!authToken || !userId) {
      setError("Please log in again.");
      return;
    }

    setError(null);
    setPolymarketResponseReceived(false);
    setPolymarketSchedule(null);
    setLoading(true);

    const headers = {
      "x-auth-token": authToken,
    };
    const url = config.base_url + "/api/strategies/polymarket/";

    try {
      const payload = {
        userID: userId,
        strategyName: polymarketStrategyName,
        address: polymarketAddress,
        cashLimit: polymarketCashLimit,
        recurrence: polymarketRecurrence,
      };
      if (providedAnyCredential) {
        payload.apiKey = apiKeyValue;
        payload.secret = secretValue;
        payload.passphrase = passphraseValue;
      }

      const response = await Axios.post(url, payload, { headers });
      if (response.status === 200 && response.data?.status === "success") {
        setPolymarketResponseReceived(true);
        setPolymarketSchedule(response.data.schedule || null);
        await fetchStrategies();
      } else {
        setError(response.data?.message || "Failed to create Polymarket strategy.");
      }
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to create Polymarket strategy.");
      setPolymarketSchedule(null);
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
	      <Tab label="Polymarket Strategy" />
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
                      {strategyOption.sourceType === "template" ? " (Saved code)" : ""}
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
                    {selectedLibraryStrategy.symphonyUrl && (
                      <Typography variant="body2">
                        <strong>Symphony:</strong>{" "}
                        <Link
                          href={selectedLibraryStrategy.symphonyUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open
                        </Link>
                      </Typography>
                    )}
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
              id="symphonyUrl"
              label="Symphony link (optional)"
              name="symphonyUrl"
              value={symphonyUrl}
              onChange={(e) => setSymphonyUrl(e.target.value)}
              fullWidth
              margin="normal"
              placeholder="https://app.composer.trade/symphony/..."
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
            <Box display="flex" alignItems="center" gap={2} flexWrap="wrap" mb={2}>
              <Button
                variant="outlined"
                color="secondary"
                onClick={handleLocalEvaluation}
                disabled={localEvalLoading || !collaborative || !collaborative.trim()}
              >
                {localEvalLoading ? "Running local simulation…" : "Simulate locally"}
              </Button>
              <Button
                variant="outlined"
                onClick={openBacktestDialog}
                disabled={!collaborative || !collaborative.trim()}
              >
                Backtest
              </Button>
              {evaluationError && (
                <Typography variant="body2" color="error">
                  {evaluationError}
                </Typography>
              )}
            </Box>

            {localEvalResult && (
              <Box mb={2} p={2} sx={{ border: '1px solid #e0e0e0', borderRadius: 1 }}>
                <Typography variant="subtitle2" gutterBottom>
                  Local simulation summary
                </Typography>
                {localEvalResult.summary && (
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-line' }} gutterBottom>
                    {localEvalResult.summary}
                  </Typography>
                )}
                {Array.isArray(localEvalResult.positions) && localEvalResult.positions.length > 0 && (
                  <Box mt={1}>
                    <Typography variant="body2" fontWeight={600}>
                      Positions ({localEvalResult.positions.length})
                    </Typography>
                    <Table size="small" sx={{ mt: 1 }}>
                      <TableHead>
                        <TableRow>
                          <TableCell>Asset</TableCell>
                          <TableCell align="right">Allocation %</TableCell>
                          <TableCell align="right">Quantity</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {localEvalResult.positions.map((pos, index) => (
                          <TableRow key={`local-pos-${index}`}>
                            <TableCell>{pos.symbol}</TableCell>
                            <TableCell align="right">{formatPct(pos.weight)}</TableCell>
                            <TableCell align="right">{pos.quantity ?? "—"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Box>
                )}
              </Box>
            )}

            <Dialog open={backtestOpen} onClose={closeBacktestDialog} fullWidth maxWidth="md">
              <DialogTitle>Backtest strategy</DialogTitle>
              <DialogContent>
                <Box display="flex" gap={2} flexWrap="wrap" mt={1}>
                  <TextField
                    label="Start date"
                    type="date"
                    value={backtestStartDate}
                    onChange={(e) => setBacktestStartDate(e.target.value)}
                    InputLabelProps={{ shrink: true }}
                  />
                  <TextField
                    label="End date"
                    type="date"
                    value={backtestEndDate}
                    onChange={(e) => setBacktestEndDate(e.target.value)}
                    InputLabelProps={{ shrink: true }}
                  />
                  <TextField
                    label="Transaction cost (bps)"
                    type="number"
                    value={backtestCostBps}
                    onChange={(e) => setBacktestCostBps(e.target.value)}
                    inputProps={{ min: 0, step: 1 }}
                  />
                </Box>

                {backtestError && (
                  <Typography variant="body2" color="error" sx={{ mt: 2 }}>
                    {backtestError}
                  </Typography>
                )}

                <Box sx={{ mt: 2, minHeight: 260, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {backtestLoading ? (
                    <CircularProgress size={22} />
                  ) : backtestResult?.series?.length ? (
                    <Box sx={{ width: "100%" }}>
                      <LineChartPort
                        pastDataPeriod={{
                          history: backtestResult.series.map((point) => ({
                            timestamp: `${point.date}T00:00:00.000Z`,
                            equity: point.value,
                          })),
                        }}
                        duration="backtest"
                      />
                    </Box>
                  ) : (
                    <Typography variant="body2" color="textSecondary">
                      Run a backtest to see the equity curve.
                    </Typography>
                  )}
                </Box>

                {backtestResult?.metrics && (
                  <>
                    <Divider sx={{ my: 2 }} />
                    <Typography variant="subtitle2">Key metrics</Typography>
                    <Typography variant="body2">CAGR: {formatPct(backtestResult.metrics.cagr)}</Typography>
                    <Typography variant="body2">Total return: {formatPct(backtestResult.metrics.totalReturn)}</Typography>
                    <Typography variant="body2">Max drawdown: {formatPct(backtestResult.metrics.maxDrawdown)}</Typography>
                    <Typography variant="body2">Volatility: {formatNumber(backtestResult.metrics.volatility)}</Typography>
                    <Typography variant="body2">Sharpe: {formatNumber(backtestResult.metrics.sharpe)}</Typography>
                    {(backtestResult.metrics.beta != null || backtestResult.metrics.r2 != null) && (
                      <>
                        <Typography variant="body2">
                          Beta{backtestResult.metrics.benchmarkSymbol ? ` (vs ${backtestResult.metrics.benchmarkSymbol})` : ""}:{" "}
                          {formatNumber(backtestResult.metrics.beta)}
                        </Typography>
                        <Typography variant="body2">R²: {formatNumber(backtestResult.metrics.r2)}</Typography>
                      </>
                    )}
                    <Typography variant="body2">Avg turnover: {formatPct(backtestResult.metrics.avgTurnover)}</Typography>
                    {backtestResult.benchmark?.metrics && (
                      <>
                        <Divider sx={{ my: 2 }} />
                        <Typography variant="subtitle2">Benchmark ({backtestResult.benchmark.symbol})</Typography>
                        <Typography variant="body2">
                          CAGR: {formatPct(backtestResult.benchmark.metrics.cagr)}
                        </Typography>
                        <Typography variant="body2">
                          Total return: {formatPct(backtestResult.benchmark.metrics.totalReturn)}
                        </Typography>
                        <Typography variant="body2">
                          Max drawdown: {formatPct(backtestResult.benchmark.metrics.maxDrawdown)}
                        </Typography>
                      </>
                    )}
                  </>
                )}

                {Array.isArray(backtestResult?.finalHoldings) && backtestResult.finalHoldings.length > 0 && (
                  <>
                    <Divider sx={{ my: 2 }} />
                    <Typography variant="subtitle2">
                      Final holdings {backtestResult.finalDate ? `(as of ${backtestResult.finalDate})` : ""}
                    </Typography>
                    <Table size="small" sx={{ mt: 1 }}>
                      <TableHead>
                        <TableRow>
                          <TableCell>Asset</TableCell>
                          <TableCell align="right">Allocation %</TableCell>
                          <TableCell align="right">Close</TableCell>
                          <TableCell align="right">Quantity</TableCell>
                          <TableCell align="right">Value</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {backtestResult.finalHoldings.map((pos) => (
                          <TableRow key={`backtest-final-${pos.symbol}`}>
                            <TableCell>{pos.symbol}</TableCell>
                            <TableCell align="right">{formatPct(pos.weight)}</TableCell>
                            <TableCell align="right">
                              {Number.isFinite(Number(pos.close)) ? Number(pos.close).toFixed(2) : "—"}
                            </TableCell>
                            <TableCell align="right">
                              {Number.isFinite(Number(pos.quantity)) ? Number(pos.quantity).toFixed(4) : "—"}
                            </TableCell>
                            <TableCell align="right">
                              {Number.isFinite(Number(pos.value)) ? Number(pos.value).toFixed(2) : "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </>
                )}
              </DialogContent>
              <DialogActions>
                <Button onClick={closeBacktestDialog} disabled={backtestLoading}>
                  Close
                </Button>
                <Button onClick={runBacktest} variant="contained" disabled={backtestLoading}>
                  Run backtest
                </Button>
              </DialogActions>
            </Dialog>

            <Box mb={3} p={2} sx={{ border: '1px dashed #bdbdbd', borderRadius: 1 }}>
              <Typography variant="subtitle2">Active local simulations</Typography>
              {evaluationJobs.length === 0 && (
                <Typography variant="body2" color="textSecondary">
                  No local evaluations in progress.
                </Typography>
              )}
              {evaluationJobs.length > 0 &&
                evaluationJobs.map((job) => {
                  const isOwner = userId && job.requester && String(job.requester) === String(userId);
                  return (
                    <Typography
                      key={job.id}
                      variant="body2"
                      color={isOwner ? 'primary' : 'textSecondary'}
                    >
                      {job.status || 'pending'} · {job.strategyName || 'Strategy'} ({job.mode || 'direct'}) ·
                      submitted {formatDateTime(job.submittedAt)}
                    </Typography>
                  );
                })}
            </Box>

            <Button
              variant="contained"
              color="primary"
              className={styles.submit}
              onClick={handlecollaborativeSubmit}
              disabled={loading}
            >
              Create this strategy
            </Button>
            {currentJobId && (
              <Box mt={2}>
                <Typography variant="subtitle2">Progress</Typography>
                {progressEvents.length === 0 && (
                  <Typography variant="body2" color="textSecondary">
                    Waiting for updates...
                  </Typography>
                )}
                {progressEvents.map((event, index) => (
                  <Typography key={`${currentJobId}-${index}`} variant="body2">
                    {formatDateTime(event.timestamp)} · {event.step || 'update'} — {event.message || event.status}
                  </Typography>
                ))}
              </Box>
            )}
          </>
        </div>

        )}

	    </Box>
	    </StyledPaper>
	    )}

	    {value === 2 && (
	      <StyledPaper>
	        <Box>
	          <Title>Polymarket strategy</Title>
	          <Typography color="textSecondary" align="left">
	            Copy trades from a Polymarket account into a paper portfolio.
	          </Typography>

	          {loading ? (
	            <Box sx={{ mt: 2 }}>
	              <CircularProgress size={24} />
	            </Box>
	          ) : polymarketResponseReceived ? (
	            <Box sx={{ mt: 2 }}>
	              <Typography variant="h6">Polymarket strategy successfully added.</Typography>
	              {polymarketSchedule && (
	                <Typography variant="body2" sx={{ mt: 1 }}>
	                  Frequency: {formatRecurrenceLabel(polymarketSchedule.recurrence)} · Next sync:{" "}
	                  {formatDateTime(polymarketSchedule.nextRebalanceAt)}
	                </Typography>
	              )}
	              <Typography variant="body2" sx={{ mt: 2 }}>
	                Note: If Polymarket requests are geo-blocked from your region, you may need a VPN/proxy.
	              </Typography>
	            </Box>
	          ) : (
	            <Box sx={{ mt: 2 }}>
	              {error && (
	                <Typography color="error" sx={{ mb: 2 }}>
	                  {error}
	                </Typography>
	              )}

	              <TextField
	                variant="outlined"
	                label="Strategy name"
	                value={polymarketStrategyName}
	                onChange={(e) => setPolymarketStrategyName(e.target.value)}
	                fullWidth
	                margin="normal"
	              />
	              <TextField
	                variant="outlined"
	                label="Polymarket address (0x...)"
	                value={polymarketAddress}
	                onChange={(e) => setPolymarketAddress(e.target.value)}
	                fullWidth
	                margin="normal"
	              />
	              <TextField
	                variant="outlined"
	                label="Cash limit (virtual USDC)"
	                value={polymarketCashLimit}
	                onChange={(e) => setPolymarketCashLimit(e.target.value)}
	                fullWidth
	                margin="normal"
	              />
	              <Typography variant="body2" color="textSecondary" sx={{ mt: 1 }}>
	                Leave apiKey / secret / passphrase blank to use the server `.env` Polymarket keys.
	              </Typography>
	              <TextField
	                variant="outlined"
	                label="Polymarket apiKey (optional override)"
	                value={polymarketApiKey}
	                onChange={(e) => setPolymarketApiKey(e.target.value)}
	                fullWidth
	                margin="normal"
	              />
	              <TextField
	                variant="outlined"
	                type="password"
	                label="Polymarket secret (optional override)"
	                value={polymarketSecret}
	                onChange={(e) => setPolymarketSecret(e.target.value)}
	                fullWidth
	                margin="normal"
	              />
	              <TextField
	                variant="outlined"
	                type="password"
	                label="Polymarket passphrase (optional override)"
	                value={polymarketPassphrase}
	                onChange={(e) => setPolymarketPassphrase(e.target.value)}
	                fullWidth
	                margin="normal"
	              />
	              <TextField
	                select
	                variant="outlined"
	                label="Sync frequency"
	                value={polymarketRecurrence}
	                onChange={(e) => setPolymarketRecurrence(e.target.value)}
	                fullWidth
	                margin="normal"
	              >
	                {RECURRENCE_OPTIONS.map((option) => (
	                  <MenuItem key={option.value} value={option.value}>
	                    {option.label}
	                  </MenuItem>
	                ))}
	              </TextField>

	              <Box sx={{ mt: 2 }}>
	                <Button variant="contained" color="primary" onClick={handlePolymarketSubmit}>
	                  Create this strategy
	                </Button>
	              </Box>
	            </Box>
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
