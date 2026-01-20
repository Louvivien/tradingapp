const nock = require('nock');

const {
  extractNextDataFromHtml,
  parseSymphonyIdFromUrl,
  guessStrategyText,
  guessHoldings,
  holdingsObjectToWeights,
  guessEffectiveAsOfDateKey,
  scoreTreeToStrategyText,
  fetchComposerLinkSnapshot,
  fetchPublicSymphonyBacktestById,
} = require('../composerLinkClient');

describe('composerLinkClient', () => {
  it('extracts __NEXT_DATA__ JSON from HTML', () => {
    const html = `
      <html>
        <body>
          <script id="__NEXT_DATA__" type="application/json">
            {"props":{"pageProps":{"hello":"world"}}}
          </script>
        </body>
      </html>
    `;
    const parsed = extractNextDataFromHtml(html);
    expect(parsed).toMatchObject({ props: { pageProps: { hello: 'world' } } });
  });

  it('guesses strategy text from payload', () => {
    const payload = {
      a: 'nope',
      nested: {
        strategy: '(defsymphony "Test" {} (asset "SPY"))',
      },
    };
    expect(guessStrategyText(payload)).toContain('(defsymphony');
  });

  it('guesses holdings and normalizes percent weights', () => {
    const payload = {
      data: {
        holdings: [
          { symbol: 'SPY', allocation: 60 },
          { symbol: 'BIL', allocation: 40 },
        ],
      },
    };
    const holdings = guessHoldings(payload);
    expect(holdings.map((row) => row.symbol)).toEqual(['BIL', 'SPY']);
    const spy = holdings.find((row) => row.symbol === 'SPY');
    expect(spy.weight).toBeCloseTo(0.6, 8);
  });

  it('guesses effective as-of date key', () => {
    const payload = { meta: { asOfDate: '2026-01-07' } };
    expect(guessEffectiveAsOfDateKey(payload)).toEqual('2026-01-07');
  });

  it('parses symphony id from url', () => {
    expect(parseSymphonyIdFromUrl('https://app.composer.trade/symphony/ABC123/details')).toEqual('ABC123');
  });

  it('converts last_backtest_holdings object into weights', () => {
    const weights = holdingsObjectToWeights({ SPY: 60, BIL: 40, $USD: 10 });
    expect(weights.map((row) => row.symbol)).toEqual(['BIL', 'SPY']);
    expect(weights.find((row) => row.symbol === 'SPY').weight).toBeCloseTo(0.6, 8);
  });

  it('fetches snapshot from a Composer link HTML', async () => {
    const scope = nock('https://example.com').get('/symphony/abc').reply(
      200,
      `
        <html><body>
          <script id="__NEXT_DATA__" type="application/json">
            ${JSON.stringify({
              props: {
                pageProps: {
                  symphony: {
                    strategyText: '(defsymphony "Test" {} (asset "SPY"))',
                  },
                  currentHoldings: [{ ticker: 'SPY', percent: 100 }],
                  asOf: '2026-01-07',
                },
              },
            })}
          </script>
        </body></html>
      `,
      { 'Content-Type': 'text/html; charset=utf-8' }
    );

    const snapshot = await fetchComposerLinkSnapshot({ url: 'https://example.com/symphony/abc' });
    expect(snapshot.strategyText).toContain('(defsymphony');
    expect(snapshot.holdings[0]).toMatchObject({ symbol: 'SPY' });
    expect(snapshot.effectiveAsOfDateKey).toEqual('2026-01-07');
    scope.done();
  });

  it('falls back to public symphony endpoint when HTML has no holdings payload', async () => {
    const htmlScope = nock('https://app.composer.trade')
      .get('/symphony/XYZ/factsheet')
      .reply(200, '<html><body><div id="app"></div></body></html>', {
        'Content-Type': 'text/html; charset=utf-8',
      });

    const apiScope = nock('https://backtest-api.composer.trade')
      .get('/api/v1/public/symphonies/XYZ')
      .reply(200, {
        last_backtest_last_market_day: '2026-01-07',
        last_backtest_holdings: { SPY: 60, BIL: 40, $USD: 10 },
        name: 'Fallback Strategy',
      });

    const scoreScope = nock('https://backtest-api.composer.trade')
      .get('/api/v1/public/symphonies/XYZ/score')
      .query({ score_version: 'v2' })
      .reply(200, {
        type: 'node_root',
        asset_class: 'EQUITIES',
        rebalance: 'daily',
        rebalance_corridor_width: null,
        meta: { name: 'Fallback Strategy' },
        children: [
          {
            type: 'node_weight',
            weight: ['weight_equal'],
            meta: {},
            children: [{ type: 'node_asset', ticker: 'EQUITIES::SPY//USD', exchange: 'NYSEARCA', meta: {} }],
          },
        ],
      });

    const snapshot = await fetchComposerLinkSnapshot({ url: 'https://app.composer.trade/symphony/XYZ/factsheet' });
    expect(snapshot.holdings.map((row) => row.symbol)).toEqual(['BIL', 'SPY']);
    expect(snapshot.effectiveAsOfDateKey).toEqual('2026-01-07');
    expect(snapshot.strategyText).toContain('(defsymphony');
    htmlScope.done();
    apiScope.done();
    scoreScope.done();
  });

  it('converts score tree to defsymphony syntax and scales percent constants', () => {
    const script = scoreTreeToStrategyText({
      type: 'node_root',
      asset_class: 'EQUITIES',
      rebalance: 'daily',
      rebalance_corridor_width: null,
      meta: { name: 'Score Strategy' },
      children: [
        {
          type: 'node_weight',
          weight: ['weight_equal'],
          meta: {},
          children: [
            {
              type: 'node_if',
              meta: {},
              condition: [
                'fn_gt',
                ['fn_relative_strength_index', ['metric_close', 'EQUITIES::SPY//USD'], 10],
                ['fn_constant', 0.8],
              ],
              then_children: [{ type: 'node_asset', ticker: 'EQUITIES::TQQQ//USD', exchange: 'NASDAQ', meta: {} }],
              else_children: [{ type: 'node_asset', ticker: 'EQUITIES::BIL//USD', exchange: 'NYSEARCA', meta: {} }],
            },
          ],
        },
      ],
    });

    expect(script).toContain('(defsymphony');
    expect(script).toContain(':rebalance-frequency :daily');
    expect(script).toContain('(rsi "SPY" {:window 10})');
    expect(script).toContain(' 80)');
    expect(script).not.toContain('0.8');
  });

  it('fetches public backtest holdings for a given date and converts last_market_day to a date key', async () => {
    const apiScope = nock('https://backtest-api.composer.trade')
      .post('/api/v2/public/symphonies/ABC/backtest', (body) => body?.end_date === '2026-01-13')
      .reply(200, {
        last_market_day: 20466,
        last_market_days_value: 10000,
        last_market_days_holdings: {
          'EQUITIES::SPY//USD': 10000,
          $USD: 0,
        },
      });

    const result = await fetchPublicSymphonyBacktestById({
      symphonyId: 'ABC',
      capital: 10000,
      startDate: '2026-01-01',
      endDate: '2026-01-13',
      broker: 'alpaca',
      abbreviateDays: 1,
    });

    expect(result.effectiveAsOfDateKey).toEqual('2026-01-13');
    expect(result.holdingsObject).toEqual({ SPY: 10000, $USD: 0 });
    apiScope.done();
  });

  it('surfaces outdated_series tickers when the public backtest cannot run', async () => {
    const apiScope = nock('https://backtest-api.composer.trade')
      .post('/api/v2/public/symphonies/DEF/backtest')
      .reply(400, {
        code: 'no-data-in-date-range',
        message: 'No data available in the requested date range.',
        meta: {
          outdated_series: ['Close price of EQUITIES::HKND//USD'],
        },
      });

    await expect(
      fetchPublicSymphonyBacktestById({
        symphonyId: 'DEF',
        capital: 10000,
        startDate: '2026-01-01',
        endDate: '2026-01-13',
        broker: 'alpaca',
        abbreviateDays: 1,
      })
    ).rejects.toMatchObject({
      name: 'ComposerPublicBacktestError',
      status: 400,
      code: 'no-data-in-date-range',
      outdatedSeries: ['HKND'],
    });

    apiScope.done();
  });
});
