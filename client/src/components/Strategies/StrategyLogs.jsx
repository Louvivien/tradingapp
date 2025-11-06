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

    return logs.map((log) => {
      const details = log.details || null;
      let humanSummary = null;
      let remainingDetails = null;
      let thoughtProcess = null;

      if (details && typeof details === "object" && !Array.isArray(details)) {
        const { humanSummary: summaryText, thoughtProcess: tp, ...rest } = details;
        humanSummary = summaryText || null;
        thoughtProcess = tp || null;
        remainingDetails = Object.keys(rest || {}).length ? rest : null;
      } else {
        remainingDetails = details;
      }

      const reasoningList = Array.isArray(thoughtProcess?.reasoning)
        ? thoughtProcess.reasoning.filter(Boolean)
        : [];
      const adjustments = Array.isArray(thoughtProcess?.adjustments)
        ? thoughtProcess.adjustments
        : [];
      const cashSummary = thoughtProcess?.cashSummary || null;
      const composerPositions = Array.isArray(thoughtProcess?.composerPositions)
        ? thoughtProcess.composerPositions
        : [];
      const codeInterpreterInfo = thoughtProcess?.tooling?.codeInterpreter;
      const blueprintList = Array.isArray(codeInterpreterInfo?.blueprint)
        ? codeInterpreterInfo.blueprint.filter(Boolean)
        : [];
      const toolingTickers = Array.isArray(codeInterpreterInfo?.tickers)
        ? codeInterpreterInfo.tickers.filter(Boolean)
        : [];
      const buyList = Array.isArray(details?.buys) ? details.buys : [];
      const sellList = Array.isArray(details?.sells) ? details.sells : [];
      const holdList = Array.isArray(details?.holds) ? details.holds : [];

      return (
        <Paper key={log._id} sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle2">
            {formatDateTime(log.createdAt)} · {log.level?.toUpperCase() || "INFO"}
          </Typography>
          <Typography variant="body2" sx={{ mt: 1 }}>
            {log.message}
          </Typography>
          {humanSummary && (
            <Box
              sx={{
                backgroundColor: "#f8f9fb",
                borderRadius: 1,
                fontSize: "0.9rem",
                mt: 1,
                p: 1.5,
                whiteSpace: "pre-line",
              }}
            >
              {humanSummary}
            </Box>
          )}
          {reasoningList.length > 0 && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="subtitle2">Agent reasoning</Typography>
              {reasoningList.map((item, index) => (
                <Typography key={`${log._id}-reasoning-${index}`} variant="body2">
                  • {item}
                </Typography>
              ))}
            </Box>
          )}
          {codeInterpreterInfo?.used && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="subtitle2">Tooling</Typography>
              <Typography variant="body2">
                • Code interpreter evaluated the Composer strategy and computed the requested metrics.
              </Typography>
              {toolingTickers.length > 0 && (
                <Typography variant="body2">
                  • Instrument universe parsed: {toolingTickers.join(', ')}.
                </Typography>
              )}
              {blueprintList.length > 0 && (
                <Box sx={{ mt: 0.5 }}>
                  {blueprintList.map((step, index) => (
                    <Typography key={`${log._id}-ci-step-${index}`} variant="body2">
                      • Step {index + 1}: {step}
                    </Typography>
                  ))}
                </Box>
              )}
            </Box>
          )}
          {composerPositions.length > 0 && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="subtitle2">Composer evaluation</Typography>
              {composerPositions.map((pos, index) => (
                <Typography key={`${log._id}-composer-${index}`} variant="body2">
                  • {pos.symbol}: weight {formatPercent(pos.weight)} · qty {pos.quantity ?? "n/a"} · est cost
                  {pos.estimated_cost != null ? ` ${formatCurrency(pos.estimated_cost)}` : ''}
                </Typography>
              ))}
            </Box>
          )}
          {adjustments.length > 0 && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="subtitle2">Adjustments</Typography>
              {adjustments.map((adj, index) => (
                <Typography key={`${log._id}-adjustment-${index}`} variant="body2">
                  • {adj.symbol}: {adj.action?.toUpperCase?.() || adj.action} from {adj.currentQty} to {adj.desiredQty}.
                  {adj.explanation ? ` ${adj.explanation}` : ''}
                </Typography>
              ))}
            </Box>
          )}
          {buyList.length > 0 && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="subtitle2">Buy orders</Typography>
              {buyList.map((buy, index) => (
                <Typography key={`${log._id}-buy-${index}`} variant="body2">
                  • {buy.symbol}: {buy.qty} shares{buy.price != null ? ` @ ${formatCurrency(buy.price)}` : ''}
                </Typography>
              ))}
            </Box>
          )}
          {sellList.length > 0 && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="subtitle2">Sell orders</Typography>
              {sellList.map((sell, index) => (
                <Typography key={`${log._id}-sell-${index}`} variant="body2">
                  • {sell.symbol}: {sell.qty} shares{sell.price != null ? ` @ ${formatCurrency(sell.price)}` : ''}
                </Typography>
              ))}
            </Box>
          )}
          {holdList.length > 0 && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="subtitle2">Positions unchanged</Typography>
              {holdList.map((hold, index) => (
                <Typography key={`${log._id}-hold-${index}`} variant="body2">
                  • {hold.symbol}: {hold.explanation || 'No action taken.'}
                </Typography>
              ))}
            </Box>
          )}
          {cashSummary && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="subtitle2">Cash summary</Typography>
              {cashSummary.startingCash != null && (
                <Typography variant="body2">• Starting cash: {formatCurrency(cashSummary.startingCash)}</Typography>
              )}
              {cashSummary.sellProceeds != null && (
                <Typography variant="body2">• Sell proceeds: {formatCurrency(cashSummary.sellProceeds)}</Typography>
              )}
              {cashSummary.spentOnBuys != null && (
                <Typography variant="body2">• Spent on buys: {formatCurrency(cashSummary.spentOnBuys)}</Typography>
              )}
              {cashSummary.endingCash != null && (
                <Typography variant="body2">• Ending cash: {formatCurrency(cashSummary.endingCash)}</Typography>
              )}
              {cashSummary.cashBuffer != null && (
                <Typography variant="body2">• Cash buffer: {formatCurrency(cashSummary.cashBuffer)}</Typography>
              )}
            </Box>
          )}
          {remainingDetails && (
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
              {JSON.stringify(remainingDetails, null, 2)}
            </Box>
          )}
        </Paper>
      );
    });
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

const formatCurrency = (value) => {
  if (value == null || Number.isNaN(Number(value))) {
    return 'n/a';
  }
  const num = Number(value);
  return `$${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const formatPercent = (value) => {
  if (value == null || Number.isNaN(Number(value))) {
    return 'n/a';
  }
  const num = Number(value);
  return `${(num * 100).toFixed(2)}%`;
};

export default StrategyLogs;
