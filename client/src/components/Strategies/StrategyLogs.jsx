import React, { useContext, useEffect, useState } from "react";
import { Box, Button, CircularProgress, Collapse, Paper, Typography } from "@mui/material";
import Axios from "axios";
import config from "../../config/Config";
import UserContext from "../../context/UserContext";

const StrategyLogs = ({ strategyId, strategyName, onClose = () => {} }) => {
  const { userData } = useContext(UserContext);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedSections, setExpandedSections] = useState({});

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

  const isSectionExpanded = (logId, section) => Boolean(expandedSections[`${logId}:${section}`]);
  const toggleSection = (logId, section) => {
    const key = `${logId}:${section}`;
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

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
        const trimmed = { ...(rest || {}) };
        ["buys", "sells", "rebalance", "holds"].forEach((key) => {
          if (key in trimmed) {
            delete trimmed[key];
          }
        });
        remainingDetails = Object.keys(trimmed || {}).length ? trimmed : null;
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
      const localEvaluatorInfo = thoughtProcess?.tooling?.localEvaluator;
	      const localBlueprintList = Array.isArray(localEvaluatorInfo?.blueprint)
	        ? localEvaluatorInfo.blueprint.filter(Boolean)
	        : [];
	      const localTickers = Array.isArray(localEvaluatorInfo?.tickers)
	        ? localEvaluatorInfo.tickers.filter(Boolean)
	        : [];
      const rebalanceList = Array.isArray(details?.rebalance) ? details.rebalance : [];
      const buyList = Array.isArray(details?.buys) ? details.buys : [];
      const sellList = Array.isArray(details?.sells) ? details.sells : [];
      const holdList = Array.isArray(details?.holds) ? details.holds : [];
      const isPolymarket = details?.provider === "polymarket";
      const showMakerTradeLabels = isPolymarket && details?.sizeToBudget === true;

      const polymarketSummary =
        !humanSummary && isPolymarket && details && typeof details === "object" && !Array.isArray(details)
          ? buildPolymarketHumanSummary(details)
          : null;
      if (!humanSummary && polymarketSummary) {
        humanSummary = polymarketSummary;
      }

      const MAX_LIST_ITEMS = 12;
      const showBuyExpand = buyList.length > MAX_LIST_ITEMS;
      const showSellExpand = sellList.length > MAX_LIST_ITEMS;
      const showRebalanceExpand = rebalanceList.length > MAX_LIST_ITEMS;
      const showHoldExpand = holdList.length > MAX_LIST_ITEMS;
      const showRawExpand = remainingDetails != null;

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
          {localEvaluatorInfo?.used && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="subtitle2">Tooling</Typography>
              <>
                <Typography variant="body2">
                  • Local defsymphony evaluator sized allocations using cached Alpaca prices.
                </Typography>
                {localTickers.length > 0 && (
                  <Typography variant="body2">
                    • Cached instrument universe: {localTickers.join(', ')}.
                  </Typography>
                )}
                {typeof localEvaluatorInfo.lookbackDays === "number" && (
                  <Typography variant="body2">
                    • Price cache lookback window: {localEvaluatorInfo.lookbackDays} days.
                  </Typography>
                )}
                {localEvaluatorInfo.fallbackReason && (
                  <Typography variant="body2">
                    • Reason for local evaluation: {localEvaluatorInfo.fallbackReason}.
                  </Typography>
                )}
                {localBlueprintList.length > 0 && (
                  <Box sx={{ mt: 0.5 }}>
                    {localBlueprintList.map((step, index) => (
                      <Typography key={`${log._id}-local-step-${index}`} variant="body2">
                        • Step {index + 1}: {step}
                      </Typography>
                    ))}
                  </Box>
                )}
              </>
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
              <Typography variant="subtitle2">
                {showMakerTradeLabels ? "Copied maker buys" : "Buy orders"}
              </Typography>
              {(
                isSectionExpanded(log._id, "buys") ? buyList : buyList.slice(0, MAX_LIST_ITEMS)
              ).map((buy, index) => {
                const qty = buy?.qty ?? buy?.size ?? buy?.amount ?? buy?.quantity;
                const priceText = buy?.price != null ? ` @ ${formatCurrency(buy.price)}` : "";
                const costText = buy?.cost != null ? ` · cost ${formatCurrency(buy.cost)}` : "";
                return (
                  <Typography key={`${log._id}-buy-${index}`} variant="body2">
                    • {buy.symbol}: {qty} shares{priceText}
                    {costText}
                  </Typography>
                );
              })}
              {showBuyExpand && (
                <Button
                  size="small"
                  variant="text"
                  sx={{ mt: 0.5 }}
                  onClick={() => toggleSection(log._id, "buys")}
                >
                  {isSectionExpanded(log._id, "buys")
                    ? "Show less"
                    : `Show all (${buyList.length})`}
                </Button>
              )}
            </Box>
          )}

          {sellList.length > 0 && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="subtitle2">
                {showMakerTradeLabels ? "Copied maker sells" : "Sell orders"}
              </Typography>
              {(
                isSectionExpanded(log._id, "sells") ? sellList : sellList.slice(0, MAX_LIST_ITEMS)
              ).map((sell, index) => {
                const qty = sell?.qty ?? sell?.size ?? sell?.amount ?? sell?.quantity;
                const priceText = sell?.price != null ? ` @ ${formatCurrency(sell.price)}` : "";
                const proceedsText =
                  sell?.proceeds != null ? ` · proceeds ${formatCurrency(sell.proceeds)}` : "";
                return (
                  <Typography key={`${log._id}-sell-${index}`} variant="body2">
                    • {sell.symbol}: {qty} shares{priceText}
                    {proceedsText}
                  </Typography>
                );
              })}
              {showSellExpand && (
                <Button
                  size="small"
                  variant="text"
                  sx={{ mt: 0.5 }}
                  onClick={() => toggleSection(log._id, "sells")}
                >
                  {isSectionExpanded(log._id, "sells")
                    ? "Show less"
                    : `Show all (${sellList.length})`}
                </Button>
              )}
            </Box>
          )}

          {isPolymarket && rebalanceList.length > 0 && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="subtitle2">My live orders</Typography>
              {(
                isSectionExpanded(log._id, "rebalance")
                  ? rebalanceList
                  : rebalanceList.slice(0, MAX_LIST_ITEMS)
              ).map((row, index) => {
		                const side = String(row?.side || "").toUpperCase();
		                const symbol = row?.symbol || "PM";
		                const orderId = row?.execution?.orderId || null;
                const rawStatus = row?.execution?.status ?? null;
                const statusCode = Number(rawStatus);
                const hasStatusCode = Number.isFinite(statusCode) && statusCode >= 100;
                const statusText =
                  rawStatus != null && (typeof rawStatus === "string" || Number.isNaN(statusCode))
                    ? String(rawStatus)
                    : hasStatusCode
                      ? `${statusCode}`
                      : null;
		                const execError = row?.execution?.error || row?.error || null;
		                const price = row?.price != null ? formatCurrency(row.price) : null;
		                const notional = row?.notional != null ? formatCurrency(row.notional) : null;
		
		                const amountText =
		                  side === "BUY"
		                    ? notional || formatCurrency(row?.amount)
		                    : `${row?.amount} shares`;
		
		                const suffixParts = [];
			                if (price) suffixParts.push(`@ ${price}`);
                  if (statusText && !suffixParts.some((part) => part.startsWith("status "))) {
                    suffixParts.push(`status ${statusText}`);
                  }
			                if (orderId) suffixParts.push(`order ${orderId}`);
			                const looksSkipped = row?.reason === "execution_skipped_untradeable_token";
			                const looksFailed =
			                  row?.reason === "execution_failed" ||
			                  row?.reason === "execution_retryable_error" ||
			                  (hasStatusCode && statusCode >= 400 && !orderId);
			                if (looksSkipped) {
			                  suffixParts.push(
			                    `SKIPPED: ${execError || row?.error || row?.reason || "Untradeable token"}`
			                  );
			                }
			                if (looksFailed) {
			                  suffixParts.push(
			                    `FAILED${hasStatusCode ? ` (${statusCode})` : ""}: ${execError || row?.error || row?.reason || "Order rejected"}`
			                  );
			                }
		
		                return (
		                  <Typography key={`${log._id}-rebalance-${index}`} variant="body2">
		                    • {side} {symbol}: {amountText}
	                    {suffixParts.length ? ` · ${suffixParts.join(" · ")}` : ""}
	                  </Typography>
	                );
	              })}
              {showRebalanceExpand && (
                <Button
                  size="small"
                  variant="text"
                  sx={{ mt: 0.5 }}
                  onClick={() => toggleSection(log._id, "rebalance")}
                >
                  {isSectionExpanded(log._id, "rebalance")
                    ? "Show less"
                    : `Show all (${rebalanceList.length})`}
                </Button>
              )}
	            </Box>
	          )}

          {holdList.length > 0 && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="subtitle2">Positions unchanged</Typography>
              {(
                isSectionExpanded(log._id, "holds") ? holdList : holdList.slice(0, MAX_LIST_ITEMS)
              ).map((hold, index) => (
                <Typography key={`${log._id}-hold-${index}`} variant="body2">
                  • {hold.symbol}: {hold.explanation || "No action taken."}
                </Typography>
              ))}
              {showHoldExpand && (
                <Button
                  size="small"
                  variant="text"
                  sx={{ mt: 0.5 }}
                  onClick={() => toggleSection(log._id, "holds")}
                >
                  {isSectionExpanded(log._id, "holds")
                    ? "Show less"
                    : `Show all (${holdList.length})`}
                </Button>
              )}
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

          {showRawExpand && (
            <Box sx={{ mt: 1 }}>
              <Button
                size="small"
                variant="text"
                onClick={() => toggleSection(log._id, "raw")}
              >
                {isSectionExpanded(log._id, "raw") ? "Hide raw details" : "Show raw details"}
              </Button>
              <Collapse in={isSectionExpanded(log._id, "raw")} timeout="auto" unmountOnExit>
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
              </Collapse>
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

const formatNumber = (value, digits = 6) => {
  if (value == null || Number.isNaN(Number(value))) {
    return "n/a";
  }
  const num = Number(value);
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.max(0, Math.min(12, digits)),
  });
};

const pickLargestBy = (list, field) => {
  if (!Array.isArray(list) || !list.length) {
    return null;
  }
  let best = null;
  let bestValue = null;
  list.forEach((item) => {
    if (!item || typeof item !== "object") {
      return;
    }
    const val = Number(item[field]);
    if (!Number.isFinite(val)) {
      return;
    }
    if (bestValue === null || val > bestValue) {
      bestValue = val;
      best = item;
    }
  });
  return best;
};

const buildPolymarketHumanSummary = (details) => {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return null;
  }
  if (details.provider !== "polymarket") {
    return null;
  }

  const lines = [];
  lines.push("Polymarket copy-trader sync.");

  const mode = details.mode ? String(details.mode) : null;
  const executionMode = details.executionMode ? String(details.executionMode) : null;
  const portfolioUpdated =
    details.portfolioUpdated === true ? "yes" : details.portfolioUpdated === false ? "no" : null;

  const sizing = details.sizing && typeof details.sizing === "object" ? details.sizing : null;
  const scale = sizing?.scale;
  const sizingBudget = sizing?.sizingBudget;
  const makerValue = sizing?.makerValue;

  const makerBuys = Array.isArray(details.buys) ? details.buys : [];
  const makerSells = Array.isArray(details.sells) ? details.sells : [];

  const buyCount = Number.isFinite(Number(details.buyCount)) ? Number(details.buyCount) : makerBuys.length;
  const sellCount = Number.isFinite(Number(details.sellCount)) ? Number(details.sellCount) : makerSells.length;

  const largestBuy = pickLargestBy(makerBuys, "cost");
  const largestSell = pickLargestBy(makerSells, "proceeds");

  const plan = details.liveRebalancePlan && typeof details.liveRebalancePlan === "object" ? details.liveRebalancePlan : null;
  const attemptedOrders = plan && Number.isFinite(Number(plan.attemptedOrders)) ? Number(plan.attemptedOrders) : null;
  const successfulOrders = plan && Number.isFinite(Number(plan.successfulOrders)) ? Number(plan.successfulOrders) : null;
  const failedOrders = plan && Number.isFinite(Number(plan.failedOrders)) ? Number(plan.failedOrders) : null;
  const skippedOrders = plan && Number.isFinite(Number(plan.skippedOrders)) ? Number(plan.skippedOrders) : null;
  const planReason = plan?.reason ? String(plan.reason) : null;

  const modeParts = [
    mode ? `mode ${mode}` : null,
    executionMode ? `execution ${executionMode}` : null,
  ].filter(Boolean);
  if (modeParts.length) {
    lines.push(`• ${modeParts.join(" · ")}.`);
  }

  if (details.sizeToBudget === true) {
    const segments = [];
    if (sizingBudget != null) segments.push(`budget ${formatCurrency(sizingBudget)}`);
    if (scale != null) segments.push(`scale ${formatNumber(scale, 8)}`);
    if (makerValue != null) segments.push(`maker value ${formatCurrency(makerValue)}`);
    if (segments.length) {
      lines.push(`• Size-to-budget: ON (${segments.join(" · ")}).`);
    } else {
      lines.push("• Size-to-budget: ON.");
    }
  }

  if (buyCount || sellCount) {
    lines.push(
      details.sizeToBudget === true
        ? `• Maker trades ingested: buys ${buyCount} · sells ${sellCount}.`
        : `• Trades processed: buys ${buyCount} · sells ${sellCount}.`
    );
  }

  if (largestBuy?.symbol && largestBuy?.cost != null) {
    const priceText = largestBuy.price != null ? ` @ ${formatCurrency(largestBuy.price)}` : "";
    const label = details.sizeToBudget === true ? "Largest maker buy" : "Largest buy";
    lines.push(`• ${label}: ${largestBuy.symbol} cost ${formatCurrency(largestBuy.cost)}${priceText}.`);
  }
  if (largestSell?.symbol && largestSell?.proceeds != null) {
    const priceText = largestSell.price != null ? ` @ ${formatCurrency(largestSell.price)}` : "";
    const label = details.sizeToBudget === true ? "Largest maker sell" : "Largest sell";
    lines.push(`• ${label}: ${largestSell.symbol} proceeds ${formatCurrency(largestSell.proceeds)}${priceText}.`);
  }

  if (attemptedOrders !== null || successfulOrders !== null || failedOrders !== null || skippedOrders !== null) {
    const parts = [
      attemptedOrders !== null ? `attempted ${attemptedOrders}` : null,
      successfulOrders !== null ? `matched ${successfulOrders}` : null,
      failedOrders !== null ? `failed ${failedOrders}` : null,
      skippedOrders !== null ? `skipped ${skippedOrders}` : null,
    ].filter(Boolean);
    const suffix = planReason ? ` (reason: ${planReason})` : "";
    if (parts.length) {
      lines.push(`• My live orders: ${parts.join(" · ")}${suffix}.`);
    }
  }

  if (portfolioUpdated) {
    lines.push(`• Portfolio updated: ${portfolioUpdated}.`);
  }

  return lines.join("\n");
};

const formatPercent = (value) => {
  if (value == null || Number.isNaN(Number(value))) {
    return 'n/a';
  }
  const num = Number(value);
  return `${(num * 100).toFixed(2)}%`;
};

export default StrategyLogs;
