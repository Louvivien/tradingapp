import React, { useContext, useEffect, useState } from "react";
import { Link, Collapse, IconButton, Modal, Button, Typography, useTheme, LinearProgress, Box, TextField, MenuItem, CircularProgress, Tooltip, Dialog, DialogTitle, DialogContent, DialogActions, Divider, Chip } from "@mui/material";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Title from "../Template/Title.jsx";
import SaleModal from "./SaleModal.jsx";
import styles from "./Dashboard.module.css";
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import EditIcon from '@mui/icons-material/Edit';
import Axios from "axios";
import config from "../../config/Config";
import UserContext from "../../context/UserContext";
import HighlightOffIcon from '@mui/icons-material/HighlightOff';
import EditCalendarIcon from '@mui/icons-material/EditCalendar';
import { useNavigate } from "react-router-dom";
import { logError } from "../../utils/logger";
import StrategyEquityChart from "./StrategyEquityChart";
import LineChartPort from "../Template/LineChartPort.jsx";
import {
  buildAiPortfolioIntegrationLink,
  buildTradingAppStrategyEquityUrl,
  copyTextToClipboard,
  suggestAiPortfolioSymbol,
} from "../../utils/aiportfolioIntegration";





const PORTFOLIO_FILTER_STORAGE_KEY = "tradingapp:portfolioFilter";

const loadPortfolioFilter = () => {
  if (typeof window === "undefined") {
    return "all";
  }
  try {
    const raw = window.localStorage.getItem(PORTFOLIO_FILTER_STORAGE_KEY);
    if (raw === "composer" || raw === "polymarket" || raw === "all") {
      return raw;
    }
  } catch {
    // ignore storage errors
  }
  return "all";
};

const Portfolios = ({ portfolios, onViewStrategyLogs, refreshPortfolios }) => {
  const navigate = useNavigate();
  const [saleOpen, setSaleOpen] = useState(false);
  const { userData, setUserData } = useContext(UserContext);
  const [stock, setStock] = useState(undefined);
  const [openStrategies, setOpenStrategies] = useState(false);
  const [openPortfolio, setOpenPortfolio] = useState({});
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [strategyToDelete, setStrategyToDelete] = useState(null);
  const theme = useTheme();
  const [recurrenceError, setRecurrenceError] = useState(null);
  const [updatingRecurrence, setUpdatingRecurrence] = useState({});
  const [resendStatus, setResendStatus] = useState({});
  const [resendOpen, setResendOpen] = useState(false);
  const [strategyToResend, setStrategyToResend] = useState(null);
  const [scheduleEditor, setScheduleEditor] = useState(() => createScheduleEditorState());
  const [strategyTextCache, setStrategyTextCache] = useState({});
  const [backtestOpen, setBacktestOpen] = useState(false);
  const [backtestPortfolio, setBacktestPortfolio] = useState(null);
  const [backtestStartDate, setBacktestStartDate] = useState("");
  const [backtestEndDate, setBacktestEndDate] = useState("");
  const [backtestCostBps, setBacktestCostBps] = useState("1");
  const [backtestLoading, setBacktestLoading] = useState(false);
  const [backtestResult, setBacktestResult] = useState(null);
  const [backtestError, setBacktestError] = useState(null);
  const [metadataEditor, setMetadataEditor] = useState({
    open: false,
    portfolio: null,
    name: "",
    symphonyUrl: "",
    saving: false,
    error: null,
  });
  const [portfolioFilter, setPortfolioFilter] = useState(() => loadPortfolioFilter());
  const [aiPortfolioDialog, setAiPortfolioDialog] = useState({
    open: false,
    name: "",
    link: "",
    apiUrl: "",
  });
  const [aiPortfolioCopied, setAiPortfolioCopied] = useState(false);
  const [polymarketBalance, setPolymarketBalance] = useState(null);
  const [polymarketBalanceLoading, setPolymarketBalanceLoading] = useState(false);
  const [polymarketBalanceError, setPolymarketBalanceError] = useState(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(PORTFOLIO_FILTER_STORAGE_KEY, portfolioFilter);
    } catch {
      // ignore storage errors
    }
  }, [portfolioFilter]);

  useEffect(() => {
    const hasLivePolymarket = Array.isArray(portfolios) && portfolios.some((portfolio) => {
      return portfolio?.provider === "polymarket" && Boolean(portfolio?.isRealMoney);
    });

    if (!hasLivePolymarket) {
      setPolymarketBalance(null);
      setPolymarketBalanceError(null);
      setPolymarketBalanceLoading(false);
      return;
    }
    if (!userData?.token || !userData?.user?.id) {
      setPolymarketBalanceLoading(false);
      return;
    }

    let cancelled = false;
    const fetchPolymarketBalanceAllowance = async () => {
      setPolymarketBalanceLoading(true);
      setPolymarketBalanceError(null);

      try {
        const headers = { "x-auth-token": userData.token };
        const url = `${config.base_url}/api/strategies/polymarket/balance/${userData.user.id}`;
        const response = await Axios.get(url, { headers });

        if (cancelled) {
          return;
        }

        if (response.status === 200 && response.data?.status === "success") {
          setPolymarketBalance({
            source: response.data.source ?? null,
            address: response.data.address ?? null,
            balance: response.data.balance ?? null,
            allowance: response.data.allowance ?? null,
            available: response.data.available ?? null,
            tradable: response.data.tradable ?? null,
          });
        } else {
          setPolymarketBalance(null);
          setPolymarketBalanceError(response.data?.message || "Failed to fetch Polymarket balance.");
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        setPolymarketBalance(null);
        setPolymarketBalanceError(error.response?.data?.message || error.message || "Failed to fetch Polymarket balance.");
      } finally {
        if (!cancelled) {
          setPolymarketBalanceLoading(false);
        }
      }
    };

    fetchPolymarketBalanceAllowance();
    return () => {
      cancelled = true;
    };
  }, [portfolios, userData?.token, userData?.user?.id]);





  const roundNumber = (num) => {
    return Math.round((num + Number.EPSILON) * 100) / 100;
  };

  const formatCurrencyValue = (value) => {
    if (value === null || value === undefined) {
      return '—';
    }
    const numeric = Number(value);
    if (Number.isNaN(numeric)) {
      return '—';
    }
    return `$${roundNumber(numeric).toLocaleString()}`;
  };

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

  const pickBaselineInvestment = (portfolio) => {
    const candidates = [
      portfolio?.initialInvestment,
      portfolio?.cashLimit,
      portfolio?.budget,
      portfolio?.currentValue,
    ];
    for (const v of candidates) {
      const num = Number(v);
      if (Number.isFinite(num) && num > 0) {
        return num;
      }
    }
    return 0;
  };

  const openAiPortfolioDialog = (portfolio, event) => {
    if (event?.stopPropagation) {
      event.stopPropagation();
    }
    if (!portfolio?.strategy_id || !userData?.user?.id) {
      return;
    }

    const apiUrl = buildTradingAppStrategyEquityUrl({
      baseUrl: config.base_url,
      userId: userData.user.id,
      strategyId: portfolio.strategy_id,
      limit: 400,
    });

    const symbol = suggestAiPortfolioSymbol(portfolio);
    const displayName = portfolio.name || "Strategy";
    const costPrice = pickBaselineInvestment(portfolio);

    const link = buildAiPortfolioIntegrationLink({
      symbol,
      displayName,
      apiUrl,
      apiToken: userData?.token,
      quantity: 1,
      costPrice,
      tags: ["TradingApp", "Strategy", portfolio.provider || ""].filter(Boolean),
    });

    setAiPortfolioCopied(false);
    setAiPortfolioDialog({
      open: true,
      name: displayName,
      link,
      apiUrl,
    });
  };

  const closeAiPortfolioDialog = () => {
    setAiPortfolioCopied(false);
    setAiPortfolioDialog((prev) => ({ ...prev, open: false }));
  };

  const copyAiPortfolioLink = async () => {
    const ok = await copyTextToClipboard(aiPortfolioDialog.link);
    if (!ok) {
      window.prompt("Copy this link:", aiPortfolioDialog.link);
      return;
    }
    setAiPortfolioCopied(true);
    setTimeout(() => setAiPortfolioCopied(false), 2000);
  };

  const fetchStrategyText = async (strategyId) => {
    if (!strategyId) {
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(strategyTextCache, strategyId)) {
      return strategyTextCache[strategyId];
    }
    if (!userData?.user?.id || !userData?.token) {
      return null;
    }
    try {
      const url = `${config.base_url}/api/strategies/all/${userData.user.id}`;
      const headers = { "x-auth-token": userData.token };
      const response = await Axios.get(url, { headers });
      const strategies = Array.isArray(response.data?.strategies) ? response.data.strategies : [];
      const match = strategies.find((entry) => String(entry.id) === String(strategyId));
      const strategyText = match?.strategy || null;
      setStrategyTextCache((prev) => ({ ...prev, [strategyId]: strategyText }));
      return strategyText;
    } catch (error) {
      return null;
    }
  };

  const openBacktestDialog = async (portfolio, event) => {
    if (event?.stopPropagation) {
      event.stopPropagation();
    }
    if (!portfolio) {
      return;
    }
    setBacktestError(null);
    setBacktestResult(null);
    setBacktestPortfolio(portfolio);
    const today = new Date();
    const oneYearAgo = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000);
    setBacktestStartDate(toISODateInput(oneYearAgo));
    setBacktestEndDate(toISODateInput(today));
    setBacktestOpen(true);
  };

  const closeBacktestDialog = () => {
    if (backtestLoading) {
      return;
    }
    setBacktestOpen(false);
    setBacktestPortfolio(null);
  };

  const runBacktest = async () => {
    if (!backtestPortfolio) {
      setBacktestError("No strategy selected.");
      return;
    }
    if (!backtestStartDate || !backtestEndDate) {
      setBacktestError("Please select a start and end date.");
      return;
    }
    if (!userData?.user?.id) {
      setBacktestError("You must be logged in to run a backtest.");
      return;
    }

    setBacktestLoading(true);
    setBacktestError(null);
    setBacktestResult(null);

    try {
      const strategyText = await fetchStrategyText(backtestPortfolio.strategy_id);
      if (!strategyText || typeof strategyText !== "string" || !strategyText.trim()) {
        throw new Error("Unable to load this strategy script for backtesting.");
      }
      const headers = {};
      if (userData?.token) {
        headers["x-auth-token"] = userData.token;
      }
      const initialCapital =
        Number(backtestPortfolio.cashLimit) > 0
          ? Number(backtestPortfolio.cashLimit)
          : Number(backtestPortfolio.budget) > 0
            ? Number(backtestPortfolio.budget)
            : Number(backtestPortfolio.initialInvestment) > 0
              ? Number(backtestPortfolio.initialInvestment)
              : 10000;

      const payload = {
        strategyText,
        startDate: backtestStartDate,
        endDate: backtestEndDate,
        initialCapital,
        transactionCostBps: Number(backtestCostBps) || 0,
        includeBenchmark: true,
        benchmarkSymbol: "SPY",
      };

      const response = await Axios.post(`${config.base_url}/api/data/composer/backtest-local`, payload, { headers });
      if (response.status === 200 && response.data?.status === "success") {
        setBacktestResult(response.data.data);
      } else {
        setBacktestError(response.data?.message || "Backtest failed.");
      }
    } catch (error) {
      setBacktestError(error?.response?.data?.message || error.message || "Backtest failed.");
    } finally {
      setBacktestLoading(false);
    }
  };

  const openSaleModal = (stock) => {
    setStock(stock);
    setSaleOpen(true);
  };


  const handleStrategiesClick = () => {
    setOpenStrategies(!openStrategies);
  };

const handlePortfolioClick = (strategyId) => {
    setOpenPortfolio(prevState => ({ ...prevState, [strategyId]: !prevState[strategyId] }));
  };

  const openMetadataEditor = (portfolio, event) => {
    if (event?.stopPropagation) {
      event.stopPropagation();
    }
    if (!portfolio) {
      return;
    }
    setMetadataEditor({
      open: true,
      portfolio,
      name: portfolio.name || "",
      symphonyUrl: portfolio.symphonyUrl || "",
      saving: false,
      error: null,
    });
  };

  const closeMetadataEditor = () => {
    if (metadataEditor.saving) {
      return;
    }
    setMetadataEditor({
      open: false,
      portfolio: null,
      name: "",
      symphonyUrl: "",
      saving: false,
      error: null,
    });
  };

  const saveMetadataEditor = async () => {
    if (metadataEditor.saving) {
      return;
    }
    const { portfolio } = metadataEditor;
    if (!portfolio?.strategy_id) {
      setMetadataEditor((prev) => ({ ...prev, error: "Missing strategy id." }));
      return;
    }
    const nextName = String(metadataEditor.name || "").trim();
    if (!nextName) {
      setMetadataEditor((prev) => ({ ...prev, error: "Strategy name cannot be empty." }));
      return;
    }
    if (!userData?.user?.id || !userData?.token) {
      setMetadataEditor((prev) => ({ ...prev, error: "Please sign in again." }));
      return;
    }

    setMetadataEditor((prev) => ({ ...prev, saving: true, error: null }));
    try {
      const url = `${config.base_url}/api/strategies/metadata/${userData.user.id}/${portfolio.strategy_id}`;
      const headers = { "x-auth-token": userData.token };
      const payload = {
        name: nextName,
        symphonyUrl: metadataEditor.symphonyUrl,
      };
      const response = await Axios.patch(url, payload, { headers });
      if (response.status === 200 && response.data?.status === "success") {
        closeMetadataEditor();
        if (typeof refreshPortfolios === "function") {
          await refreshPortfolios();
        }
      } else {
        setMetadataEditor((prev) => ({ ...prev, error: response.data?.message || "Failed to update strategy." }));
      }
    } catch (error) {
      setMetadataEditor((prev) => ({
        ...prev,
        error: error?.response?.data?.message || error.message || "Failed to update strategy.",
      }));
    } finally {
      setMetadataEditor((prev) => ({ ...prev, saving: false }));
    }
  };


  const openDeleteModal = (strategyId) => {
    // console.log('strategyId:', strategyId);
    setStrategyToDelete(strategyId);
    setDeleteOpen(true);
};



const closeDeleteModal = () => {
    setDeleteOpen(false);
  };

  const openScheduleEditor = (portfolio) => {
    if (!portfolio) {
      return;
    }
    setScheduleEditor(createScheduleEditorState({
      open: true,
      portfolio,
      value: formatDateTimeLocalInput(portfolio.nextRebalanceAt),
    }));
  };

  const closeScheduleEditor = () => {
    setScheduleEditor(createScheduleEditorState());
  };

  const handleScheduleEditorChange = (event) => {
    const value = event?.target?.value || '';
    setScheduleEditor((prev) => ({
      ...prev,
      value,
      error: null,
    }));
  };

  const handleScheduleEditorSave = async () => {
    if (!scheduleEditor.portfolio) {
      return;
    }
    if (!scheduleEditor.value) {
      setScheduleEditor((prev) => ({
        ...prev,
        error: 'Please choose a future date and time.',
      }));
      return;
    }
    const parsedDate = new Date(scheduleEditor.value);
    if (Number.isNaN(parsedDate.getTime())) {
      setScheduleEditor((prev) => ({
        ...prev,
        error: 'Invalid date. Please pick another value.',
      }));
      return;
    }
    if (parsedDate.getTime() <= Date.now()) {
      setScheduleEditor((prev) => ({
        ...prev,
        error: 'Please select a time in the future.',
      }));
      return;
    }

    setScheduleEditor((prev) => ({
      ...prev,
      saving: true,
      error: null,
    }));

    try {
      const url = `${config.base_url}/api/strategies/rebalance-date/${userData.user.id}/${scheduleEditor.portfolio.strategy_id}`;
      const headers = {
        "x-auth-token": userData.token,
      };
      await Axios.patch(url, {
        nextRebalanceAt: parsedDate.toISOString(),
      }, { headers });

      if (typeof refreshPortfolios === 'function') {
        await refreshPortfolios();
      }
      closeScheduleEditor();
    } catch (error) {
      const message = error?.response?.data?.message || 'Failed to update next reallocation.';
      setScheduleEditor((prev) => ({
        ...prev,
        saving: false,
        error: message,
      }));
    }
  };


const deleteStrategy = async (strategyId) => {
    try {
      const url = config.base_url + `/api/strategies/delete/${userData.user.id}/${strategyId}`;
      const headers = {
        "x-auth-token": userData.token,
      };

      const response = await Axios.delete(url, { headers });

      if (response.data.status === "success") {
        // console.log("Strategy deleted successfully");
        // You might want to update the state or redirect the user here
      } else {
        logError('Error deleting strategy:', response.data.message);
      }
    } catch (error) {
      logError('Error deleting strategy:', error);
    }
  };

  const handleRecurrenceChange = async (portfolio, newRecurrence) => {
    if (!newRecurrence || newRecurrence === portfolio.recurrence) {
      return;
    }

    setUpdatingRecurrence((prev) => ({
      ...prev,
      [portfolio.strategy_id]: true,
    }));
    setRecurrenceError(null);

    try {
      const url = `${config.base_url}/api/strategies/recurrence/${userData.user.id}/${portfolio.strategy_id}`;
      const headers = {
        "x-auth-token": userData.token,
      };

      await Axios.patch(url, { recurrence: newRecurrence }, { headers });
      if (typeof refreshPortfolios === "function") {
        await refreshPortfolios();
      }
    } catch (error) {
      setRecurrenceError(error.response?.data?.message || error.message);
    } finally {
      setUpdatingRecurrence((prev) => ({
        ...prev,
        [portfolio.strategy_id]: false,
      }));
    }
  };

  const handleResendOrders = async (portfolio) => {
    if (!portfolio?.strategy_id || !userData?.user?.id || !userData?.token) {
      return;
    }

    const strategyId = portfolio.strategy_id;
    setResendStatus((prev) => ({
      ...prev,
      [strategyId]: { loading: true, message: null, error: false },
    }));

    try {
      const url = `${config.base_url}/api/strategies/resend/${userData.user.id}/${strategyId}`;
      const headers = {
        "x-auth-token": userData.token,
      };
      const response = await Axios.post(url, {}, { headers });
      const message = response?.data?.message || "Manual rebalance triggered.";
      setResendStatus((prev) => ({
        ...prev,
        [strategyId]: { loading: false, message, error: false },
      }));
      if (typeof refreshPortfolios === "function") {
        await refreshPortfolios();
      }
    } catch (error) {
      setResendStatus((prev) => ({
        ...prev,
        [strategyId]: {
          loading: false,
          message: error.response?.data?.message || error.message || "Failed to resend orders.",
          error: true,
        },
      }));
    }
  };

  const handlePolymarketBackfill = async (portfolio, event) => {
    if (event?.stopPropagation) {
      event.stopPropagation();
    }
    if (!portfolio?.strategy_id || !userData?.user?.id || !userData?.token) {
      return;
    }

    const strategyId = portfolio.strategy_id;
    const confirm = window.confirm(
      `Backfill Polymarket trades for "${portfolio.name}"?\n\nThis will reset the paper portfolio to your cash limit and replay historical trades to approximate current positions.`
    );
    if (!confirm) {
      return;
    }

    setResendStatus((prev) => ({
      ...prev,
      [strategyId]: { loading: true, message: null, error: false },
    }));

    try {
      const url = `${config.base_url}/api/strategies/rebalance-now/${userData.user.id}/${strategyId}`;
      const headers = {
        "x-auth-token": userData.token,
      };
      const response = await Axios.post(url, { mode: "backfill" }, { headers });
      const message =
        response?.data?.log?.message ||
        response?.data?.message ||
        "Polymarket backfill complete.";

      setResendStatus((prev) => ({
        ...prev,
        [strategyId]: { loading: false, message, error: false },
      }));

      if (typeof refreshPortfolios === "function") {
        await refreshPortfolios();
      }
    } catch (error) {
      setResendStatus((prev) => ({
        ...prev,
        [strategyId]: {
          loading: false,
          message: error.response?.data?.message || error.message || "Polymarket backfill failed.",
          error: true,
        },
      }));
    }
  };

  const handlePolymarketSyncNow = async (portfolio, event) => {
    if (event?.stopPropagation) {
      event.stopPropagation();
    }
    if (!portfolio?.strategy_id || !userData?.user?.id || !userData?.token) {
      return;
    }

    const strategyId = portfolio.strategy_id;
    const isRealMoney = Boolean(portfolio?.isRealMoney);
    const isRealMoneyRequested = Boolean(portfolio?.isRealMoneyRequested);
    const confirmText = isRealMoney
      ? `Run Polymarket sync now for \"${portfolio.name}\"?\n\nThis may place REAL orders on your Polymarket account.`
      : isRealMoneyRequested
        ? `Run Polymarket sync now for \"${portfolio.name}\"?\n\nThis strategy is set to real money, but live execution is disabled by the server environment (it will run in paper mode).`
        : `Run Polymarket sync now for \"${portfolio.name}\"?`;

    const confirm = window.confirm(confirmText);
    if (!confirm) {
      return;
    }

    setResendStatus((prev) => ({
      ...prev,
      [strategyId]: { loading: true, message: null, error: false },
    }));

    try {
      const url = `${config.base_url}/api/strategies/rebalance-now/${userData.user.id}/${strategyId}`;
      const headers = {
        "x-auth-token": userData.token,
      };
      const response = await Axios.post(url, { mode: "incremental" }, { headers });
      const message =
        response?.data?.log?.message ||
        response?.data?.message ||
        "Polymarket sync complete.";

      setResendStatus((prev) => ({
        ...prev,
        [strategyId]: { loading: false, message, error: false },
      }));

      if (typeof refreshPortfolios === "function") {
        await refreshPortfolios();
      }
    } catch (error) {
      setResendStatus((prev) => ({
        ...prev,
        [strategyId]: {
          loading: false,
          message: error.response?.data?.message || error.message || "Polymarket sync failed.",
          error: true,
        },
      }));
    }
  };

  const openResendModal = (portfolio, event) => {
    if (event?.stopPropagation) {
      event.stopPropagation();
    }
    setStrategyToResend(portfolio);
    setResendOpen(true);
  };

  const closeResendModal = () => {
    setResendOpen(false);
    setStrategyToResend(null);
  };

  const normalizedPortfolios = Array.isArray(portfolios) ? portfolios : [];
  const visiblePortfolios = normalizedPortfolios.filter((portfolio) => {
    const provider = String(portfolio?.provider || "alpaca").toLowerCase();
    if (portfolioFilter === "polymarket") {
      return provider === "polymarket";
    }
    if (portfolioFilter === "composer") {
      return provider !== "polymarket";
    }
    return true;
  });

  return (
    <React.Fragment>
      <Title>
        <IconButton
          onClick={handleStrategiesClick}
          aria-expanded={openStrategies}
          aria-label="show more"
        >
          <ExpandMoreIcon />
        </IconButton>
        Strategies portfolios
      </Title>
      {recurrenceError && (
        <Typography color="error" sx={{ ml: 6, mb: 1 }}>
          {recurrenceError}
        </Typography>
      )}

      <Collapse in={openStrategies}>
        <Box sx={{ ml: 6, mt: 1, mb: 2, maxWidth: 260 }}>
          <TextField
            select
            label="Filter"
            size="small"
            value={portfolioFilter}
            onChange={(event) => setPortfolioFilter(event.target.value)}
            fullWidth
          >
            <MenuItem value="all">All</MenuItem>
            <MenuItem value="composer">Composer</MenuItem>
            <MenuItem value="polymarket">Polymarket</MenuItem>
          </TextField>
        </Box>
        {!visiblePortfolios.length ? (
          <Typography variant="body2" color="textSecondary" sx={{ ml: 6, mb: 2 }}>
            No portfolios match this filter.
          </Typography>
        ) : (
          visiblePortfolios.map((portfolio) => {
          // console.log('Portfolio:', portfolio);
          
          // Calculate totals for each portfolio
          let totalQuantity = 0;
          let totalPurchaseTotal = 0;
          let totalCurrentTotal = 0;
          let totalDifference = 0;
          let allStocksHaveAvgCost = true;
          let hasPending = false;

          portfolio.stocks.forEach((stock) => {
            if (stock.avgCost == null || stock.currentPrice == null) {
              allStocksHaveAvgCost = false;
              hasPending = true;
            } else {
              totalQuantity += Number(stock.quantity);
              totalPurchaseTotal += Number(stock.quantity) * Number(stock.avgCost);
              totalCurrentTotal += Number(stock.quantity) * Number(stock.currentPrice);
              totalDifference += (stock.currentPrice - stock.avgCost) / stock.currentPrice;
            }
          });

          const assetCount = portfolio.stocks.length;
          const totalUnrealizedPL = allStocksHaveAvgCost ? totalCurrentTotal - totalPurchaseTotal : null;
          const purchaseSummary = allStocksHaveAvgCost && totalPurchaseTotal > 0
            ? `$${roundNumber(totalPurchaseTotal).toLocaleString()}`
            : hasPending
              ? 'pending fills'
              : '—';
          const currentSummary = allStocksHaveAvgCost && totalCurrentTotal > 0
            ? `$${roundNumber(totalCurrentTotal).toLocaleString()}`
            : hasPending
              ? 'pending fills'
              : '—';
          const totalDiffPct = allStocksHaveAvgCost && totalPurchaseTotal > 0
            ? ((totalCurrentTotal - totalPurchaseTotal) / totalPurchaseTotal) * 100
            : null;
          const cashLimitValue = Number(portfolio.cashLimit ?? portfolio.budget ?? null);
          const limitBaseline = Number.isFinite(cashLimitValue) && cashLimitValue > 0 ? cashLimitValue : null;

          const currentValue = hasPending
            ? null
            : Number.isFinite(Number(portfolio.currentValue))
              ? Number(portfolio.currentValue)
              : (allStocksHaveAvgCost ? totalCurrentTotal : null);
          const cashBufferValue = Number.isFinite(Number(portfolio.cashBuffer)) ? Number(portfolio.cashBuffer) : 0;
          const equityValue = currentValue !== null ? currentValue + cashBufferValue : null;
          const initialInvestmentValue = Number.isFinite(Number(portfolio.initialInvestment))
            ? Number(portfolio.initialInvestment)
            : 0;
          const computedPnlValue = hasPending
            ? null
            : portfolio.pnlValue !== undefined && portfolio.pnlValue !== null && Number.isFinite(Number(portfolio.pnlValue))
              ? Number(portfolio.pnlValue)
              : (equityValue !== null ? equityValue - initialInvestmentValue : null);
          const pnlPercent = portfolio.pnlPercent !== undefined && portfolio.pnlPercent !== null && Number.isFinite(Number(portfolio.pnlPercent))
            ? Number(portfolio.pnlPercent)
            : (computedPnlValue !== null && initialInvestmentValue > 0 ? (computedPnlValue / initialInvestmentValue) * 100 : null);

          const limitDifference = limitBaseline !== null && currentValue !== null
            ? currentValue - limitBaseline
            : null;
          const limitUsagePct = limitBaseline !== null && currentValue !== null && limitBaseline > 0
            ? Math.min(100, Math.max(0, (currentValue / limitBaseline) * 100))
            : null;
          const rebalanceCount = Number.isFinite(Number(portfolio.rebalanceCount)) ? Number(portfolio.rebalanceCount) : 0;
          const pnlValue = computedPnlValue;
          const pnlDisplay = (() => {
            if (pnlValue === null || Number.isNaN(pnlValue)) {
              return null;
            }
            const arrow = pnlValue >= 0 ? '▲' : '▼';
            const amount = `$${Math.abs(roundNumber(pnlValue)).toLocaleString()}`;
            const percentText = pnlPercent !== null && !Number.isNaN(pnlPercent)
              ? ` (${Math.abs(pnlPercent).toFixed(2)}%)`
              : '';
            return `${arrow} ${amount}${percentText}`;
          })();





          return (
            <div style={{ minHeight: "2px", margin: "2px 0" }} key={portfolio.strategy_id || portfolio.name}>

              <div style={{ color: theme.palette.info.light }}>
                <IconButton
                  onClick={() => handlePortfolioClick(portfolio.strategy_id)}
                  aria-expanded={openPortfolio[portfolio.strategy_id]}
                  aria-label="show more"
                >
                  <ExpandMoreIcon />
                </IconButton>
                {portfolio.symphonyUrl ? (
                  <Link
                    href={portfolio.symphonyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    underline="hover"
                    sx={{ color: 'inherit' }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {portfolio.name}
                  </Link>
                ) : (
                  <Box
                    component="span"
                    sx={{ color: 'inherit', cursor: 'pointer' }}
                    onClick={(event) => openMetadataEditor(portfolio, event)}
                  >
                    {portfolio.name}
                  </Box>
                )}
                {Boolean(portfolio.isRealMoney) && (
                  <Chip
                    label="real money"
                    size="small"
                    color="error"
                    variant="outlined"
                    sx={{ ml: 1 }}
                    onClick={(event) => event.stopPropagation()}
                  />
                )}
                {!portfolio.isRealMoney && Boolean(portfolio.isRealMoneyRequested) && (
                  <Chip
                    label="real money (disabled)"
                    size="small"
                    color="warning"
                    variant="outlined"
                    sx={{ ml: 1 }}
                    onClick={(event) => event.stopPropagation()}
                  />
                )}

                <Tooltip title="Edit strategy title & symphony link" arrow>
                  <IconButton size="small" onClick={(event) => openMetadataEditor(portfolio, event)}>
                    <EditIcon fontSize="inherit" />
                  </IconButton>
                </Tooltip>

                <IconButton color="error" onClick={() => openDeleteModal(portfolio.strategy_id)}>
                  <HighlightOffIcon fontSize="small"/>
                </IconButton>
                <Button
                  size="small"
                  sx={{ ml: 1 }}
                  onClick={() => {
                    if (onViewStrategyLogs) {
                      onViewStrategyLogs({
                        id: portfolio.strategy_id,
                        name: portfolio.name,
                      });
                    } else {
                      navigate(`/strategies/${portfolio.strategy_id}/logs?name=${encodeURIComponent(portfolio.name)}`);
                    }
                  }}
                >
                  View Logs
                </Button>
                <Tooltip
                  title="Copy an aiportfolio link (includes your JWT). Paste it into aiportfolio ➜ Add Position ➜ Custom API position."
                  arrow
                >
                  <Button
                    size="small"
                    variant="outlined"
                    sx={{ ml: 1 }}
                    onClick={(event) => openAiPortfolioDialog(portfolio, event)}
                    disabled={!userData?.token || !portfolio?.strategy_id}
                  >
                    AI Portfolio
                  </Button>
                </Tooltip>
                {portfolio.provider !== "polymarket" && (
                  <Button
                    size="small"
                    variant="outlined"
                    sx={{ ml: 1 }}
                    onClick={(event) => openBacktestDialog(portfolio, event)}
                  >
                    Backtest
                  </Button>
                )}
                {portfolio.provider !== "polymarket" && (
                  <Button
                    size="small"
                    variant="outlined"
                    sx={{ ml: 1 }}
                    onClick={(event) => openResendModal(portfolio, event)}
                    disabled={!!resendStatus[portfolio.strategy_id]?.loading}
                  >
                    {resendStatus[portfolio.strategy_id]?.loading ? 'Resending…' : 'Resend Orders'}
                  </Button>
                )}
                {portfolio.provider === "polymarket" && (
                  <Button
                    size="small"
                    variant="outlined"
                    sx={{ ml: 1 }}
                    onClick={(event) => handlePolymarketSyncNow(portfolio, event)}
                    disabled={!!resendStatus[portfolio.strategy_id]?.loading}
                  >
                    {resendStatus[portfolio.strategy_id]?.loading ? "Syncing…" : "Sync now"}
                  </Button>
                )}
                {portfolio.provider === "polymarket" && (
                  <Button
                    size="small"
                    variant="outlined"
                    sx={{ ml: 1 }}
                    onClick={(event) => handlePolymarketBackfill(portfolio, event)}
                    disabled={!!resendStatus[portfolio.strategy_id]?.loading}
                  >
                    {resendStatus[portfolio.strategy_id]?.loading ? "Backfilling…" : "Backfill"}
                  </Button>
                )}




              </div>
              <Typography variant="body2" color="textSecondary" sx={{ ml: 6, mt: 0.5 }}>
                Status: {formatStatus(portfolio.status)} · Frequency: {formatRecurrenceLabel(portfolio.recurrence)} · Next reallocation:{' '}
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center' }}>
                  {formatDateTime(portfolio.nextRebalanceAt)}
                  <Tooltip title="Edit next reallocation" arrow>
                    <IconButton
                      size="small"
                      color="inherit"
                      aria-label="Edit next reallocation"
                      sx={{ ml: 0.5, p: 0.25 }}
                      onClick={() => openScheduleEditor(portfolio)}
                    >
                      <EditCalendarIcon fontSize="inherit" />
                    </IconButton>
                  </Tooltip>
                </Box>
                {' '}· Rebalances: {rebalanceCount}
              </Typography>
              <Box sx={{ display: "flex", alignItems: "center", ml: 6, mt: 1, gap: 1 }}>
                <TextField
                  select
                  label="Rebalance frequency"
                  size="small"
                  value={portfolio.recurrence || ""}
                  onChange={(event) => handleRecurrenceChange(portfolio, event.target.value)}
                  disabled={!!updatingRecurrence[portfolio.strategy_id]}
                  sx={{ minWidth: 220 }}
                >
                  {Object.entries(RECURRENCE_LABELS).map(([value, label]) => (
                    <MenuItem key={value} value={value}>
                      {label}
                    </MenuItem>
                  ))}
                </TextField>
                {updatingRecurrence[portfolio.strategy_id] && <CircularProgress size={18} />}
              </Box>
              {hasPending ? (
                <Typography variant="body2" color="textSecondary" sx={{ ml: 6 }}>
                  Orders pending fill — portfolio value and P/L will update once trades execute.
                </Typography>
              ) : (
                <Typography variant="body2" color="textSecondary" sx={{ ml: 6 }}>
                  Initial investment: {formatCurrencyValue(initialInvestmentValue)} · Holdings value: {currentValue !== null ? formatCurrencyValue(currentValue) : '—'} · Equity: {equityValue !== null ? formatCurrencyValue(equityValue) : '—'}
                  {pnlDisplay && (
                    <> · P/L: <span className={pnlValue >= 0 ? styles.positive : styles.negative}>{pnlDisplay}</span></>
                  )}
                </Typography>
              )}
              {limitBaseline !== null && (
                <React.Fragment>
                  <Typography variant="body2" color="textSecondary" sx={{ ml: 6 }}>
                    Cash limit: ${roundNumber(limitBaseline).toLocaleString()}
                  </Typography>
                  {portfolio.provider === "polymarket" && portfolio.isRealMoney && (
                    <Box sx={{ ml: 6, mt: 0.5 }}>
                      {polymarketBalanceLoading ? (
                        <Typography variant="body2" color="textSecondary">
                          Polymarket wallet: fetching balance…
                        </Typography>
                      ) : polymarketBalanceError ? (
                        <Typography variant="body2" color="error">
                          Polymarket wallet: {polymarketBalanceError}
                        </Typography>
                      ) : polymarketBalance ? (
                        <Typography variant="body2" color="textSecondary">
                          Polymarket wallet: balance {formatCurrencyValue(polymarketBalance.balance ?? polymarketBalance.available)} · tradable {formatCurrencyValue(polymarketBalance.tradable)}{polymarketBalance.allowance !== null && polymarketBalance.allowance !== undefined ? ` (allowance: ${formatCurrencyValue(polymarketBalance.allowance)})` : ""}
                        </Typography>
                      ) : (
                        <Typography variant="body2" color="textSecondary">
                          Polymarket wallet: —
                        </Typography>
                      )}
                      <Typography variant="caption" color="textSecondary">
                        TradingApp caps strategy cash to your cash limit; Polymarket shows your full wallet.
                      </Typography>
                    </Box>
                  )}
                  {limitUsagePct !== null && (
                    <Box sx={{ ml: 6, mt: 0.5, mr: 2 }}>
                      <LinearProgress
                        variant="determinate"
                        value={limitUsagePct}
                        color={limitDifference !== null && limitDifference < 0 ? "warning" : "success"}
                      />
                      <Typography variant="caption" color="textSecondary">
                        {limitUsagePct.toFixed(1)}% of limit used
                      </Typography>
                    </Box>
                  )}
                </React.Fragment>
              )}
              {portfolio.cashBuffer > 0 && (
                <Typography variant="body2" color="textSecondary" sx={{ ml: 6 }}>
                  Cash buffer available: ${roundNumber(portfolio.cashBuffer).toLocaleString()}
                </Typography>
              )}
              <Box sx={{ ml: 6, mt: 2, mr: 2 }}>
                <StrategyEquityChart
                  userId={userData?.user?.id}
                  token={userData?.token}
                  strategyId={portfolio.strategy_id}
                  strategyName={portfolio.name}
                />
              </Box>
              {resendStatus[portfolio.strategy_id]?.message && (
                <Typography
                  variant="body2"
                  sx={{
                    ml: 6,
                    mt: 0.5,
                    color: resendStatus[portfolio.strategy_id]?.error
                      ? theme.palette.error.main
                      : theme.palette.success.main,
                  }}
                >
                  {resendStatus[portfolio.strategy_id].message}
                </Typography>
              )}

                  <Modal
                    open={deleteOpen}
                    onClose={closeDeleteModal}
                    aria-labelledby="delete-strategy-modal-title"
                    aria-describedby="delete-strategy-modal-description"
                  >
                    <div style={{ padding: '20px', backgroundColor: 'white', margin: 'auto', marginTop: '20%', width: '50%' }}>
                      <h2 id="delete-strategy-modal-title">Delete Strategy</h2>
                      <p id="delete-strategy-modal-description">
                        Are you sure that you want to delete this strategy? This will liquidate the assets.
                      </p>
                      <Button variant="contained" color="primary" onClick={closeDeleteModal} style={{ marginRight: '20px' }}>
                        Cancel
                      </Button>
                      <Button variant="contained" color="secondary" onClick={async () => {
                        await deleteStrategy(strategyToDelete);
                        closeDeleteModal();
                        window.location.reload();
                      }}>
                        Proceed
                      </Button>
                    </div>
                  </Modal>

                  <Modal
                    open={resendOpen}
                    onClose={closeResendModal}
                    aria-labelledby="resend-orders-modal-title"
                    aria-describedby="resend-orders-modal-description"
                  >
                    <div style={{ padding: '20px', backgroundColor: 'white', margin: 'auto', marginTop: '20%', width: '50%' }}>
                      <h2 id="resend-orders-modal-title">Resend Orders</h2>
                      <p id="resend-orders-modal-description">
                        Resend the latest allocation orders for "{strategyToResend?.name}"? This will place trades using your current Alpaca account.
                      </p>
                      <Button variant="contained" color="primary" onClick={closeResendModal} style={{ marginRight: '20px' }}>
                        Cancel
                      </Button>
                      <Button
                        variant="contained"
                        color="secondary"
                        disabled={strategyToResend && !!resendStatus[strategyToResend.strategy_id]?.loading}
                        onClick={async () => {
                          if (strategyToResend) {
                            await handleResendOrders(strategyToResend);
                          }
                          closeResendModal();
                        }}
                      >
                        Confirm
                      </Button>
                    </div>
                  </Modal>



              <Collapse in={openPortfolio[portfolio.strategy_id]}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Asset</TableCell>
                      <TableCell align="right">Allocation %</TableCell>
                      <TableCell>Quantity</TableCell>
                      <TableCell align="right">Avg Entry Price</TableCell>
                      <TableCell align="right">Current Price</TableCell>
                      <TableCell align="right">Market Value</TableCell>
                      <TableCell align="right">Unrealized P/L</TableCell>
                      <TableCell align="right">Unrealized P/L %</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {portfolio.stocks.map((stock) => {
                      const qty = Number(stock.quantity) || 0;
                      const avgCost = Number(stock.avgCost);
                      const currentPrice = Number(stock.currentPrice);
                      const marketValue = currentPrice && qty ? currentPrice * qty : null;
                      const allocationRatio = marketValue !== null && totalCurrentTotal > 0
                        ? marketValue / totalCurrentTotal
                        : null;
                      const purchaseTotal = avgCost && qty ? avgCost * qty : null;
                      const unrealizedPL = purchaseTotal !== null && marketValue !== null ? marketValue - purchaseTotal : null;
                      const unrealizedPLPct = unrealizedPL !== null && purchaseTotal ? (unrealizedPL / purchaseTotal) * 100 : null;

                      if (stock.avgCost == null || stock.currentPrice == null) {
                        return (
                          <TableRow key={stock.symbol}>
                            <TableCell>
                              {portfolio.provider === "polymarket" ? (
                                <span>{stock.symbol}</span>
                              ) : (
                                <Link onClick={() => openSaleModal(stock)}>{stock.symbol}</Link>
                              )}
                            </TableCell>
                            <TableCell align="right">—</TableCell>
                            <TableCell>{stock.quantity || "----"}</TableCell>
                            <TableCell colSpan={5}>Order not filled yet.</TableCell>
                          </TableRow>
                        );
                      }

                      return (
                        <TableRow key={stock.symbol}>
                          <TableCell>
                            {portfolio.provider === "polymarket" ? (
                              <span>{stock.symbol}</span>
                            ) : (
                              <Link onClick={() => openSaleModal(stock)}>{stock.symbol}</Link>
                            )}
                          </TableCell>
                          <TableCell align="right">
                            {allocationRatio !== null ? formatPct(allocationRatio) : "----"}
                          </TableCell>
                          <TableCell>{stock.quantity || "----"}</TableCell>
                          <TableCell align="right">
                            ${avgCost ? avgCost.toLocaleString() : "----"}
                          </TableCell>
                          <TableCell align="right">
                            ${currentPrice ? currentPrice.toLocaleString() : "----"}
                          </TableCell>
                          <TableCell
                            align="right"
                            className={
                              marketValue !== null && purchaseTotal !== null && marketValue >= purchaseTotal
                                ? styles.positive
                                : styles.negative
                            }
                          >
                            ${marketValue !== null ? roundNumber(marketValue).toLocaleString() : "----"}
                          </TableCell>
                          <TableCell
                            align="right"
                            className={
                              unrealizedPL !== null && unrealizedPL >= 0
                                ? styles.positive
                                : styles.negative
                            }
                          >
                            ${unrealizedPL !== null ? roundNumber(unrealizedPL).toLocaleString() : "----"}
                          </TableCell>
                          <TableCell
                            align="right"
                            className={
                              unrealizedPLPct !== null && unrealizedPLPct >= 0 ? styles.positive : styles.negative
                            }
                          >
                            {unrealizedPLPct !== null
                              ? `${unrealizedPLPct >= 0 ? "▲" : "▼"} ${Math.abs(unrealizedPLPct).toFixed(2)}%`
                              : "----"}
                          </TableCell>
                        </TableRow>
                      );
                    })}

                    {allStocksHaveAvgCost && (
                      <TableRow>
                        <TableCell>Total</TableCell>
                        <TableCell align="right">100%</TableCell>
                        <TableCell>{totalQuantity}</TableCell>
                        <TableCell></TableCell>
                        <TableCell></TableCell>
                        <TableCell
                          align="right"
                          className={
                            totalCurrentTotal >= totalPurchaseTotal
                              ? styles.positive
                              : styles.negative
                          }
                        >
                          ${roundNumber(totalCurrentTotal).toLocaleString()}
                        </TableCell>
                        <TableCell
                          align="right"
                          className={
                            totalUnrealizedPL !== null && totalUnrealizedPL >= 0
                              ? styles.positive
                              : styles.negative
                          }
                        >
                          ${totalUnrealizedPL !== null ? roundNumber(totalUnrealizedPL).toLocaleString() : "----"}
                        </TableCell>
                        <TableCell
                          align="right"
                          className={
                            totalDiffPct !== null && totalDiffPct >= 0 ? styles.positive : styles.negative
                          }
                        >
                          {totalDiffPct !== null ? `${totalDiffPct >= 0 ? "▲" : "▼"} ${Math.abs(totalDiffPct).toFixed(2)}%` : "----"}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </Collapse>
            </div>
          );
        })
        )}
      </Collapse>

      <Modal
        open={scheduleEditor.open}
        onClose={scheduleEditor.saving ? undefined : closeScheduleEditor}
        aria-labelledby="edit-rebalance-modal-title"
        aria-describedby="edit-rebalance-modal-description"
      >
        <Box
          sx={{
            p: 3,
            backgroundColor: 'background.paper',
            width: '90%',
            maxWidth: 420,
            mx: 'auto',
            mt: '15%',
            borderRadius: 2,
            boxShadow: 24,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <Typography id="edit-rebalance-modal-title" variant="h6">
            Edit next reallocation
          </Typography>
          <Typography id="edit-rebalance-modal-description" variant="body2" color="textSecondary">
            Strategy: {scheduleEditor.portfolio?.name || '—'}
          </Typography>
          <Typography variant="body2" color="textSecondary">
            One-time override: after the next rebalance runs, scheduling returns to the default end-of-day window. Manual times must be during market hours.
          </Typography>
          <TextField
            label="Next reallocation"
            type="datetime-local"
            value={scheduleEditor.value}
            onChange={handleScheduleEditorChange}
            InputLabelProps={{ shrink: true }}
            disabled={scheduleEditor.saving}
          />
          {scheduleEditor.error && (
            <Typography variant="body2" color="error">
              {scheduleEditor.error}
            </Typography>
          )}
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
            <Button onClick={closeScheduleEditor} disabled={scheduleEditor.saving}>
              Cancel
            </Button>
            <Button
              variant="contained"
              onClick={handleScheduleEditorSave}
              disabled={scheduleEditor.saving}
            >
              {scheduleEditor.saving ? 'Saving…' : 'Save'}
            </Button>
          </Box>
        </Box>
      </Modal>

      <Dialog
        open={aiPortfolioDialog.open}
        onClose={closeAiPortfolioDialog}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>AI Portfolio link: {aiPortfolioDialog.name || "Strategy"}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="error" sx={{ mb: 1 }}>
            This link contains your JWT. Treat it like a password.
          </Typography>
          <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
            In aiportfolio: enable <strong>Custom API position?</strong> then paste this link and click{" "}
            <strong>Apply link</strong>.
          </Typography>
          <TextField
            label="Copy/paste link"
            value={aiPortfolioDialog.link}
            fullWidth
            multiline
            minRows={3}
            InputProps={{ readOnly: true }}
            sx={{ mb: 2 }}
          />
          <TextField
            label="API URL (no token)"
            value={aiPortfolioDialog.apiUrl}
            fullWidth
            InputProps={{ readOnly: true }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeAiPortfolioDialog}>Close</Button>
          <Button onClick={copyAiPortfolioLink} variant="contained" disabled={!aiPortfolioDialog.link}>
            {aiPortfolioCopied ? "Copied" : "Copy link"}
          </Button>
        </DialogActions>
      </Dialog>

      <Modal
        open={metadataEditor.open}
        onClose={metadataEditor.saving ? undefined : closeMetadataEditor}
        aria-labelledby="edit-strategy-metadata-title"
        aria-describedby="edit-strategy-metadata-description"
      >
        <Box
          sx={{
            p: 3,
            backgroundColor: 'background.paper',
            width: '90%',
            maxWidth: 480,
            mx: 'auto',
            mt: '15%',
            borderRadius: 2,
            boxShadow: 24,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <Typography id="edit-strategy-metadata-title" variant="h6">
            Edit strategy
          </Typography>
          <Typography id="edit-strategy-metadata-description" variant="body2" color="textSecondary">
            Update the title and optional Symphony link.
          </Typography>
          <TextField
            label="Strategy title"
            value={metadataEditor.name}
            onChange={(event) => setMetadataEditor((prev) => ({ ...prev, name: event.target.value }))}
            disabled={metadataEditor.saving}
            fullWidth
          />
          <TextField
            label="Symphony link (optional)"
            value={metadataEditor.symphonyUrl}
            onChange={(event) => setMetadataEditor((prev) => ({ ...prev, symphonyUrl: event.target.value }))}
            disabled={metadataEditor.saving}
            fullWidth
            placeholder="https://app.composer.trade/symphony/..."
          />
          {metadataEditor.error && (
            <Typography variant="body2" color="error">
              {metadataEditor.error}
            </Typography>
          )}
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
            <Button onClick={closeMetadataEditor} disabled={metadataEditor.saving}>
              Cancel
            </Button>
            <Button
              variant="contained"
              onClick={saveMetadataEditor}
              disabled={metadataEditor.saving}
            >
              {metadataEditor.saving ? 'Saving…' : 'Save'}
            </Button>
          </Box>
        </Box>
      </Modal>

      <Dialog open={backtestOpen} onClose={closeBacktestDialog} fullWidth maxWidth="md">
        <DialogTitle>Backtest: {backtestPortfolio?.name || "Strategy"}</DialogTitle>
        <DialogContent>
          <Box display="flex" gap={2} flexWrap="wrap" mt={1}>
            <TextField
              label="Start date"
              type="date"
              value={backtestStartDate}
              onChange={(e) => setBacktestStartDate(e.target.value)}
              InputLabelProps={{ shrink: true }}
              disabled={backtestLoading}
            />
            <TextField
              label="End date"
              type="date"
              value={backtestEndDate}
              onChange={(e) => setBacktestEndDate(e.target.value)}
              InputLabelProps={{ shrink: true }}
              disabled={backtestLoading}
            />
            <TextField
              label="Transaction cost (bps)"
              type="number"
              value={backtestCostBps}
              onChange={(e) => setBacktestCostBps(e.target.value)}
              inputProps={{ min: 0, step: 1 }}
              disabled={backtestLoading}
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
                  <Typography variant="body2">CAGR: {formatPct(backtestResult.benchmark.metrics.cagr)}</Typography>
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
        </DialogContent>
        <DialogActions>
          <Button onClick={closeBacktestDialog} disabled={backtestLoading}>
            Close
          </Button>
          <Button onClick={runBacktest} variant="contained" disabled={backtestLoading || !backtestPortfolio}>
            Run backtest
          </Button>
        </DialogActions>
      </Dialog>

      {saleOpen && stock && (
        <SaleModal setSaleOpen={setSaleOpen} stock={stock} />
      )}
    </React.Fragment>
  );
};

export default Portfolios;
const RECURRENCE_LABELS = {
  every_minute: "Every minute",
  every_5_minutes: "Every 5 minutes",
  every_15_minutes: "Every 15 minutes",
  hourly: "Hourly",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

const formatRecurrenceLabel = (value) => {
  if (!value) {
    return "—";
  }
  return RECURRENCE_LABELS[value] || value;
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

const formatStatus = (value) => {
  if (!value) {
    return "Scheduled";
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
};

const createScheduleEditorState = (overrides = {}) => ({
  open: false,
  portfolio: null,
  value: '',
  saving: false,
  error: null,
  ...overrides,
});

const formatDateTimeLocalInput = (value) => {
  if (!value) {
    return '';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }
  const offset = parsed.getTimezoneOffset() * 60000;
  return new Date(parsed.getTime() - offset).toISOString().slice(0, 16);
};
