# Polymarket Proxy Trade POC - Quick Start

## TL;DR

Test proxy connectivity and prove a trade is possible through proxies:

```bash
cd tradingapp/server

# 1. Basic test (no trade, just proxy testing)
node scripts/polymarket_proxy_trade_poc.js

# 2. Test with a market (paper mode - no real trade)
node scripts/polymarket_proxy_trade_poc.js \
  --slug will-btc-be-above-100k-on-jan-1-2026 \
  --outcome Yes \
  --side buy \
  --amount 1

# 3. Live trade (requires credentials in .env)
node scripts/polymarket_proxy_trade_poc.js \
  --slug will-btc-be-above-100k-on-jan-1-2026 \
  --outcome Yes \
  --side buy \
  --amount 1 \
  --confirm
```

## What You Get

✅ **Proxy Fetching**: Automatically fetches proxies from 4 public sources
✅ **Proxy Testing**: Tests proxies for connectivity and Polymarket access
✅ **Country Filtering**: Filters out geoblocked countries (US, CA, GB, etc.)
✅ **Latency Sorting**: Ranks proxies by speed
✅ **Trade Execution**: Tests actual trade execution through best proxy
✅ **Paper Mode**: Safe testing without real trades
✅ **Live Mode**: Optional live trading with `--confirm`

## The 4 Proxy Sources

The POC uses these public proxy lists:

1. `https://raw.githubusercontent.com/TheSpeedX/PROXY-List/refs/heads/master/http.txt`
2. `https://raw.githubusercontent.com/proxifly/free-proxy-list/refs/heads/main/proxies/protocols/http/data.txt`
3. `https://raw.githubusercontent.com/monosans/proxy-list/refs/heads/main/proxies/http.txt`
4. `https://raw.githubusercontent.com/jetkai/proxy-list/refs/heads/main/online-proxies/txt/proxies-https.txt`

## Expected Results

When you run the POC, you should see:

```
╔══════════════════════════════════════════════════════════════╗
║          Polymarket Proxy Trade POC                          ║
╚══════════════════════════════════════════════════════════════╝

[Step 1] Checking current IP geoblock status...
  Current IP: BLOCKED (country: US)

[Step 2] Fetching proxies from sources...
  Total unique proxies: 891

[Step 3] Testing proxies...
  ✓ 103.152.112.162:80 [ID] 1245ms
  ✓ 185.217.136.67:1337 [NL] 1567ms
  ...
  Testing complete: 10 good, 87 failed, 97 tested

[Step 4] Preparing trade parameters...
  Market: Will BTC be above $100k on Jan 1, 2026?
  ...

[Step 5] Testing trade execution through proxy...
  ✓ Trade built successfully (dry-run mode, not submitted)

╔══════════════════════════════════════════════════════════════╗
║                    POC Complete!                             ║
╚══════════════════════════════════════════════════════════════╝

Summary:
  ✓ Working proxies found: 10
  ✓ Best proxy: 103.152.112.162:80 [ID] (1245ms)
  ✓ Trade execution: SUCCESS
```

## Common Options

| Use Case | Command |
|----------|---------|
| Just test proxies | `node scripts/polymarket_proxy_trade_poc.js` |
| Test with market (paper) | `node scripts/polymarket_proxy_trade_poc.js --slug <slug> --outcome Yes` |
| Live trade | Add `--confirm` flag |
| Custom proxy sources | `--proxy-urls "http://url1,http://url2"` |
| More proxies | `--max-tests 1000 --max-good 20` |
| Faster (fewer tests) | `--max-tests 100 --max-good 5` |

## Prerequisites for Live Trading

To execute live trades, you need in `tradingapp/server/config/.env`:

```bash
# Wallet private key
POLYMARKET_PRIVATE_KEY=0x...

# CLOB L2 API credentials
POLYMARKET_API_KEY=...
POLYMARKET_SECRET=...
POLYMARKET_PASSPHRASE=...
POLYMARKET_AUTH_ADDRESS=0x...
```

Generate L2 credentials:
```bash
POLYMARKET_PRIVATE_KEY=0x... node scripts/polymarket_create_or_derive_api_key.js
```

## Understanding the Output

### Proxy Testing
- `✓` = Proxy works and can access Polymarket
- Country code in brackets `[ID]` = Exit country
- Number at end = Latency in milliseconds
- Automatically filters blocked countries

### Trade Execution
- `dry-run mode, not submitted` = Paper mode (safe, no real trade)
- `submitted` = Live mode (real trade with `--confirm`)
- `Order ID: ...` = Successful trade submission

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No proxies found | Increase `--max-tests` or try different `--proxy-urls` |
| All proxies fail | Public proxies have high failure rates; try more sources |
| Trade fails | Check `.env` credentials and USDC balance |
| Geoblock errors | Proxy's country may be blocked; test more proxies |

## Security Warning

⚠️ **Public proxies are UNTRUSTED!**

- Use for testing/POC only
- Do NOT use with large amounts
- Do NOT send sensitive data through random proxies
- For production, use trusted paid proxy services

## Files Created

1. **[polymarket_proxy_trade_poc.js](polymarket_proxy_trade_poc.js)** - Main POC script
2. **[POLYMARKET_PROXY_POC_README.md](POLYMARKET_PROXY_POC_README.md)** - Full documentation
3. **[POLYMARKET_PROXY_POC_QUICKSTART.md](POLYMARKET_PROXY_POC_QUICKSTART.md)** - This quick start guide

## Next Steps

After successful POC:

1. ✅ Proxies work → Consider trusted proxy service
2. ✅ Trade works → Start with small amounts
3. ✅ Everything works → Implement in production with monitoring

## Need Help?

- Full docs: [POLYMARKET_PROXY_POC_README.md](POLYMARKET_PROXY_POC_README.md)
- Test connectivity: `node scripts/polymarket_smoke_test.js 0xYourAddress`
- Check credentials: `node scripts/polymarket_account_check.js`
- Get help: `node scripts/polymarket_proxy_trade_poc.js --help`
