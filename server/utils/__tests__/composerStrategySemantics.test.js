const { compareComposerStrategySemantics } = require('../composerStrategySemantics');

describe('compareComposerStrategySemantics', () => {
  it('treats redundant weight-equal wrappers as equivalent', () => {
    const dbStrategyText =
      '(defsymphony "A" {} (weight-equal [(weight-equal [(asset "SPY") (asset "QQQ")])]))';
    const linkStrategyText =
      '(defsymphony "B" {} (weight-equal [(asset "SPY" "S&P 500 ETF") (asset "QQQ" "Nasdaq 100 ETF")]))';

    expect(compareComposerStrategySemantics({ dbStrategyText, linkStrategyText })).toBe(true);
  });

  it('ignores defsymphony name and group labels for equivalence', () => {
    const dbStrategyText =
      '(defsymphony "Alpha" {} (weight-equal [(group "Group A" [(asset "SPY")])]))';
    const linkStrategyText =
      '(defsymphony "Beta" {} (weight-equal [(group "Group B" [(asset "SPY" "S&P 500 ETF")])]))';

    expect(compareComposerStrategySemantics({ dbStrategyText, linkStrategyText })).toBe(true);
  });

  it('returns false when strategy logic differs', () => {
    const dbStrategyText = '(defsymphony "A" {} (weight-equal [(asset "SPY")]))';
    const linkStrategyText = '(defsymphony "A" {} (weight-equal [(asset "QQQ")]))';

    expect(compareComposerStrategySemantics({ dbStrategyText, linkStrategyText })).toBe(false);
  });

  it('treats keyword cadence values as equivalent to strings', () => {
    const dbStrategyText = '(defsymphony "A" {:rebalance-frequency :daily} (asset "SPY"))';
    const linkStrategyText = '(defsymphony "B" {:rebalance-frequency "daily"} (asset "SPY"))';

    expect(compareComposerStrategySemantics({ dbStrategyText, linkStrategyText })).toBe(true);
  });

  it('returns null when inputs are missing', () => {
    expect(
      compareComposerStrategySemantics({
        dbStrategyText: '',
        linkStrategyText: '(defsymphony "A" {} (asset "SPY"))',
      })
    ).toBe(null);
  });
});
