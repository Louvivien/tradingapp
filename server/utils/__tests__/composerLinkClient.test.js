const nock = require('nock');

const {
  extractNextDataFromHtml,
  parseSymphonyIdFromUrl,
  guessStrategyText,
  guessHoldings,
  holdingsObjectToWeights,
  guessEffectiveAsOfDateKey,
  fetchComposerLinkSnapshot,
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
      });

    const snapshot = await fetchComposerLinkSnapshot({ url: 'https://app.composer.trade/symphony/XYZ/factsheet' });
    expect(snapshot.holdings.map((row) => row.symbol)).toEqual(['BIL', 'SPY']);
    expect(snapshot.effectiveAsOfDateKey).toEqual('2026-01-07');
    htmlScope.done();
    apiScope.done();
  });
});
