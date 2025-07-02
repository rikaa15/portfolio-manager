import { Injectable, Logger } from '@nestjs/common';
import { 
  OptionContract, 
  OptionPosition, 
  OptionPricingParams
} from './types';
import {
  calculateBlackScholesPrice,
  calculateIntrinsicValue,
  calculateTimeValue,
  calculateDelta,
  calculateTheta,
  daysToYears,
  calculateDaysToExpiry
} from './options.utils';

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