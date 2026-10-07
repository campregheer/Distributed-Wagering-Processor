import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WagerTransactionEntity } from './infrastructure/persistence/wager-transaction.entity';
import { WageringController } from './wagering.controller';
import { WageringService } from './wagering.service';


@Module({
  imports: [TypeOrmModule.forFeature([WagerTransactionEntity])],
  controllers: [WageringController],
  providers: [WageringService],
})
export class WageringModule {}
