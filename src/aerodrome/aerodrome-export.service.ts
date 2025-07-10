import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PoolTestConfig, UnifiedOutputStatus } from './types';
import { logger } from './aerodrome.utils';

interface ColumnConfig {
  name: string;
  padEnd: number;
  type: 'number' | 'string';
  fixed?: number;
  headerConsole: string;
}

@Injectable()
export class AerodromeExportService {
  private readonly exportsPath = path.join(process.cwd(), 'exports');
  private readonly aerodromeExportsPath = path.join(
    this.exportsPath,
    'aerodrome',
  );

  constructor() {
    this.ensureExportsFolder();
  }

  private ensureExportsFolder(): void {
    if (!fs.existsSync(this.exportsPath)) {
      fs.mkdirSync(this.exportsPath, { recursive: true });
    }
    if (!fs.existsSync(this.aerodromeExportsPath)) {
      fs.mkdirSync(this.aerodromeExportsPath, { recursive: true });
    }
  }

  private getColumnConfigs(): ColumnConfig[] {
    return [
      { name: 'timestamp', padEnd: 12, type: 'string', headerConsole: 'time' },
      {
        name: 'asset_composition',
        padEnd: 12,
        type: 'string',
        headerConsole: 'assets',
      },
      {
        name: 'asset_amounts',
        padEnd: 18,
        type: 'string',
        headerConsole: 'amounts',
      },
      {
        name: 'total_portfolio_value',
        padEnd: 10,
        type: 'number',
        fixed: 0,
        headerConsole: 'value',
      },
      {
        name: 'pnl',
        padEnd: 8,
        type: 'number',
        fixed: 0,
        headerConsole: 'pnl',
      },
      {
        name: 'return',
        padEnd: 8,
        type: 'number',
        fixed: 3,
        headerConsole: 'return%',
      },
      {
        name: 'net_gain_vs_hold',
        padEnd: 8,
        type: 'number',
        fixed: 0,
        headerConsole: 'vs_hold',
      },
      {
        name: 'capital_used_in_trading',
        padEnd: 10,
        type: 'number',
        fixed: 0,
        headerConsole: 'cap_used',
      },
      {
        name: 'total_capital_locked',
        padEnd: 10,
        type: 'number',
        fixed: 0,
        headerConsole: 'cap_lock',
      },
      {
        name: 'lp_fees_earned',
        padEnd: 8,
        type: 'number',
        fixed: 2,
        headerConsole: 'lp_fees',
      },
      {
        name: 'trading_fees_paid',
        padEnd: 8,
        type: 'number',
        fixed: 0,
        headerConsole: 'trade_fee',
      },
      {
        name: 'gas_fees_paid',
        padEnd: 8,
        type: 'number',
        fixed: 0,
        headerConsole: 'gas_fee',
      },
      {
        name: 'max_drawdown',
        padEnd: 8,
        type: 'number',
        fixed: 3,
        headerConsole: 'max_dd%',
      },
      {
        name: 'max_gain',
        padEnd: 8,
        type: 'number',
        fixed: 3,
        headerConsole: 'max_gain%',
      },
      {
        name: 'impermanent_loss',
        padEnd: 8,
        type: 'number',
        fixed: 3,
        headerConsole: 'il%',
      },
      {
        name: 'asset_exposure',
        padEnd: 8,
        type: 'number',
        fixed: 0,
        headerConsole: 'exposure%',
      },
      {
        name: 'rebalancing_actions',
        padEnd: 6,
        type: 'string',
        headerConsole: 'rebal',
      },
      { name: 'notes', padEnd: 10, type: 'string', headerConsole: 'notes' },
    ];
  }

  getUnifiedOutputHeaders(): string[] {
    return this.getColumnConfigs().map((col) => col.name);
  }

  getConsoleHeaders(): string[] {
    return [
      'timestamp',
      'assets',
      'amounts',
      'value',
      'pnl',
      'return%',
      'vs_hold',
      'cap_used',
      'fees',
      'gas',
      'max_dd%',
      'max_gain%',
      'il%',
      'rebal',
      'notes',
    ];
  }

  printConsoleHeader(): void {
    const configs = this.getColumnConfigs();
    const headerRow = configs
      .map((col) => col.headerConsole.padEnd(col.padEnd))
      .join(' | ');
    logger.log('');
    logger.log(headerRow);
    logger.log('-'.repeat(headerRow.length));
  }

  formatConsoleRow(status: UnifiedOutputStatus): string {
    const configs = this.getColumnConfigs();
    const values = this.getStatusValues(status);

    return configs
      .map((col, i) => {
        let value = values[i];

        // Apply number formatting if specified
        if (
          col.type === 'number' &&
          typeof value === 'number' &&
          col.fixed !== undefined
        ) {
          value = value.toFixed(col.fixed);
        }

        return value.toString().padEnd(col.padEnd);
      })
      .join(' | ');
  }

  private getStatusValues(status: UnifiedOutputStatus): (string | number)[] {
    return [
      status.timestamp,
      status.assetComposition,
      status.assetAmounts,
      status.totalPortfolioValue,
      status.pnl,
      status.return,
      status.netGainVsHold,
      status.capitalUsedInTrading,
      status.totalCapitalLocked,
      status.lpFeesEarned,
      status.tradingFeesPaid,
      status.gasFeesPaid,
      status.maxDrawdown,
      status.maxGain,
      status.impermanentLoss,
      status.assetExposure,
      status.rebalancingActions,
      status.notes || '',
    ];
  }
  formatUnifiedOutputRow(status: UnifiedOutputStatus): string[] {
    return [
      status.timestamp.toString(),
      status.assetComposition,
      status.assetAmounts,
      status.totalPortfolioValue.toFixed(2),
      status.pnl.toFixed(2),
      status.return.toFixed(6),
      status.netGainVsHold.toFixed(2),
      status.capitalUsedInTrading.toFixed(2),
      status.totalCapitalLocked.toFixed(2),
      status.lpFeesEarned.toFixed(6),
      status.tradingFeesPaid.toFixed(2),
      status.gasFeesPaid.toFixed(2),
      status.maxDrawdown.toFixed(6),
      status.maxGain.toFixed(6),
      status.impermanentLoss.toFixed(6),
      status.assetExposure.toFixed(2),
      status.rebalancingActions.toString(),
      status.notes || '',
    ];
  }
  generateTsvFilename(config: PoolTestConfig): string {
    const poolName = config.poolName.toLowerCase().replace('/', '_');
    const positionType = config.positionType.replace('%', 'pct');
    const granularity = config.granularity;
    const startDate = config.startDate.replace(/-/g, '');
    const endDate = config.endDate.replace(/-/g, '');

    // Generate timestamp in YYYYMMDD_HHMMSS format
    const now = new Date();
    const timestamp = now
      .toISOString()
      .replace(/[-:]/g, '')
      .replace('T', '_')
      .substring(0, 15); // YYYYMMDD_HHMMSS

    // Include 'aero' prefix and timestamp for uniqueness
    return `aero_${poolName}_${positionType}_${granularity}_${startDate}_${endDate}_${timestamp}.tsv`;
  }

  exportTsv(filename: string, data: UnifiedOutputStatus[]): void {
    const fullPath = path.join(this.aerodromeExportsPath, filename);

    const headers = this.getUnifiedOutputHeaders();
    const configs = this.getColumnConfigs();

    // Convert data to TSV format using column configs
    const tsvContent = [
      headers.join('\t'),
      ...data.map((status) => {
        const values = this.getStatusValues(status);
        return configs
          .map((col, i) => {
            let value = values[i];

            // Apply number formatting for TSV (use original precision for TSV)
            if (col.type === 'number' && typeof value === 'number') {
              // Use specific precision for TSV export
              if (
                col.name.includes('return') ||
                col.name.includes('fees') ||
                col.name.includes('drawdown') ||
                col.name.includes('gain') ||
                col.name.includes('loss')
              ) {
                value = value.toFixed(6);
              } else {
                value = value.toFixed(2);
              }
            }

            return value.toString();
          })
          .join('\t');
      }),
    ].join('\n');

    // Write to file
    fs.writeFileSync(fullPath, tsvContent, 'utf8');
    logger.log(
      `Unified output exported: ${path.relative(process.cwd(), fullPath)}`,
    );
  }
}
