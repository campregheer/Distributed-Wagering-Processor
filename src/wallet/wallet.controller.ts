import { Inject } from '@nestjs/common';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import { WalletService } from './wallet.service';
import { ProviderAuthGuard } from '../auth/provider-auth.guard';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletController {
  constructor(
    @Inject(WalletService) private readonly walletService: WalletService,
  ) {}

  @Post()
  createWallet(
    @Body('playerId', ParseUUIDPipe) playerId: string,
    @Body('initialBalance') initialBalance: unknown,
  ) {
    return this.walletService.createWallet({ playerId, initialBalance });
  }

  @Get(':id')
  getWallet(@Param('id', ParseUUIDPipe) id: string) {
    return this.walletService.findById(id);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.walletService.ledger(walletId, cursor, limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId', ParseUUIDPipe) walletId: string) {
    return this.walletService.reconcile(walletId);
  }
}
