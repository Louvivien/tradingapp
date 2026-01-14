jest.mock('../priceCacheService', () => ({
  getCachedPrices: jest.fn(),
  normalizeAdjustment: (value) => value,
  fetchLatestPrice: jest.fn(),
}));

const { evaluateDefsymphonyStrategy } = require('../defsymphonyEvaluator');
const { getCachedPrices } = require('../priceCacheService');

const buildBarsEndingOn = ({ endDayKey, length, startPrice, dailyReturn }) => {
  const end = new Date(`${endDayKey}T00:00:00.000Z`);
  const millisPerDay = 24 * 60 * 60 * 1000;
  const bars = [];
  let price = startPrice;
  for (let idx = 0; idx < length; idx += 1) {
    const date = new Date(end.getTime() - (length - 1 - idx) * millisPerDay);
    const rounded = Number(price.toFixed(8));
    bars.push({
      t: date.toISOString(),
      o: rounded,
      h: rounded,
      l: rounded,
      c: rounded,
      v: 1000,
    });
    price *= 1 + dailyReturn;
  }
  return { bars };
};

describe('evaluateDefsymphonyStrategy (EM strategy branch parity)', () => {
  beforeEach(() => {
    getCachedPrices.mockReset();
  });

  it('matches the expected EM branch allocation when inputs are complete', async () => {
    const endDayKey = '2026-01-06';
    const barsLength = 260;

    const make = (dailyReturn) =>
      buildBarsEndingOn({ endDayKey, length: barsLength, startPrice: 100, dailyReturn });

    getCachedPrices.mockImplementation(async ({ symbol }) => {
      switch (String(symbol || '').toUpperCase()) {
        case 'SPY':
          return make(0.002);
        case 'EEM':
          return make(-0.01);
        case 'EDC':
        case 'EDZ':
        case 'BIL':
          return make(0);
        default:
          throw new Error(`Unexpected symbol ${symbol}`);
      }
    });

    const strategy = `
      (defsymphony
        "EM branch parity (minimal)"
        {:asset-class "EQUITIES", :rebalance-frequency :daily}
        (weight-equal
          [(group
            "EM"
            [(if
              (>
                (current-price "SPY")
                (moving-average-price "SPY" {:window 200}))
              [(if
                (< (rsi "EEM" {:window 10}) 25)
                [(weight-specified 0.68 (asset "EDC" nil) 0.32 (asset "BIL" nil))]
                [(asset "EDZ" nil)])]
              [(asset "BIL" nil)])])]))
    `;

    const result = await evaluateDefsymphonyStrategy({
      strategyText: strategy,
      budget: 10000,
      // 2026-01-07 15:00 ET (before close) -> previous-close targets the 2026-01-06 bar.
      asOfDate: '2026-01-07T20:00:00.000Z',
      asOfMode: 'previous-close',
      priceSource: 'tiingo',
      dataAdjustment: 'all',
      priceRefresh: false,
      requireMarketData: true,
      requireCompleteUniverse: true,
      allowFallbackAllocations: false,
    });

    const symbols = result.positions.map((pos) => pos.symbol).sort();
    expect(symbols).toEqual(['BIL', 'EDC']);

    const weights = Object.fromEntries(result.positions.map((pos) => [pos.symbol, pos.weight]));
    expect(weights.EDC).toBeCloseTo(0.68, 6);
    expect(weights.BIL).toBeCloseTo(0.32, 6);

    const seenSymbols = getCachedPrices.mock.calls.map(([args]) => String(args.symbol || '').toUpperCase());
    expect(seenSymbols).not.toContain('EM');
  });
});
