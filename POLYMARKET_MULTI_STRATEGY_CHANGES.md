# Polymarket Multi-Strategy Account Tracking - Changes

## Problem
Multiple Polymarket strategies can share the same Polymarket wallet address, but each strategy only tracked its own positions. This meant:
- Each strategy showed only its own equity ($96.19 for one strategy)
- Polymarket account showed total portfolio ($186.73 across all positions)
- No way to see account-level totals or understand the full picture
- P/L calculations were missing for Polymarket strategies

## Solution Implemented

### 1. Added P/L Calculation to Polymarket Service
**File**: `server/services/polymarketCopyService.js` (around line 3272)

Added calculation of:
- `portfolio.pnlValue` - Total profit/loss in dollars
- `portfolio.pnlPercent` - Total profit/loss as percentage
- `portfolio.initialInvestment` - Auto-set from cost basis if not already set

This now matches the P/L calculation logic used by Alpaca/Composer strategies.

### 2. Created Account-Level Aggregation
**File**: `server/controllers/strategiesController.js` (around line 4380)

Added logic to:
- Group all Polymarket strategies by their wallet address
- Calculate aggregated metrics:
  - Total holdings value across all strategies
  - Total cash buffer
  - Total equity (holdings + cash)
  - Total initial investment
  - Total P/L (value and percentage)
- Attach aggregation data to each portfolio response

### 3. Updated Dashboard UI
**File**: `client/src/components/Dashboard/Portfolios.jsx`

Added display of:
- Individual strategy metrics (existing)
- **NEW**: Account-level totals section showing:
  - Total Holdings across all strategies
  - Total Cash
  - Total Equity
  - Total Initial Investment
  - Account-level P/L (with percentage)
  - Number of strategies using this account

Visual improvements:
- Clear separator (divider) between strategy and account totals
- Distinct color coding (blue) for account totals
- Icon (📊) to make account totals stand out
- Helpful caption explaining the individual strategy section

## What You'll See Now

### Before
```
Elon Musk's Little Friend for Real
Initial investment: $76 · Holdings value: $20.19 · Equity: $96.19 · P/L: ▲ $20.19 (26.57%)
```

### After
```
Elon Musk's Little Friend for Real

This strategy's holdings (see account total below):
Initial investment: $76 · Holdings value: $20.19 · Equity: $96.19 · P/L: ▲ $20.19 (26.57%)

─────────────────────────────────────
📊 Account Total (all strategies on this address):
Total Holdings: $XX.XX · Total Cash: $XX.XX · Total Equity: $186.73
Total Initial Investment: $XXX.XX · Account P/L: ▲ $XX.XX (X.XX%)
Strategies on this account: 3
```

## How to Test

1. **Restart the server**:
   ```bash
   cd server
   npm start
   ```

2. **Restart the client** (if needed):
   ```bash
   cd client
   npm start
   ```

3. **View your dashboard**:
   - Go to your dashboard where Polymarket strategies are listed
   - Expand any Polymarket strategy
   - You should now see BOTH:
     - Individual strategy metrics
     - Account total metrics (if multiple strategies share the same address)

4. **Verify the numbers**:
   - The "Total Equity" in the account totals should match your Polymarket dashboard
   - Individual strategy equity + other strategies' equity = Total Equity

## API Response Changes

The `/api/strategies/portfolios/:userId` endpoint now returns:

```json
{
  "status": "success",
  "portfolios": [
    {
      "provider": "polymarket",
      "name": "Strategy Name",
      "currentValue": 20.19,
      "cashBuffer": 76,
      "pnlValue": 20.19,
      "pnlPercent": 26.57,
      "polymarketAccountTotals": {
        "address": "0x...",
        "strategies": ["strategy_id_1", "strategy_id_2", "strategy_id_3"],
        "totalHoldingsValue": 120.50,
        "totalCashBuffer": 66.23,
        "totalEquity": 186.73,
        "totalInitialInvestment": 150.00,
        "totalPnlValue": 36.73,
        "totalPnlPercent": 24.49
      }
    }
  ],
  "polymarketAggregation": [
    {
      "address": "0x...",
      "strategies": ["strategy_id_1", "strategy_id_2", "strategy_id_3"],
      "totalEquity": 186.73,
      ...
    }
  ]
}
```

## Files Modified

1. `/server/services/polymarketCopyService.js` - Added P/L calculation
2. `/server/controllers/strategiesController.js` - Added aggregation logic
3. `/client/src/components/Dashboard/Portfolios.jsx` - Updated UI display

## Notes

- The aggregation groups strategies by Polymarket wallet address (case-insensitive)
- Only Polymarket strategies are aggregated; Alpaca/Composer strategies are unchanged
- Each strategy still maintains its own positions and tracking
- The account totals are calculated on-the-fly when fetching portfolios
- P/L calculations now include both unrealized gains from holdings
