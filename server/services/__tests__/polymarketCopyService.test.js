const nock = require('nock');

jest.setTimeout(15000);

jest.mock('../strategyLogger', () => ({
  recordStrategyLog: jest.fn(async () => {}),
}));

  describe('polymarketCopyService', () => {
    const managedEnvKeys = [
      'POLYMARKET_TRADES_SOURCE',
      'POLYMARKET_API_KEY',
      'POLYMARKET_SECRET',
      'POLYMARKET_PASSPHRASE',
      'POLYMARKET_AUTH_ADDRESS',
      'POLYMARKET_BACKFILL_LIVE_REBALANCE',
      'POLYMARKET_SIZE_TO_BUDGET',
      'POLYMARKET_LIVE_REBALANCE_MIN_NOTIONAL',
      'POLYMARKET_LIVE_REBALANCE_MAX_ORDERS',
    ];

  let previousEnvValues = {};

  beforeEach(() => {
    jest.resetModules();
    nock.disableNetConnect();
    previousEnvValues = Object.fromEntries(managedEnvKeys.map((key) => [key, process.env[key]]));
  });

  afterEach(() => {
    managedEnvKeys.forEach((key) => {
      const previous = previousEnvValues[key];
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    });
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('prefers env POLYMARKET_AUTH_ADDRESS when using env creds', async () => {
    const envAuthAddress = '0x1111111111111111111111111111111111111111';
    const storedAuthAddress = '0x2222222222222222222222222222222222222222';
    const makerAddress = '0x3333333333333333333333333333333333333333';

    process.env.POLYMARKET_TRADES_SOURCE = 'clob-l2';
    process.env.POLYMARKET_API_KEY = 'test-key';
    process.env.POLYMARKET_SECRET = 'dGVzdA==';
    process.env.POLYMARKET_PASSPHRASE = 'test-passphrase';
    process.env.POLYMARKET_AUTH_ADDRESS = envAuthAddress;

    const clob = nock('https://clob.polymarket.com');
    clob.get('/time').query(true).reply(200, 1700000000).persist();
    clob
      .get('/data/trades')
      .query(true)
      .matchHeader('POLY_ADDRESS', envAuthAddress)
      .reply(200, {
        data: [
          {
            id: 'trade-1',
            asset_id: 'asset-1',
            market: 'cond-1',
            outcome: 'Yes',
            side: 'BUY',
            size: 1,
            price: 0.5,
            match_time: 1700000001,
          },
        ],
        next_cursor: 'LTE=',
      });
    clob.get('/markets/cond-1').query(true).reply(200, { tokens: [] });

    const { syncPolymarketPortfolio } = require('../polymarketCopyService');

    const portfolio = {
      provider: 'polymarket',
      userId: 'user-1',
      strategy_id: 'strategy-1',
      name: 'Polymarket Test',
      recurrence: 'every_minute',
      stocks: [],
      retainedCash: 100,
      cashBuffer: 100,
      budget: 100,
      cashLimit: 100,
      initialInvestment: 100,
      rebalanceCount: 0,
      save: jest.fn(async () => {}),
      polymarket: {
        address: makerAddress,
        authAddress: storedAuthAddress,
        backfillPending: false,
        backfilledAt: null,
        apiKey: null,
        secret: null,
        passphrase: null,
        lastTradeMatchTime: '1970-01-01T00:00:00.000Z',
        lastTradeId: null,
      },
    };

    const result = await syncPolymarketPortfolio(portfolio, { mode: 'incremental' });
    expect(result.tradeSource).toBe('clob-l2');
  });

  it('sizes copied positions to the portfolio budget when enabled', async () => {
    const envAuthAddress = '0x1111111111111111111111111111111111111111';
    const makerAddress = '0x3333333333333333333333333333333333333333';

    process.env.POLYMARKET_TRADES_SOURCE = 'clob-l2';
    process.env.POLYMARKET_API_KEY = 'test-key';
    process.env.POLYMARKET_SECRET = 'dGVzdA==';
    process.env.POLYMARKET_PASSPHRASE = 'test-passphrase';
    process.env.POLYMARKET_AUTH_ADDRESS = envAuthAddress;
    delete process.env.POLYMARKET_SIZE_TO_BUDGET;

    const clob = nock('https://clob.polymarket.com');
    clob.get('/time').query(true).reply(200, 1700000000).persist();
    clob
      .get('/data/trades')
      .query(true)
      .reply(200, {
        data: [
          {
            id: 'trade-1',
            asset_id: 'asset-1',
            market: 'cond-1',
            outcome: 'Yes',
            side: 'BUY',
            size: 10,
            price: 0.5,
            match_time: 1700000001,
          },
        ],
        next_cursor: 'LTE=',
      });
    clob.get('/markets/cond-1').query(true).reply(200, {
      tokens: [{ token_id: 'asset-1', price: 0.5, outcome: 'Yes' }],
    });

    const { syncPolymarketPortfolio } = require('../polymarketCopyService');

    const portfolio = {
      provider: 'polymarket',
      userId: 'user-1',
      strategy_id: 'strategy-1',
      name: 'Polymarket Sized',
      recurrence: 'every_minute',
      stocks: [],
      retainedCash: 100,
      cashBuffer: 100,
      budget: 100,
      cashLimit: 100,
      initialInvestment: 100,
      rebalanceCount: 0,
      save: jest.fn(async () => {}),
      polymarket: {
        address: makerAddress,
        sizeToBudget: true,
        authAddress: null,
        backfillPending: true,
        backfilledAt: null,
        apiKey: null,
        secret: null,
        passphrase: null,
        lastTradeMatchTime: '1970-01-01T00:00:00.000Z',
        lastTradeId: null,
      },
    };

    await syncPolymarketPortfolio(portfolio, { mode: 'backfill' });
    expect(portfolio.stocks).toHaveLength(1);
    expect(portfolio.stocks[0].quantity).toBeCloseTo(200, 6);
    expect(portfolio.retainedCash).toBeCloseTo(0, 6);
  });

  it('does not auto-backfill positions on incremental sync when backfill is disabled', async () => {
    const makerAddress = '0x3333333333333333333333333333333333333333';

    process.env.POLYMARKET_TRADES_SOURCE = 'data-api';
    process.env.POLYMARKET_SIZE_TO_BUDGET_BOOTSTRAP = 'true';
    process.env.POLYMARKET_SIZE_TO_BUDGET_BOOTSTRAP_MAX_TRADES = '2000';

    const dataApi = nock('https://data-api.polymarket.com');
    dataApi
      .get('/trades')
      .query(true)
      .reply(200, [
        {
          transactionHash: '0x1111',
          asset: 'asset-1',
          conditionId: 'cond-1',
          outcome: 'Yes',
          side: 'BUY',
          timestamp: 1700000001,
          price: 0.5,
          size: 10,
        },
      ]);

    const clob = nock('https://clob.polymarket.com');
    clob.get('/markets/cond-1').query(true).reply(200, {
      tokens: [{ token_id: 'asset-1', price: 0.5, outcome: 'Yes' }],
    });

    const { syncPolymarketPortfolio } = require('../polymarketCopyService');

    const portfolio = {
      provider: 'polymarket',
      userId: 'user-1',
      strategy_id: 'strategy-1',
      name: 'Polymarket Bootstrap',
      recurrence: 'every_minute',
      stocks: [],
      retainedCash: 100,
      cashBuffer: 100,
      budget: 100,
      cashLimit: 100,
      initialInvestment: 100,
      rebalanceCount: 0,
      save: jest.fn(async () => {}),
      polymarket: {
        address: makerAddress,
        sizeToBudget: true,
        backfillPending: false,
        lastTradeMatchTime: '1970-01-01T00:00:00.000Z',
        lastTradeId: null,
      },
    };

    const result = await syncPolymarketPortfolio(portfolio, { mode: 'incremental' });
    expect(result.mode).toBe('incremental');
    expect(portfolio.polymarket.backfillPending).toBe(false);
    expect(portfolio.polymarket.backfilledAt).toBeNull();
    expect(portfolio.polymarket.sizingState).toBeUndefined();
    expect(portfolio.stocks).toHaveLength(1);
    expect(portfolio.stocks[0].quantity).toBeCloseTo(10, 6);
  });

  it('executes a live rebalance when size-to-budget target changes', async () => {
    const executionModulePath = require.resolve('../polymarketExecutionService');
    jest.doMock(executionModulePath, () => ({
      getPolymarketExecutionMode: jest.fn(() => 'live'),
      executePolymarketMarketOrder: jest.fn(async ({ tokenID, side, amount }) => ({
        ok: true,
        mode: 'live',
        dryRun: false,
        request: { tokenID, side, amount },
        response: { orderID: `order-${side}-${tokenID}` },
      })),
    }));

    const envAuthAddress = '0x1111111111111111111111111111111111111111';
    const makerAddress = '0x3333333333333333333333333333333333333333';

    process.env.POLYMARKET_TRADES_SOURCE = 'clob-l2';
    process.env.POLYMARKET_API_KEY = 'test-key';
    process.env.POLYMARKET_SECRET = 'dGVzdA==';
    process.env.POLYMARKET_PASSPHRASE = 'test-passphrase';
    process.env.POLYMARKET_AUTH_ADDRESS = envAuthAddress;
    process.env.POLYMARKET_LIVE_REBALANCE_MIN_NOTIONAL = '0.01';
    process.env.POLYMARKET_LIVE_REBALANCE_MAX_ORDERS = '10';

    const clob = nock('https://clob.polymarket.com');
    clob.get('/time').query(true).reply(200, 1700000000).persist();

    // Backfill: maker buys A and B.
    clob
      .get('/data/trades')
      .query(true)
      .reply(200, {
        data: [
          {
            id: 'trade-2',
            asset_id: 'asset-b',
            market: 'cond-b',
            outcome: 'Yes',
            side: 'BUY',
            size: 10,
            price: 0.5,
            match_time: 1700000002,
          },
          {
            id: 'trade-1',
            asset_id: 'asset-a',
            market: 'cond-a',
            outcome: 'Yes',
            side: 'BUY',
            size: 10,
            price: 0.5,
            match_time: 1700000001,
          },
        ],
        next_cursor: 'LTE=',
      });
    clob.get('/markets/cond-a').query(true).reply(200, {
      tokens: [{ token_id: 'asset-a', price: 0.5, outcome: 'Yes' }],
    }).persist();
    clob.get('/markets/cond-b').query(true).reply(200, {
      tokens: [{ token_id: 'asset-b', price: 0.5, outcome: 'Yes' }],
    }).persist();

    const { syncPolymarketPortfolio } = require('../polymarketCopyService');
    const { executePolymarketMarketOrder } = require(executionModulePath);

    const portfolio = {
      provider: 'polymarket',
      userId: 'user-1',
      strategy_id: 'strategy-1',
      name: 'Polymarket Live Sized',
      recurrence: 'every_minute',
      stocks: [],
      retainedCash: 100,
      cashBuffer: 100,
      budget: 100,
      cashLimit: 100,
      initialInvestment: 100,
      rebalanceCount: 0,
      save: jest.fn(async () => {}),
      polymarket: {
        address: makerAddress,
        executionMode: 'live',
        sizeToBudget: true,
        authAddress: null,
        backfillPending: true,
        backfilledAt: null,
        apiKey: null,
        secret: null,
        passphrase: null,
        lastTradeMatchTime: '1970-01-01T00:00:00.000Z',
        lastTradeId: null,
      },
    };

    await syncPolymarketPortfolio(portfolio, { mode: 'backfill' });
    expect(portfolio.stocks).toHaveLength(2);
    expect(portfolio.polymarket.backfillPending).toBe(false);
    expect(portfolio.polymarket.lastTradeId).toBe('trade-2');

    // Reset HTTP mocks so the incremental call gets a fresh /data/trades response.
    nock.cleanAll();
    const clob2 = nock('https://clob.polymarket.com');
    clob2.get('/time').query(true).reply(200, 1700000000).persist();
    clob2.get('/markets/cond-a').query(true).reply(200, {
      tokens: [{ token_id: 'asset-a', price: 0.5, outcome: 'Yes' }],
    }).persist();
    clob2.get('/markets/cond-b').query(true).reply(200, {
      tokens: [{ token_id: 'asset-b', price: 0.5, outcome: 'Yes' }],
    }).persist();

    // Incremental: maker buys more A.
    clob2
      .get('/data/trades')
      .query(true)
      .reply(200, {
        data: [
          {
            id: 'trade-3',
            asset_id: 'asset-a',
            market: 'cond-a',
            outcome: 'Yes',
            side: 'BUY',
            size: 10,
            price: 0.5,
            match_time: 1700000003,
          },
        ],
        next_cursor: 'LTE=',
      });

    const { recordStrategyLog } = require('../strategyLogger');
    const beforeLogs = recordStrategyLog.mock.calls.length;
    const result = await syncPolymarketPortfolio(portfolio, { mode: 'incremental' });
    expect(result.processed).toBe(1);

    const afterLogs = recordStrategyLog.mock.calls.length;
    expect(afterLogs).toBeGreaterThan(beforeLogs);
    const lastLog = recordStrategyLog.mock.calls[afterLogs - 1]?.[0] || null;
    expect(lastLog?.details?.executionMode).toBe('live');
    expect(lastLog?.details?.mode).toBe('incremental');
    expect(lastLog?.details?.executionEnabled).toBe(true);

    expect(executePolymarketMarketOrder).toHaveBeenCalled();

    const calls = executePolymarketMarketOrder.mock.calls.map((args) => args[0]);
    const buyA = calls.find((c) => c.side === 'BUY' && c.tokenID === 'asset-a');
    const sellB = calls.find((c) => c.side === 'SELL' && c.tokenID === 'asset-b');
    expect(buyA).toBeTruthy();
    expect(sellB).toBeFalsy();
    expect(buyA.amount).toBeCloseTo(50, 6);
  });

  it('can execute a live rebalance after a backfill when explicitly enabled', async () => {
    const executionModulePath = require.resolve('../polymarketExecutionService');
    jest.doMock(executionModulePath, () => ({
      getPolymarketExecutionMode: jest.fn(() => 'live'),
      executePolymarketMarketOrder: jest.fn(async ({ tokenID, side, amount }) => ({
        ok: true,
        mode: 'live',
        dryRun: false,
        request: { tokenID, side, amount },
        response: { orderID: `order-${side}-${tokenID}` },
      })),
    }));

    process.env.POLYMARKET_BACKFILL_LIVE_REBALANCE = 'true';

    const envAuthAddress = '0x1111111111111111111111111111111111111111';
    const makerAddress = '0x3333333333333333333333333333333333333333';

    process.env.POLYMARKET_TRADES_SOURCE = 'clob-l2';
    process.env.POLYMARKET_API_KEY = 'test-key';
    process.env.POLYMARKET_SECRET = 'dGVzdA==';
    process.env.POLYMARKET_PASSPHRASE = 'test-passphrase';
    process.env.POLYMARKET_AUTH_ADDRESS = envAuthAddress;
    process.env.POLYMARKET_LIVE_REBALANCE_MIN_NOTIONAL = '0.01';
    process.env.POLYMARKET_LIVE_REBALANCE_MAX_ORDERS = '10';

    const clob = nock('https://clob.polymarket.com');
    clob.get('/time').query(true).reply(200, 1700000000).persist();
    clob
      .get('/data/trades')
      .query(true)
      .reply(200, {
        data: [
          {
            id: 'trade-2',
            asset_id: 'asset-b',
            market: 'cond-b',
            outcome: 'Yes',
            side: 'BUY',
            size: 10,
            price: 0.5,
            match_time: 1700000002,
          },
          {
            id: 'trade-1',
            asset_id: 'asset-a',
            market: 'cond-a',
            outcome: 'Yes',
            side: 'BUY',
            size: 10,
            price: 0.5,
            match_time: 1700000001,
          },
        ],
        next_cursor: 'LTE=',
      });
    clob.get('/markets/cond-a').query(true).reply(200, {
      tokens: [{ token_id: 'asset-a', price: 0.5, outcome: 'Yes' }],
    }).persist();
    clob.get('/markets/cond-b').query(true).reply(200, {
      tokens: [{ token_id: 'asset-b', price: 0.5, outcome: 'Yes' }],
    }).persist();

    const { syncPolymarketPortfolio } = require('../polymarketCopyService');
    const { executePolymarketMarketOrder } = require(executionModulePath);

    const portfolio = {
      provider: 'polymarket',
      userId: 'user-1',
      strategy_id: 'strategy-1',
      name: 'Polymarket Live Backfill Rebalance',
      recurrence: 'every_minute',
      stocks: [],
      retainedCash: 100,
      cashBuffer: 100,
      budget: 100,
      cashLimit: 100,
      initialInvestment: 100,
      rebalanceCount: 0,
      save: jest.fn(async () => {}),
      polymarket: {
        address: makerAddress,
        executionMode: 'live',
        sizeToBudget: true,
        authAddress: null,
        backfillPending: true,
        backfilledAt: null,
        apiKey: null,
        secret: null,
        passphrase: null,
        lastTradeMatchTime: '1970-01-01T00:00:00.000Z',
        lastTradeId: null,
      },
    };

    await syncPolymarketPortfolio(portfolio, { mode: 'backfill' });

    expect(executePolymarketMarketOrder).toHaveBeenCalled();
    const calls = executePolymarketMarketOrder.mock.calls.map((args) => args[0]);
    const buyA = calls.find((c) => c.side === 'BUY' && c.tokenID === 'asset-a');
    const buyB = calls.find((c) => c.side === 'BUY' && c.tokenID === 'asset-b');
    expect(buyA).toBeTruthy();
    expect(buyB).toBeTruthy();
    expect(buyA.amount).toBeCloseTo(50, 6);
    expect(buyB.amount).toBeCloseTo(50, 6);
  });

  it('defaults polymarket.executionMode to paper when missing (even if env is live)', async () => {
    const executionModulePath = require.resolve('../polymarketExecutionService');
    jest.doMock(executionModulePath, () => ({
      getPolymarketExecutionMode: jest.fn(() => 'live'),
      executePolymarketMarketOrder: jest.fn(async ({ tokenID, side, amount }) => ({
        ok: true,
        mode: 'live',
        dryRun: false,
        request: { tokenID, side, amount },
        response: { orderID: `order-${side}-${tokenID}` },
      })),
    }));

    const envAuthAddress = '0x1111111111111111111111111111111111111111';
    const makerAddress = '0x3333333333333333333333333333333333333333';

    process.env.POLYMARKET_TRADES_SOURCE = 'clob-l2';
    process.env.POLYMARKET_API_KEY = 'test-key';
    process.env.POLYMARKET_SECRET = 'dGVzdA==';
    process.env.POLYMARKET_PASSPHRASE = 'test-passphrase';
    process.env.POLYMARKET_AUTH_ADDRESS = envAuthAddress;
    process.env.POLYMARKET_LIVE_REBALANCE_MIN_NOTIONAL = '0.01';
    process.env.POLYMARKET_LIVE_REBALANCE_MAX_ORDERS = '10';

    const clob = nock('https://clob.polymarket.com');
    clob.get('/time').query(true).reply(200, 1700000000).persist();
    clob
      .get('/data/trades')
      .query(true)
      .reply(200, {
        data: [
          {
            id: 'trade-2',
            asset_id: 'asset-b',
            market: 'cond-b',
            outcome: 'Yes',
            side: 'BUY',
            size: 10,
            price: 0.5,
            match_time: 1700000002,
          },
          {
            id: 'trade-1',
            asset_id: 'asset-a',
            market: 'cond-a',
            outcome: 'Yes',
            side: 'BUY',
            size: 10,
            price: 0.5,
            match_time: 1700000001,
          },
        ],
        next_cursor: 'LTE=',
      });
    clob.get('/markets/cond-a').query(true).reply(200, {
      tokens: [{ token_id: 'asset-a', price: 0.5, outcome: 'Yes' }],
    }).persist();
    clob.get('/markets/cond-b').query(true).reply(200, {
      tokens: [{ token_id: 'asset-b', price: 0.5, outcome: 'Yes' }],
    }).persist();

    const { syncPolymarketPortfolio } = require('../polymarketCopyService');
    const { executePolymarketMarketOrder } = require(executionModulePath);
    const { recordStrategyLog } = require('../strategyLogger');

    const portfolio = {
      provider: 'polymarket',
      userId: 'user-1',
      strategy_id: 'strategy-1',
      name: 'Polymarket Default Paper',
      recurrence: 'every_minute',
      stocks: [],
      retainedCash: 100,
      cashBuffer: 100,
      budget: 100,
      cashLimit: 100,
      initialInvestment: 100,
      rebalanceCount: 0,
      save: jest.fn(async () => {}),
      polymarket: {
        address: makerAddress,
        sizeToBudget: true,
        authAddress: null,
        backfillPending: true,
        backfilledAt: null,
        apiKey: null,
        secret: null,
        passphrase: null,
        lastTradeMatchTime: '1970-01-01T00:00:00.000Z',
        lastTradeId: null,
      },
    };

    await syncPolymarketPortfolio(portfolio, { mode: 'backfill' });

    nock.cleanAll();
    const clob2 = nock('https://clob.polymarket.com');
    clob2.get('/time').query(true).reply(200, 1700000000).persist();
    clob2.get('/markets/cond-a').query(true).reply(200, {
      tokens: [{ token_id: 'asset-a', price: 0.5, outcome: 'Yes' }],
    }).persist();
    clob2.get('/markets/cond-b').query(true).reply(200, {
      tokens: [{ token_id: 'asset-b', price: 0.5, outcome: 'Yes' }],
    }).persist();
    clob2
      .get('/data/trades')
      .query(true)
      .reply(200, {
        data: [
          {
            id: 'trade-3',
            asset_id: 'asset-a',
            market: 'cond-a',
            outcome: 'Yes',
            side: 'BUY',
            size: 10,
            price: 0.5,
            match_time: 1700000003,
          },
        ],
        next_cursor: 'LTE=',
      });

    const beforeCalls = executePolymarketMarketOrder.mock.calls.length;
    await syncPolymarketPortfolio(portfolio, { mode: 'incremental' });
    const afterCalls = executePolymarketMarketOrder.mock.calls.length;
    expect(afterCalls).toBe(beforeCalls);

    const lastLog = recordStrategyLog.mock.calls[recordStrategyLog.mock.calls.length - 1]?.[0] || null;
    expect(lastLog?.details?.envExecutionMode).toBe('live');
    expect(lastLog?.details?.portfolioExecutionMode).toBe('paper');
    expect(lastLog?.details?.executionMode).toBe('paper');
    expect(lastLog?.details?.executionEnabled).toBe(false);
  });

  it('honors polymarket.executionMode=paper even when env is live', async () => {
    const executionModulePath = require.resolve('../polymarketExecutionService');
    jest.doMock(executionModulePath, () => ({
      getPolymarketExecutionMode: jest.fn(() => 'live'),
      executePolymarketMarketOrder: jest.fn(async ({ tokenID, side, amount }) => ({
        ok: true,
        mode: 'live',
        dryRun: false,
        request: { tokenID, side, amount },
        response: { orderID: `order-${side}-${tokenID}` },
      })),
    }));

    const envAuthAddress = '0x1111111111111111111111111111111111111111';
    const makerAddress = '0x3333333333333333333333333333333333333333';

    process.env.POLYMARKET_TRADES_SOURCE = 'clob-l2';
    process.env.POLYMARKET_API_KEY = 'test-key';
    process.env.POLYMARKET_SECRET = 'dGVzdA==';
    process.env.POLYMARKET_PASSPHRASE = 'test-passphrase';
    process.env.POLYMARKET_AUTH_ADDRESS = envAuthAddress;
    process.env.POLYMARKET_LIVE_REBALANCE_MIN_NOTIONAL = '0.01';
    process.env.POLYMARKET_LIVE_REBALANCE_MAX_ORDERS = '10';

    const clob = nock('https://clob.polymarket.com');
    clob.get('/time').query(true).reply(200, 1700000000).persist();
    clob
      .get('/data/trades')
      .query(true)
      .reply(200, {
        data: [
          {
            id: 'trade-2',
            asset_id: 'asset-b',
            market: 'cond-b',
            outcome: 'Yes',
            side: 'BUY',
            size: 10,
            price: 0.5,
            match_time: 1700000002,
          },
          {
            id: 'trade-1',
            asset_id: 'asset-a',
            market: 'cond-a',
            outcome: 'Yes',
            side: 'BUY',
            size: 10,
            price: 0.5,
            match_time: 1700000001,
          },
        ],
        next_cursor: 'LTE=',
      });
    clob.get('/markets/cond-a').query(true).reply(200, {
      tokens: [{ token_id: 'asset-a', price: 0.5, outcome: 'Yes' }],
    }).persist();
    clob.get('/markets/cond-b').query(true).reply(200, {
      tokens: [{ token_id: 'asset-b', price: 0.5, outcome: 'Yes' }],
    }).persist();

    const { syncPolymarketPortfolio } = require('../polymarketCopyService');
    const { executePolymarketMarketOrder } = require(executionModulePath);
    const { recordStrategyLog } = require('../strategyLogger');

    const portfolio = {
      provider: 'polymarket',
      userId: 'user-1',
      strategy_id: 'strategy-1',
      name: 'Polymarket Override Paper',
      recurrence: 'every_minute',
      stocks: [],
      retainedCash: 100,
      cashBuffer: 100,
      budget: 100,
      cashLimit: 100,
      initialInvestment: 100,
      rebalanceCount: 0,
      save: jest.fn(async () => {}),
      polymarket: {
        address: makerAddress,
        executionMode: 'paper',
        sizeToBudget: true,
        authAddress: null,
        backfillPending: true,
        backfilledAt: null,
        apiKey: null,
        secret: null,
        passphrase: null,
        lastTradeMatchTime: '1970-01-01T00:00:00.000Z',
        lastTradeId: null,
      },
    };

    await syncPolymarketPortfolio(portfolio, { mode: 'backfill' });

    nock.cleanAll();
    const clob2 = nock('https://clob.polymarket.com');
    clob2.get('/time').query(true).reply(200, 1700000000).persist();
    clob2.get('/markets/cond-a').query(true).reply(200, {
      tokens: [{ token_id: 'asset-a', price: 0.5, outcome: 'Yes' }],
    }).persist();
    clob2.get('/markets/cond-b').query(true).reply(200, {
      tokens: [{ token_id: 'asset-b', price: 0.5, outcome: 'Yes' }],
    }).persist();
    clob2
      .get('/data/trades')
      .query(true)
      .reply(200, {
        data: [
          {
            id: 'trade-3',
            asset_id: 'asset-a',
            market: 'cond-a',
            outcome: 'Yes',
            side: 'BUY',
            size: 10,
            price: 0.5,
            match_time: 1700000003,
          },
        ],
        next_cursor: 'LTE=',
      });

    const beforeCalls = executePolymarketMarketOrder.mock.calls.length;
    await syncPolymarketPortfolio(portfolio, { mode: 'incremental' });
    const afterCalls = executePolymarketMarketOrder.mock.calls.length;
    expect(afterCalls).toBe(beforeCalls);

    const lastLog = recordStrategyLog.mock.calls[recordStrategyLog.mock.calls.length - 1]?.[0] || null;
    expect(lastLog?.details?.envExecutionMode).toBe('live');
    expect(lastLog?.details?.portfolioExecutionMode).toBe('paper');
    expect(lastLog?.details?.executionMode).toBe('paper');
    expect(lastLog?.details?.executionEnabled).toBe(false);
  });

  it('matches paper vs live portfolio state (excluding executions)', async () => {
    const executionModulePath = require.resolve('../polymarketExecutionService');
    jest.doMock(executionModulePath, () => ({
      getPolymarketExecutionMode: jest.fn(() => 'live'),
      executePolymarketMarketOrder: jest.fn(async ({ tokenID, side, amount }) => ({
        ok: true,
        mode: 'live',
        dryRun: false,
        request: { tokenID, side, amount },
        response: { orderID: `order-${side}-${tokenID}` },
      })),
    }));

    const envAuthAddress = '0x1111111111111111111111111111111111111111';
    const makerAddress = '0x3333333333333333333333333333333333333333';

    process.env.POLYMARKET_TRADES_SOURCE = 'clob-l2';
    process.env.POLYMARKET_API_KEY = 'test-key';
    process.env.POLYMARKET_SECRET = 'dGVzdA==';
    process.env.POLYMARKET_PASSPHRASE = 'test-passphrase';
    process.env.POLYMARKET_AUTH_ADDRESS = envAuthAddress;
    process.env.POLYMARKET_LIVE_REBALANCE_MIN_NOTIONAL = '0.01';
    process.env.POLYMARKET_LIVE_REBALANCE_MAX_ORDERS = '10';

    const { syncPolymarketPortfolio } = require('../polymarketCopyService');
    const { executePolymarketMarketOrder } = require(executionModulePath);

    const makePortfolio = (executionMode) => ({
      provider: 'polymarket',
      userId: 'user-1',
      strategy_id: `strategy-${executionMode}`,
      name: `Polymarket ${executionMode}`,
      recurrence: 'every_minute',
      stocks: [],
      retainedCash: 100,
      cashBuffer: 100,
      budget: 100,
      cashLimit: 100,
      initialInvestment: 100,
      rebalanceCount: 0,
      save: jest.fn(async () => {}),
      polymarket: {
        address: makerAddress,
        executionMode,
        sizeToBudget: true,
        authAddress: null,
        backfillPending: true,
        backfilledAt: null,
        apiKey: null,
        secret: null,
        passphrase: null,
        lastTradeMatchTime: '1970-01-01T00:00:00.000Z',
        lastTradeId: null,
      },
    });

    const runScenario = async (portfolio) => {
      nock.cleanAll();
      const clob = nock('https://clob.polymarket.com');
      clob.get('/time').query(true).reply(200, 1700000000).persist();
      clob
        .get('/data/trades')
        .query(true)
        .reply(200, {
          data: [
            {
              id: 'trade-2',
              asset_id: 'asset-b',
              market: 'cond-b',
              outcome: 'Yes',
              side: 'BUY',
              size: 10,
              price: 0.5,
              match_time: 1700000002,
            },
            {
              id: 'trade-1',
              asset_id: 'asset-a',
              market: 'cond-a',
              outcome: 'Yes',
              side: 'BUY',
              size: 10,
              price: 0.5,
              match_time: 1700000001,
            },
          ],
          next_cursor: 'LTE=',
        });
      clob.get('/markets/cond-a').query(true).reply(200, {
        tokens: [{ token_id: 'asset-a', price: 0.5, outcome: 'Yes' }],
      }).persist();
      clob.get('/markets/cond-b').query(true).reply(200, {
        tokens: [{ token_id: 'asset-b', price: 0.5, outcome: 'Yes' }],
      }).persist();

      await syncPolymarketPortfolio(portfolio, { mode: 'backfill' });

      nock.cleanAll();
      const clob2 = nock('https://clob.polymarket.com');
      clob2.get('/time').query(true).reply(200, 1700000000).persist();
      clob2.get('/markets/cond-a').query(true).reply(200, {
        tokens: [{ token_id: 'asset-a', price: 0.5, outcome: 'Yes' }],
      }).persist();
      clob2.get('/markets/cond-b').query(true).reply(200, {
        tokens: [{ token_id: 'asset-b', price: 0.5, outcome: 'Yes' }],
      }).persist();
      clob2
        .get('/data/trades')
        .query(true)
        .reply(200, {
          data: [
            {
              id: 'trade-3',
              asset_id: 'asset-a',
              market: 'cond-a',
              outcome: 'Yes',
              side: 'BUY',
              size: 10,
              price: 0.5,
              match_time: 1700000003,
            },
          ],
          next_cursor: 'LTE=',
        });

      await syncPolymarketPortfolio(portfolio, { mode: 'incremental' });

      const normalizedStocks = (portfolio.stocks || [])
        .map((row) => ({
          asset_id: row.asset_id,
          market: row.market,
          outcome: row.outcome,
          quantity: row.quantity,
          avgCost: row.avgCost,
          currentPrice: row.currentPrice,
        }))
        .sort((a, b) => String(a.asset_id).localeCompare(String(b.asset_id)));

      return {
        retainedCash: portfolio.retainedCash,
        stocks: normalizedStocks,
        lastTradeId: portfolio?.polymarket?.lastTradeId || null,
      };
    };

    const paperPortfolio = makePortfolio('paper');
    const livePortfolio = makePortfolio('live');

    const paper = await runScenario(paperPortfolio);
    expect(executePolymarketMarketOrder).not.toHaveBeenCalled();

    const live = await runScenario(livePortfolio);
    expect(executePolymarketMarketOrder).toHaveBeenCalled();

    expect(live.lastTradeId).toBe(paper.lastTradeId);
    expect(live.retainedCash).toBeCloseTo(paper.retainedCash, 6);
    expect(live.stocks).toEqual(paper.stocks);
  });

  it('does not save polymarket.sizingState when it is undefined', async () => {
    process.env.POLYMARKET_TRADES_SOURCE = 'data-api';

    const dataApi = nock('https://data-api.polymarket.com');
    dataApi
      .get('/trades')
      .query(true)
      .reply(200, []);

    const { syncPolymarketPortfolio } = require('../polymarketCopyService');

    const portfolio = {
      provider: 'polymarket',
      userId: 'user-1',
      strategy_id: 'strategy-1',
      name: 'Polymarket Undefined State',
      recurrence: 'every_minute',
      stocks: [],
      retainedCash: 100,
      cashBuffer: 100,
      budget: 100,
      cashLimit: 100,
      initialInvestment: 100,
      rebalanceCount: 0,
      save: jest.fn(async function () {
        expect(this.polymarket).toBeTruthy();
        expect(this.polymarket.sizingState).toEqual({});
      }),
      polymarket: {
        address: '0x3333333333333333333333333333333333333333',
        sizeToBudget: true,
        sizingState: undefined,
        backfillPending: false,
        lastTradeMatchTime: '1970-01-01T00:00:00.000Z',
        lastTradeId: null,
      },
    };

    const result = await syncPolymarketPortfolio(portfolio, { mode: 'incremental' });
    expect(result.processed).toBe(0);
    expect(portfolio.save).toHaveBeenCalled();
  });
});
