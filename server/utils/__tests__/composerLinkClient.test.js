const nock = require('nock');

const {
  extractNextDataFromHtml,
  guessStrategyText,
  guessHoldings,
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
});

