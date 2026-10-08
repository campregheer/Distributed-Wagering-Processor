import {
  Controller,
  Get,
  Header,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SqsGateway } from '../messaging/sqs.gateway';
import { metrics } from './metrics';

@Controller()
export class HealthController {
  constructor(
    @Inject(DataSource) private readonly db: DataSource,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
  ) {}
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }
  @Get('health/ready')
  async ready() {
    try {
      await Promise.all([this.db.query('SELECT 1'), this.sqs.ready()]);
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('PostgreSQL ou SQS indisponível.');
    }
  }
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metrics() {
    return metrics.render();
  }
}
