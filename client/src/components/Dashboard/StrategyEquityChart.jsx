import React, { useEffect, useState, useCallback } from "react";
import PropTypes from "prop-types";
import axios from "axios";
import { Box, CircularProgress, Typography } from "@mui/material";
import LineChartPort from "../Template/LineChartPort";
import config from "../../config/Config";
import { logError, logWarn } from "../../utils/logger";

const normalizeHistory = (snapshots = []) => {
  if (!Array.isArray(snapshots)) {
    return [];
  }

  return snapshots
    .map((snapshot) => {
      const timestamp = snapshot.timestamp || snapshot.createdAt;
      const equityValue = Number(snapshot.equityValue ?? snapshot.equity ?? Number.NaN);
      if (!timestamp || Number.isNaN(equityValue)) {
        return null;
      }
      const date = new Date(timestamp);
      const isoTimestamp = Number.isNaN(date.getTime()) ? timestamp : date.toISOString();
      return {
        timestamp: isoTimestamp,
        equity: equityValue,
      };
    })
    .filter(Boolean);
};

const StrategyEquityChart = ({ userId, token, strategyId, strategyName }) => {
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchHistory = useCallback(async () => {
    if (!userId || !token || !strategyId) {
      setHistory(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const headers = { "x-auth-token": token };
      const url = `${config.base_url}/api/strategies/equity/${userId}/${strategyId}?limit=120`;
      const response = await axios.get(url, { headers });
      if (response.data?.status !== "success") {
        logWarn("Equity history request failed:", response.data);
        setHistory(null);
        setError(response.data?.message || "Unable to load equity history.");
        return;
      }
      const normalized = normalizeHistory(response.data?.data);
      setHistory(normalized);
    } catch (requestError) {
      logError("Failed to fetch strategy equity history:", requestError);
      setError(requestError?.response?.data?.message || requestError.message);
      setHistory(null);
    } finally {
      setLoading(false);
    }
  }, [userId, token, strategyId]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  if (!userId || !token || !strategyId) {
    return null;
  }

  const chartData = history?.length ? { history } : null;
  const subtitle = strategyName
    ? `Equity (holdings + cash buffer) for ${strategyName}`
    : "Strategy equity (holdings + cash buffer)";

  return (
    <Box sx={{ width: "100%" }}>
      <Typography variant="subtitle2" color="textSecondary" sx={{ mb: 1 }}>
        {subtitle} (last {history?.length || 0} snapshots)
      </Typography>
      <Box sx={{ minHeight: 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {loading ? (
          <CircularProgress size={18} />
        ) : error ? (
          <Typography variant="body2" color="textSecondary">
            {error}
          </Typography>
        ) : chartData ? (
          <LineChartPort pastDataPeriod={chartData} duration="4 months" />
        ) : (
          <Typography variant="body2" color="textSecondary">
            No equity history yet.
          </Typography>
        )}
      </Box>
    </Box>
  );
};

StrategyEquityChart.propTypes = {
  userId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  token: PropTypes.string,
  strategyId: PropTypes.string,
  strategyName: PropTypes.string,
};

StrategyEquityChart.defaultProps = {
  userId: null,
  token: null,
  strategyId: null,
  strategyName: null,
};

export default StrategyEquityChart;
