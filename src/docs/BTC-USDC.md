## BTC/USDC LP strategy

### Objective
Achieve at least 15% higher annual alpha than passive BTC while maintaining minimal BTC delta.

### Implementation

• Supply liquidity to the WBTC / USDC pool on Uniswap V3 (Ethereum) with a 10% price range.

• Short BTC perpetual on Hyperliquid equal to 50% of LP position notional value to hedge initial BTC exposure.

• Monitor 8-hour funding rates on BTC/USD perpetual; adjust position size when funding exceeds 0.1% per 8h period.

• Rebalance perpetual hedge when LP pair shifts >5% from 50/50 allocation due to price movement.

• Scale short position dynamically: increase short exposure as price approaches upper range, decrease as price approaches lower range.

### Risk Controls
• Maintain perpetual margin usage below 75%; liquidation buffer at 85%.

• Exit LP position if price moves outside range for >24 hours to avoid single-asset concentration.

• Close hedge positions if cumulative funding payments exceed 20% of weekly LP fees for 3 consecutive day.

• Monitor Ethereum gas costs; pause rebalancing if Ethereum gas fees exceed $20 per transaction.

### Key Performance Indicators (KPIs)

• Weekly fee yield ≥ 0.30 % of LP notional.

• Net BTC delta maintained between -5% and +5% of position value.

• Time-in-range ≥ 85% to maximize fee generation

• Total strategy return (LP fees minus funding costs minus gas) ≥ 15% annually.

### Implementation details
To maintain BTC neutrality in a BTC/USDC liquidity pool strategy while using Hyperliquid perpetual shorts, the hedge position must dynamically adjust based on the LP's current composition. Here's the calculation methodology:
```
Short Position Size = (BTC_Value_in_LP / Total_LP_Value − 0.5) × LP_Notional_Value × 2
 ```

Where:
- BTC Value in LP = Current BTC holdings in pool × BTC price
- Total LP Value = BTC Value + USDC in pool
- LP Notional Value = Total value of both assets in the position

Example Calculation:
If LP contains $55,000 BTC and $45,000 USDC (55% BTC allocation):
```
Short Size = (0.55 - 0.5) × $100,000 × 2 = $10,000 (10% of LP value)
```

Implementation Steps:
1. Monitor LP Composition
Track real-time:
- BTC price
- BTC quantity in LP
- USDC quantity in LP

2. Calculate Delta Exposure
```
BTC Exposure Ratio = BTC Value / (BTC Value + USDC)
```

3. Determine Hedge Adjustment

BTC Allocation	Action	New Short %
>55%	Increase short	(Allocation% - 50%) × 2
<45%	Decrease short	(50% - Allocation%) × 2
45-55%	Maintain	No change

4. Execute Hedge:
- Use Hyperliquid's perpetual futures market 
- Set order size to calculated short percentage
- Cross-margin mode recommended for efficiency

Key Considerations:
- Rebalancing triggers when allocation drifts >5% from target 
- Maintain 75% margin buffer on Hyperliquid 
- Factor in funding rates >0.1%/8h when holding positions 
- Gas costs >$20/transaction warrant delayed rebalancing

This methodology keeps net BTC delta within ±5% while preserving fee-generating capacity in the LP position.

The multiplicative factor of 2 in the formula accounts for the concentrated liquidity characteristics of Uniswap V3 positions.