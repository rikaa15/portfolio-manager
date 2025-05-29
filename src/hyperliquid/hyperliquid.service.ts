import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as hl from "@nktkas/hyperliquid";
import { Hex } from '@nktkas/hyperliquid';

@Injectable()
export class HyperliquidService {
    logger = new Logger(HyperliquidService.name);

    constructor(private configService: ConfigService) {}

    async bootstrap() {
        const transport = new hl.HttpTransport();
        const client = new hl.PublicClient({ transport });

        const walletAddress = this.configService.get<Hex>('WALLET_ADDRESS');
        const userState = await client.clearinghouseState({ user: walletAddress })
        this.logger.log('HyperliquidService boostrap completed');
    }
}
