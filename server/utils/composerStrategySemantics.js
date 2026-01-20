const { parseComposerScript } = require('./composerDslParser');

const roundForStableCompare = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return value;
  }
  if (Number.isInteger(number)) {
    return number;
  }
  return Number(number.toFixed(12));
};

const NORMALIZED_KEYWORDS = new Set([
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'yearly',
  'none',
  'threshold',
]);

const normalizeKeywordString = (value) => {
  if (typeof value !== 'string') {
    return value;
  }
  if (!value.startsWith(':')) {
    return value;
  }
  const stripped = value.slice(1);
  const normalized = stripped.trim().toLowerCase();
  if (!NORMALIZED_KEYWORDS.has(normalized)) {
    return value;
  }
  return normalized;
};

const canonicalizeComposerAstForCompare = (node) => {
  if (Array.isArray(node)) {
    if (!node.length) {
      return [];
    }
    const head = node[0];
    if (head === 'asset') {
      return ['asset', canonicalizeComposerAstForCompare(node[1])];
    }
    if (head === 'group') {
      const maybeVector = node[2];
      if (Array.isArray(maybeVector) && maybeVector.length === 1) {
        return canonicalizeComposerAstForCompare(maybeVector[0]);
      }
      if (Array.isArray(maybeVector)) {
        return maybeVector.map(canonicalizeComposerAstForCompare);
      }
      return canonicalizeComposerAstForCompare(node[1]);
    }
    if (head === 'weight-equal' && Array.isArray(node[1]) && node[1].length === 1) {
      return canonicalizeComposerAstForCompare(node[1][0]);
    }
    if (head === 'defsymphony') {
      return [
        'defsymphony',
        null,
        canonicalizeComposerAstForCompare(node[2]),
        canonicalizeComposerAstForCompare(node[3]),
      ];
    }
    return node.map(canonicalizeComposerAstForCompare);
  }

  if (node && typeof node === 'object') {
    const result = {};
    Object.keys(node)
      .sort()
      .forEach((key) => {
        result[key] = canonicalizeComposerAstForCompare(node[key]);
      });
    return result;
  }

  if (typeof node === 'number') {
    return roundForStableCompare(node);
  }

  if (typeof node === 'string') {
    return normalizeKeywordString(node);
  }

  return node;
};

const deepEqual = (a, b) => {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return false;
    }
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  if (a && typeof a === 'object' && b && typeof b === 'object') {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    aKeys.sort();
    bKeys.sort();
    for (let i = 0; i < aKeys.length; i += 1) {
      if (aKeys[i] !== bKeys[i]) {
        return false;
      }
    }
    for (const key of aKeys) {
      if (!deepEqual(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return roundForStableCompare(a) === roundForStableCompare(b);
  }
  return false;
};

const compareComposerStrategySemantics = ({ dbStrategyText, linkStrategyText }) => {
  if (!dbStrategyText || !linkStrategyText) {
    return null;
  }
  try {
    const dbAst = canonicalizeComposerAstForCompare(parseComposerScript(String(dbStrategyText)));
    const linkAst = canonicalizeComposerAstForCompare(parseComposerScript(String(linkStrategyText)));
    return deepEqual(dbAst, linkAst);
  } catch {
    return null;
  }
};

module.exports = {
  canonicalizeComposerAstForCompare,
  compareComposerStrategySemantics,
  deepEqual,
};
