# Compare Composer Holdings vs TradingApp (DB-driven)

This tool loads strategies that have a `symphonyUrl` stored in MongoDB, fetches the Composer page for each link, extracts the **current Composer holdings**, and compares them to TradingApp’s **local defsymphony evaluator** holdings.

## Run

From `tradingapp/server`:

```bash
npm run compare:composer-links-db -- --userId "<yourUserId>" --limit 50 --asOfMode previous-close --priceSource tiingo --dataAdjustment all
```

### Useful flags

- `--userId <id>`: limit to a user’s strategies
- `--strategyId <id>`: limit to one strategy id (`strategy_id`)
- `--limit <n>`: max strategies to check (default 200)
- `--allowNonComposer true`: include non-Composer `symphonyUrl` entries (default: skip them)
- `--tolerance <w>`: weight diff threshold (default `0.005`)
- `--asOfDate <YYYY-MM-DD>`: force evaluation date (otherwise uses Composer link “as-of” if found)
- `--strategyTextSource db|link`: evaluate using TradingApp’s stored `strategy.strategy` (default `db`) or use the link’s extracted defsymphony (`link`)
- `--skipDbPriceCache true`: bypass Mongo price-cache reads (forces network fetch + in-memory use)

## Output

Prints JSON with one entry per strategy:

- `composer.holdings`: `{symbol, weight}` from the Composer link (best-effort extraction)
- `tradingApp.holdings`: `{symbol, weight}` from local evaluator
- `comparison.mismatches`: per-symbol diffs above tolerance
