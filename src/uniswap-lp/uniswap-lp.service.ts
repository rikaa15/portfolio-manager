import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers, JsonRpcProvider, Wallet, formatUnits } from 'ethers';
import { Pool } from '@uniswap/v3-sdk';
import { Token } from '@uniswap/sdk-core';
import {
  LiquidityPosition,
  AddLiquidityParams,
  RemoveLiquidityParams,
  CollectFeesParams,
} from './types';
import { Config } from '../config/configuration';
import { abi as NonfungiblePositionManagerABI } from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json';

const NONFUNGIBLE_POSITION_MANAGER_ADDRESS = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';

@Injectable()
export class UniswapLpService {
  private readonly logger = new Logger(UniswapLpService.name);
  private readonly provider: JsonRpcProvider;
  private readonly signer: Wallet;
  private readonly nfpmContract: ethers.Contract & any;

  constructor(private readonly configService: ConfigService<Config>) {
    const rpcUrl = this.configService.get('ethereum.rpcUrl', { infer: true });
    const privateKey = this.configService.get('ethereum.privateKey', { infer: true });
    
    this.provider = new JsonRpcProvider(rpcUrl);
    this.signer = new Wallet(privateKey, this.provider);
    
    // Initialize NFT Position Manager contract
    this.nfpmContract = new ethers.Contract(
      NONFUNGIBLE_POSITION_MANAGER_ADDRESS,
      NonfungiblePositionManagerABI,
      this.provider
    );
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

      // Get WBTC/USDC position info
      await this.getWbtcUsdcPosition();

      this.logger.log('UniswapLpService initialized successfully');
    } catch (error) {
      this.logger.error(`Failed to initialize UniswapLpService: ${error.message}`);
      throw error;
    }
  }

  async getPositionsByOwner(ownerAddress: string): Promise<string[]> {
    try {
      // Get number of positions
      const numPositions = await this.nfpmContract.balanceOf(ownerAddress);
      
      // Fetch all position IDs
      const calls = [];
      for (let i = 0; i < numPositions; i++) {
        calls.push(this.nfpmContract.tokenOfOwnerByIndex(ownerAddress, i));
      }
      
      const positionIds = await Promise.all(calls);
      return positionIds.map(id => id.toString());
    } catch (error) {
      this.logger.error(`Failed to get positions for owner ${ownerAddress}: ${error.message}`);
      throw error;
    }
  }

  async getPosition(tokenId: string): Promise<LiquidityPosition> {
    try {
      const position = await this.nfpmContract.positions(tokenId);
      
      return {
        tokenId,
        token0: new Token(1, position.token0, 18), // Mainnet chainId = 1
        token1: new Token(1, position.token1, 18),
        fee: position.fee,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        liquidity: position.liquidity.toString(),
        token0Balance: position.tokensOwed0.toString(),
        token1Balance: position.tokensOwed1.toString(),
        feeGrowthInside0LastX128: position.feeGrowthInside0LastX128.toString(),
        feeGrowthInside1LastX128: position.feeGrowthInside1LastX128.toString(),
      };
    } catch (error) {
      this.logger.error(`Failed to get position ${tokenId}: ${error.message}`);
      throw error;
    }
  }

  async addLiquidity(params: AddLiquidityParams): Promise<string> {
    try {
      const tx = await this.nfpmContract.connect(this.signer).mint({
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
      const event = receipt.events.find(e => e.event === 'IncreaseLiquidity');
      return event.args.tokenId.toString();
    } catch (error) {
      this.logger.error(`Failed to add liquidity: ${error.message}`);
      throw error;
    }
  }

  async removeLiquidity(params: RemoveLiquidityParams): Promise<void> {
    try {
      const tx = await this.nfpmContract.connect(this.signer).decreaseLiquidity({
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
      const tx = await this.nfpmContract.connect(this.signer).collect({
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

  async getWbtcUsdcPosition(tokenId: string = '999399'): Promise<void> {
    try {
      this.logger.log(`Fetching WBTC/USDC position #${tokenId}...`);
      
      const position = await this.getPosition(tokenId);
      console.log('position', position)
      
      // Format amounts with proper decimals
      const wbtcAmount = formatUnits(position.token0Balance, 8); // WBTC has 8 decimals
      const usdcAmount = formatUnits(position.token1Balance, 6); // USDC has 6 decimals

      // Calculate tick ranges to price
      const tickToPrice = (tick: bigint): number => {
        // Convert tick to number for the calculation since we can't use ** with bigint
        const tickNumber = Number(tick);
        return 1.0001 ** tickNumber;
      };

      const lowerPrice = tickToPrice(position.tickLower);
      const upperPrice = tickToPrice(position.tickUpper);

      this.logger.log('Position Details:');
      this.logger.log(`Token ID: ${position.tokenId}`);
      this.logger.log(`Fee Tier: ${Number(position.fee) / 10000}%`);
      this.logger.log(`Price Range: $${lowerPrice.toFixed(2)} - $${upperPrice.toFixed(2)}`);
      this.logger.log(`WBTC Amount: ${wbtcAmount}`);
      this.logger.log(`USDC Amount: ${usdcAmount}`);
      this.logger.log(`Liquidity: ${position.liquidity}`);
      
      // Log uncollected fees
      const wbtcFees = formatUnits(position.feeGrowthInside0LastX128, 8);
      const usdcFees = formatUnits(position.feeGrowthInside1LastX128, 6);
      this.logger.log(`Uncollected Fees:`);
      this.logger.log(`- WBTC: ${wbtcFees}`);
      this.logger.log(`- USDC: ${usdcFees}`);

    } catch (error) {
      this.logger.error(`Failed to fetch WBTC/USDC position: ${error.message}`);
      throw error;
    }
  }
}
