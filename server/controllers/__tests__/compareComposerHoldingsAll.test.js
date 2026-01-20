jest.mock('../../models/strategyModel', () => ({
  find: jest.fn(),
}));

jest.mock('../../models/portfolioModel', () => ({
  find: jest.fn(),
}));

jest.mock('../../utils/composerLinkClient', () => ({
  fetchComposerLinkSnapshot: jest.fn(),
  fetchPublicSymphonyBacktestById: jest.fn(),
  parseSymphonyIdFromUrl: (url) => {
    const match = String(url || '').match(/\/symphony\/([^/]+)/);
    return match?.[1] || null;
  },
}));

jest.mock('../../utils/openaiComposerStrategy', () => ({
  runComposerStrategy: jest.fn(),
}));

jest.mock('../../utils/composerHoldingsWeights', () => ({
  computeComposerHoldingsWeights: jest.fn(),
}));

const Strategy = require('../../models/strategyModel');
const Portfolio = require('../../models/portfolioModel');
const { fetchComposerLinkSnapshot, fetchPublicSymphonyBacktestById } = require('../../utils/composerLinkClient');
const { runComposerStrategy } = require('../../utils/openaiComposerStrategy');
const { computeComposerHoldingsWeights } = require('../../utils/composerHoldingsWeights');
const { compareComposerHoldingsAll } = require('../strategiesController');

const mockRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
};

describe('compareComposerHoldingsAll', () => {
  beforeEach(() => {
    Strategy.find.mockReset();
    Portfolio.find.mockReset();
    fetchComposerLinkSnapshot.mockReset();
    fetchPublicSymphonyBacktestById.mockReset();
    runComposerStrategy.mockReset();
    computeComposerHoldingsWeights.mockReset();
  });

  it('skips polymarket and non-composer links, compares holdings, and can guarantee when Composer backtest matches', async () => {
    Portfolio.find.mockReturnValue({
      select: () => ({
        lean: async () => [
          {
            strategy_id: '1',
            recurrence: 'daily',
            cashLimit: 10000,
            nextRebalanceAt: new Date('2026-01-08T20:30:00.000Z'),
          },
        ],
      }),
    });

    Strategy.find.mockReturnValue({
      sort: () => ({
        limit: () => ({
          lean: async () => [
            {
              strategy_id: '1',
              name: 'Good Composer',
              userId: 'u1',
              provider: 'alpaca',
              symphonyUrl: 'https://app.composer.trade/symphony/abc',
              strategy: '(defsymphony "Test" {} (asset "SPY"))',
            },
            {
              strategy_id: '2',
              name: 'Polymarket',
              userId: 'u1',
              provider: 'polymarket',
              symphonyUrl: 'https://polymarket.com/@someone',
              strategy: '(defsymphony "Test" {} (asset "SPY"))',
            },
            {
              strategy_id: '3',
              name: 'Non composer',
              userId: 'u1',
              provider: 'alpaca',
              symphonyUrl: 'https://example.com/not-composer',
              strategy: '(defsymphony "Test" {} (asset "SPY"))',
            },
          ],
        }),
      }),
    });

    fetchComposerLinkSnapshot.mockResolvedValue({
      effectiveAsOfDateKey: '2026-01-07',
      holdings: [{ symbol: 'SPY', weight: 1 }],
      strategyText: '(defsymphony "Different" {} (asset "QQQ"))',
    });

    fetchPublicSymphonyBacktestById.mockResolvedValue({
      effectiveAsOfDateKey: '2026-01-07',
      holdingsObject: { SPY: 10000 },
      lastBacktestValue: 10000,
    });

    computeComposerHoldingsWeights.mockResolvedValue({
      holdings: [{ symbol: 'SPY', weight: 1 }],
      meta: { pricedBy: 'tiingo' },
    });

    runComposerStrategy.mockResolvedValue({
      positions: [{ symbol: 'SPY', weight: 1 }],
      meta: { localEvaluator: { asOfDate: '2026-01-07T00:00:00.000Z' } },
    });

    const req = {
      params: { userId: 'u1' },
      query: { limit: '10', tolerance: '0.001' },
      user: 'u1',
    };
    const res = mockRes();

    await compareComposerHoldingsAll(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('success');
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBe(1);
    expect(res.body.results[0]).toMatchObject({
      id: '1',
      name: 'Good Composer',
      status: 'ok',
    });
    expect(res.body.results[0].comparison.mismatches).toEqual([]);
    expect(res.body.results[0].prediction).toMatchObject({
      asOfTarget: 'next-rebalance',
      usedComposerBacktest: true,
      matchesComposer: true,
      canGuaranteeMatchNextRebalance: true,
      confidence: 'high',
      strategyTextMatchesComposer: false,
    });
    expect(res.body.summary).toMatchObject({
      total: 1,
      mismatched: 0,
      guaranteed: 1,
    });
  });

  it('cannot guarantee when Composer backtest fails, even if allocations match', async () => {
    Portfolio.find.mockReturnValue({
      select: () => ({
        lean: async () => [
          {
            strategy_id: '1',
            recurrence: 'daily',
            cashLimit: 10000,
            nextRebalanceAt: new Date('2026-01-08T20:30:00.000Z'),
          },
        ],
      }),
    });

    Strategy.find.mockReturnValue({
      sort: () => ({
        limit: () => ({
          lean: async () => [
            {
              strategy_id: '1',
              name: 'Missing data strategy',
              userId: 'u1',
              provider: 'alpaca',
              symphonyUrl: 'https://app.composer.trade/symphony/abc',
              strategy: '(defsymphony "Test" {} (asset "SPY"))',
            },
          ],
        }),
      }),
    });

    fetchComposerLinkSnapshot.mockResolvedValue({
      effectiveAsOfDateKey: '2026-01-07',
      holdings: [{ symbol: 'SPY', weight: 1 }],
      strategyText: '(defsymphony "Test" {} (asset "SPY"))',
    });

    const error = new Error('Composer evaluation failed');
    error.outdatedSeries = ['HKND'];
    fetchPublicSymphonyBacktestById.mockRejectedValue(error);

    runComposerStrategy.mockResolvedValue({
      positions: [{ symbol: 'SPY', weight: 1 }],
      meta: { localEvaluator: { asOfDate: '2026-01-07T00:00:00.000Z' } },
    });

    const req = {
      params: { userId: 'u1' },
      query: { limit: '10', tolerance: '0.001' },
      user: 'u1',
    };
    const res = mockRes();

    await compareComposerHoldingsAll(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.results.length).toBe(1);
    expect(res.body.results[0].comparison.mismatches).toEqual([]);
    expect(res.body.results[0].prediction.usedComposerBacktest).toBe(false);
    expect(res.body.results[0].prediction.canGuaranteeMatchNextRebalance).toBe(false);
    expect(res.body.results[0].prediction.confidence).toBe('low');
    expect(res.body.results[0].prediction.reasons.join(' ')).toContain('Outdated series');
    expect(res.body.results[0].prediction.reasons.join(' ')).toContain('HKND');
    expect(res.body.summary).toMatchObject({
      total: 1,
      mismatched: 0,
      guaranteed: 0,
    });
  });
});
