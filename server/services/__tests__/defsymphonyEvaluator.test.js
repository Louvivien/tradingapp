jest.mock('../priceCacheService', () => ({
  getCachedPrices: jest.fn(),
}));

const { evaluateDefsymphonyStrategy } = require('../defsymphonyEvaluator');
const { getCachedPrices } = require('../priceCacheService');

const buildPriceResponse = (start, step, length = 60) => ({
  bars: Array.from({ length }, (_, index) => {
    const close = Number((start + step * index).toFixed(4));
    const timestamp = new Date(2020, 0, index + 1).toISOString();
    return {
      t: timestamp,
      o: close,
      h: close,
      l: close,
      c: close,
      v: 1000,
    };
  }),
});

const installPriceMapMock = (priceMap) => {
  getCachedPrices.mockImplementation(async ({ symbol }) => {
    const entry = priceMap[symbol.toUpperCase()];
    if (!entry) {
      throw new Error(`Missing mock price data for ${symbol}`);
    }
    return entry;
  });
};

describe('evaluateDefsymphonyStrategy', () => {
  beforeEach(() => {
    getCachedPrices.mockReset();
  });

  it('simulates group equity series and selects the strongest group for filters', async () => {
    installPriceMapMock({
      AAA: buildPriceResponse(100, 1),
      AAB: buildPriceResponse(90, 1),
      BBB: buildPriceResponse(50, -0.2),
      BBC: buildPriceResponse(45, -0.2),
    });

    const strategy = `
      (defsymphony "Group Filter" {}
        (filter
          (cumulative-return {:window 2})
          (select-top 1)
          [
            (group "Growth"
              [
                (weight-equal
                  [
                    (asset "AAA")
                    (asset "AAB")
                  ])
              ])
            (group "Value"
              [
                (weight-equal
                  [
                    (asset "BBB")
                    (asset "BBC")
                  ])
              ])
          ]))
    `;

    const result = await evaluateDefsymphonyStrategy({ strategyText: strategy, budget: 10000 });

    const positionTickers = result.positions.map((pos) => pos.symbol).sort();
    expect(positionTickers).toEqual(['AAA', 'AAB']);
    expect(result.reasoning.some((line) => line.includes('Step 1b'))).toBe(true);
  });

  it('evaluates ticker-only strategies without requiring group simulations', async () => {
    installPriceMapMock({
      SPY: buildPriceResponse(400, 0.5),
      QQQ: buildPriceResponse(300, 0.3),
    });

    const strategy = `
      (defsymphony "Simple" {}
        (weight-equal
          [
            (asset "SPY")
            (asset "QQQ")
          ]))
    `;

    const result = await evaluateDefsymphonyStrategy({ strategyText: strategy, budget: 5000 });

    const positionTickers = result.positions.map((pos) => pos.symbol).sort();
    expect(positionTickers).toEqual(['QQQ', 'SPY']);
    expect(result.reasoning.some((line) => line.includes('Step 1b'))).toBe(false);
  });

  it('supports max-drawdown filters over nested groups', async () => {
    installPriceMapMock({
      AAA: buildPriceResponse(100, 1, 80),
      BBB: buildPriceResponse(100, -1, 80),
    });

    const strategy = `
      (defsymphony "Group Drawdown" {}
        (filter
          (max-drawdown {:window 4})
          (select-bottom 1)
          [
            (group "LowDD"
              [
                (group "Inner"
                  [
                    (asset "AAA")
                  ])
              ])
            (group "HighDD"
              [
                (group "Inner"
                  [
                    (asset "BBB")
                  ])
              ])
          ]))
    `;

    const result = await evaluateDefsymphonyStrategy({ strategyText: strategy, budget: 10000 });
    expect(result.positions.map((pos) => pos.symbol)).toEqual(['AAA']);
    expect(result.reasoning.some((line) => line.includes('Step 1b'))).toBe(true);
  });
});
