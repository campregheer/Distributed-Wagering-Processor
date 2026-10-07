import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { WalletService } from './wallet.service';

@Controller('wallets')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

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
}