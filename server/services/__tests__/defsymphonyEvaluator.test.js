jest.mock('../priceCacheService', () => ({
  getCachedPrices: jest.fn(),
  normalizeAdjustment: (value) => value,
  fetchLatestPrice: jest.fn(),
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

const buildPriceResponseFromSeries = (closes) => ({
  bars: closes.map((close, index) => {
    const value = Number(Number(close).toFixed(4));
    const timestamp = new Date(2020, 0, index + 1).toISOString();
    return {
      t: timestamp,
      o: value,
      h: value,
      l: value,
      c: value,
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

  it('does not truncate all symbols to the shortest history when evaluating long-window filters', async () => {
    installPriceMapMock({
      LONG: buildPriceResponse(100, 0.5, 220),
      SHORT: buildPriceResponse(50, 0.2, 60),
    });

    const strategy = `
      (defsymphony "History Alignment" {}
        (filter
          (moving-average-return {:window 100})
          (select-top 1)
          [
            (asset "LONG")
            (asset "SHORT")
          ]))
    `;

    const result = await evaluateDefsymphonyStrategy({
      strategyText: strategy,
      budget: 10000,
      requireMarketData: false,
      requireCompleteUniverse: false,
    });
    expect(result.positions.map((pos) => pos.symbol)).toEqual(['LONG']);
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

  it('detects groups nested inside single-element vectors and evaluates group filters correctly', async () => {
    installPriceMapMock({
      AAA: buildPriceResponse(100, 1),
      AAB: buildPriceResponse(90, 1),
      BBB: buildPriceResponse(50, -0.2),
      BBC: buildPriceResponse(45, -0.2),
    });

    const strategy = `
      (defsymphony "Single Wrapper Group" {}
        (weight-equal
          [
            (group "Outer"
              [
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
                  ])
              ])
          ]))
    `;

    const result = await evaluateDefsymphonyStrategy({ strategyText: strategy, budget: 10000 });
    expect(result.positions.map((pos) => pos.symbol).sort()).toEqual(['AAA', 'AAB']);
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

  it('defaults to Wilder RSI (Composer-style) but can toggle to simple-average RSI', async () => {
    const originalRsiMethod = process.env.RSI_METHOD;

    // Construct a series where Wilder RSI stays elevated due to smoothing, while Cutler/SMA RSI
    // reflects the recent pullback and stays below the threshold.
    const closes = [100];
    for (let i = 0; i < 60; i += 1) {
      closes.push(closes[closes.length - 1] + 1);
    }
    for (let i = 0; i < 7; i += 1) {
      closes.push(closes[closes.length - 1] - 1);
    }

    installPriceMapMock({
      AAA: buildPriceResponseFromSeries(closes),
      WIN: buildPriceResponse(100, 0, closes.length),
      LOSE: buildPriceResponse(100, 0, closes.length),
    });

    const strategy = `
      (defsymphony "RSI Branch" {}
        (if
          (> (rsi "AAA" {:window 14}) 55)
          [(asset "WIN")]
          [(asset "LOSE")]))
    `;

    delete process.env.RSI_METHOD;
    const wilderResult = await evaluateDefsymphonyStrategy({
      strategyText: strategy,
      budget: 10000,
      asOfMode: 'current',
    });
    expect(wilderResult.positions.map((pos) => pos.symbol)).toEqual(['WIN']);

    process.env.RSI_METHOD = 'cutler';
    const simpleResult = await evaluateDefsymphonyStrategy({
      strategyText: strategy,
      budget: 10000,
      asOfMode: 'current',
    });
    expect(simpleResult.positions.map((pos) => pos.symbol)).toEqual(['LOSE']);

    if (originalRsiMethod === undefined) {
      delete process.env.RSI_METHOD;
    } else {
      process.env.RSI_METHOD = originalRsiMethod;
    }
  });

  describe('market data gating', () => {
    it('fails fast when any strategy ticker is missing/stale (no silent partial evaluation)', async () => {
      getCachedPrices.mockImplementation(async ({ symbol }) => {
        const upper = String(symbol || '').toUpperCase();
        if (upper === 'AAA') {
          return buildPriceResponse(100, 1, 60);
        }
        throw new Error(`Missing mock price data for ${upper}`);
      });

      const strategy = `
        (defsymphony "Missing Data Gate" {}
          (weight-equal
            [
              (asset "AAA")
              (asset "BBB")
            ]))
      `;

      await expect(
        evaluateDefsymphonyStrategy({
          strategyText: strategy,
          budget: 10000,
          requireMarketData: true,
          requireCompleteUniverse: true,
          allowFallbackAllocations: false,
        })
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_MARKET_DATA' });
    });

    it('treats n/a indicators inside conditions as a market-data error (not FALSE)', async () => {
      installPriceMapMock({
        AAA: buildPriceResponse(100, 1, 40), // < window+1 => RSI is n/a
        BBB: buildPriceResponse(100, 1, 60),
      });

      const strategy = `
        (defsymphony "NA Condition Gate" {}
          (if
            (> (rsi "AAA" {:window 50}) 80)
            [(asset "AAA")]
            [(asset "BBB")]))
      `;

      await expect(
        evaluateDefsymphonyStrategy({
          strategyText: strategy,
          budget: 10000,
          requireMarketData: true,
          requireCompleteUniverse: true,
          allowFallbackAllocations: false,
        })
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_MARKET_DATA' });
    });

    it('does not apply equal-weight fallback unless explicitly enabled', async () => {
      getCachedPrices.mockImplementation(async ({ symbol }) => {
        const upper = String(symbol || '').toUpperCase();
        if (upper === 'BBB') {
          return buildPriceResponse(100, 1, 60);
        }
        throw new Error(`Missing mock price data for ${upper}`);
      });

      const strategy = `
        (defsymphony "No Fallback" {}
          (if
            (> (rsi "BBB" {:window 2}) 1000)
            [(asset "AAA")]
            [(asset "AAA")]))
      `;

      await expect(
        evaluateDefsymphonyStrategy({
          strategyText: strategy,
          budget: 10000,
          requireMarketData: false,
          requireCompleteUniverse: false,
          allowFallbackAllocations: false,
        })
      ).rejects.toMatchObject({ code: 'EMPTY_ALLOCATION' });
    });
  });
});
