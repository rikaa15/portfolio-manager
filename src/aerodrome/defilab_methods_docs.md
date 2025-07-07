# Defilab Methods Documentation

## Overview

This document explains the mathematical implementation of Defilab's Uniswap V3 concentrated liquidity methods used in our Aerodrome backtesting system. These methods calculate optimal token allocation and liquidity units for concentrated positions.

## Key Methods

### 1. `tokensForStrategy` - Token Allocation Calculator

**Purpose:** Calculate the optimal token amounts (token0 and token1) needed to deploy a given USD investment into a concentrated liquidity position within a specific price range.

#### Uniswap V3 Math Background

In Uniswap V3, liquidity positions are defined by price ranges [priceLow, priceHigh]. The ratio of token0:token1 depends on where the current price sits within this range:

- **Price at center**: roughly 50/50 split
- **Price near upper bound**: mostly token1 (higher-value token)
- **Price near lower bound**: mostly token0 (lower-value token)  
- **Price outside range**: 100% of one token, 0% of the other

#### Why Square Root Prices?

Uniswap V3 uses square root prices internally for mathematical efficiency:
- Allows constant product formula (x * y = k) to work with concentrated liquidity
- sqrt(price) represents the "exchange rate" between tokens in Uniswap's internal math
- Enables efficient tick-based price calculations

#### Algorithm Logic

**Step 1: Convert prices to sqrt format with decimal adjustment**
```
sqrtPrice = sqrt(price * 10^decimal)
sqrtLow = sqrt(minRange * 10^decimal)  
sqrtHigh = sqrt(maxRange * 10^decimal)
```
The decimal adjustment accounts for different token decimal places (e.g., USDC=6, cbBTC=8).

**Step 2: Calculate based on price position**

**Case 1: Price within range (most common)**
```
delta = investment / (sqrtPrice - sqrtLow + (1/sqrtPrice - 1/sqrtHigh) * price * 10^decimal)
amount1 = delta * (sqrtPrice - sqrtLow)
amount0 = delta * (1/sqrtPrice - 1/sqrtHigh) * 10^decimal
```

**Case 2: Price below range**
```
delta = investment / ((1/sqrtLow - 1/sqrtHigh) * price)
amount1 = 0
amount0 = delta * (1/sqrtLow - 1/sqrtHigh)
```

**Case 3: Price above range**
```
delta = investment / (sqrtHigh - sqrtLow)
amount1 = delta * (sqrtHigh - sqrtLow)
amount0 = 0
```

---

### 2. `liquidityForStrategy` - Liquidity Units Calculator

**Purpose:** Calculate the amount of liquidity units that can be created with given token amounts within a specific price range. This is the **KEY METHOD** that determines fee earning power.

#### 🎯 Critical Insight - Concentration Effect

This method is **WHY concentrated positions earn more fees**:
- **SAME token amounts + NARROWER price range = MORE liquidity units**
- **MORE liquidity units = MORE fees** (fees = feeGrowth × liquidityAmount)

#### Concentration Examples (same $1000 investment)

| Range Width | Liquidity Units | Expected APR | Concentration Level |
|-------------|----------------|--------------|-------------------|
| 5% range   | 1,237,721,726  | ~31% APR     | High concentration |
| 10% range  | 622,348,943    | ~21% APR     | Medium concentration |
| 20% range  | ~311,174,471   | ~10% APR     | Low concentration |
| Full-range | 17,087,106     | ~0.05% APR   | No concentration |

#### Why Narrower Range = More Liquidity?

**Mathematical principle:** `Liquidity = tokens / price_range_factor`
- Smaller price range → smaller denominator → higher liquidity
- Think "liquidity density": same tokens spread over smaller area = higher density

#### Uniswap V3 Liquidity Math Background

- **Liquidity (L)** represents the amount of "virtual tokens" available for swapping
- **Higher liquidity** = more tokens available = lower slippage for swaps
- The relationship between token amounts and liquidity depends on the price range
- Liquidity is calculated differently based on where current price sits relative to the range

#### Why 2^96?

Uniswap V3 uses Q96 fixed-point arithmetic for precision:
- 2^96 is a scaling factor that allows fractional numbers to be represented as integers
- This prevents precision loss in smart contract calculations
- Enables high-precision calculations without floating point errors

#### Liquidity Formula Logic

**If price below range:**
```
L = Δx / ((1/√Pa - 1/√Pb) * 10^decimals0)
```

**If price above range:**
```
L = Δy / ((√Pb - √Pa) * 10^decimals1)
```

**If price in range:**
```
L = min(L_from_x, L_from_y)  // Use limiting factor
```

#### Algorithm Implementation

**Step 1: Calculate decimal adjustment**
```
decimal = token1Decimals - token0Decimals
```

**Step 2: Convert price bounds to Q96 format**
```
sLow = sqrt(low * 10^decimal) * 2^96
sHigh = sqrt(high * 10^decimal) * 2^96
sPrice = sqrt(price * 10^decimal) * 2^96
```

**Step 3: Calculate liquidity based on price position**

**Case 1: Price below range**
```
liquidity = tokens0 / ((2^96 * (sHigh - sLow)) / sHigh / sLow / 10^decimals0)
```

**Case 2: Price within range** 🔥 **CONCENTRATION MAGIC HAPPENS HERE**
```
liq0 = tokens0 / ((2^96 * (sHigh - sPrice)) / sHigh / sPrice / 10^decimals0)
liq1 = tokens1 / ((sPrice - sLow) / 2^96 / 10^decimals1)
liquidity = min(liq0, liq1)
```

**Key insight:** Smaller `(sHigh - sPrice)` and `(sPrice - sLow)` denominators = HIGHER liquidity!
- Narrower range (5%) → smaller denominators → LARGER liquidity units
- Wider range (20%) → larger denominators → smaller liquidity units
- Same tokens ÷ smaller range factor = MORE liquidity units = MORE fees!

**Case 3: Price above range**
```
liquidity = tokens1 / ((sHigh - sLow) / 2^96 / 10^decimals1)
```

---

### 3. `calcUnboundedFees` - Fee Growth Calculator

**Purpose:** Calculate the amount of fees earned per unit of liquidity over a specific time period using Uniswap's feeGrowthGlobal values.

#### Uniswap V3 Fee Mechanics Background

- Every swap generates trading fees (typically 0.05%, 0.30%, or 1.00%)
- Fees are accumulated globally and tracked per unit of liquidity
- `feeGrowthGlobal0X128` and `feeGrowthGlobal1X128` represent cumulative fees per liquidity unit
- To get fees for a period: `current_fee_growth - previous_fee_growth`

#### Why "Unbounded"?

"Unbounded" means we calculate total fees as if we had infinite range liquidity:
- Gives theoretical maximum fees that could be earned
- Individual positions earn a fraction based on their actual liquidity and range
- Think of it as "total pie size" before calculating our specific slice

#### Why X128 Format?

Uniswap uses Q128 fixed-point arithmetic for fee growth tracking:
- 2^128 is a massive scaling factor to maintain precision with tiny fee amounts
- Prevents precision loss when dealing with very small fee increments
- Example: 0.000001 fee becomes 340,282,366,920,938,463,463,374,607,431,768,211,456 in X128

#### Algorithm Implementation

**Step 1: Convert from X128 format to actual token units**
```
fg0_current = feeGrowthGlobal0 / 2^128 / 10^token0Decimals
fg0_previous = prevFeeGrowthGlobal0 / 2^128 / 10^token0Decimals
fg1_current = feeGrowthGlobal1 / 2^128 / 10^token1Decimals  
fg1_previous = prevFeeGrowthGlobal1 / 2^128 / 10^token1Decimals
```

**Step 2: Calculate fee growth delta**
```
fg0 = fg0_current - fg0_previous  // Token0 fees per liquidity unit
fg1 = fg1_current - fg1_previous  // Token1 fees per liquidity unit
```

**Step 3: Calculate actual fees**
```
feeToken0 = fg0 * liquidityAmount * activeLiquidityPercent / 100
feeToken1 = fg1 * liquidityAmount * activeLiquidityPercent / 100
```

---

### 4. `activeLiquidityForCandle` - Time in Range Calculator

**Purpose:** Calculate what percentage of a time period (day/hour) your position was actively earning fees.

#### Why This Matters

- You only earn fees when the market price is within your position range
- If BTC price moves from $100k to $120k, but your range is $105k-$110k, you only earn fees when price was between $105k-$110k
- This method calculates the overlap between day's price movement and your position range

#### Algorithm Logic

**Step 1: Get price range for the period**
```
dayLow = lowest price during the day
dayHigh = highest price during the day
```

**Step 2: Convert to ticks for precision**
```
dayLowTick = getTickFromPrice(dayLow)
dayHighTick = getTickFromPrice(dayHigh)
positionLowerTick = your position's lower bound
positionUpperTick = your position's upper bound
```

**Step 3: Calculate overlap**
```
totalDayRange = dayHighTick - dayLowTick
overlapRange = min(positionUpper, dayHigh) - max(positionLower, dayLow)
activeLiquidityPercent = (overlapRange / totalDayRange) * 100
```

#### Example Scenarios

**Scenario 1 - Perfect Overlap (100% active):**
```
Day's price range:     $102k ████████████ $108k
Your position range:   $100k ████████████████ $110k
Result: 100% active (all day's trading was in your range)
```

**Scenario 2 - Partial Overlap (50% active):**
```
Day's price range:     $105k ████████████ $115k  
Your position range:   $100k ████████████████ $110k
Overlap:               $105k ████████ $110k
Result: 50% active (half the day's range overlapped)
```

**Scenario 3 - No Overlap (0% active):**
```
Day's price range:     $90k ████████████ $95k
Your position range:   $100k ████████████████ $110k  
Result: 0% active (no overlap = no fees earned)
```

---

### 5. `getTickFromPrice` - Price to Tick Converter

**Purpose:** Convert a USD price (e.g., $105,000) to Uniswap's internal tick representation (e.g., -69637). Ticks are Uniswap V3's way of representing prices in a logarithmic scale.

#### Why Ticks Instead of Prices?

Uniswap V3 uses ticks for several key reasons:
- **Logarithmic scale**: Each tick represents a 0.01% price change (1.0001^tick = price_ratio)
- **Integer arithmetic**: Ticks are integers, avoiding floating-point precision issues
- **Efficient range calculations**: Easy to calculate price ranges using tick arithmetic
- **Gas optimization**: Integer operations are cheaper than decimal math in smart contracts

#### Tick Math Formula

```
tick = log(price_adjusted) / log(1.0001)
```

Where:
- `price_adjusted` = inverted price with decimal adjustment
- `1.0001` = Uniswap's base (each tick = 0.01% price change)
- `log` = natural logarithm

#### Algorithm Implementation

**Step 1: Invert price to match pool's token assignment**
```
invertedPrice = 1 / price
```

Our pool has token0=USDC, token1=cbBTC, but we treat price as "BTC price in USD". So we need USDC-per-cbBTC ratio, which is `1/price`.

**Step 2: Apply decimal adjustment for token precision**
```
adjustedPrice = invertedPrice * 10^(token0Decimals - token1Decimals)
```

Different tokens have different decimal places (USDC=6, cbBTC=8). This normalizes the price ratio for Uniswap's internal calculations.

**Step 3: Convert to tick using logarithmic formula**
```
tickRaw = log(adjustedPrice) / log(1.0001)
tick = round(tickRaw)
```

Uniswap uses base 1.0001 logarithms where each tick represents a 0.01% price change.

#### Example Calculation

For BTC price of $105,710:

1. **Invert price**: `1 / 105710 = 0.0000095`
2. **Decimal adjustment**: `0.0000095 * 10^(6-8) = 0.0000095 * 0.01 = 0.000000095`
3. **Calculate tick**: `log(0.000000095) / log(1.0001) = -69637`

#### Tick Spacing Alignment

Different pools have different tick spacing requirements:
- **Volatile pools**: Usually 200 tick spacing (2% ranges)
- **Stable pools**: Usually 10 tick spacing (0.1% ranges)  
- **Emerging tokens**: Usually 2000 tick spacing (20% ranges)

Position ranges must align to these spacing requirements:
```
alignedTick = floor(rawTick / tickSpacing) * tickSpacing
```

#### Price Range Calculations

Once you have ticks, calculating position ranges becomes simple:
```
currentTick = getTickFromPrice(currentPrice)
rangePercent = 0.10  // 10% position

// Calculate tick bounds
tickRange = rangePercent * currentTick  // Approximate
lowerTick = currentTick - tickRange/2
upperTick = currentTick + tickRange/2

// Align to tick spacing
lowerTickAligned = floor(lowerTick / tickSpacing) * tickSpacing
upperTickAligned = ceil(upperTick / tickSpacing) * tickSpacing
```

#### Converting Back to Prices

To convert ticks back to prices:
```
priceRatio = 1.0001^tick
adjustedPrice = priceRatio / 10^(token0Decimals - token1Decimals)  
price = 1 / adjustedPrice
```

#### Real-World Examples

| BTC Price | Inverted | Adjusted | Tick | Range (10%) |
|-----------|----------|----------|------|-------------|
| $100,000 | 0.00001 | 0.0000001 | -72,000 | -74,000 to -70,000 |
| $105,710 | 0.0000095 | 0.000000095 | -69,637 | -71,637 to -67,637 |
| $110,000 | 0.0000091 | 0.000000091 | -68,000 | -70,000 to -66,000 |

#### Precision Considerations

- **Tick rounding**: Always round to nearest integer
- **Tick spacing**: Must align to pool requirements
- **Price precision**: Small price changes can result in same tick
- **Range bounds**: Ensure upper tick > lower tick after alignment

---

## Implementation Notes

### Token Decimal Handling

Critical to get token decimals correct:
- **USDC**: 6 decimals (token0 in our pool)
- **cbBTC**: 8 decimals (token1 in our pool)
- **Decimal adjustment**: `token0Decimals - token1Decimals = 6 - 8 = -2`

### LP Share Scaling

**Important:** Do NOT scale fees by LP share percentage. The `feeGrowthGlobal` values already account for competition between liquidity providers. Additional scaling artificially reduces fees by ~100x.

### First Period Handling

Always return 0 fees for the first time period (day/hour) since you need at least 2 data points to calculate a fee growth delta.

---

## Mathematical Validation

### Concentration Multiplier Verification

For a 10% concentrated position vs full-range:
- **Concentrated liquidity**: ~622,348,944 units
- **Full-range liquidity**: ~17,087,106 units  
- **Concentration multiplier**: 36.42x
- **Expected APR boost**: 36x higher fees than full-range

### Realistic APR Expectations

| Position Type | Expected APR | Actual Results |
|---------------|--------------|----------------|
| Full-range    | ~0.05%       | ✅ Very low    |
| 20% concentrated | ~5-15%    | ✅ Medium      |
| 10% concentrated | ~15-50%   | ✅ 34% (realistic) |
| 5% concentrated  | ~30-100%  | ✅ High        |

---

## References

- [Uniswap V3 Math Primer](https://blog.uniswap.org/uniswap-v3-math-primer)
- [Uniswap V3 Math Primer Part 2](https://blog.uniswap.org/uniswap-v3-math-primer-2)
- [Defilab Uniswap V3 Backtest Repository](https://github.com/DefiLab-xyz/uniswap-v3-backtest)
- [Liquidity Math in Uniswap V3](https://atiselsts.github.io/pdfs/uniswap-v3-liquidity-math.pdf)