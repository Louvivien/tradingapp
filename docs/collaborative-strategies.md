# Collaborative Strategies (Composer / defsymphony)

This app can import and locally evaluate “collaborative strategies” written in Composer’s `defsymphony` DSL.

## What happens when you add a strategy

1. **Parse the strategy**
   - The server parses the `defsymphony` text into an AST (tree of nodes like `group`, `filter`, `if`, `asset`).

2. **Collect required tickers**
   - The evaluator walks the AST and extracts all referenced tickers (e.g. `SPY`, `TQQQ`, `BIL`).

3. **Load price history**
   - Prices are loaded from the local Alpaca cache (used for indicators + metrics).
   - If a ticker is missing from cache, it’s reported and may fall back to live pricing during order sizing (depending on your environment and configuration).

4. **Align history**
   - Price series are aligned to the same usable bar count (the evaluator trims to the shortest available series so all symbols share the same “time axis”).
   - Indicators that need long history (e.g. 200-day moving average) require enough bars after alignment.

5. **Evaluate the strategy**
   - `weight-equal` distributes weights across child nodes.
   - `if` selects a branch based on indicator conditions.
   - `filter` ranks a list of candidates with a metric and selects top/bottom items.

6. **Size to your budget**
   - Final weights are converted into share quantities using latest prices.
   - The app produces a “Decision Breakdown” log so you can see each step.

## Filters: assets vs groups

`filter` can rank:

- **Assets** (e.g. `(asset "HG")`)
  - Metrics like `cumulative-return`, `max-drawdown`, `stdev-return`, etc. are computed directly from that ticker’s price series.

- **Groups** (e.g. `(group "Paretos Signals Compilation" [...])`)
  - A group is treated like a “mini strategy”.
  - To compute metrics over a group, the evaluator simulates a synthetic **NAV series** by:
    - evaluating the group at each historical bar to get positions,
    - computing the portfolio return for that bar,
    - chaining returns to form a NAV curve.
  - This NAV series is then used as the series input to metrics like `cumulative-return` or `max-drawdown`.

### Lazy group-metric simulation (performance)

Group NAV simulation is the expensive part. The evaluator does it **on-demand**:

- Group NAV series are simulated only for groups that actually appear as *filter candidates* at runtime.
- The result is cached for the rest of the evaluation run so repeated ranking of the same group is fast.

## Common failure modes

- **Not enough data for an indicator/metric window**
  - Example: `Not enough data to compute cumulative return window 17.`
  - Fix: ensure enough history is available (and not trimmed away by a short-history ticker) or reduce the required window.

- **Missing price/indicator data for a symbol**
  - If a ticker can’t be loaded, filters that require that series may fail or that branch may become non-tradable.

## Where this logic lives

- Evaluator: `tradingapp/server/services/defsymphonyEvaluator.js`
- DSL parsing: `tradingapp/server/utils/composerDslParser.js`

