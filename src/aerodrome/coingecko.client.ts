import axios from 'axios';

export const CoinGeckoTokenIdsMap: Record<string, string> = {
  aero: 'aerodrome-finance',
  usdt: 'tether',
};

// hardcode values for test purposes
export const CoinGeckoRates: Record<string, number> = {
  'aerodrome-finance': 0.608768,
  tether: 1,
};

// hardcoded historical rates
export const CoinGeckoHistoricalRates: Record<
  string,
  Record<string, number>
> = {
  'aerodrome-finance': {
    '11-06-2025': 0.608768,
  },
};

interface CoinGeckoPriceResponse {
  [key: string]: {
    [key: string]: number;
  };
}

const tokenPriceCache: Record<string, number> = {};

// Coingecko API docs: https://www.coingecko.com/en/api/documentation
export const getTokenPrices = async (tokens: string[]) => {
  const ids = tokens.join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
  const { data } = await axios.get<CoinGeckoPriceResponse>(url);
  return data;
};

export const getTokenPrice = async (token: string, fromCache = true) => {
  const tokenId = CoinGeckoTokenIdsMap[token.toLowerCase()];
  if (fromCache) {
    if (tokenPriceCache[tokenId]) {
      return tokenPriceCache[tokenId];
    }
    if (CoinGeckoRates[tokenId]) {
      return CoinGeckoRates[tokenId];
    }
  }
  console.log('Coingecko API: Get token price', tokenId);
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${tokenId}&vs_currencies=usd`;
  const { data } = await axios.get<CoinGeckoPriceResponse>(url);
  const value = data[tokenId]['usd'];

  tokenPriceCache[tokenId] = value;
  return value;
};

export const getTokenPriceDate = async (
  tokenId: string,
  timestamp: number,
  fromCache = true,
) => {
  const coinGeckoDate = new Date(timestamp * 1000)
    .toLocaleDateString('en-GB')
    .replace(/\//g, '-');
  if (fromCache) {
    if (CoinGeckoHistoricalRates[tokenId]?.[coinGeckoDate]) {
      console.log(
        `Using cached historical price for ${tokenId} on ${coinGeckoDate}:`,
        CoinGeckoHistoricalRates[tokenId][coinGeckoDate],
      );
      return CoinGeckoHistoricalRates[tokenId][coinGeckoDate];
    }
  }
  console.log(`Coingecko API: Get token price (${coinGeckoDate})`, tokenId);
  const url = `https://api.coingecko.com/api/v3/coins/${tokenId}/history?date=${coinGeckoDate}`;
  const { data } = await axios.get<any>(url);
  const value = data.market_data?.current_price?.usd || 0;
  return value;
};

export interface CoinGeckoToken {
  id: string;
  symbol: string;
  name: string;
}

export const getTokensList = async () => {
  const url = `https://api.coingecko.com/api/v3/coins/list`;
  const { data } = await axios.get<CoinGeckoToken[]>(url);
  return data;
};
