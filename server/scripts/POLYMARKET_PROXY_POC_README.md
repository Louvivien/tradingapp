# Polymarket Proxy Trade POC

## Overview

This POC (Proof of Concept) demonstrates the ability to:
1. **Fetch proxies** from multiple public proxy list URLs
2. **Test proxies** to find working ones that can access Polymarket
3. **Connect to Polymarket** through a working proxy
4. **Execute a test trade** through the proxy

## What This POC Does

The script performs the following steps:

### Step 1: Check Current IP Status
- Checks if your current IP is geoblocked by Polymarket
- Shows your country and block status

### Step 2: Fetch Proxies
- Fetches proxy lists from 4 default sources:
  - `https://raw.githubusercontent.com/TheSpeedX/PROXY-List/refs/heads/master/http.txt`
  - `https://raw.githubusercontent.com/proxifly/free-proxy-list/refs/heads/main/proxies/protocols/http/data.txt`
  - `https://raw.githubusercontent.com/monosans/proxy-list/refs/heads/main/proxies/http.txt`
  - `https://raw.githubusercontent.com/jetkai/proxy-list/refs/heads/main/online-proxies/txt/proxies-https.txt`
- Deduplicates and aggregates proxies from all sources

### Step 3: Test Proxies
- Tests each proxy concurrently (20 at a time by default)
- For each proxy:
  - Tests basic connectivity via Cloudflare
  - Detects the proxy's exit country and IP
  - Filters out geoblocked countries (US, CA, GB, etc.)
  - Tests Polymarket CLOB API connectivity
  - Measures latency
- Stops after finding 10 good proxies (configurable)
- Sorts proxies by latency (fastest first)

### Step 4: Prepare Trade
- Fetches market information from Polymarket Gamma API
- Resolves market slug/ID to token ID
- Validates trade parameters (side, amount, price)

### Step 5: Execute Trade
- Uses the best (fastest) working proxy
- Executes a test trade through the proxy
- Supports both paper (dry-run) and live modes

## Usage

### Basic Usage (No Trade)

Just test proxy connectivity:

```bash
cd tradingapp/server
node scripts/polymarket_proxy_trade_poc.js
```

This will:
- Fetch and test proxies
- Show working proxies
- Exit without attempting a trade

### Test a Trade (Paper Mode)

Test a trade without actually submitting it:

```bash
node scripts/polymarket_proxy_trade_poc.js \
  --slug will-btc-be-above-100k-on-jan-1-2026 \
  --outcome Yes \
  --side buy \
  --amount 1
```

This will:
- Find working proxies
- Prepare the trade order
- Build the order payload
- NOT submit the order (paper mode)

### Execute a Live Trade

⚠️ **WARNING: This will submit a real trade!**

```bash
node scripts/polymarket_proxy_trade_poc.js \
  --slug will-btc-be-above-100k-on-jan-1-2026 \
  --outcome Yes \
  --side buy \
  --amount 1 \
  --confirm
```

Requirements for live trading:
- `POLYMARKET_PRIVATE_KEY` set in `.env`
- `POLYMARKET_API_KEY`, `POLYMARKET_SECRET`, `POLYMARKET_PASSPHRASE`, `POLYMARKET_AUTH_ADDRESS` set in `.env`
- Sufficient USDC balance and allowance on-chain

## Command Line Options

| Option | Description | Default |
|--------|-------------|---------|
| `--proxy-urls "<url1>,<url2>,..."` | Custom proxy list URLs (comma-separated) | Uses 4 default sources |
| `--slug <market-slug>` | Market slug to trade | None (required for trade) |
| `--market-id <id>` | Market ID (alternative to slug) | None |
| `--outcome <Yes\|No>` | Outcome to trade | First outcome |
| `--side <buy\|sell>` | Trade side | `buy` |
| `--amount <N>` | Amount (USDC for buy, shares for sell) | `1` |
| `--price <0.xx>` | Limit price (0 < price < 1) | Market order |
| `--confirm` | Execute live trade | `false` (paper mode) |
| `--max-tests <N>` | Max proxies to test | `500` |
| `--max-good <N>` | Stop after finding N good proxies | `10` |
| `--skip-proxy-fetch` | Skip fetching, use existing proxy pool | `false` |
| `--help` | Show help | |

## Environment Variables

### Required for Live Trading

```bash
# Wallet private key (for signing orders)
POLYMARKET_PRIVATE_KEY=0x...

# CLOB L2 API credentials (generate with polymarket_create_or_derive_api_key.js)
POLYMARKET_API_KEY=...
POLYMARKET_SECRET=...
POLYMARKET_PASSPHRASE=...
POLYMARKET_AUTH_ADDRESS=0x...
```

### Optional

```bash
# Proxy configuration (will be overridden by POC)
POLYMARKET_CLOB_PROXY=http://proxy.example.com:8080

# For Magic/email wallets
POLYMARKET_FUNDER_ADDRESS=0x...
POLYMARKET_SIGNATURE_TYPE=1

# Chain settings
POLYMARKET_CHAIN_ID=137  # Polygon mainnet
```

## Example Output

```
╔══════════════════════════════════════════════════════════════╗
║          Polymarket Proxy Trade POC                          ║
╚══════════════════════════════════════════════════════════════╝

[Step 1] Checking current IP geoblock status...
  Current IP: BLOCKED (country: US)

[Step 2] Fetching proxies from sources...
  Fetching from 4 source(s)...
  - https://raw.githubusercontent.com/TheSpeedX/PROXY-List/refs/heads/master/http.txt
    Fetched 342 proxies
  - https://raw.githubusercontent.com/proxifly/free-proxy-list/refs/heads/main/proxies/protocols/http/data.txt
    Fetched 156 proxies
  - https://raw.githubusercontent.com/monosans/proxy-list/refs/heads/main/proxies/http.txt
    Fetched 289 proxies
  - https://raw.githubusercontent.com/jetkai/proxy-list/refs/heads/main/online-proxies/txt/proxies-https.txt
    Fetched 412 proxies
  Total unique proxies: 891

[Step 3] Testing proxies...
Testing 500 proxies (concurrency: 20, max good: 10)...
  ✓ 103.152.112.162:80 [ID] 1245ms
  ✓ 185.217.136.67:1337 [NL] 1567ms
  ✓ 51.159.115.233:3128 [FR] 1892ms
  ...
Reached max good proxies (10), stopping tests.
Testing complete: 10 good, 87 failed, 97 tested

[Step 4] Preparing trade parameters...
  Market: Will BTC be above $100k on Jan 1, 2026?
  Outcome: Yes
  Token ID: 1234567890
  Side: BUY
  Amount: 1 USDC
  Mode: PAPER (dry-run)

[Step 5] Testing trade execution through proxy...

=== Executing Test Trade ===
Using proxy: 103.152.112.162:80 [ID]
Execution service config:
  - L2 creds present: true
  - Auth matches private key: true
  - Proxy configured: true
  - Proxy: 103.152.112.162:80
✓ Trade built successfully (dry-run mode, not submitted)

╔══════════════════════════════════════════════════════════════╗
║                    POC Complete!                             ║
╚══════════════════════════════════════════════════════════════╝

Summary:
  ✓ Working proxies found: 10
  ✓ Best proxy: 103.152.112.162:80 [ID] (1245ms)
  ✓ Trade execution: SUCCESS
    (Dry-run mode - no actual order submitted)

Next steps:
  - To execute a live trade, add --confirm flag
  - Configure POLYMARKET_PRIVATE_KEY and L2 creds in .env for live trading
```

## How It Works

### Proxy Testing

The POC tests each proxy by:

1. **Cloudflare Test**: Makes a request to `https://www.cloudflare.com/cdn-cgi/trace`
   - Verifies basic connectivity
   - Extracts exit country and IP from response
   - Filters out geoblocked countries

2. **CLOB Test**: Makes a request to `https://clob.polymarket.com/time`
   - Verifies Polymarket API is accessible
   - Confirms the proxy can reach Polymarket infrastructure

3. **Latency Measurement**: Tracks total time for both tests

### Trade Execution

The POC uses the existing `polymarketExecutionService` with:
- `POLYMARKET_CLOB_PROXY` env var set to the selected proxy
- `POLYMARKET_EXECUTION_MODE` set to `paper` (default) or `live` (with `--confirm`)

The execution service handles:
- CLOB L2 authentication
- Order building and signing
- Order submission (if live mode)

## Security Considerations

⚠️ **IMPORTANT**: Public proxies are untrusted!

- **DO NOT** use random public proxies for live trading with real funds
- **DO NOT** send sensitive credentials through untrusted proxies
- This POC is for **testing and demonstration only**

For production use:
- Use trusted, paid proxy services
- Consider residential proxies or VPN services
- Implement proxy rotation and health monitoring
- Use dedicated proxies per trading session

## Troubleshooting

### No working proxies found

- Public proxy lists can have high failure rates (80-90%)
- Try increasing `--max-tests` (e.g., `--max-tests 1000`)
- Try different proxy sources with `--proxy-urls`
- Public proxies change frequently; some lists may be stale

### Proxy works but trade fails

- Check your `.env` configuration
- Verify L2 credentials are valid: `node scripts/polymarket_account_check.js`
- Ensure sufficient USDC balance and allowance
- Check trade parameters (amount, price, market ID)

### Geoblock errors

- The proxy's exit country may be blocked by Polymarket
- The POC filters known blocked countries, but Polymarket's list may change
- Try more proxies or different sources

### Rate limiting

- Polymarket may rate-limit proxy IPs
- Use fewer concurrent tests: `--max-tests 100 --concurrency 10`
- Wait between test runs

## Next Steps

After running the POC successfully:

1. **Configure production proxies**: Replace public proxies with trusted services
2. **Set up monitoring**: Track proxy health and failover
3. **Implement rotation**: Rotate proxies per request or session
4. **Add error handling**: Handle proxy failures gracefully
5. **Test with real trades**: Start with small amounts in live mode

## Related Scripts

- [polymarket_test_trade.js](polymarket_test_trade.js) - Test trade execution (no proxy fetching)
- [polymarket_proxy_pool_refresh.js](polymarket_proxy_pool_refresh.js) - Refresh proxy pool cache
- [polymarket_account_check.js](polymarket_account_check.js) - Verify account credentials
- [polymarket_create_or_derive_api_key.js](polymarket_create_or_derive_api_key.js) - Generate L2 API keys

## License

MIT - See [LICENSE](../../LICENSE) for details
