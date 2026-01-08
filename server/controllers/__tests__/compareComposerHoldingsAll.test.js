jest.mock('../../models/strategyModel', () => ({
  find: jest.fn(),
}));

jest.mock('../../utils/composerLinkClient', () => ({
  fetchComposerLinkSnapshot: jest.fn(),
}));

jest.mock('../../utils/openaiComposerStrategy', () => ({
  runComposerStrategy: jest.fn(),
}));

const Strategy = require('../../models/strategyModel');
const { fetchComposerLinkSnapshot } = require('../../utils/composerLinkClient');
const { runComposerStrategy } = require('../../utils/openaiComposerStrategy');
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
    fetchComposerLinkSnapshot.mockReset();
    runComposerStrategy.mockReset();
  });

  it('skips polymarket and non-composer links, compares composer vs tradingapp holdings', async () => {
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
      strategyText: '(defsymphony "Test" {} (asset "SPY"))',
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
  });
});

