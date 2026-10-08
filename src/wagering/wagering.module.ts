import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WagerTransactionEntity } from './infrastructure/persistence/wager-transaction.entity';
import { WageringController } from './wagering.controller';
import { WageringService } from './wagering.service';
import { InboxMessageEntity } from '../messaging/infrastructure/inbox-message.entity';
import { OutboxMessageEntity } from '../messaging/infrastructure/outbox-message.entity';
import { ProviderTransactionsController } from './provider-transactions.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WagerTransactionEntity,
      InboxMessageEntity,
      OutboxMessageEntity,
    ]),
  ],
  controllers: [WageringController, ProviderTransactionsController],
  providers: [WageringService],
  exports: [WageringService],
})
export class WageringModule {}
