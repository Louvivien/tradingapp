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
    rsiMethod,
    dataAdjustment,
    debugIndicators,
  });

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
