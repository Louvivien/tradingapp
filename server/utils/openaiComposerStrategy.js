const { evaluateDefsymphonyStrategy } = require('../services/defsymphonyEvaluator');

const normalizeEnginePreference = (value) => {
  if (!value) {
    return 'auto';
  }
  return String(value).trim().toLowerCase();
};

const runComposerStrategy = async ({
  strategyText,
  budget = 1000,
  engine = null,
  asOfDate = null,
  rsiMethod = null,
  dataAdjustment = null,
  debugIndicators = null,
  asOfMode = null,
  priceSource = null,
  priceRefresh = null,
}) => {
  const cleanedScript = String(strategyText || '').trim();
  if (!cleanedScript) {
    throw new Error('Strategy text is required');
  }

  const numericBudget =
    Number.isFinite(Number(budget)) && Number(budget) > 0 ? Number(budget) : 1000;
  const enginePreference = normalizeEnginePreference(
    engine || process.env.COMPOSER_ENGINE || 'auto'
  );

  const resolvedDefaults = {
    rsiMethod: String(process.env.COMPOSER_RSI_METHOD || 'wilder').trim(),
    dataAdjustment: String(process.env.COMPOSER_DATA_ADJUSTMENT || 'split').trim(),
    asOfMode: String(process.env.COMPOSER_ASOF_MODE || 'previous-close').trim(),
    priceSource: String(process.env.COMPOSER_PRICE_SOURCE || 'yahoo').trim(),
    priceRefresh: process.env.COMPOSER_PRICE_REFRESH ?? 'false',
  };

  const resolvedRsiMethod = rsiMethod ?? resolvedDefaults.rsiMethod;
  const resolvedAdjustment = dataAdjustment ?? resolvedDefaults.dataAdjustment;
  const resolvedAsOfMode = asOfMode ?? resolvedDefaults.asOfMode;
  const resolvedPriceSource = priceSource ?? resolvedDefaults.priceSource;
  const resolvedPriceRefresh = priceRefresh ?? resolvedDefaults.priceRefresh;

  let fallbackReason = null;
  if (enginePreference === 'openai' || enginePreference === 'remote') {
    fallbackReason =
      'Remote Composer evaluation disabled (external Python runtime unavailable).';
    console.warn('[ComposerStrategy] Remote evaluation requested but unavailable. Using local defsymphony evaluator.');
  }

  const result = await evaluateDefsymphonyStrategy({
    strategyText: cleanedScript,
    budget: numericBudget,
    asOfDate,
    rsiMethod: resolvedRsiMethod,
    dataAdjustment: resolvedAdjustment,
    debugIndicators,
    asOfMode: resolvedAsOfMode,
    priceSource: resolvedPriceSource,
    priceRefresh: resolvedPriceRefresh,
  });

  const warnings = [];
  const normalizedRsi = String(resolvedRsiMethod || '').trim().toLowerCase();
  const normalizedSource = String(resolvedPriceSource || '').trim().toLowerCase();
  const normalizedAdjustment = String(resolvedAdjustment || '').trim().toLowerCase();
  const normalizedMode = String(resolvedAsOfMode || '').trim().toLowerCase();

  if (normalizedRsi && normalizedRsi !== 'wilder') {
    warnings.push(`Non-standard RSI method "${resolvedRsiMethod}" (Composer uses Wilder RSI).`);
  }
  if (normalizedAdjustment && normalizedAdjustment !== 'split') {
    warnings.push(`Non-standard adjustment "${resolvedAdjustment}" (recommended "split").`);
  }
  if (normalizedSource && !['yahoo', 'tiingo'].includes(normalizedSource)) {
    warnings.push(`Non-standard price source "${resolvedPriceSource}" (recommended Yahoo or Tiingo).`);
  }
  if (normalizedMode && !['previous-close', 'current'].includes(normalizedMode)) {
    warnings.push(`Unrecognized as-of mode "${resolvedAsOfMode}".`);
  }

  if (warnings.length) {
    const baseMeta = result.meta || {};
    result.meta = {
      ...baseMeta,
      warnings,
    };
  }

  if (fallbackReason) {
    const baseMeta = result.meta || {};
    const localMeta = baseMeta.localEvaluator || {};
    result.meta = {
      ...baseMeta,
      engine: 'local',
      fallbackReason,
      localEvaluator: {
        ...localMeta,
        fallbackReason: localMeta.fallbackReason || fallbackReason,
      },
    };
  }

  return result;
};

module.exports = {
  runComposerStrategy,
};
