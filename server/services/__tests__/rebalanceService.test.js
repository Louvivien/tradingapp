process.env.ALPACA_ENABLE_FRACTIONAL = 'true';

const { buildAdjustments } = require('../rebalanceService');

describe('buildAdjustments snapshot sizing', () => {
  it('uses snapshot quantities when drift is within tolerance', async () => {
    const targets = [
      {
        symbol: 'AAA',
        targetWeight: 0.5,
        targetQuantitySnapshot: 10,
        targetPriceSnapshot: 50,
        targetValueSnapshot: 500,
      },
    ];

    const adjustments = await buildAdjustments({
      targets,
      budget: 1000,
      positionMap: {},
      priceCache: { AAA: 51 },
      dataKeys: {},
      trackedHoldings: {},
      useSnapshotQuantities: true,
      maxSnapshotDriftPct: 0.05,
    });

    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].usedSnapshotSizing).toBe(true);
    expect(adjustments[0].desiredQty).toBeCloseTo(10, 6);
    expect(adjustments[0].priceDriftPct).toBeCloseTo(0.02, 6);
  });

  it('falls back to live sizing when drift exceeds tolerance', async () => {
    const targets = [
      {
        symbol: 'AAA',
        targetWeight: 0.5,
        targetQuantitySnapshot: 10,
        targetPriceSnapshot: 50,
        targetValueSnapshot: 500,
      },
    ];

    const adjustments = await buildAdjustments({
      targets,
      budget: 1000,
      positionMap: {},
      priceCache: { AAA: 60 },
      dataKeys: {},
      trackedHoldings: {},
      useSnapshotQuantities: true,
      maxSnapshotDriftPct: 0.02,
    });

    expect(adjustments).toHaveLength(1);
    expect(adjustments[0].usedSnapshotSizing).toBe(false);
    expect(adjustments[0].desiredQty).toBeCloseTo(500 / 60, 6);
    expect(adjustments[0].priceDriftPct).toBeGreaterThan(0.02);
  });
});
