## Uniform output table format for backtesting

| Date                 | BTC Price | Total Portfolio Value | Profit/Loss ($) | Return (%) | Net Gain vs. Hold ($) | Capital Used in Trading | Total Capital Locked | LP Fees Earned | Trading Fees Paid | Gas Fees Paid | Max Drawdown | Max Gain | Impermanent Loss (%) | Hedge Position | Rebalancing Actions | Notes |
|----------------------|-----------|-----------------------|-----------------|------------|-----------------------|-------------------------|----------------------|----------------|-------------------|---------------|--------------|----------|----------------------|----------------|---------------------|-------|
| Day 0 (2024-07-01)   | $XX,XXX   | $219,000              | $0              | 0.00%      | $0                    | $219,000                | $219,000             | $0             | $0                | $0            | 0%           | 0%       | 0.00%                | 0%             | 0                   | Start |
| Day 7 (2024-07-08)   | $XX,XXX   | $XXX,XXX              | $X,XXX          | X.XX%      | $X,XXX                | $XXX,XXX                | $XXX,XXX             | $X,XXX         | $XX               | $X            | X%           | X%       | X.XX%                | XX%            | X                   |       |
| ...                  | ...       | ...                   | ...             | ...        | ...                   | ...                     | ...                  | ...            | ...               | ...           | ...          | ...      | ...                  | ...            | ...                 |       |
| Day 365 (2025-07-01) | $YY,YYY   | $ZZZ,ZZZ              | $YY,YYY         | YY.YY%     | $YY,YYY               | $ZZZ,ZZZ                | $ZZZ,ZZZ             | $YY,YYY        | $YY               | $Y            | Y%           | Y%       | Y.YY%                | YY%            | Y                   | End   |

### Column Definitions & Interpretation

- BTC Price: Market price of BTC at the increment.
- Total Portfolio Value: Combined value of all assets (BTC, USDC, LP position, hedge PnL). 
- Profit/Loss ($): Cumulative profit or loss since inception. 
- Return (%): Cumulative return as a percentage of starting capital. 
- Net Gain vs. Hold ($): Difference in profit/loss compared to simply holding 1 BTC + $110k USDC. 
- Capital Used in Trading: Actual capital actively deployed (including margin/collateral for hedges). 
- Total Capital Locked: All capital locked in LP, hedge collateral, and buffers. 
- LP Fees Earned: Total fees earned from providing liquidity. 
- Trading Fees Paid: Total trading fees paid for rebalancing and hedging. 
- Gas Fees Paid: Total transaction (gas) fees paid on-chain (in USD). 
- Max Drawdown: Largest observed peak-to-trough loss during the period. 
- Max Gain: Largest observed gain relative to starting value. 
- Impermanent Loss (%): Cumulative impermanent loss as percent of capital. 
- Hedge Position: Current hedge exposure as a percentage of BTC position. 
- Rebalancing Actions: Number of rebalancing events taken in the period. 
- Notes: Any relevant qualitative notes (e.g., major market events, strategy adjustments).

### How to Interpret These Metrics
- Profit/Loss ($) and Return (%) show absolute and relative performance over time. 
- Net Gain vs. Hold ($) directly quantifies the strategy’s value-add versus passive holding. 
- Capital Used in Trading and Total Capital Locked help assess capital efficiency and risk exposure. 
- LP Fees Earned, Trading Fees Paid, and Gas Fees Paid break down sources of income and costs. 
- Max Drawdown and Max Gain are risk metrics: lower drawdown and higher max gain indicate better risk-adjusted performance. 
- Impermanent Loss (%) reveals the impact of price divergence on LP returns. 
- Hedge Position tracks risk management effectiveness. 
- Rebalancing Actions and Notes provide operational context and explain sudden changes in other metrics.
