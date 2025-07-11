import { PoolDayData, Position, PositionRange } from './types';

/**
 * Calculate tick range for different position types
 * Works with any tick spacing and percentage range
 */
export function getPositionTickRange(
  currentTick: number,
  positionType: string,
  tickSpacing: number = 2000,
): PositionRange {
  switch (positionType.toLowerCase()) {
    case 'full-range':
    case 'full':
      return {
        tickLower: -887272,
        tickUpper: 887272,
        rangeWidth: Infinity,
        priceLower: 0,
        priceUpper: Infinity,
      };

    case '10%':
      // 10% ≈ ±920 ticks, round to tick spacing
      const range10 = Math.floor(920 / tickSpacing) * tickSpacing;
      return {
        tickLower: currentTick - range10,
        tickUpper: currentTick + range10,
        rangeWidth: 0.1,
        priceLower: 0, // Will be calculated based on current price
        priceUpper: 0, // Will be calculated based on current price
      };

    case '20%':
      // 20% ≈ ±1840 ticks, round to tick spacing
      const range20 = Math.floor(1840 / tickSpacing) * tickSpacing;
      return {
        tickLower: currentTick - range20,
        tickUpper: currentTick + range20,
        rangeWidth: 0.2,
        priceLower: 0, // Will be calculated based on current price
        priceUpper: 0, // Will be calculated based on current price
      };

    case '30%':
      // 30% ≈ ±2760 ticks, round to tick spacing
      const range30 = Math.floor(2760 / tickSpacing) * tickSpacing;
      return {
        tickLower: currentTick - range30,
        tickUpper: currentTick + range30,
        rangeWidth: 0.3,
        priceLower: 0, // Will be calculated based on current price
        priceUpper: 0, // Will be calculated based on current price
      };

    default:
      throw new Error(`Unsupported position type: ${positionType}`);
  }
}

/**
 * Check if position is active (earning fees) at current tick
 */
export function isPositionActive(
  currentTick: number,
  positionRange: PositionRange,
): boolean {
  return (
    currentTick >= positionRange.tickLower &&
    currentTick < positionRange.tickUpper
  );
}

/**
 * Check if a position type is full-range based on rangeWidth
 */
export function isFullRange(positionRange: PositionRange): boolean {
  return (
    positionRange.rangeWidth === Infinity || positionRange.rangeWidth >= 100
  );
}

/**
 * Calculate active liquidity distribution at current tick
 * Updated to use actual schema with tickIdx
 */
export function calculateActiveLiquidityDistribution(
  allPositions: Position[],
  currentTick: number,
): {
  totalActiveLiquidity: number;
  fullRangeLiquidity: number;
  concentratedLiquidity: number;
} {
  let totalActiveLiquidity = 0;
  let fullRangeLiquidity = 0;
  let concentratedLiquidity = 0;

  for (const position of allPositions) {
    const tickLowerIdx = parseInt(position.tickLower.tickIdx);
    const tickUpperIdx = parseInt(position.tickUpper.tickIdx);

    // Check if position is active at current tick
    if (currentTick >= tickLowerIdx && currentTick < tickUpperIdx) {
      const liquidity = parseFloat(position.liquidity);
      totalActiveLiquidity += liquidity;

      // Classify position type based on range width
      const rangeWidth = tickUpperIdx - tickLowerIdx;
      if (rangeWidth > 500000) {
        // Very wide range = full range (based on your debug data)
        fullRangeLiquidity += liquidity;
      } else {
        concentratedLiquidity += liquidity;
      }
    }
  }

  return {
    totalActiveLiquidity,
    fullRangeLiquidity,
    concentratedLiquidity,
  };
}

/**
 * Calculate position fees for any range type using real market data
 */
export function calculatePositionFees(
  poolDayData: PoolDayData,
  positionType: string,
  allPositions: Position[],
  lpSharePercentage: number,
  tickSpacing: number = 2000,
): number {
  const currentTick = parseInt(poolDayData.tick);
  const positionRange = getPositionTickRange(
    currentTick,
    positionType,
    tickSpacing,
  );

  // Check if position is active
  if (!isPositionActive(currentTick, positionRange)) {
    return 0;
  }

  // For full-range: use the simple, proven approach
  if (isFullRange(positionRange)) {
    const liquidityDistribution = calculateActiveLiquidityDistribution(
      allPositions,
      currentTick,
    );
    const positionShare =
      liquidityDistribution.fullRangeLiquidity /
      liquidityDistribution.totalActiveLiquidity;
    return parseFloat(poolDayData.feesUSD) * positionShare;
  }

  // For concentrated positions: calculate competing liquidity in our range
  let competingLiquidity = 0;
  for (const position of allPositions) {
    const tickLowerIdx = parseInt(position.tickLower.tickIdx);
    const tickUpperIdx = parseInt(position.tickUpper.tickIdx);

    const isActive = currentTick >= tickLowerIdx && currentTick < tickUpperIdx;
    const hasOverlap = !(
      tickUpperIdx <= positionRange.tickLower ||
      tickLowerIdx >= positionRange.tickUpper
    );

    if (isActive && hasOverlap) {
      competingLiquidity += parseFloat(position.liquidity);
    }
  }

  if (competingLiquidity === 0) {
    return 0;
  }

  // Calculate our share in the concentrated range
  const ourInvestment = lpSharePercentage * parseFloat(poolDayData.tvlUSD);
  const positionShare = ourInvestment / (competingLiquidity + ourInvestment);

  return parseFloat(poolDayData.feesUSD) * positionShare;
}
