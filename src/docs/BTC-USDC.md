## BTC/USDC LP strategy

### Objective
Achieve at least 15% higher annual alpha than passive BTC while maintaining minimal BTC delta.

### Implementation

• Supply liquidity to the WBTC / USDC pool on Uniswap V3 (Ethereum) with a 10% price range.

• Short BTC perpetual on Hyperliquid equal to 50% of LP position notional value to hedge initial BTC exposure.

• Monitor 8-hour funding rates on BTC/USD perpetual; adjust position size when funding exceeds 0.1% per 8h period.

• Rebalance perpetual hedge when LP pair shifts >5% from 50/50 allocation due to price movement.

• Scale short position dynamically: increase short exposure as price approaches upper range, decrease as price approaches lower range.

### Key Performance Indicators (KPIs)

• Weekly fee yield ≥ 0.30 % of LP notional.

• Net BTC delta maintained between -5% and +5% of position value.

• Time-in-range ≥ 85% to maximize fee generation

• Total strategy return (LP fees minus funding costs minus gas) ≥ 15% annually.