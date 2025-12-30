describe('runComposerStrategy defaults', () => {
  const loadModule = async () => {
    jest.resetModules();
    jest.doMock('../../services/defsymphonyEvaluator', () => ({
      evaluateDefsymphonyStrategy: jest.fn(async (payload) => ({
        summary: 'ok',
        reasoning: [],
        positions: [
          {
            symbol: 'SPY',
            weight: 1,
            quantity: 1,
            estimated_cost: 100,
            rationale: 'mock',
          },
        ],
        meta: { payload },
      })),
    }));
    const { runComposerStrategy } = require('../openaiComposerStrategy');
    const { evaluateDefsymphonyStrategy } = require('../../services/defsymphonyEvaluator');
    return { runComposerStrategy, evaluateDefsymphonyStrategy };
  };

  beforeEach(() => {
    delete process.env.COMPOSER_PRICE_SOURCE;
    delete process.env.COMPOSER_DATA_ADJUSTMENT;
    delete process.env.COMPOSER_PRICE_REFRESH;
    delete process.env.TIINGO_API_KEYS;
    delete process.env.TIINGO_TOKEN;
    delete process.env.TIINGO_API_KEY;
    delete process.env.TIINGO_API_KEY1;
  });

  it('defaults to Tiingo + all-adjusted when Tiingo token is present', async () => {
    process.env.TIINGO_API_KEY1 = 'test-token';

    const { runComposerStrategy, evaluateDefsymphonyStrategy } = await loadModule();

    await runComposerStrategy({
      strategyText: '(defsymphony "Test" {} (asset "SPY"))',
      budget: 1000,
    });

    expect(evaluateDefsymphonyStrategy).toHaveBeenCalledWith(
      expect.objectContaining({
        priceSource: 'tiingo',
        dataAdjustment: 'all',
        priceRefresh: null,
      })
    );
  });

  it('defaults to Yahoo when no Tiingo token is present', async () => {
    const { runComposerStrategy, evaluateDefsymphonyStrategy } = await loadModule();

    await runComposerStrategy({
      strategyText: '(defsymphony "Test" {} (asset "SPY"))',
      budget: 1000,
    });

    expect(evaluateDefsymphonyStrategy).toHaveBeenCalledWith(
      expect.objectContaining({
        priceSource: 'yahoo',
        dataAdjustment: 'all',
        priceRefresh: null,
      })
    );
  });
});

