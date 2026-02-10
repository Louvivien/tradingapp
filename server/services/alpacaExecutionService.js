const normalizeEnvValue = (value) => String(value ?? '').trim();

const normalizeExecutionMode = (value) => {
  const raw = normalizeEnvValue(value).toLowerCase();
  if (!raw) return 'paper';
  if (raw === 'live' || raw === 'real') return 'live';
  if (raw === 'paper' || raw === 'dry' || raw === 'dry-run' || raw === 'dryrun') return 'paper';
  if (raw === 'true' || raw === '1' || raw === 'yes') return 'live';
  if (raw === 'false' || raw === '0' || raw === 'no') return 'paper';
  return 'paper';
};

const normalizeExecutionModeOverride = (value) => {
  if (typeof value === 'boolean') {
    return value ? 'live' : 'paper';
  }
  const raw = normalizeEnvValue(value).toLowerCase();
  if (!raw) return null;
  if (raw === 'live' || raw === 'real') return 'live';
  if (raw === 'paper' || raw === 'dry' || raw === 'dry-run' || raw === 'dryrun') return 'paper';
  if (raw === 'true' || raw === '1' || raw === 'yes') return 'live';
  if (raw === 'false' || raw === '0' || raw === 'no') return 'paper';
  return null;
};

const getEnvAlpacaExecutionMode = () => {
  const raw =
    process.env.ALPACA_EXECUTION_MODE ||
    process.env.ALPACA_TRADING_MODE ||
    process.env.ALPACA_LIVE_TRADING ||
    '';
  return normalizeExecutionMode(raw);
};

module.exports = {
  normalizeExecutionMode,
  normalizeExecutionModeOverride,
  getEnvAlpacaExecutionMode,
};

