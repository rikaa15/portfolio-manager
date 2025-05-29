import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers, JsonRpcProvider, Wallet } from 'ethers';
import { Pool } from '@uniswap/v3-sdk';
import { Token } from '@uniswap/sdk-core';
import {
  LiquidityPosition,
  AddLiquidityParams,
  RemoveLiquidityParams,
  CollectFeesParams,
} from './types';
import { Config } from '../config/configuration';

@Injectable()
export class UniswapLpService {
  private readonly logger = new Logger(UniswapLpService.name);
  private readonly provider: JsonRpcProvider;
  private readonly signer: Wallet;

  constructor(private readonly configService: ConfigService<Config>) {
    const rpcUrl = this.configService.get('ethereum.rpcUrl', { infer: true });
    const privateKey = this.configService.get('ethereum.privateKey', { infer: true });
    
    this.provider = new JsonRpcProvider(rpcUrl);
    this.signer = new Wallet(privateKey, this.provider);
  }

  async bootstrap(): Promise<void> {
    try {
      this.logger.log('Initializing UniswapLpService...');
      
      // Test connection to provider
      const network = await this.provider.getNetwork();
      this.logger.log(`Connected to network: ${network.name} (chainId: ${network.chainId})`);
      
      // Test signer
      const address = await this.signer.getAddress();
      const balance = await this.provider.getBalance(address);
      this.logger.log(`Signer address: ${address}`);
      this.logger.log(`Signer balance: ${ethers.formatEther(balance)} ETH`);

      this.logger.log('UniswapLpService initialized successfully');
    } catch (error) {
      this.logger.error(`Failed to initialize UniswapLpService: ${error.message}`);
      throw error;
    }
  }

  async getPosition(poolAddress: string, tokenId: string): Promise<LiquidityPosition> {
    try {
      // Implementation will use Uniswap V3 NFT Position Manager contract
      // to fetch position details
      const positionManagerContract = new ethers.Contract(
        poolAddress,
        ['function positions(uint256) view returns (tuple(uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1))'],
        this.provider
      );

      const position = await positionManagerContract.positions(tokenId);

      // Convert the position data to our interface format
      return {
        tokenId,
        token0: new Token(1, position.token0, 18), // Assuming ETH mainnet (chainId: 1) and 18 decimals
        token1: new Token(1, position.token1, 18),
        fee: position.fee,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        liquidity: position.liquidity,
        token0Balance: position.tokensOwed0,
        token1Balance: position.tokensOwed1,
        feeGrowthInside0LastX128: position.feeGrowthInside0LastX128,
        feeGrowthInside1LastX128: position.feeGrowthInside1LastX128,
      };
    } catch (error) {
      this.logger.error(`Failed to get position: ${error.message}`);
      throw error;
    }
  }

  async addLiquidity(params: AddLiquidityParams): Promise<string> {
    try {
      const positionManagerContract = new ethers.Contract(
        this.configService.get('ethereum.contracts.uniswapPositionManager', { infer: true }),
        ['function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external returns (uint256 tokenId)'],
        this.signer
      );

      const tx = await positionManagerContract.mint({
        token0: params.token0.address,
        token1: params.token1.address,
        fee: params.fee,
        tickLower: params.tickLower,
        tickUpper: params.tickUpper,
        amount0Desired: params.amount0Desired,
        amount1Desired: params.amount1Desired,
        amount0Min: params.amount0Min,
        amount1Min: params.amount1Min,
        recipient: params.recipient,
        deadline: params.deadline,
      });

      const receipt = await tx.wait();
      // Extract tokenId from event logs
      const event = receipt.events.find(e => e.event === 'IncreaseLiquidity');
      return event.args.tokenId.toString();
    } catch (error) {
      this.logger.error(`Failed to add liquidity: ${error.message}`);
      throw error;
    }
  }

  async removeLiquidity(params: RemoveLiquidityParams): Promise<void> {
    try {
      const positionManagerContract = new ethers.Contract(
        this.configService.get('ethereum.contracts.uniswapPositionManager', { infer: true }),
        ['function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external returns (uint256 amount0, uint256 amount1)'],
        this.signer
      );

      const tx = await positionManagerContract.decreaseLiquidity({
        tokenId: params.tokenId,
        liquidity: params.liquidity,
        amount0Min: params.amount0Min,
        amount1Min: params.amount1Min,
        deadline: params.deadline,
      });

      await tx.wait();
    } catch (error) {
      this.logger.error(`Failed to remove liquidity: ${error.message}`);
      throw error;
    }
  }

  async collectFees(params: CollectFeesParams): Promise<void> {
    try {
      const positionManagerContract = new ethers.Contract(
        this.configService.get('ethereum.contracts.uniswapPositionManager', { infer: true }),
        ['function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external returns (uint256 amount0, uint256 amount1)'],
        this.signer
      );

      const tx = await positionManagerContract.collect({
        tokenId: params.tokenId,
        recipient: params.recipient,
        amount0Max: params.amount0Max,
        amount1Max: params.amount1Max,
      });

      await tx.wait();
    } catch (error) {
      this.logger.error(`Failed to collect fees: ${error.message}`);
      throw error;
    }
  }
}
