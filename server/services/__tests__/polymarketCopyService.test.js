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
});
