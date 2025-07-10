import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PoolTestConfig } from './types';
import { logger } from './aerodrome.utils';

export interface TsvDataRow {
  day: number;
  date: string;
  tvl: number;
  value: number;
  fees: number;
  il: number;
  pnl: number;
  apr: number;
  gas?: number;
  rangeStatus: string;
  rebalanceStatus: string;
  tick?: number;
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

  exportTsv(filename: string, data: TsvDataRow[]): void {
    const fullPath = path.join(this.aerodromeExportsPath, filename);

    // Create headers - clean column names without labels
    const headers = [
      'day',
      'date',
      'tvl',
      'value',
      'fees',
      'il',
      'pnl',
      'apr',
      'gas',
      'range_status',
      'rebalance_status',
      'tick',
    ];

    // Convert data to TSV format
    const tsvContent = [
      headers.join('\t'),
      ...data.map((row) =>
        [
          row.day,
          row.date,
          row.tvl.toFixed(2),
          row.value.toFixed(2),
          row.fees.toFixed(2),
          row.il.toFixed(2),
          row.pnl.toFixed(2),
          row.apr.toFixed(3),
          row.gas?.toFixed(0) || '0',
          row.rangeStatus,
          row.rebalanceStatus,
          row.tick?.toString() || '',
        ].join('\t'),
      ),
    ].join('\n');

    // Write to file
    fs.writeFileSync(fullPath, tsvContent, 'utf8');
    logger.log(`TSV file exported: ${path.relative(process.cwd(), fullPath)}`);
  }
}
