import React, { useContext, useEffect, useState } from "react";
import { Box, Button, CircularProgress, Paper, Typography } from "@mui/material";
import Axios from "axios";
import config from "../../config/Config";
import UserContext from "../../context/UserContext";

const StrategyLogs = ({ strategyId, strategyName, onClose = () => {} }) => {
  const { userData } = useContext(UserContext);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const userId = userData?.user?.id;
  const token = userData?.token;

  useEffect(() => {
    if (!strategyId || !userId || !token) {
      return;
    }

    let isMounted = true;

    const fetchLogs = async () => {
      setLoading(true);
      setError(null);

      try {
        const url = `${config.base_url}/api/strategies/logs/${userId}/${strategyId}`;
        const headers = {
          "x-auth-token": token,
        };

        const response = await Axios.get(url, { headers });

        if (!isMounted) {
          return;
        }

        if (response.data.status === "success") {
          setLogs(response.data.logs || []);
        } else {
          setError(response.data.message || "Unable to load strategy logs.");
          setLogs([]);
        }
      } catch (fetchError) {
        if (!isMounted) {
          return;
        }
        setError(fetchError.response?.data?.message || fetchError.message);
        setLogs([]);
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    fetchLogs();

    return () => {
      isMounted = false;
    };
  }, [strategyId, userId, token]);

  const renderBody = () => {
    if (!strategyId) {
      return (
        <Typography color="textSecondary">
          Select a strategy portfolio from the dashboard to inspect its activity logs.
        </Typography>
      );
    }

    if (!userId || !token) {
      return (
        <Typography color="textSecondary">
          Your session has expired. Please sign in again to review strategy activity.
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

    if (logs.length === 0) {
      return (
        <Typography sx={{ mt: 2 }}>
          No log entries yet. Come back after the next reallocation cycle.
        </Typography>
      );
    }

    return logs.map((log) => (
      <Paper key={log._id} sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2">
          {formatDateTime(log.createdAt)} · {log.level?.toUpperCase() || "INFO"}
        </Typography>
        <Typography variant="body2" sx={{ mt: 1 }}>
          {log.message}
        </Typography>
        {log.details && (
          <Box
            component="pre"
            sx={{
              backgroundColor: "#f6f8fa",
              borderRadius: 1,
              fontSize: "0.85rem",
              mt: 1,
              overflowX: "auto",
              p: 1.5,
            }}
          >
            {JSON.stringify(log.details, null, 2)}
          </Box>
        )}
      </Paper>
    ));
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Typography variant="h5">
          Strategy Logs {strategyName ? `— ${strategyName}` : ""}
        </Typography>
        <Button variant="outlined" onClick={onClose}>
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

export default StrategyLogs;
