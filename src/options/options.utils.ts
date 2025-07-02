import { OptionPricingParams } from './types';

function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2.0);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function calculateD1(params: OptionPricingParams): number {
  const { spotPrice, strikePrice, timeToExpiry, riskFreeRate, volatility } = params;
  
  return (
    (Math.log(spotPrice / strikePrice) + (riskFreeRate + 0.5 * volatility * volatility) * timeToExpiry) /
    (volatility * Math.sqrt(timeToExpiry))
  );
}

function calculateD2(params: OptionPricingParams): number {
  const d1 = calculateD1(params);
  return d1 - params.volatility * Math.sqrt(params.timeToExpiry);
}

export function calculateBlackScholesPrice(params: OptionPricingParams): number {
  const { spotPrice, strikePrice, timeToExpiry, riskFreeRate, optionType } = params;

  if (timeToExpiry <= 0) {
    return calculateIntrinsicValue(spotPrice, strikePrice, optionType);
  }

  const d1 = calculateD1(params);
  const d2 = calculateD2(params);

  if (optionType === 'call') {
    return (
      spotPrice * normalCDF(d1) - 
      strikePrice * Math.exp(-riskFreeRate * timeToExpiry) * normalCDF(d2)
    );
  } else {
    return (
      strikePrice * Math.exp(-riskFreeRate * timeToExpiry) * normalCDF(-d2) - 
      spotPrice * normalCDF(-d1)
    );
  }
}

export function calculateIntrinsicValue(
  spotPrice: number, 
  strikePrice: number, 
  optionType: 'call' | 'put'
): number {
  if (optionType === 'call') {
    return Math.max(0, spotPrice - strikePrice);
  } else {
    return Math.max(0, strikePrice - spotPrice);
  }
}

export function calculateTimeValue(params: OptionPricingParams): number {
  const totalValue = calculateBlackScholesPrice(params);
  const intrinsicValue = calculateIntrinsicValue(params.spotPrice, params.strikePrice, params.optionType);
  return Math.max(0, totalValue - intrinsicValue);
}

export function calculateDelta(params: OptionPricingParams): number {
  if (params.timeToExpiry <= 0) {
    if (params.optionType === 'call') {
      return params.spotPrice > params.strikePrice ? 1 : 0;
    } else {
      return params.spotPrice < params.strikePrice ? -1 : 0;
    }
  }

  const d1 = calculateD1(params);
  
  if (params.optionType === 'call') {
    return normalCDF(d1);
  } else {
    return normalCDF(d1) - 1;
  }
}

export function calculateTheta(params: OptionPricingParams): number {
  const { spotPrice, strikePrice, timeToExpiry, riskFreeRate, volatility, optionType } = params;

  if (timeToExpiry <= 0) {
    return 0;
  }

  const d1 = calculateD1(params);
  const d2 = calculateD2(params);

  const term1 = -(spotPrice * normalPDF(d1) * volatility) / (2 * Math.sqrt(timeToExpiry));
  
  if (optionType === 'call') {
    const term2 = -riskFreeRate * strikePrice * Math.exp(-riskFreeRate * timeToExpiry) * normalCDF(d2);
    return (term1 + term2) / 365;
  } else {
    const term2 = riskFreeRate * strikePrice * Math.exp(-riskFreeRate * timeToExpiry) * normalCDF(-d2);
    return (term1 + term2) / 365;
  }
}

export function calculateGamma(params: OptionPricingParams): number {
  if (params.timeToExpiry <= 0) {
    return 0;
  }

  const d1 = calculateD1(params);
  return normalPDF(d1) / (params.spotPrice * params.volatility * Math.sqrt(params.timeToExpiry));
}

export function calculateVega(params: OptionPricingParams): number {
  if (params.timeToExpiry <= 0) {
    return 0;
  }

  const d1 = calculateD1(params);
  return params.spotPrice * normalPDF(d1) * Math.sqrt(params.timeToExpiry) / 100;
}

export function calculateHistoricalVolatility(
  prices: number[], 
  timeframe: 'daily' | 'hourly' = 'daily'
): number {
  if (prices.length < 2) {
    throw new Error('Need at least 2 price points');
  }

  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.log(prices[i] / prices[i - 1]));
  }

  const meanReturn = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;

  const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - meanReturn, 2), 0) / (returns.length - 1);

  const periodsPerYear = timeframe === 'daily' ? 365 : 365 * 24;
  return Math.sqrt(variance * periodsPerYear);
}

export function daysToYears(days: number): number {
  return days / 365;
}

export function calculateDaysToExpiry(currentTimestamp: number, expiryTimestamp: number): number {
  return Math.max(0, (expiryTimestamp - currentTimestamp) / (1000 * 60 * 60 * 24));
} 