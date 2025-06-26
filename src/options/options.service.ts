import { Injectable, Logger } from '@nestjs/common';
import { 
  OptionContract, 
  OptionPosition, 
  OptionBacktestParams, 
  OptionBacktestResult,
  OptionPricingParams,
  StrategyBacktestResult 
} from './types';
import {
  calculateBlackScholesPrice,
  calculateIntrinsicValue,
  calculateTimeValue,
  calculateDelta,
  calculateTheta,
  calculateHistoricalVolatility,
  daysToYears,
  calculateDaysToExpiry
} from './options.utils';
import { PoolDayData } from '../aerodrome/types';

@Injectable()
export class OptionsService {
  private readonly logger = new Logger(OptionsService.name);
  private readonly DEFAULT_RISK_FREE_RATE = 0.05;
  private readonly DEFAULT_VOLATILITY = 0.8;

  createOption(params: {
    type: 'call' | 'put';
    strikePrice: number;
    expiryDays: number;
    underlyingAsset: string;
    contractSize: number;
    currentSpotPrice: number;
    volatility?: number;
    riskFreeRate?: number;
  }): OptionContract {
    const expiryTimestamp = Date.now() + (params.expiryDays * 24 * 60 * 60 * 1000);
    const pricingParams: OptionPricingParams = {
      spotPrice: params.currentSpotPrice,
      strikePrice: params.strikePrice,
      timeToExpiry: daysToYears(params.expiryDays),
      riskFreeRate: params.riskFreeRate || this.DEFAULT_RISK_FREE_RATE,
      volatility: params.volatility || this.DEFAULT_VOLATILITY,
      optionType: params.type
    };
    const premium = calculateBlackScholesPrice(pricingParams);
    return {
      type: params.type,
      strikePrice: params.strikePrice,
      expiryTimestamp,
      underlyingAsset: params.underlyingAsset,
      premium: premium * params.contractSize,
      contractSize: params.contractSize
    };
  }

  calculateOptionValue(
    contract: OptionContract,
    currentSpotPrice: number,
    currentTimestamp: number = Date.now(),
    volatility?: number,
    riskFreeRate?: number
  ): {
    value: number;
    intrinsicValue: number;
    timeValue: number;
    delta: number;
    theta: number;
    daysToExpiry: number;
  } {
    const daysToExpiry = calculateDaysToExpiry(currentTimestamp, contract.expiryTimestamp);
    const timeToExpiry = daysToYears(daysToExpiry);
    if (daysToExpiry <= 0) {
      const intrinsicValue = calculateIntrinsicValue(
        currentSpotPrice, 
        contract.strikePrice, 
        contract.type
      ) * contract.contractSize;
      return {
        value: intrinsicValue,
        intrinsicValue,
        timeValue: 0,
        delta: 0,
        theta: 0,
        daysToExpiry: 0
      };
    }
    const pricingParams: OptionPricingParams = {
      spotPrice: currentSpotPrice,
      strikePrice: contract.strikePrice,
      timeToExpiry,
      riskFreeRate: riskFreeRate || this.DEFAULT_RISK_FREE_RATE,
      volatility: volatility || this.DEFAULT_VOLATILITY,
      optionType: contract.type
    };
    const optionPrice = calculateBlackScholesPrice(pricingParams);
    const intrinsicValue = calculateIntrinsicValue(currentSpotPrice, contract.strikePrice, contract.type);
    const timeValue = calculateTimeValue(pricingParams);
    const delta = calculateDelta(pricingParams);
    const theta = calculateTheta(pricingParams);
    return {
      value: optionPrice * contract.contractSize,
      intrinsicValue: intrinsicValue * contract.contractSize,
      timeValue: timeValue * contract.contractSize,
      delta: delta * contract.contractSize,
      theta: theta * contract.contractSize,
      daysToExpiry
    };
  }

  openPosition(
    contract: OptionContract,
    currentSpotPrice: number,
    openTimestamp: number = Date.now()
  ): OptionPosition {
    const currentValue = this.calculateOptionValue(contract, currentSpotPrice, openTimestamp);
    return {
      contract,
      openTimestamp,
      openPrice: currentSpotPrice,
      currentValue: currentValue.value,
      unrealizedPnL: currentValue.value - contract.premium,
      timeDecay: currentValue.theta,
      isActive: true
    };
  }

  updatePosition(
    position: OptionPosition,
    currentSpotPrice: number,
    currentTimestamp: number = Date.now(),
    volatility?: number
  ): OptionPosition {
    if (!position.isActive) {
      return position;
    }
    const currentValue = this.calculateOptionValue(
      position.contract,
      currentSpotPrice,
      currentTimestamp,
      volatility
    );
    const isExpired = calculateDaysToExpiry(currentTimestamp, position.contract.expiryTimestamp) <= 0;
    return {
      ...position,
      currentValue: currentValue.value,
      unrealizedPnL: currentValue.value - position.contract.premium,
      timeDecay: currentValue.theta,
      isActive: !isExpired
    };
  }

  closePosition(
    position: OptionPosition,
    currentSpotPrice: number,
    closeTimestamp: number = Date.now()
  ): {
    position: OptionPosition;
    realizedPnL: number;
    holdingPeriodDays: number;
  } {
    const updatedPosition = this.updatePosition(position, currentSpotPrice, closeTimestamp);
    const holdingPeriodDays = (closeTimestamp - position.openTimestamp) / (1000 * 60 * 60 * 24);
    return {
      position: {
        ...updatedPosition,
        isActive: false
      },
      realizedPnL: updatedPosition.unrealizedPnL,
      holdingPeriodDays
    };
  }

  private calculateRealVolatility(poolDayData: PoolDayData[], lookbackDays: number = 30): number {
    if (poolDayData.length < 2) {
      this.logger.warn('Insufficient price data for volatility calculation, using default');
      return this.DEFAULT_VOLATILITY;
    }
    const recentData = poolDayData.slice(-Math.min(lookbackDays, poolDayData.length));
    const prices = recentData.map(data => parseFloat(data.token0Price));
    try {
      const volatility = calculateHistoricalVolatility(prices, 'daily');
      this.logger.log(`Calculated ${lookbackDays}-day volatility: ${(volatility * 100).toFixed(1)}%`);
      return volatility;
    } catch (error) {
      this.logger.error(`Failed to calculate volatility: ${error.message}`);
      return this.DEFAULT_VOLATILITY;
    }
  }

  runOptionBacktestWithPoolData(
    poolDayData: PoolDayData[],
    params: OptionBacktestParams,
    volatilityLookbackDays: number = 30
  ): OptionBacktestResult[] {
    this.logger.log(`Running option backtest for ${params.optionType} option with REAL pool data...`);
    this.logger.log(`Strike: $${params.strikePrice}, Expiry: ${params.expiryDays} days`);
    this.logger.log(`Pool data points: ${poolDayData.length}`);
    const results: OptionBacktestResult[] = [];
    if (poolDayData.length === 0) {
      this.logger.error('No pool data provided');
      return results;
    }
    const realVolatility = this.calculateRealVolatility(poolDayData, volatilityLookbackDays);
    const initialPrice = parseFloat(poolDayData[0].token0Price);
    const contract = this.createOption({
      type: params.optionType,
      strikePrice: params.strikePrice,
      expiryDays: params.expiryDays,
      underlyingAsset: 'BTC',
      contractSize: params.contractSize,
      currentSpotPrice: initialPrice,
      volatility: realVolatility,
      riskFreeRate: params.riskFreeRate
    });
    const startTimestamp = poolDayData[0].date * 1000;
    const premium = contract.premium;
    this.logger.log(`Real initial BTC price: $${initialPrice.toFixed(2)}`);
    this.logger.log(`Real volatility: ${(realVolatility * 100).toFixed(1)}%`);
    this.logger.log(`Premium paid: $${premium.toFixed(2)}`);
    for (let i = 0; i < poolDayData.length; i++) {
      const dayData = poolDayData[i];
      const currentPrice = parseFloat(dayData.token0Price);
      const currentTimestamp = dayData.date * 1000;
      const daysSinceOpen = (currentTimestamp - startTimestamp) / (1000 * 60 * 60 * 24);
      if (daysSinceOpen > params.expiryDays) {
        break;
      }
      const volatilityStartIndex = Math.max(0, i - volatilityLookbackDays);
      const rollingPoolData = poolDayData.slice(volatilityStartIndex, i + 1);
      const dynamicVolatility = this.calculateRealVolatility(rollingPoolData, volatilityLookbackDays);
      const optionValue = this.calculateOptionValue(
        contract,
        currentPrice,
        currentTimestamp,
        dynamicVolatility
      );
      const result: OptionBacktestResult = {
        timestamp: currentTimestamp,
        spotPrice: currentPrice,
        optionValue: optionValue.value,
        premium: premium,
        timeToExpiry: daysToYears(optionValue.daysToExpiry),
        intrinsicValue: optionValue.intrinsicValue,
        timeValue: optionValue.timeValue,
        delta: optionValue.delta,
        theta: optionValue.theta,
        unrealizedPnL: optionValue.value - premium,
        daysSinceOpen: daysSinceOpen
      };
      results.push(result);
    }
    if (results.length > 0) {
      const finalResult = results[results.length - 1];
      const totalReturn = ((finalResult.optionValue - premium) / premium) * 100;
      const priceReturn = ((finalResult.spotPrice - initialPrice) / initialPrice) * 100;
      this.logger.log('=== Option Backtest Summary (REAL DATA) ===');
      this.logger.log(`Initial Premium: $${premium.toFixed(2)}`);
      this.logger.log(`Final Value: $${finalResult.optionValue.toFixed(2)}`);
      this.logger.log(`Option Return: ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`);
      this.logger.log(`BTC Price Return: ${priceReturn >= 0 ? '+' : ''}${priceReturn.toFixed(2)}%`);
      this.logger.log(`Days Simulated: ${finalResult.daysSinceOpen.toFixed(1)}`);
    }
    return results;
  }

  runOptionBacktest(
    priceData: Array<{ timestamp: number; price: number }>,
    params: OptionBacktestParams
  ): OptionBacktestResult[] {
    this.logger.warn('Using runOptionBacktest with mock data. Consider using runOptionBacktestWithPoolData for real LP data.');
    const results: OptionBacktestResult[] = [];
    if (priceData.length === 0) {
      return results;
    }
    const contract = this.createOption({
      type: params.optionType,
      strikePrice: params.strikePrice,
      expiryDays: params.expiryDays,
      underlyingAsset: 'BTC',
      contractSize: params.contractSize,
      currentSpotPrice: params.initialSpotPrice,
      volatility: params.initialVolatility,
      riskFreeRate: params.riskFreeRate
    });
    const startTimestamp = priceData[0].timestamp;
    const premium = contract.premium;
    const prices = priceData.map(d => d.price);
    const historicalVolatility = prices.length >= 30 ? 
      calculateHistoricalVolatility(prices.slice(-30)) : 
      params.initialVolatility || this.DEFAULT_VOLATILITY;
    this.logger.log(`Historical volatility: ${(historicalVolatility * 100).toFixed(1)}%`);
    this.logger.log(`Premium paid: $${premium.toFixed(2)}`);
    for (const dataPoint of priceData) {
      const daysSinceOpen = (dataPoint.timestamp - startTimestamp) / (1000 * 60 * 60 * 24);
      if (daysSinceOpen > params.expiryDays) {
        break;
      }
      const optionValue = this.calculateOptionValue(
        contract,
        dataPoint.price,
        dataPoint.timestamp,
        historicalVolatility
      );
      const result: OptionBacktestResult = {
        timestamp: dataPoint.timestamp,
        spotPrice: dataPoint.price,
        optionValue: optionValue.value,
        premium: premium,
        timeToExpiry: daysToYears(optionValue.daysToExpiry),
        intrinsicValue: optionValue.intrinsicValue,
        timeValue: optionValue.timeValue,
        delta: optionValue.delta,
        theta: optionValue.theta,
        unrealizedPnL: optionValue.value - premium,
        daysSinceOpen: daysSinceOpen
      };
      results.push(result);
    }
    if (results.length > 0) {
      const finalResult = results[results.length - 1];
      const totalReturn = ((finalResult.optionValue - premium) / premium) * 100;
      this.logger.log('=== Option Backtest Summary ===');
      this.logger.log(`Initial Premium: $${premium.toFixed(2)}`);
      this.logger.log(`Final Value: $${finalResult.optionValue.toFixed(2)}`);
      this.logger.log(`Total Return: ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`);
      this.logger.log(`Days Simulated: ${finalResult.daysSinceOpen.toFixed(1)}`);
    }
    return results;
  }

  estimateOptionPremium(
    spotPrice: number,
    strikePrice: number,
    daysToExpiry: number,
    optionType: 'call' | 'put',
    volatility?: number,
    riskFreeRate?: number
  ): {
    premium: number;
    delta: number;
    theta: number;
    intrinsicValue: number;
    timeValue: number;
  } {
    const pricingParams: OptionPricingParams = {
      spotPrice,
      strikePrice,
      timeToExpiry: daysToYears(daysToExpiry),
      riskFreeRate: riskFreeRate || this.DEFAULT_RISK_FREE_RATE,
      volatility: volatility || this.DEFAULT_VOLATILITY,
      optionType
    };
    const premium = calculateBlackScholesPrice(pricingParams);
    const intrinsicValue = calculateIntrinsicValue(spotPrice, strikePrice, optionType);
    const timeValue = calculateTimeValue(pricingParams);
    const delta = calculateDelta(pricingParams);
    const theta = calculateTheta(pricingParams);
    return {
      premium,
      delta,
      theta,
      intrinsicValue,
      timeValue
    };
  }

  suggestStrikePrice(
    currentSpotPrice: number,
    optionType: 'call' | 'put',
    moneyness: 'ITM' | 'ATM' | 'OTM' = 'ITM'
  ): number {
    const tickSize = 1000;
    if (moneyness === 'ATM') {
      return Math.round(currentSpotPrice / tickSize) * tickSize;
    }
    if (optionType === 'call') {
      if (moneyness === 'ITM') {
        return Math.floor(currentSpotPrice / tickSize) * tickSize;
      } else {
        return Math.ceil(currentSpotPrice / tickSize) * tickSize;
      }
    } else {
      if (moneyness === 'ITM') {
        return Math.ceil(currentSpotPrice / tickSize) * tickSize;
      } else {
        return Math.floor(currentSpotPrice / tickSize) * tickSize;
      }
    }
  }
} 