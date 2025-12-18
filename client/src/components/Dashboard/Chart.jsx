import React, { useState, useContext, useEffect, useCallback } from "react";
import UserContext from "../../context/UserContext";
import Title from "../Template/Title.jsx";
import LineChart from "../Template/LineChartPort";
import axios from "axios";
import config from "../../config/Config";
import { logError, logWarn } from "../../utils/logger";
import { Box, Button, CircularProgress, Typography } from "@mui/material";

const Chart = () => {
  const [chartData, setChartData] = useState(null);
  const [error, setError] = useState(null);
  const [backfillStatus, setBackfillStatus] = useState(null);
  const [backfillLoading, setBackfillLoading] = useState(false);
  const [backfillError, setBackfillError] = useState(null);
  const { userData } = useContext(UserContext);
  const userId = userData?.user?.id;
  const token = userData?.token;

  const fetchBackfillStatus = useCallback(async () => {
    if (!token || !userId) {
      setBackfillStatus(null);
      return;
    }
    try {
      const headers = { "x-auth-token": token };
      const response = await axios.get(
        `${config.base_url}/api/strategies/equity/backfill-status/${userId}`,
        { headers }
      );
      if (response.data?.status === "success") {
        setBackfillStatus(response.data.data);
      }
    } catch (statusError) {
      logWarn("Unable to fetch equity backfill status:", statusError);
    }
  }, [token, userId]);

  useEffect(() => {
    const fetchPortfolioHistory = async () => {
      if (!userData?.token || !userData?.user?.id) {
        setChartData(null);
        return;
      }

      const headers = {
        "x-auth-token": userData.token,
      };

      try {
        const response = await axios.get(
          `${config.base_url}/api/data/portfolio/${userData.user.id}`,
          { headers }
        );

        if (response.data?.status !== "success" || !response.data?.portfolio) {
          logWarn("Portfolio history request did not succeed:", response.data);
          setChartData(null);
          setError(response.data?.message || "Unable to load portfolio history.");
          return;
        }

        const history = normalizePortfolioHistory(response.data.portfolio);

        if (!history || history.length === 0) {
          logWarn("Portfolio history response missing data:", response.data.portfolio);
          setChartData(null);
          setError("No portfolio history available.");
          return;
        }

        setChartData({ history });
        setError(null);
      } catch (fetchError) {
        logError("Error fetching portfolio history:", fetchError);
        setError(fetchError.response?.data?.message || fetchError.message);
        setChartData(null);
      }
    };

    fetchPortfolioHistory();
    fetchBackfillStatus();
  }, [userData?.token, userData?.user?.id, fetchBackfillStatus]);

  const handleBackfillClick = async () => {
    if (!token || !userId) return;
    setBackfillLoading(true);
    setBackfillError(null);
    try {
      const headers = { "x-auth-token": token };
      const response = await axios.post(
        `${config.base_url}/api/strategies/equity/backfill/${userId}`,
        {},
        { headers }
      );
      if (response.data?.status === "success") {
        setBackfillStatus((prev) => ({
          ...(prev || {}),
          status: response.data.result?.status || "completed",
          completedAt: new Date().toISOString(),
          metadata: response.data.result || null,
        }));
      }
    } catch (backfillErr) {
      const message = backfillErr?.response?.data?.message || backfillErr.message;
      setBackfillError(message);
      logError("Failed to run equity backfill:", backfillErr);
    } finally {
      setBackfillLoading(false);
      fetchBackfillStatus();
    }
  };

  const isBackfillCompleted = backfillStatus?.status === "completed";

  if (error) {
    return (
      <React.Fragment>
        <Title>Portfolio Performance Chart</Title>
        <div style={{ minHeight: "240px", display: "flex", alignItems: "center" }}>
          <p style={{ color: "#b00020" }}>{error}</p>
        </div>
      </React.Fragment>
    );
  }

  if (!chartData) {
    return null;
  }

  return (
    <React.Fragment>
      <Title>Portfolio Performance Chart</Title>
      {token && userId && (
        <Box sx={{ display: "flex", alignItems: "center", mb: 1, gap: 2 }}>
          <Button
            variant="outlined"
            size="small"
            onClick={handleBackfillClick}
            disabled={backfillLoading || isBackfillCompleted}
          >
            {backfillLoading ? <CircularProgress size={18} /> : 'Backfill equity history'}
          </Button>
          <Typography variant="body2" color="textSecondary">
            {isBackfillCompleted
              ? "Backfill already completed."
              : backfillStatus?.status === "running"
                ? "Backfill is currently running…"
                : "Populate history from logs if missing."}
          </Typography>
        </Box>
      )}
      {backfillError && (
        <Typography variant="body2" sx={{ color: "#b00020", mb: 1 }}>
          {backfillError}
        </Typography>
      )}
      <div style={{ minHeight: "240px" }}>
        <LineChart pastDataPeriod={chartData} duration={"12 months"} />
      </div>
    </React.Fragment>
  );
};

const normalizePortfolioHistory = (portfolio) => {
  if (!portfolio) {
    return null;
  }

  if (Array.isArray(portfolio.history)) {
    return portfolio.history;
  }

  const timestamps = portfolio.timestamp || portfolio.timestamps;
  const equities = portfolio.equity;

  if (!Array.isArray(timestamps) || !Array.isArray(equities) || timestamps.length !== equities.length) {
    return null;
  }

  return timestamps.map((ts, index) => ({
    timestamp: convertTimestamp(ts),
    equity: Number(equities[index]),
  }));
};

const convertTimestamp = (value) => {
  if (!value) {
    return value;
  }

  if (typeof value === "number") {
    return new Date(value * 1000).toISOString();
  }

  const parsed = Number(value);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed * 1000).toISOString();
  }

  return value;
};

export default Chart;
