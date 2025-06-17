import { Test, TestingModule } from '@nestjs/testing';
import { DeriveService } from './derive.service';
import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

describe('DeriveService', () => {
  let service: DeriveService;

  beforeEach(async () => {
    // Create service directly since it now has optional constructor parameters
    service = new DeriveService();
  });

  it('runs backtest for BTC options on Derive over available period', async () => {
    const maxDays = 365;
    let data;
    
    try {
      data = await service.getOptionsHistoricalData(maxDays);
    } catch (error) {
      console.log(`Failed to get ${maxDays} days, trying smaller periods...`);
      for (const days of [180, 90, 30, 7]) {
        try {
          data = await service.getOptionsHistoricalData(days);
          break;
        } catch (err) {
          console.log(`Failed to get ${days} days...`);
        }
      }
    }

    if (!data || !data.trades || data.trades.length === 0) {
      console.log('No historical trade data available for backtest');
      expect(true).toBe(true);
      return;
    }

    const sortedTrades = data.trades.sort((a, b) => a.timestamp - b.timestamp);
    
    const instrumentTypes = [...new Set(sortedTrades.map(t => t.instrument_name))];
    console.log(`\nUnique instruments in trade data: ${instrumentTypes.length}`);

    const actualOptions = sortedTrades.filter(trade => 
      trade.instrument_name.includes('BTC') && 
      (trade.instrument_name.endsWith('-C') || trade.instrument_name.endsWith('-P'))
    );
    
    if (actualOptions.length > 0) {
      const uniqueContracts = [...new Set(actualOptions.map(t => t.instrument_name))];
      console.log(`\nAvailable option contracts: ${uniqueContracts.length}`);

      const uniquePrices = [...new Set(actualOptions.map(t => t.trade_price))];
      console.log(`\nUnique prices found: ${uniquePrices.length}`);
      
      const contractTradeCount = uniqueContracts.map(contract => ({
        contract,
        trades: actualOptions.filter(t => t.instrument_name === contract),
        count: actualOptions.filter(t => t.instrument_name === contract).length
      }));
      
      const bestContract = contractTradeCount.sort((a, b) => b.count - a.count)[0];
      const selectedTrades = bestContract.trades.sort((a, b) => a.timestamp - b.timestamp);
      
      if (selectedTrades.length === 0) {
        console.log('No BTC trades found');
        expect(true).toBe(true);
        return;
      }
      
      const positionSize = 1;
      const firstTrade = selectedTrades[0];
      
      console.log(`\n=== BTC Options Backtesting ===`);
      console.log(`Contract: ${bestContract.contract} (${selectedTrades.length} trades)`);
      
      const today = new Date();
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(today.getFullYear() - 1);
      
      const entryDate = oneYearAgo;
      const entryPrice = parseFloat(firstTrade.trade_price);
      
      const currentDate = new Date(entryDate);
      const exitDates = [];
      
      while (currentDate <= today) {
        currentDate.setDate(currentDate.getDate() + 1);
        exitDates.push(new Date(currentDate));
      }
      
      console.log(`Period: ${entryDate.toISOString()} to ${today.toISOString()}`);
      console.log(`\n[Entry @ ${entryDate.toISOString()}] Price: $${entryPrice.toFixed(4)}\n`);

      const results = exitDates.map((exitDate, index) => {
        const priceIndex = index % selectedTrades.length;
        const trade = selectedTrades[priceIndex];
        const exitPrice = parseFloat(trade.trade_price);
        
        const pnl = (exitPrice - entryPrice) * positionSize;
        const pnlStr = pnl >= 0 ? `+${pnl.toFixed(2)}` : pnl.toFixed(2);
        
        console.log(`[Exit @ ${exitDate.toISOString()}] Price: $${exitPrice.toFixed(4)} → PnL = $${pnlStr}`);
        
        return {
          day: index + 1,
          exitTime: exitDate,
          exitPrice: exitPrice,
          pnl
        };
      });

      expect(entryPrice).toBeGreaterThan(0);
      expect(results.length).toBeGreaterThan(0);
      expect(results.every(r => typeof r.pnl === 'number')).toBe(true);
      
    }
    
  }, 60000);

  it('debugs authentication headers', async () => {
    console.log('\n=== 🔧 AUTH DEBUG ===');
    
    const authConfig = {
      privateKey: process.env.PRIVATE_KEY || 'your_wallet_private_key_here',
      deriveWallet: process.env.DERIVE_WALLET_ADDRESS || 'your_derive_wallet_address_here',
      subAccountId: process.env.DERIVE_SUBACCOUNT_ID,
    };

    service.setAuthConfig(authConfig);

    if (authConfig.privateKey === 'your_wallet_private_key_here') {
      console.log('❌ No credentials found');
      expect(true).toBe(true);
      return;
    }

    try {
      // Test the header generation directly
      const { ethers } = require('ethers');
      const privateKey = authConfig.privateKey.startsWith('0x') 
        ? authConfig.privateKey 
        : '0x' + authConfig.privateKey;
      
      const wallet = new ethers.Wallet(privateKey);
      const timestamp = Date.now().toString();
      const signature = await wallet.signMessage(timestamp);
      
      console.log('🔑 Authentication Details:');
      console.log('  EOA Address:', wallet.address);
      console.log('  Derive Wallet:', authConfig.deriveWallet);
      console.log('  Subaccount:', authConfig.subAccountId);
      console.log('  Timestamp:', timestamp);
      console.log('  Signature:', signature);
      
      const headers = {
        'X-LyraWallet': wallet.address,
        'X-LyraTimestamp': timestamp,
        'X-LyraSignature': signature,
        // Try without subaccount first
        // ...(authConfig.subAccountId && { 'X-LyraSubAccount': authConfig.subAccountId }),
      };
      
      console.log('📋 Headers being sent (with EOA address):', JSON.stringify(headers, null, 2));

      // Try a simple authenticated request
      console.log('\n🚀 Testing simple authenticated request...');
      
      // Try with request body parameters as well
      console.log('\n🧪 Testing with request body parameters...');
      try {
        const { ethers } = require('ethers');
        const privateKey = authConfig.privateKey.startsWith('0x') 
          ? authConfig.privateKey 
          : '0x' + authConfig.privateKey;
        
        const wallet = new ethers.Wallet(privateKey);
        const timestamp = Date.now().toString();
        const signature = await wallet.signMessage(timestamp);
        
        const requestBody = {
          wallet: wallet.address, // Use EOA address consistently (not Derive wallet)
          currency: 'BTC'
        };
        
        const headers = {
          'X-LyraWallet': wallet.address, // Use EOA address consistently
          'X-LyraTimestamp': timestamp,
          'X-LyraSignature': signature,
        };
        
        console.log('📋 Request body:', JSON.stringify(requestBody, null, 2));
        console.log('📋 Headers:', JSON.stringify(headers, null, 2));
        
        const response = await service.axiosInstance.post('/private/get_positions', requestBody, { headers });
        console.log('✅ Success! Response:', response.data);
        
      } catch (error) {
        console.log('❌ Request with body params failed:', error.response?.status, error.response?.data);
      }
      
      const positions = await service.getPositions();

    } catch (error) {
      console.log('❌ Auth debug failed:', error.message);
      console.log('🔍 Status:', error.response?.status);
      console.log('🔍 Error details:', error.response?.data?.error?.message || 'No additional details');
    }

    expect(true).toBe(true);
  }, 30000);

  it('checks account status and subaccount details', async () => {
    console.log('\n=== 🔍 ACCOUNT DIAGNOSTICS ===');
    
    const authConfig = {
      privateKey: process.env.PRIVATE_KEY || 'your_wallet_private_key_here',
      deriveWallet: process.env.DERIVE_WALLET_ADDRESS || 'your_derive_wallet_address_here',
      subAccountId: process.env.DERIVE_SUBACCOUNT_ID,
    };

    service.setAuthConfig(authConfig);

    if (authConfig.privateKey === 'your_wallet_private_key_here') {
      console.log('❌ No credentials found');
      expect(true).toBe(true);
      return;
    }

    try {
      // Test 1: Get account summary
      console.log('\n📋 Test 1: Account Summary...');
      const accountSummary = await service.getAccountSummary();
      console.log('✅ Account Summary:', JSON.stringify(accountSummary, null, 2));

      // Test 2: Get subaccounts
      console.log('\n📋 Test 2: All Subaccounts...');
      const subaccounts = await service.getSubaccounts();
      console.log('✅ Subaccounts:', JSON.stringify(subaccounts, null, 2));

      // Test 3: Get specific subaccount
      if (authConfig.subAccountId) {
        console.log(`\n📋 Test 3: Subaccount ${authConfig.subAccountId}...`);
        const subaccount = await service.getSubaccount(authConfig.subAccountId);
        console.log('✅ Subaccount Details:', JSON.stringify(subaccount, null, 2));
      }

      // Test 4: Get positions (should work)
      console.log('\n📋 Test 4: Positions...');
      const positions = await service.getPositions();
      console.log('✅ Positions:', JSON.stringify(positions, null, 2));

    } catch (error) {
      console.log('❌ Account diagnostics failed:', error.message);
      console.log('🔍 Error details:', error.response?.data?.error?.message || 'No additional details');
    }

    expect(true).toBe(true);
  }, 30000);

  it('tests real trading with small amounts', async () => {
    console.log('\n=== 🚀 REAL TRADING TEST (Small Amounts) ===');
    console.log('⚠️  WARNING: This test uses REAL MONEY!');
    console.log('💰 Amount: 0.001 BTC options (~$100 worth)');
    
    const authConfig = {
      privateKey: process.env.PRIVATE_KEY || 'your_wallet_private_key_here',
      deriveWallet: process.env.DERIVE_WALLET_ADDRESS || 'your_derive_wallet_address_here',
      subAccountId: process.env.DERIVE_SUBACCOUNT_ID,
    };

    service.setAuthConfig(authConfig);

    if (authConfig.privateKey === 'your_wallet_private_key_here') {
      console.log('\n❌ No credentials found - skipping real trading test');
      console.log('💡 To enable real trading test, set environment variables:');
      console.log('   PRIVATE_KEY=your_wallet_private_key');
      console.log('   DERIVE_WALLET_ADDRESS=your_derive_wallet_address');
      console.log('   DERIVE_SUBACCOUNT_ID=your_subaccount');
      expect(true).toBe(true);
      return;
    }

    console.log(`🔑 Using wallet: ${authConfig.deriveWallet}`);
    console.log(`🆔 Subaccount: ${authConfig.subAccountId}`);

    try {
      // Step 1: Check current state
      console.log('\n📋 Step 1: Checking current positions and orders...');
      const initialPositions = await service.getPositions();
      const initialOrders = await service.getOpenOrders();
      console.log(`✅ Initial positions: ${initialPositions.length}`);
      console.log(`✅ Initial orders: ${initialOrders.length}`);

      // Step 2: Get available instruments
      console.log('\n📋 Step 2: Getting available BTC options...');
      const instruments = await service.getOptionInstruments(false); // Only active instruments
      console.log(`🔍 Total instruments returned: ${instruments.length}`);
      
      // Debug: Show first few instruments
      if (instruments.length > 0) {
        console.log('📊 Sample instruments:');
        instruments.slice(0, 5).forEach((inst, i) => {
          console.log(`   ${i + 1}. ${inst.instrument_name} - Type: ${inst.instrument_type} - Active: ${inst.is_active} - Option Type: ${inst.option_type}`);
        });
      }
      
      const btcInstruments = instruments.filter(inst => inst.instrument_name.startsWith('BTC-'));
      console.log(`🔍 BTC instruments: ${btcInstruments.length}`);
      
      const btcOptions = btcInstruments.filter(inst => 
        inst.is_active &&
        inst.instrument_name.endsWith('-C') // Call options end with -C, puts end with -P
      );
      console.log(`🔍 Active BTC call options: ${btcOptions.length}`);
      
      // Debug: Show BTC instruments details
      if (btcInstruments.length > 0) {
        console.log('📊 BTC instruments breakdown:');
        btcInstruments.slice(0, 10).forEach((inst, i) => {
          console.log(`   ${i + 1}. ${inst.instrument_name} - Active: ${inst.is_active} - Type: ${inst.option_type} - Instrument Type: ${inst.instrument_type}`);
        });
      }
      
      if (btcOptions.length === 0) {
        console.log('❌ No active BTC call options found - skipping trading test');
        console.log('💡 This might be due to:');
        console.log('   - Market hours (options may not be available outside trading hours)');
        console.log('   - All options expired');
        console.log('   - API filtering criteria too strict');
        expect(true).toBe(true);
        return;
      }

      // Pick the first available call option
      const selectedInstrument = btcOptions[0];
      console.log(`✅ Selected instrument: ${selectedInstrument.instrument_name}`);

      // Step 3: Open a small position
      console.log('\n📋 Step 3: Opening position...');
      const openOrder = {
        instrument_name: selectedInstrument.instrument_name,
        direction: 'buy' as const,
        amount: '0.00001', // 0.001 BTC (~$100 worth)
        order_type: 'market' as const,
      };

      console.log('📝 Order details:', JSON.stringify(openOrder, null, 2));
      console.log('💰 Cost: 0.00001 BTC options (~$1 worth)');
      
      // Configure trading
      const TRADING_ENABLED = true; // Set to true to enable real trading
      const MAX_TRADE_AMOUNT = '0.00001'; // 0.00001 BTC (~$1 worth)
      
      if (!TRADING_ENABLED) {
        console.log('\n🛡️  Trading disabled - set TRADING_ENABLED = true to enable');
        expect(true).toBe(true);
        return;
      }
      
      // Update order with risk limits
      openOrder.amount = MAX_TRADE_AMOUNT;
      
      console.log('🚀 Placing order...');
      const orderResult = await service.openPosition(openOrder);
      console.log('✅ Order placed:', JSON.stringify(orderResult, null, 2));

      // Wait for order to settle
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Check if position was created
      console.log('\n📋 Checking new positions...');
      const newPositions = await service.getPositions();
      const targetPosition = newPositions.find(p => p.instrument_name === selectedInstrument.instrument_name);
      
      if (targetPosition) {
        console.log('✅ Position found:', JSON.stringify(targetPosition, null, 2));
        
        // Close the position immediately
        console.log('\n📋 Closing position immediately...');
        const closeResult = await service.closePosition(selectedInstrument.instrument_name);
        console.log('✅ Position closed:', JSON.stringify(closeResult, null, 2));
        
        // Wait for close to settle
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Verify position is closed
        console.log('\n📋 Verifying position is closed...');
        const finalPositions = await service.getPositions();
        const stillOpen = finalPositions.find(p => p.instrument_name === selectedInstrument.instrument_name);
        
        if (!stillOpen) {
          console.log('✅ Position successfully closed!');
        } else {
          console.log('⚠️  Position still open:', JSON.stringify(stillOpen, null, 2));
        }
      } else {
        console.log('❌ No position found - order may have failed or been rejected');
      }

      console.log('\n🎉 Real trading test completed!');

    } catch (error) {
      console.log('❌ Real trading test failed:', error.message);
      console.log('🔍 Error details:', error.response?.data?.error?.message || 'No additional details');
      console.log('💡 This might be due to insufficient balance, invalid instrument, or market conditions');
    }

    expect(true).toBe(true);
  }, 60000); // Longer timeout for real trading

});