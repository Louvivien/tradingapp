import React, { useContext, useEffect, useRef, useState } from "react";
import { Box, Button, CircularProgress, Collapse, Paper, Typography } from "@mui/material";
import { useNavigate } from "react-router-dom";
import Axios from "axios";
import config from "../../config/Config";
import UserContext from "../../context/UserContext";

const POLL_INTERVAL_MS = 1000;
const MAX_LOGS = 500;
const PAGE_SIZE = 200;

const LiveLogs = () => {
  const navigate = useNavigate();
  const { userData } = useContext(UserContext);
  const userId = userData?.user?.id;
  const token = userData?.token;

  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedSummaries, setExpandedSummaries] = useState({});

  const cursorRef = useRef({ after: null, afterId: null });
  const pollingRef = useRef({ cancelled: false });

  const isExpanded = (id) => Boolean(expandedSummaries[String(id)]);
  const toggleExpanded = (id) => {
    const key = String(id);
    setExpandedSummaries((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  useEffect(() => {
    if (!userId || !token) {
      return;
    }

    pollingRef.current.cancelled = false;
    cursorRef.current = { after: null, afterId: null };
    setExpandedSummaries({});
    setLogs([]);
    setError(null);
    setLoading(true);

    let timeoutId = null;

    const fetchBatch = async ({ initial }) => {
      const url = `${config.base_url}/api/strategies/logs/all/${userId}`;
      const headers = { "x-auth-token": token };

      const params = {
        limit: PAGE_SIZE,
        compact: 1,
      };

      const after = cursorRef.current.after;
      const afterId = cursorRef.current.afterId;
      if (!initial && after) {
        params.after = after;
        if (afterId) {
          params.afterId = afterId;
        }
      }

      const response = await Axios.get(url, { headers, params });
      if (response.data.status !== "success") {
        throw new Error(response.data.message || "Unable to load logs.");
      }

      const batch = Array.isArray(response.data.logs) ? response.data.logs : [];
      if (!batch.length) {
        return;
      }

      cursorRef.current = {
        after: batch[0]?.createdAt || cursorRef.current.after,
        afterId: batch[0]?._id || cursorRef.current.afterId,
      };

      setLogs((prev) => {
        const seen = new Set(prev.map((log) => String(log?._id)));
        const uniqueBatch = batch.filter((log) => {
          const id = String(log?._id);
          if (!id || seen.has(id)) {
            return false;
          }
          seen.add(id);
          return true;
        });
        if (!uniqueBatch.length) {
          return prev;
        }
        const next = [...uniqueBatch, ...prev];
        return next.slice(0, MAX_LOGS);
      });
    };

    const start = async () => {
      try {
        await fetchBatch({ initial: true });
      } catch (fetchError) {
        setError(fetchError.response?.data?.message || fetchError.message);
      } finally {
        setLoading(false);
      }

      const tick = async () => {
        if (pollingRef.current.cancelled) {
          return;
        }
        try {
          await fetchBatch({ initial: false });
        } catch (pollError) {
          setError(pollError.response?.data?.message || pollError.message);
        }
        if (pollingRef.current.cancelled) {
          return;
        }
        timeoutId = setTimeout(tick, POLL_INTERVAL_MS);
      };

      timeoutId = setTimeout(tick, POLL_INTERVAL_MS);
    };

    start();

    return () => {
      pollingRef.current.cancelled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [userId, token]);

  const openStrategyLogs = (log) => {
    const strategyId = log?.strategy_id;
    if (!strategyId) {
      return;
    }
    const name = log?.strategyName || "";
    navigate(`/strategies/${strategyId}/logs?name=${encodeURIComponent(name)}`);
  };

  const renderBody = () => {
    if (!userId || !token) {
      return (
        <Typography color="textSecondary">
          Your session has expired. Please sign in again to review activity logs.
        </Typography>
      );
    }

    if (loading) {
      return (
        <Box sx={{ display: "flex", justifyContent: "center", mt: 4 }}>
          <CircularProgress />
        </Box>
      );
    }

    if (error) {
      return (
        <Typography color="error" sx={{ mt: 2 }}>
          {error}
        </Typography>
      );
    }

    if (!logs.length) {
      return (
        <Typography sx={{ mt: 2 }}>
          No log entries yet. Leave this page open and it will auto-refresh.
        </Typography>
      );
    }

    return logs.map((log) => {
      const humanSummary = log?.details?.humanSummary || null;
      return (
        <Paper key={log._id} sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle2">
            {formatDateTime(log.createdAt)} · {(log.level || "info").toUpperCase()} ·{" "}
            {log.strategyName || log.strategy_id}
          </Typography>
          <Typography variant="body2" sx={{ mt: 1 }}>
            {log.message}
          </Typography>
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mt: 1 }}>
            <Button size="small" variant="outlined" onClick={() => openStrategyLogs(log)}>
              Open strategy logs
            </Button>
            {humanSummary && (
              <Button size="small" variant="text" onClick={() => toggleExpanded(log._id)}>
                {isExpanded(log._id) ? "Hide summary" : "Show summary"}
              </Button>
            )}
          </Box>
          {humanSummary && (
            <Collapse in={isExpanded(log._id)} timeout="auto" unmountOnExit>
              <Box
                component="pre"
                sx={{
                  backgroundColor: "#f6f8fa",
                  borderRadius: 1,
                  fontSize: "0.85rem",
                  mt: 1,
                  overflowX: "auto",
                  p: 1.5,
                  whiteSpace: "pre-wrap",
                }}
              >
                {humanSummary}
              </Box>
            </Collapse>
          )}
        </Paper>
      );
    });
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2 }}>
        <Box>
          <Typography variant="h5">Live Logs — All Strategies</Typography>
          <Typography variant="body2" color="textSecondary">
            Auto-refreshing every {Math.round(POLL_INTERVAL_MS / 100) / 10}s · Showing up to {MAX_LOGS} entries
          </Typography>
        </Box>
        <Button variant="outlined" onClick={() => navigate("/")}>
          Back to dashboard
        </Button>
      </Box>
      {renderBody()}
    </Box>
  );
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

export default LiveLogs;

