# AI Trading App

[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]



## About
Welcome to the AI Trading App!

It connects to Alpaca to read positions/orders and place trades.

Main features:
- Alpaca integration: paper/live support, positions, orders, market-clock awareness.
- Trading UI: search tickers, buy/sell, portfolio dashboard.
- Composer/defsymphony strategies: import strategies and evaluate them locally into target allocations.
- Automated rebalancing: scheduled portfolio rebalances with logs and cash/position reconciliation.
- Diagnostics: allocation diff/trace endpoint + one-shot rebalance trigger for fixing mismatched holdings.
- Data + analytics: price caching with multi-source fallback (Yahoo/Tiingo/Stooq/Alpaca), equity snapshots/history.
- Optional sentiment/news tooling (work in progress).

Credit for UI: [OktarianTB](https://github.com/OktarianTB/stock-trading-simulator)

## Stack
Backend: NodeJS with Python Scripts, AI: ChatGPT (collaborative strategy feature), Claude & Vertex (AI Fund feature)

Frontend: React,  Material 5

Data: MongoDB

Devops: Github, Vercel, Render, Google Cloud Build, Gitguardian

Product Management: Notion

Project Management: Jira

## Hackathons
Friday, May 26 2023 - 6:00 PM
Anthropic AI Hackathon
Build AI Apps with leading AI models!
[Submitted project](https://lablab.ai/event/anthropic-ai-hackathon/ai-traders/ai-trading-app)

Friday, July 7 2023 - 6:00 PM
Google Cloud Vertex AI Hackathon
Be the first to build an AI App on Google’s AI models!
[Submitted project](https://lablab.ai/event/google-vertex-ai-hackathon/ai-traders/ai-traders)


## Installation
Make sure you have NodeJS installed. You can check your Node.js version by running the command node -v in your terminal. If your version is older than 14.20.1, you will need to update Node.js. Please make sure that node -v gives you a version after 14.20.1 before doing anything else. 

Go to the server folder:
```sh
cd server
```

Then install the required packages for the server with:

```sh
npm install
```

Go to the client folder:
```sh
cd ..
```
```sh
cd client
```

Install the required packages for the client with:
```sh
npm install
```

Then you have to set up the .env files for the server and the client:
Go to the different services, create accounts and get the API keys

In `tradingapp/server/config/` you have an example file. Rename it `.env` and change the keys with yours.

In `tradingapp/client/` you have an example file. Rename it `.env` and change the keys with yours.

Check `REACT_APP_BASE_URL_DEV=http://localhost:3000` and make sure it matches your server port.

For deployments (Vercel frontend + Render backend), set `REACT_APP_BASE_URL_PROD` to your backend URL (ex: `https://your-service.onrender.com`), not the Vercel app URL.

Tip: after deploying the backend, visit `https://<backend>/api/health` to confirm MongoDB is connected and required env vars are present.

Please make sure you have created a .env in the server AND in the client or it will not work

To use Vertex you will need to create /tradingapp/server/config/googlecredentials.json with your google credentials

Then you can start the server and the client

Go to the client folder

And run the client with:
```sh
npm run start
```

Open another terminal window and then run the server with:

Go to the server folder

```sh
npm run start
```

Code explanation: [Video](https://www.loom.com/share/2411f7d34ea1491ab22c166957e107de) 

## Polymarket (Copy Trader)
The Polymarket “copy trader (paper)” strategy syncs trades for a given wallet address.

Server env vars (in `tradingapp/server/config/.env`):
- Trade source: `POLYMARKET_TRADES_SOURCE=auto|clob-l2|data-api` (default: `auto`, falls back to `data-api` if CLOB auth fails)
- CLOB L2 creds (only needed if forcing `clob-l2`): `POLYMARKET_API_KEY`, `POLYMARKET_SECRET`, `POLYMARKET_PASSPHRASE`, `POLYMARKET_AUTH_ADDRESS`
- Execution mode: `POLYMARKET_EXECUTION_MODE=paper|live` (default: `paper`)
  - Live trading requires: `POLYMARKET_PRIVATE_KEY` (signer), plus the CLOB L2 creds above.
  - Optional live settings: `POLYMARKET_CHAIN_ID=137|80002`, `POLYMARKET_SIGNATURE_TYPE=0|1`, `POLYMARKET_FUNDER_ADDRESS=0x...`, `POLYMARKET_MARKET_ORDER_TYPE=fak|fok`
  - Safety: live execution runs only for incremental syncs by default; to allow a one-time live rebalance after a backfill (to enter the copied positions), set `POLYMARKET_BACKFILL_LIVE_REBALANCE=true` (requires “Size trades to my budget”).
- Data API options (optional): `POLYMARKET_DATA_API_HOST`, `POLYMARKET_DATA_API_TAKER_ONLY`, `POLYMARKET_DATA_API_USER_AGENT`
- CLOB HTTP user agent (optional, helps with Cloudflare 403s): `POLYMARKET_CLOB_USER_AGENT` (default: `tradingapp/1.0`)
- CLOB HTTP proxy (optional, supports comma-separated lists; first entry used): `POLYMARKET_CLOB_PROXY` (fallbacks: `POLYMARKET_HTTP_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY`)
- CLOB auth retry cooldown in `auto` mode (optional, default 1h): `POLYMARKET_CLOB_AUTH_FAILURE_COOLDOWN_MS`

Smoke test:
```sh
cd tradingapp/server
node scripts/polymarket_smoke_test.js 0xYourWalletAddress
```

Debug endpoint (useful after deploying the backend):
- `GET /api/health/polymarket?maker=0xYourWalletAddress` (returns CLOB `/time`, `/auth/api-keys`, and `/data/trades` status + env credential fingerprints/lengths)
  - If `POLYMARKET_DEBUG_TOKEN` is set server-side, include header `x-debug-token: <token>`

Fix `401 Unauthorized/Invalid api key` (regenerate CLOB L2 creds):
```sh
cd tradingapp/server

# Option A: provide the wallet private key via env (recommended to run locally)
POLYMARKET_PRIVATE_KEY=0x... node scripts/polymarket_create_or_derive_api_key.js

# Option B: read the private key from a file (first non-empty line)
POLYMARKET_PRIVATE_KEY_FILE=/path/to/private_key.txt node scripts/polymarket_create_or_derive_api_key.js
```

Notes:
- The script writes `POLYMARKET_API_KEY`, `POLYMARKET_SECRET`, `POLYMARKET_PASSPHRASE`, `POLYMARKET_AUTH_ADDRESS` into `tradingapp/server/config/.env` (and creates a `*.bak.*` backup by default).
- It never prints full secrets to stdout (only status + lengths).

## Strategy Evaluation Parity (Composer/defsymphony)
The server evaluates defsymphony strategies locally. To keep results aligned with Composer, the defaults are:
- RSI: Wilder (`COMPOSER_RSI_METHOD=wilder`)
- Price adjustment: split (`COMPOSER_DATA_ADJUSTMENT=split`)
- As-of mode: previous close (`COMPOSER_ASOF_MODE=previous-close`)
- Price source: Yahoo with Tiingo fallback (`COMPOSER_PRICE_SOURCE=yahoo`)
- Price refresh: disabled by default (`COMPOSER_PRICE_REFRESH=false`) to avoid unexpected allocation changes
- Indicators are computed using the prior bar when `previous-close` is used (lookahead-safe, closer to Composer backtests)

If you override these settings (ex: `RSI_METHOD=simple` or `PRICE_DATA_SOURCE=alpaca`), the app will still work but allocations can differ from Composer; rebalance logs will include a warning.

### Debug endpoints
These endpoints are helpful when investigating mismatched holdings vs expected allocation:
- Diagnose allocation inputs/trace: `GET /api/strategies/diagnose/:userId/:strategyId`
- Trigger an immediate rebalance: `POST /api/strategies/rebalance-now/:userId/:strategyId`



## Deployment
The front is optimized to be deployed on Vercel. Don't forget to add env variables.

The back is optimized to be deployed on Render. Don't forget to add env variables.

## Usage

You can edit you API keys in Settings

To buy stocks you can go in Search, search for a stock and buy

You can sell from the dashboard clicking on stocks ticker

You can implement a collaborative strategy that you found online in Strategies, copy paste it and add a name for the strategy. It will buy the stocks. This create a strategy portfolio that will show up on the dashboard

Paper vs live trading depends on which Alpaca credentials are configured.

## How collaborative strategy evaluation works

See `tradingapp/docs/collaborative-strategies.md`.



## Roadmap
- Improve AI Fund signals (news quality, sentiment analysis).
- Add transaction cost displays (slippage/fees) for strategy evaluation.
- Add support for more brokers (ex: DeGiro) and crypto (via Alpaca).

## Links

Discord: [Discord](https://discord.gg/Neu7KBrhV3)

<!-- Badges -->
[contributors-shield]: https://img.shields.io/github/contributors/Louvivien/tradingapp.svg?style=for-the-badge
[contributors-url]: https://github.com/Louvivien/tradingapp/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/Louvivien/tradingapp.svg?style=for-the-badge
[forks-url]: https://github.com/Louvivien/tradingapp/network/members
[stars-shield]: https://img.shields.io/github/stars/Louvivien/tradingapp.svg?style=for-the-badge
[stars-url]: https://github.com/Louvivien/tradingapp/stargazers
[issues-shield]: https://img.shields.io/github/issues/Louvivien/tradingapp.svg?style=for-the-badge
[issues-url]: https://github.com/Louvivien/tradingapp/issues
[license-shield]: https://img.shields.io/github/license/Louvivien/tradingapp.svg?style=for-the-badge
[license-url]: https://github.com/Louvivien/tradingapp/blob/master/LICENSE.txt
[linkedin-shield]: https://img.shields.io/badge/-LinkedIn-black.svg?style=for-the-badge&logo=linkedin&colorB=555
[linkedin-url]: https://www.linkedin.com/in/vivienrichaud/
[nodejs-shield]: https://img.shields.io/badge/node.js-6DA55F?style=for-the-badge&logo=node.js&logoColor=white
[nodejs-url]: https://nodejs.org/
[react-shield]: https://img.shields.io/badge/React
