## BTC/USDC LP strategy

### Objective
Achieve at least 15% higher annual alpha than passive BTC while maintaining minimal BTC delta.

### Implementation

• Supply liquidity to the WBTC / USDC pool on Uniswap V3 (Ethereum) with a 10% price range.

• Short BTC perpetual on Hyperliquid equal to 50% of LP position notional value to hedge initial BTC exposure.

• Monitor 8-hour funding rates on BTC/USD perpetual; adjust position size when funding exceeds 0.1% per 8h period.

• Rebalance perpetual hedge when LP pair shifts >5% from 50/50 allocation due to price movement.

• Scale short position dynamically: increase short exposure as price approaches upper range, decrease as price approaches lower range.

#### When BTC Price Increases (and BTC quantity in LP decreases)

The strategy incrementally reduces the short BTC hedge as the BTC quantity in the LP declines.

Trigger for Reduction: The hedge is reduced based on a predefined decrease in BTC quantity in the LP. For example: "For every 10% reduction in BTC quantity in the LP (relative to the initial 1 BTC), reduce the short hedge by 0.1 BTC."

Example Steps:
- Initial: LP holds 1 BTC; Hedge is short 1 BTC.
- BTC in LP drops to 0.9 BTC (as LP sells BTC for USDC due to price increase): Reduce hedge to short 0.9 BTC.
- BTC in LP drops to 0.8 BTC: Reduce hedge to short 0.8 BTC.
- And so forth.

#### When BTC Price Decreases After a Hedge Reduction (and BTC quantity in LP increases):

If the BTC price declines within the active LP range after a hedge reduction, the strategy incrementally increases the short hedge proportionally.

Trigger for Increase: The same thresholds used for reduction are applied in reverse.

Example Steps:
- Current: Hedge is short 0.8 BTC (corresponding to 0.8 BTC in LP).
- BTC price decreases, and BTC quantity in LP rises to 0.9 BTC: Increase hedge to short 0.9 BTC.
- BTC quantity in LP returns to 1 BTC (e.g., price reverts to the initial entry point within the range): Increase hedge to short 1 BTC.

The maximum hedge size will not exceed the initial full hedge (e.g., short 1 BTC).

### Key Performance Indicators (KPIs)

• Weekly fee yield ≥ 0.30 % of LP notional.

• Net BTC delta maintained between -5% and +5% of position value.

• Time-in-range ≥ 85% to maximize fee generation

• Total strategy return (LP fees minus funding costs minus gas) ≥ 15% annually.