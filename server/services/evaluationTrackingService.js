const { randomUUID } = require('crypto');
const { parseComposerScript } = require('../utils/composerDslParser');

const ACTIVE_EVALUATIONS = new Map();
const COMPLETED_TTL_MS = 2 * 60 * 1000;

const createEvaluationRecord = (metadata = {}) => {
  const id = randomUUID();
  const submittedAt = new Date();
  const record = {
    id,
    status: 'queued',
    submittedAt,
    lastUpdatedAt: submittedAt,
    ...metadata,
  };
  ACTIVE_EVALUATIONS.set(id, record);
  return record;
};

const updateEvaluationRecord = (id, updates = {}) => {
  const existing = ACTIVE_EVALUATIONS.get(id);
  if (!existing) {
    return null;
  }
  const updated = {
    ...existing,
    ...updates,
    lastUpdatedAt: new Date(),
  };
  ACTIVE_EVALUATIONS.set(id, updated);
  return updated;
};

const scheduleCleanup = (id) => {
  setTimeout(() => {
    ACTIVE_EVALUATIONS.delete(id);
  }, COMPLETED_TTL_MS);
};

const traverseAst = (node, predicate) => {
  if (!node) {
    return false;
  }
  if (Array.isArray(node)) {
    if (predicate(node)) {
      return true;
    }
    return node.some((child) => traverseAst(child, predicate));
  }
  if (node && typeof node === 'object') {
    return Object.values(node).some((child) => traverseAst(child, predicate));
  }
  return false;
};

const summarizeStrategy = (strategyText) => {
  if (!strategyText || typeof strategyText !== 'string') {
    return { name: 'Unknown strategy', hasGroup: false };
  }
  try {
    const ast = parseComposerScript(strategyText);
    if (!ast) {
      return { name: 'Unknown strategy', hasGroup: false };
    }
    const name = Array.isArray(ast) && ast[0] === 'defsymphony' ? ast[1] || 'Untitled strategy' : 'Untitled strategy';
    const hasGroup = traverseAst(ast, (node) => Array.isArray(node) && node[0] === 'group');
    return { name, hasGroup };
  } catch (error) {
    return { name: 'Unknown strategy', hasGroup: false };
  }
};

const runTrackedEvaluation = async ({ handler, metadata }) => {
  if (typeof handler !== 'function') {
    throw new Error('Handler function is required for tracked evaluation.');
  }
  const initialRecord = createEvaluationRecord(metadata);
  const { id } = initialRecord;
  try {
    const startTime = new Date();
    updateEvaluationRecord(id, { status: 'running', startedAt: startTime });
    const result = await handler();
    const finalRecord = updateEvaluationRecord(id, {
      status: 'completed',
      completedAt: new Date(),
      durationMs: Date.now() - startTime.getTime(),
    });
    scheduleCleanup(id);
    return { id, job: finalRecord, result };
  } catch (error) {
    updateEvaluationRecord(id, {
      status: 'failed',
      completedAt: new Date(),
      error: error.message || 'evaluation failed',
    });
    scheduleCleanup(id);
    throw error;
  }
};

const listActiveEvaluations = () => Array.from(ACTIVE_EVALUATIONS.values());

module.exports = {
  runTrackedEvaluation,
  listActiveEvaluations,
  summarizeStrategy,
};
