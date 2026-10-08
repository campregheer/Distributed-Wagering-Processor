import { Inject } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';

import type { SubmitTransactionDto } from './dto/submit-transaction.dto';
import { Money, MoneyDomainError } from '../wallet/domain/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  FailureCode,
} from './wager-transaction';
import { Wallet } from '../wallet/domain/wallet';
import { WalletLedgerEntry } from '../wallet/domain/wallet-ledger-entry';
import { LedgerDirection } from '../wallet/domain/ledger-direction';
import { WalletEntity } from '../wallet/infrastructure/persistence/wallet.entity';
import { WalletLedgerEntryEntity } from '../wallet/infrastructure/persistence/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from './infrastructure/persistence/wager-transaction.entity';
import { InboxMessageEntity } from '../messaging/infrastructure/inbox-message.entity';
import { OutboxMessage } from '../messaging/domain/outbox-message';
import type { IntegrationEvent } from '../messaging/domain/integration-event';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  WagerTransactionFailed,
  WalletBalanceChanged,
} from './events/wagering.events';
import { transactionPayloadHash } from './payload-hash';
import { metrics } from '../observability/metrics';

export interface TransactionResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
}

export interface SubmissionContext {
  correlationId?: string;
  causationId?: string;
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}

@Injectable()
export class WageringService {
  private readonly logger = new Logger(WageringService.name);
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  async submitTransaction(
    body: SubmitTransactionDto,
    idempotencyKey: string,
    context: SubmissionContext = {},
  ): Promise<TransactionResponse> {
    return this.executeSubmission(body, idempotencyKey, context);
  }

  async recordPermanentFailure(
    body: SubmitTransactionDto,
    idempotencyKey: string,
    context: SubmissionContext,
  ): Promise<TransactionResponse> {
    return this.executeSubmission(body, idempotencyKey, context, true);
  }

  private async executeSubmission(
    body: SubmitTransactionDto,
    idempotencyKey: string,
    context: SubmissionContext,
    permanentFailure = false,
  ): Promise<TransactionResponse> {
    const { money, kind } = this.validateSubmission(body, idempotencyKey);
    const hash = transactionPayloadHash(body);
    const startedAt = Date.now();
    try {
      const result = await this.dataSource.transaction(async (manager) => {
        const walletEntity = await manager.findOne(WalletEntity, {
          where: { id: body.walletId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!walletEntity)
          throw new NotFoundException('Wallet não encontrada.');

        if (context.inbox) {
          await manager
            .createQueryBuilder()
            .insert()
            .into(InboxMessageEntity)
            .values({
              ...context.inbox,
              receivedAt: new Date(),
              processedAt: null,
            })
            .orIgnore()
            .execute();
          const inbox = await manager.findOneByOrFail(InboxMessageEntity, {
            consumerName: context.inbox.consumerName,
            messageId: context.inbox.messageId,
          });
          if (inbox.payloadHash !== context.inbox.payloadHash)
            throw new ConflictException(
              'messageId reutilizado com payload diferente.',
            );
        }

        const wager = WagerTransaction.create({
          ...body,
          kind,
          money,
          id: randomUUID(),
          idempotencyKey,
          payloadHash: hash,
        });
        const inserted = await manager
          .createQueryBuilder()
          .insert()
          .into(WagerTransactionEntity)
          .values({
            id: wager.id,
            providerId: body.providerId,
            externalTransactionId: body.externalTransactionId,
            idempotencyKey,
            payloadHash: hash,
            walletId: body.walletId,
            playerId: body.playerId,
            roundId: body.roundId,
            gameId: body.gameId,
            kind,
            status: wager.status,
            amount: money.toJSON().amount,
            currency: money.currency,
            referenceExternalTransactionId:
              body.referenceExternalTransactionId ?? null,
            referenceTransactionId: null,
            failureCode: null,
            createdAt: wager.createdAt,
            processedAt: null,
            resultBalance: walletEntity.balance,
            resultCurrency: walletEntity.currency,
            correlationId: context.correlationId ?? wager.id,
            referenceAttempts: 0,
            referenceNextAttemptAt: null,
          })
          .orIgnore()
          .returning('id')
          .execute();

        let response: TransactionResponse;
        if (inserted.raw.length === 0) {
          const existing = await manager.find(WagerTransactionEntity, {
            where: [
              { idempotencyKey },
              {
                providerId: body.providerId,
                externalTransactionId: body.externalTransactionId,
              },
            ],
          });
          if (
            existing.length !== 1 ||
            existing[0].idempotencyKey !== idempotencyKey ||
            existing[0].payloadHash !== hash
          ) {
            throw new ConflictException(
              'Chave de idempotência ou identificação externa em conflito.',
            );
          }
          response =
            permanentFailure &&
            ['PENDING', 'PENDING_REFERENCE'].includes(existing[0].status)
              ? await this.process(
                  manager,
                  this.rehydrate(existing[0]),
                  walletEntity,
                  context,
                  FailureCode.PERMANENT_INFRASTRUCTURE_FAILURE,
                )
              : this.toResponse(existing[0], true);
        } else {
          response = await this.process(
            manager,
            wager,
            walletEntity,
            context,
            permanentFailure
              ? FailureCode.PERMANENT_INFRASTRUCTURE_FAILURE
              : undefined,
          );
        }
        if (context.inbox)
          await manager.update(
            InboxMessageEntity,
            {
              consumerName: context.inbox.consumerName,
              messageId: context.inbox.messageId,
            },
            { processedAt: new Date() },
          );
        return response;
      });
      if (result.idempotentReplay) metrics.increment('wager_duplicates_total');
      else metrics.increment('wager_transactions_total', result.status);
      metrics.observeLatency(Date.now() - startedAt);
      this.logger.log({
        event: 'WagerTransactionResult',
        correlationId: context.correlationId ?? result.transactionId,
        messageId: context.inbox?.messageId,
        transactionId: result.transactionId,
        walletId: body.walletId,
        providerId: body.providerId,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
      });
      return result;
    } catch (error) {
      const code =
        (error as { code?: string; driverError?: { code?: string } })
          .driverError?.code ?? (error as { code?: string }).code;
      if (
        [
          '40001',
          '40P01',
          '55P03',
          '57P01',
          'ECONNREFUSED',
          'ECONNRESET',
          'ETIMEDOUT',
        ].includes(code ?? '')
      ) {
        if (['40001', '40P01', '55P03'].includes(code ?? ''))
          metrics.increment('wager_lock_conflicts_total');
        throw new ServiceUnavailableException(
          'Infraestrutura temporariamente indisponível; reenvie com a mesma chave.',
        );
      }
      throw error;
    }
  }

  validateSubmission(
    body: SubmitTransactionDto,
    idempotencyKey: string,
  ): { money: Money; kind: WagerTransactionKind } {
    const kind = this.parseKind(body?.kind);
    this.validateIdentifiers(body, idempotencyKey);
    const money = this.parseMoney(body?.money);

    if (kind === WagerTransactionKind.Bet && !money.isPositive()) {
      throw new BadRequestException(
        'O valor da aposta deve ser maior que zero.',
      );
    }
    if (kind === WagerTransactionKind.Win && !money.isPositive()) {
      throw new BadRequestException(
        'O valor do prêmio deve ser maior que zero.',
      );
    }

    return { money, kind };
  }

  private async process(
    manager: EntityManager,
    wager: WagerTransaction,
    entity: WalletEntity,
    context: SubmissionContext,
    forcedFailure?: FailureCode,
  ): Promise<TransactionResponse> {
    const wallet = Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      balance: Money.from({
        amount: entity.balance,
        currency: entity.currency,
      }),
    });
    let code: FailureCode | undefined = forcedFailure;
    let reference: WagerTransaction | undefined;
    if (!code && wallet.playerId.toLowerCase() !== wager.playerId.toLowerCase())
      code = FailureCode.PLAYER_MISMATCH;
    else if (!code && wallet.currency !== wager.money.currency)
      code = FailureCode.CURRENCY_MISMATCH;

    if (!code && wager.referenceExternalTransactionId) {
      const referenceEntity = await manager.findOneBy(WagerTransactionEntity, {
        providerId: wager.providerId,
        externalTransactionId: wager.referenceExternalTransactionId,
      });
      if (
        !referenceEntity ||
        ['PENDING', 'PENDING_REFERENCE'].includes(referenceEntity.status)
      ) {
        if (wager.status === WagerTransactionStatus.Pending)
          wager.markPendingReference();
      } else {
        reference = this.rehydrate(referenceEntity);
        code = wager.referenceFailureCode(reference);
        if (!code && wager.requiresReference()) {
          const previous = await manager.findOneBy(WagerTransactionEntity, {
            referenceTransactionId: reference.id,
            kind: wager.kind,
            status: WagerTransactionStatus.Processed,
          });
          if (previous) code = FailureCode.ALREADY_REVERSED;
        }
      }
    }

    let entry: WalletLedgerEntry | undefined;
    if (
      !code &&
      (wager.status !== WagerTransactionStatus.PendingReference || reference)
    ) {
      if (wager.affectsBalance() && !wager.money.isZero()) {
        const direction = wager.ledgerDirectionFor(reference);
        if (
          direction === LedgerDirection.Debit &&
          wallet.balance.isLessThan(wager.money)
        ) {
          code =
            wager.kind === WagerTransactionKind.Bet
              ? FailureCode.INSUFFICIENT_FUNDS
              : FailureCode.REVERSAL_WOULD_OVERDRAW;
        } else {
          try {
            const balances =
              direction === LedgerDirection.Debit
                ? wallet.debit(wager.money)
                : wallet.credit(wager.money);
            entry = WalletLedgerEntry.create({
              id: randomUUID(),
              walletId: wallet.id,
              transactionId: wager.id,
              direction,
              money: wager.money,
              ...balances,
            });
          } catch (error) {
            if (error instanceof MoneyDomainError)
              code = FailureCode.MONEY_LIMIT_EXCEEDED;
            else throw error;
          }
        }
      }
      if (!code) wager.markProcessed(reference?.id, new Date());
    }
    if (code === FailureCode.PERMANENT_INFRASTRUCTURE_FAILURE) wager.fail(code);
    else if (code) wager.reject(code);

    if (entry) {
      await manager.update(WalletEntity, wallet.id, {
        balance: wallet.balance.toJSON().amount,
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      });
      await manager.insert(WalletLedgerEntryEntity, {
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        amount: entry.money.toJSON().amount,
        currency: entry.money.currency,
        balanceBefore: entry.balanceBefore.toJSON().amount,
        balanceAfter: entry.balanceAfter.toJSON().amount,
        createdAt: entry.createdAt,
      });
    }
    await manager.update(WagerTransactionEntity, wager.id, {
      status: wager.status,
      failureCode: wager.failureCode ?? null,
      referenceTransactionId: wager.referenceTransactionId ?? null,
      processedAt: wager.processedAt ?? null,
      resultBalance: wallet.balance.toJSON().amount,
      resultCurrency: wallet.currency,
      referenceNextAttemptAt:
        wager.status === WagerTransactionStatus.PendingReference
          ? new Date(Date.now() + 1000)
          : null,
    });

    const eventProps = {
      eventId: randomUUID(),
      aggregateId: wallet.id,
      correlationId: context.correlationId ?? wager.id,
      causationId: context.causationId,
      occurredAt: new Date(),
    };
    const data = {
      transactionId: wager.id,
      walletId: wallet.id,
      providerId: wager.providerId,
      externalTransactionId: wager.externalTransactionId,
      kind: wager.kind,
      money: wager.money.toJSON(),
    };
    if (wager.status === WagerTransactionStatus.Processed) {
      await this.enqueue(
        manager,
        WagerTransactionProcessed.create({
          ...eventProps,
          data: { ...data, balance: wallet.balance.toJSON() },
        }),
      );
    } else if (wager.status === WagerTransactionStatus.Rejected) {
      await this.enqueue(
        manager,
        WagerTransactionRejected.create({
          ...eventProps,
          data: { ...data, failureCode: wager.failureCode! },
        }),
      );
    } else if (wager.status === WagerTransactionStatus.Failed) {
      await this.enqueue(
        manager,
        WagerTransactionFailed.create({
          ...eventProps,
          data: { ...data, failureCode: wager.failureCode! },
        }),
      );
    } else if (wager.status === WagerTransactionStatus.PendingReference) {
      await this.enqueue(
        manager,
        WagerTransactionPendingReference.create({
          ...eventProps,
          data: {
            ...data,
            referenceExternalTransactionId:
              wager.referenceExternalTransactionId!,
          },
        }),
      );
    }
    if (entry)
      await this.enqueue(
        manager,
        WalletBalanceChanged.create({
          ...eventProps,
          eventId: randomUUID(),
          data: {
            walletId: wallet.id,
            transactionId: wager.id,
            direction: entry.direction,
            money: entry.money.toJSON(),
            balanceBefore: entry.balanceBefore.toJSON(),
            balanceAfter: entry.balanceAfter.toJSON(),
            walletVersion: wallet.version,
          },
        }),
      );
    return {
      transactionId: wager.id,
      status: wager.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
      ...(wager.failureCode ? { failureCode: wager.failureCode } : {}),
    };
  }

  private async enqueue(
    manager: EntityManager,
    event: IntegrationEvent<unknown>,
  ): Promise<void> {
    const message = OutboxMessage.enqueue(event);
    await manager.query(
      `INSERT INTO outbox_messages
      (id, aggregate_id, event_type, payload, occurred_at, attempts)
      VALUES ($1, $2, $3, $4, $5, 0)`,
      [
        message.id,
        message.aggregateId,
        message.eventType,
        message.payload,
        message.occurredAt,
      ],
    );
  }

  private rehydrate(entity: WagerTransactionEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      createdAt: entity.createdAt,
      kind: entity.kind as WagerTransactionKind,
      status: entity.status as WagerTransactionStatus,
      money: Money.from({ amount: entity.amount, currency: entity.currency }),
      referenceExternalTransactionId:
        entity.referenceExternalTransactionId ?? undefined,
      referenceTransactionId: entity.referenceTransactionId ?? undefined,
      failureCode: entity.failureCode
        ? (entity.failureCode as FailureCode)
        : undefined,
      processedAt: entity.processedAt ?? undefined,
    });
  }

  private toResponse(
    entity: WagerTransactionEntity,
    replay: boolean,
  ): TransactionResponse {
    return {
      transactionId: entity.id,
      status: entity.status as WagerTransactionStatus,
      balance: {
        amount: entity.resultBalance!,
        currency: entity.resultCurrency ?? entity.currency,
      },
      idempotentReplay: replay,
      ...(entity.failureCode ? { failureCode: entity.failureCode } : {}),
    };
  }

  async findById(id: string): Promise<TransactionResponse> {
    const entity = await this.dataSource
      .getRepository(WagerTransactionEntity)
      .findOneBy({ id });
    if (!entity) throw new NotFoundException('Transação não encontrada.');
    return this.toResponse(entity, false);
  }

  async reprocessReference(id: string, now = new Date()): Promise<void> {
    const candidate = await this.dataSource
      .getRepository(WagerTransactionEntity)
      .findOneBy({ id });
    if (!candidate) return;
    await this.dataSource.transaction(async (manager) => {
      const wallet = await manager.findOne(WalletEntity, {
        where: { id: candidate.walletId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!wallet) return;
      const current = await manager.findOneByOrFail(WagerTransactionEntity, {
        id,
      });
      if (
        current.status !== WagerTransactionStatus.PendingReference ||
        (current.referenceNextAttemptAt && current.referenceNextAttemptAt > now)
      )
        return;
      const reference = await manager.findOneBy(WagerTransactionEntity, {
        providerId: current.providerId,
        externalTransactionId: current.referenceExternalTransactionId!,
      });
      const exhausted = current.referenceAttempts >= 10;
      if (
        !exhausted &&
        (!reference ||
          ['PENDING', 'PENDING_REFERENCE'].includes(reference.status))
      ) {
        const attempts = current.referenceAttempts + 1;
        await manager.update(WagerTransactionEntity, id, {
          referenceAttempts: attempts,
          referenceNextAttemptAt: new Date(
            now.getTime() + Math.min(1000 * 2 ** attempts, 300000),
          ),
        });
        metrics.increment('wager_retries_total');
        return;
      }
      const result = await this.process(
        manager,
        this.rehydrate(current),
        wallet,
        { correlationId: current.correlationId ?? id },
        exhausted && !reference
          ? FailureCode.REFERENCE_NOT_FOUND
          : exhausted &&
              reference &&
              ['PENDING', 'PENDING_REFERENCE'].includes(reference.status)
            ? FailureCode.REFERENCE_NOT_PROCESSED
            : undefined,
      );
      metrics.increment('wager_transactions_total', result.status);
    });
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionResponse> {
    const entity = await this.dataSource
      .getRepository(WagerTransactionEntity)
      .findOneBy({ providerId, externalTransactionId });
    if (!entity) throw new NotFoundException('Transação não encontrada.');
    return this.toResponse(entity, false);
  }

  private validateIdentifiers(
    body: SubmitTransactionDto,
    idempotencyKey: string,
  ): void {
    this.assertIdentifier(idempotencyKey, 'Idempotency-Key', 255);
    this.assertIdentifier(body.providerId, 'providerId', 100);
    this.assertIdentifier(
      body.externalTransactionId,
      'externalTransactionId',
      150,
    );
    this.assertIdentifier(body.roundId, 'roundId', 255);
    this.assertIdentifier(body.gameId, 'gameId', 255);

    for (const field of ['playerId', 'walletId'] as const) {
      if (
        typeof body[field] !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          body[field],
        )
      ) {
        throw new BadRequestException(`${field} deve ser um UUID válido.`);
      }
    }

    const reference = body.referenceExternalTransactionId;
    if (
      reference !== undefined ||
      body.kind === WagerTransactionKind.Refund ||
      body.kind === WagerTransactionKind.Rollback
    ) {
      this.assertIdentifier(reference, 'referenceExternalTransactionId', 150);
    }
  }

  private assertIdentifier(
    value: unknown,
    field: string,
    maxLength: number,
  ): void {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      Array.from(value).length > maxLength
    ) {
      throw new BadRequestException(
        `${field} deve ser uma string não vazia de até ${maxLength} caracteres.`,
      );
    }
  }

  private parseKind(value: unknown): WagerTransactionKind {
    switch (value) {
      case WagerTransactionKind.Bet:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Loss:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Rollback:
        return value;
      default:
        throw new BadRequestException(
          'kind deve ser BET, WIN, LOSS, REFUND ou ROLLBACK.',
        );
    }
  }

  private parseMoney(value: unknown): Money {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BadRequestException('money deve conter amount e currency.');
    }

    const input = value as Record<string, unknown>;

    if (
      typeof input.amount !== 'string' ||
      typeof input.currency !== 'string'
    ) {
      throw new BadRequestException('amount e currency devem ser strings.');
    }

    try {
      return Money.from({ amount: input.amount, currency: input.currency });
    } catch (error) {
      if (error instanceof MoneyDomainError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
