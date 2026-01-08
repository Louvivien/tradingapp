import React, { useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Divider,
  FormControlLabel,
  MenuItem,
  Paper,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import Axios from "axios";
import UserContext from "../../context/UserContext";
import config from "../../config/Config";
import styles from "./HoldingsCompare.module.css";

const formatPct = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return "—";
  }
  return `${(num * 100).toFixed(2)}%`;
};

const formatDiffPct = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return "—";
  }
  return `${(num * 100).toFixed(2)}%`;
};

const PRICE_SOURCE_OPTIONS = [
  { value: "", label: "Default (server)" },
  { value: "yahoo", label: "Yahoo" },
  { value: "tiingo", label: "Tiingo" },
  { value: "alpaca", label: "Alpaca" },
  { value: "stooq", label: "Stooq" },
];

const HoldingsCompare = () => {
  const { userData } = useContext(UserContext);
  const authToken = userData?.token;
  const userId = userData?.user?.id;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [results, setResults] = useState([]);
  const [hasRun, setHasRun] = useState(false);
  const [onlyMismatched, setOnlyMismatched] = useState(true);
  const [limit, setLimit] = useState("50");
  const [tolerance, setTolerance] = useState("0.005");
  const [priceSource, setPriceSource] = useState("");

  const fetchComparison = useCallback(async () => {
    if (!authToken || !userId) {
      return;
    }
    setLoading(true);
    setError(null);
    setHasRun(true);

    try {
      const headers = { "x-auth-token": authToken };
      const url = `${config.base_url}/api/strategies/composer-holdings/compare-all/${userId}`;
      const response = await Axios.get(url, {
        headers,
        params: {
          limit: Number(limit) || 50,
          tolerance: Number(tolerance) || 0.005,
          ...(priceSource ? { priceSource } : {}),
        },
      });

      if (response.data?.status !== "success") {
        throw new Error(response.data?.message || "Failed to compare holdings.");
      }
      setResults(Array.isArray(response.data?.results) ? response.data.results : []);
    } catch (err) {
      setError(err?.response?.data?.message || err?.message || "Failed to load comparison.");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [authToken, userId, limit, tolerance, priceSource]);

  const filtered = useMemo(() => {
    const rows = Array.isArray(results) ? results : [];
    if (!onlyMismatched) {
      return rows;
    }
    return rows.filter((row) => (row?.comparison?.mismatches || []).length > 0);
  }, [results, onlyMismatched]);

  return (
    <Container maxWidth="lg" className={styles.container}>
      <Box className={styles.headerRow}>
        <Box>
          <Typography variant="h5">Holdings Compare</Typography>
          <Typography variant="body2" color="text.secondary">
            Compares Composer link holdings vs TradingApp local evaluator (skips Polymarket/non-Composer links).
          </Typography>
        </Box>
        <Box className={styles.controls}>
          <TextField
            label="Limit"
            size="small"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            className={styles.input}
          />
          <TextField
            label="Tolerance"
            size="small"
            value={tolerance}
            onChange={(e) => setTolerance(e.target.value)}
            className={styles.input}
            helperText="Weight diff threshold"
          />
          <TextField
            label="Price source"
            size="small"
            value={priceSource}
            onChange={(e) => setPriceSource(e.target.value)}
            className={styles.selectInput}
            select
            SelectProps={{ displayEmpty: true }}
            InputLabelProps={{ shrink: true }}
          >
            {PRICE_SOURCE_OPTIONS.map((opt) => (
              <MenuItem key={opt.value || "default"} value={opt.value}>
                {opt.label}
              </MenuItem>
            ))}
          </TextField>
          <FormControlLabel
            control={
              <Switch
                checked={onlyMismatched}
                onChange={(e) => setOnlyMismatched(e.target.checked)}
              />
            }
            label="Only mismatched"
          />
          <Button variant="contained" onClick={fetchComparison} disabled={loading}>
            Run compare
          </Button>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" className={styles.alert}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box className={styles.loading}>
          <CircularProgress />
        </Box>
      ) : !hasRun ? (
        <Paper className={styles.paper}>
          <Box className={styles.emptyState}>
            <Typography variant="body2" color="text.secondary">
              Choose your settings, then click &quot;Run compare&quot;.
            </Typography>
          </Box>
        </Paper>
      ) : (
        <Paper className={styles.paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Strategy</TableCell>
                <TableCell>Composer Holdings</TableCell>
                <TableCell>TradingApp Holdings</TableCell>
                <TableCell>Mismatches</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map((row) => {
                const mismatches = row?.comparison?.mismatches || [];
                const status = row?.status || "ok";
                const composerCount = row?.composer?.holdings?.length || 0;
                const tradingCount = row?.tradingApp?.holdings?.length || 0;
                return (
                  <React.Fragment key={row?.id || row?.symphonyUrl}>
                    <TableRow hover>
                      <TableCell>
                        <Typography variant="subtitle2">{row?.name || row?.id}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {row?.id}
                        </Typography>
                      </TableCell>
                      <TableCell>{composerCount}</TableCell>
                      <TableCell>{tradingCount}</TableCell>
                      <TableCell>
                        {mismatches.length ? (
                          <Chip label={mismatches.length} color="warning" size="small" />
                        ) : (
                          <Chip label="0" color="success" size="small" />
                        )}
                      </TableCell>
                      <TableCell>
                        {status === "ok" ? (
                          <Chip label="ok" color="success" size="small" />
                        ) : (
                          <Chip label={status} color="error" size="small" />
                        )}
                      </TableCell>
                    </TableRow>
                    {mismatches.length > 0 && (
                      <TableRow>
                        <TableCell colSpan={5}>
                          <Box className={styles.detailBox}>
                            <Typography variant="subtitle2">Mismatches</Typography>
                            <Divider className={styles.divider} />
                            <Table size="small">
                              <TableHead>
                                <TableRow>
                                  <TableCell>Symbol</TableCell>
                                  <TableCell>Composer</TableCell>
                                  <TableCell>TradingApp</TableCell>
                                  <TableCell>Diff</TableCell>
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                {mismatches.map((m) => (
                                  <TableRow key={m.symbol}>
                                    <TableCell>{m.symbol}</TableCell>
                                    <TableCell>{formatPct(m.composerWeight)}</TableCell>
                                    <TableCell>{formatPct(m.tradingAppWeight)}</TableCell>
                                    <TableCell>{formatDiffPct(m.diff)}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </Box>
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                );
              })}
              {!filtered.length && (
                <TableRow>
                  <TableCell colSpan={5}>
                    <Typography variant="body2" color="text.secondary">
                      No strategies to show.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Paper>
      )}
    </Container>
  );
};

export default HoldingsCompare;
