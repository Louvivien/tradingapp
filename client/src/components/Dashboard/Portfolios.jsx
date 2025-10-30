import React, { useContext, useState } from "react";
import { Link, Collapse, IconButton, Modal, Button, Typography, useTheme, LinearProgress, Box, TextField, MenuItem, CircularProgress } from "@mui/material";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Title from "../Template/Title.jsx";
import SaleModal from "./SaleModal.jsx";
import styles from "./Dashboard.module.css";
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Axios from "axios";
import config from "../../config/Config";
import UserContext from "../../context/UserContext";
import HighlightOffIcon from '@mui/icons-material/HighlightOff';
import { useNavigate } from "react-router-dom";
import { logError } from "../../utils/logger";





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

  const openSaleModal = (stock) => {
    setStock(stock);
    setSaleOpen(true);
  };


  const handleStrategiesClick = () => {
    setOpenStrategies(!openStrategies);
  };

  const handlePortfolioClick = (name) => {
    setOpenPortfolio(prevState => ({ ...prevState, [name]: !prevState[name] }));
  };



  const openDeleteModal = (strategyId) => {
    // console.log('strategyId:', strategyId);
    setStrategyToDelete(strategyId);
    setDeleteOpen(true);
};



  const closeDeleteModal = () => {
    setDeleteOpen(false);
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
        {portfolios.map((portfolio) => {
          // console.log('Portfolio:', portfolio);
          
          // Calculate totals for each portfolio
          let totalQuantity = 0;
          let totalPurchaseTotal = 0;
          let totalCurrentTotal = 0;
          let totalDifference = 0;
          let allStocksHaveAvgCost = true;

          portfolio.stocks.forEach((stock) => {
            if (stock.avgCost === null || stock.currentPrice === null) {
              allStocksHaveAvgCost = false;
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
            : '—';
          const currentSummary = allStocksHaveAvgCost && totalCurrentTotal > 0
            ? `$${roundNumber(totalCurrentTotal).toLocaleString()}`
            : '—';
          const totalDiffPct = allStocksHaveAvgCost && totalPurchaseTotal > 0
            ? ((totalCurrentTotal - totalPurchaseTotal) / totalPurchaseTotal) * 100
            : null;
          const cashLimitValue = Number(portfolio.cashLimit ?? portfolio.budget ?? null);
          const limitBaseline = Number.isFinite(cashLimitValue) && cashLimitValue > 0 ? cashLimitValue : null;

          const currentValue = Number.isFinite(Number(portfolio.currentValue))
            ? Number(portfolio.currentValue)
            : (allStocksHaveAvgCost ? totalCurrentTotal : null);
          const initialInvestmentValue = Number.isFinite(Number(portfolio.initialInvestment))
            ? Number(portfolio.initialInvestment)
            : 0;
          const computedPnlValue = portfolio.pnlValue !== undefined && portfolio.pnlValue !== null && Number.isFinite(Number(portfolio.pnlValue))
            ? Number(portfolio.pnlValue)
            : (currentValue !== null ? currentValue - initialInvestmentValue : null);
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
            <div style={{ minHeight: "2px", margin: "2px 0" }} key={portfolio.name}>

              <div style={{ color: theme.palette.info.light }}>
                <IconButton
                  onClick={() => handlePortfolioClick(portfolio.name)}
                  aria-expanded={openPortfolio[portfolio.name]}
                  aria-label="show more"
                >
                  <ExpandMoreIcon />
                </IconButton>
                {portfolio.name}

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




              </div>
              <Typography variant="body2" color="textSecondary" sx={{ ml: 6, mt: 0.5 }}>
                Status: {formatStatus(portfolio.status)} · Frequency: {formatRecurrenceLabel(portfolio.recurrence)} · Next reallocation: {formatDateTime(portfolio.nextRebalanceAt)} · Rebalances: {rebalanceCount}
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
              <Typography variant="body2" color="textSecondary" sx={{ ml: 6 }}>
                Initial investment: {formatCurrencyValue(initialInvestmentValue)} · Current value: {currentValue !== null ? formatCurrencyValue(currentValue) : '—'}
                {pnlDisplay && (
                  <> · P/L: <span className={pnlValue >= 0 ? styles.positive : styles.negative}>{pnlDisplay}</span></>
                )}
              </Typography>
              {limitBaseline !== null && (
                <React.Fragment>
                  <Typography variant="body2" color="textSecondary" sx={{ ml: 6 }}>
                    Cash limit: ${roundNumber(limitBaseline).toLocaleString()}
                  </Typography>
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



              <Collapse in={openPortfolio[portfolio.name]}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Asset</TableCell>
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
                      const purchaseTotal = avgCost && qty ? avgCost * qty : null;
                      const unrealizedPL = purchaseTotal !== null && marketValue !== null ? marketValue - purchaseTotal : null;
                      const unrealizedPLPct = unrealizedPL !== null && purchaseTotal ? (unrealizedPL / purchaseTotal) * 100 : null;

                      if (stock.avgCost === null || stock.currentPrice === null) {
                        return (
                          <TableRow key={stock.symbol}>
                            <TableCell>
                              <Link onClick={() => openSaleModal(stock)}>{stock.symbol}</Link>
                            </TableCell>
                            <TableCell>{stock.quantity || "----"}</TableCell>
                            <TableCell colSpan={5}>Order not filled yet.</TableCell>
                          </TableRow>
                        );
                      }

                      return (
                        <TableRow key={stock.symbol}>
                          <TableCell>
                            <Link onClick={() => openSaleModal(stock)}>{stock.symbol}</Link>
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
        })}
      </Collapse>

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
