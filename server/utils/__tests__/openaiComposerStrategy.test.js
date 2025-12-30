jest.mock('../../services/defsymphonyEvaluator', () => ({
  evaluateDefsymphonyStrategy: jest.fn(async (args) => ({
    summary: 'ok',
    reasoning: [],
    positions: [],
    meta: {
      engine: 'local',
      localEvaluator: {
        used: true,
        priceSource: args.priceSource,
        dataAdjustment: args.dataAdjustment,
        rsiMethod: args.rsiMethod,
        asOfMode: args.asOfMode,
      },
    },
  })),
}));

const { evaluateDefsymphonyStrategy } = require('../../services/defsymphonyEvaluator');
const { runComposerStrategy } = require('../openaiComposerStrategy');

describe('runComposerStrategy defaults', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    evaluateDefsymphonyStrategy.mockClear();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('defaults to Composer-style settings when not provided', async () => {
    delete process.env.COMPOSER_RSI_METHOD;
    delete process.env.COMPOSER_DATA_ADJUSTMENT;
    delete process.env.COMPOSER_ASOF_MODE;
    delete process.env.COMPOSER_PRICE_SOURCE;

    const result = await runComposerStrategy({
      strategyText: '(defsymphony "Test" {} (asset "SPY"))',
      budget: 1000,
    });

    expect(evaluateDefsymphonyStrategy).toHaveBeenCalledTimes(1);
    const args = evaluateDefsymphonyStrategy.mock.calls[0][0];
    expect(args.rsiMethod).toBe('wilder');
    expect(args.dataAdjustment).toBe('split');
    expect(args.asOfMode).toBe('previous-close');
    expect(args.priceSource).toBe('yahoo');
    expect(args.priceRefresh).toBe('false');
    expect(Array.isArray(result.meta.warnings)).toBe(false);
  });

  it('emits warnings when non-Composer settings are used', async () => {
    const result = await runComposerStrategy({
      strategyText: '(defsymphony "Test" {} (asset "SPY"))',
      budget: 1000,
      rsiMethod: 'simple',
      dataAdjustment: 'raw',
      asOfMode: 'current',
      priceSource: 'alpaca',
    });

    expect(evaluateDefsymphonyStrategy).toHaveBeenCalledTimes(1);
    expect(result.meta.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Non-standard RSI method'),
        expect.stringContaining('Non-standard adjustment'),
        expect.stringContaining('Non-standard price source'),
      ])
    );
  });
});
