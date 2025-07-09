## Uniform output table format for backtesting

| timestamp  | asset_composition | asset_amounts | total_portfolio_value | pnl    | return  | net_gain_vs_hold | capital_used_in_trading | total_capital_locked | lp_fees_earned | trading_fees_paid | gas_fees_paid | max_drawdown | max_gain | impermanent_loss | asset_exposure | rebalancing_actions | notes |
|------------|-------------------|---------------|-----------------------|--------|---------|------------------|-------------------------|----------------------|----------------|-------------------|---------------|--------------|----------|------------------|----------------|---------------------|-------|
| 1752071317 | BTC,USDC          | 1.0,110000    | $0                    | 0.00%  | $0      | $219,000         | $219,000                | $0                   | $0             | $0                | 0%            | 0%           | 0.00%    | 0%               | 1,1            | Start               |       |
| 1752071317 | BTC,USDC          | 1.0,110000    | $X,XXX                | X.XX%  | $X,XXX  | $XXX,XXX         | $XXX,XXX                | $X,XXX               | $XX            | $X                | X%            | X%           | X.XX%    | XX%              | X,X            |                     |       |
| ...        | ...               | ...           | ...                   | ...    | ...     | ...              | ...                     | ...                  | ...            | ...               | ...           | ...          | ...      | ...              | ...            |                     |       |
| 1752071317 | BTC,USDC          | 1.0,110000    | $YY,YYY               | YY.YY% | $YY,YYY | $ZZZ,ZZZ         | $ZZZ,ZZZ                | $YY,YYY              | $YY            | $Y                | Y%            | Y%           | Y.YY%    | YY%              | Y,Y            | End                 |       |

### Column Definitions & Interpretation

- BTC Price: Market price of BTC at the increment.
- Total Portfolio Value: Combined value of all assets (BTC, USDC, LP position, hedge PnL). 
- Profit/Loss ($): Cumulative profit or loss since inception. 
- Return (%): Cumulative return as a percentage of starting capital. 
- Net Gain vs. Hold ($): total profit or loss of providing liquidity compared to holding the assets. It includes trading fees, rewards, and impermanent loss (IL).
- Capital Used in Trading: Actual capital actively deployed (including margin/collateral for hedges). 
- Total Capital Locked: All capital locked in LP, hedge collateral, and buffers. 
- LP Fees Earned: Total fees earned from providing liquidity. 
- Trading Fees Paid: Total trading fees paid for rebalancing and hedging. 
- Gas Fees Paid: Total transaction (gas) fees paid on-chain (in USD). 
- Max Drawdown: Largest observed peak-to-trough loss during the period. 
- Max Gain: Largest observed gain relative to starting value. 
- Impermanent Loss (%): Cumulative impermanent loss as percent of capital. 
- Asset Exposure: Current hedge exposure as a percentage of the position. 
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
