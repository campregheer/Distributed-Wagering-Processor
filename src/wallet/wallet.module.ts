import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { WalletEntity } from './infrastructure/persistence/wallet.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletLedgerEntryEntity } from './infrastructure/persistence/wallet-ledger-entry.entity';

@Module({
  imports: [TypeOrmModule.forFeature([WalletEntity, WalletLedgerEntryEntity])],
  controllers: [WalletController],
  providers: [WalletService]
})
export class WalletModule {}
