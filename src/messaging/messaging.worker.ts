import { Inject, Injectable, Logger, HttpException } from '@nestjs/common';
import type { OnModuleInit, BeforeApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Message } from '@aws-sdk/client-sqs';
import { SqsGateway } from './sqs.gateway';
import { WageringService } from '../wagering/wagering.service';
import type { SubmitTransactionDto } from '../wagering/dto/submit-transaction.dto';
import { OutboxMessageEntity } from './infrastructure/outbox-message.entity';
import { OutboxMessage } from './domain/outbox-message';
import { metrics } from '../observability/metrics';

const REQUESTS = 'wager-transactions.fifo';
const DLQ = 'wager-transactions-dlq.fifo';
const EVENTS = 'wager-events.fifo';

@Injectable()
export class MessagingWorker
  implements OnModuleInit, BeforeApplicationShutdown
{
  private readonly logger = new Logger(MessagingWorker.name);
  private stopping = false;
  private loops: Promise<void>[] = [];
  constructor(
    @Inject(DataSource) private readonly db: DataSource,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
    @Inject(WageringService) private readonly wagering: WageringService,
  ) {}

  onModuleInit(): void {
    if (process.env.WORKERS_ENABLED === 'false') return;
    this.loops = [
      this.run(() => this.consumeOnce()),
      this.run(() => this.publishOnce()),
      this.run(() => this.referencesOnce()),
    ];
  }
  private async run(work: () => Promise<unknown>): Promise<void> {
    while (!this.stopping) {
      try {
        await work();
      } catch (error) {
        this.logger.error(
          JSON.stringify({
            event: 'WorkerRetry',
            errorType: error instanceof Error ? error.name : 'UnknownError',
          }),
        );
      }
      if (!this.stopping) await delay(500);
    }
  }
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.loops);
    this.sqs.client.destroy();
  }

  async consumeOnce(): Promise<void> {
    const messages = await this.sqs.receive(REQUESTS);
    for (const message of messages) await this.handleMessage(message);
  }

  async handleMessage(message: Message): Promise<void> {
    if (!message.ReceiptHandle || !message.Body) return;
    const receipt = message.ReceiptHandle;
    const receiveCount = Number(
      message.Attributes?.ApproximateReceiveCount ?? 1,
    );
    let context: Record<string, unknown> = {
      event: 'WagerMessage',
      messageId: message.MessageId,
    };
    let validRequest:
      | {
          data: SubmitTransactionDto & { idempotencyKey: string };
          messageId: string;
        }
      | undefined;
    try {
      const envelope = JSON.parse(message.Body);
      if (
        envelope.type !== 'WagerTransactionRequested' ||
        typeof envelope.messageId !== 'string' ||
        !envelope.messageId.trim() ||
        envelope.messageId.length > 255 ||
        typeof envelope.occurredAt !== 'string' ||
        !Number.isFinite(Date.parse(envelope.occurredAt)) ||
        typeof envelope.data !== 'object' ||
        !envelope.data
      ) {
        throw new HttpException('Envelope inválido.', 400);
      }
      const data = envelope.data as SubmitTransactionDto & {
        idempotencyKey: string;
      };
      this.wagering.validateSubmission(data, data.idempotencyKey);
      validRequest = { data, messageId: envelope.messageId };
      context = {
        ...context,
        messageId: envelope.messageId,
        correlationId: envelope.messageId,
        walletId: typeof data.walletId === 'string' ? data.walletId : undefined,
        providerId:
          typeof data.providerId === 'string' ? data.providerId : undefined,
      };
      const result = await this.wagering.submitTransaction(
        data,
        data.idempotencyKey,
        {
          correlationId: envelope.messageId,
          causationId: envelope.messageId,
          inbox: {
            consumerName: 'wager-transactions',
            messageId: envelope.messageId,
            payloadHash: createHash('sha256')
              .update(message.Body)
              .digest('hex'),
          },
        },
      );
      // submitTransaction só resolve depois do commit; rejeição de negócio também é resultado auditado.
      await this.sqs.ack(REQUESTS, receipt);
      this.logger.log(
        JSON.stringify({
          ...context,
          transactionId: result.transactionId,
          status: result.status,
        }),
      );
    } catch (error) {
      const permanent =
        error instanceof SyntaxError ||
        (error instanceof HttpException && error.getStatus() < 500);
      if (permanent || receiveCount >= 5) {
        if (!permanent && validRequest) {
          await this.wagering.recordPermanentFailure(
            validRequest.data,
            validRequest.data.idempotencyKey,
            {
              correlationId: validRequest.messageId,
              causationId: validRequest.messageId,
              inbox: {
                consumerName: 'wager-transactions',
                messageId: validRequest.messageId,
                payloadHash: createHash('sha256')
                  .update(message.Body)
                  .digest('hex'),
              },
            },
          );
        }
        await this.sqs.publish(
          DLQ,
          { originalBody: message.Body, sourceMessageId: message.MessageId },
          message.MessageId ?? 'invalid',
          message.MessageId ??
            createHash('sha256').update(message.Body).digest('hex'),
        );
        await this.sqs.ack(REQUESTS, receipt);
        metrics.increment('wager_dlq_total');
        this.logger.warn(
          JSON.stringify({ ...context, event: 'MessageMovedToDlq' }),
        );
      } else {
        await this.sqs.retry(
          REQUESTS,
          receipt,
          Math.min(2 ** receiveCount, 30),
        );
        metrics.increment('wager_retries_total');
      }
    }
  }

  async publishOnce(): Promise<boolean> {
    return this.db.transaction(async (manager) => {
      const entity = await manager
        .createQueryBuilder(OutboxMessageEntity, 'message')
        .where(
          'message.published_at IS NULL AND (message.next_attempt_at IS NULL OR message.next_attempt_at <= :now)',
          { now: new Date() },
        )
        .orderBy('message.occurred_at', 'ASC')
        .addOrderBy('message.id', 'ASC')
        .take(1)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getOne();
      if (!entity) return false;
      const message = OutboxMessage.rehydrate({
        id: entity.id,
        aggregateId: entity.aggregateId,
        eventType: entity.eventType,
        payload: entity.payload,
        occurredAt: entity.occurredAt,
        attempts: entity.attempts,
        nextAttemptAt: entity.nextAttemptAt ?? undefined,
        publishedAt: entity.publishedAt ?? undefined,
      });
      try {
        await this.sqs.publish(
          EVENTS,
          message.payload,
          message.aggregateId,
          message.id,
        );
        message.markPublished(new Date());
      } catch {
        message.scheduleRetry(new Date());
        metrics.increment('wager_retries_total');
      }
      await manager.update(OutboxMessageEntity, entity.id, {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
      });
      return true;
    });
  }

  async referencesOnce(): Promise<void> {
    const rows = await this.db
      .query(`SELECT id FROM wager_transactions WHERE status = 'PENDING_REFERENCE'
      AND (reference_next_attempt_at IS NULL OR reference_next_attempt_at <= now()) ORDER BY created_at, id LIMIT 100`);
    for (const row of rows) await this.wagering.reprocessReference(row.id);
    const [lag] = await this.db.query(
      `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MIN(occurred_at))), 0)::float AS seconds FROM outbox_messages WHERE published_at IS NULL`,
    );
    metrics.set('wager_outbox_lag_seconds', Math.max(0, Number(lag.seconds)));
  }
}
