export interface OptionContract {
  type: 'call' | 'put';
  strikePrice: number;
  expiryTimestamp: number;
  underlyingAsset: string;
  premium: number;
  contractSize: number;
}

export interface OptionPricingParams {
  spotPrice: number;
  strikePrice: number;
  timeToExpiry: number;
  riskFreeRate: number;
  volatility: number;
  optionType: 'call' | 'put';
}

export interface OptionPosition {
  contract: OptionContract;
  openTimestamp: number;
  openPrice: number;
  currentValue: number;
  unrealizedPnL: number;
  timeDecay: number;
  isActive: boolean;
}

export interface OptionBacktestParams {
  initialSpotPrice: number;
  strikePrice: number;
  optionType: 'call' | 'put';
  contractSize: number;
  expiryDays: number;
  riskFreeRate?: number;
  initialVolatility?: number;
}

export interface OptionBacktestResult {
  timestamp: number;
  spotPrice: number;
  optionValue: number;
  premium: number;
  timeToExpiry: number;
  intrinsicValue: number;
  timeValue: number;
  delta: number;
  theta: number;
  unrealizedPnL: number;
  daysSinceOpen: number;
}

export interface StrategyBacktestResult {
  timestamp: number;
  date: string;
  spotPrice: number;
  lpPositionValue: number;
  perpetualPnL: number;
  optionValue: number;
  optionPnL: number;
  totalStrategyPnL: number;
  impermanentLoss: number;
  cumulativeFees: number;
} 