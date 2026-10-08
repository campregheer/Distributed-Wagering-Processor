import { Module } from '@nestjs/common';
import { WageringModule } from '../wagering/wagering.module';
import { SqsGateway } from './sqs.gateway';
import { MessagingWorker } from './messaging.worker';
import { HealthController } from '../observability/health.controller';

@Module({
  imports: [WageringModule],
  providers: [SqsGateway, MessagingWorker],
  controllers: [HealthController],
})
export class MessagingModule {}
