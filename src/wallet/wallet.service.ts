import { Inject } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';

import { Money } from './domain/money';
import { metrics } from '../observability/metrics';
import { Wallet } from './domain/wallet';
import { WalletLedgerEntry } from './domain/wallet-ledger-entry';
import { LedgerDirection } from './domain/ledger-direction';

import {
  WagerTransaction,
  WagerTransactionKind,
} from '../wagering/wager-transaction';

import { WalletEntity } from './infrastructure/persistence/wallet.entity';
import { WalletLedgerEntryEntity } from './infrastructure/persistence/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from '../wagering/infrastructure/persistence/wager-transaction.entity';
import { OutboxMessageEntity } from '../messaging/infrastructure/outbox-message.entity';
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from '../wagering/events/wagering.events';

interface CreateWalletInput {
  playerId: string;
  initialBalance: unknown;
}

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: {
    amount: string;
    currency: string;
  };
  version: number;
}

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  async createWallet(input: CreateWalletInput): Promise<WalletResponse> {
    const initialBalance = this.parseInitialBalance(input.initialBalance);

    let wallet: Wallet;

    try {
      wallet = Wallet.open({
        id: randomUUID(),
        playerId: input.playerId,
        initialBalance,
      });
    } catch {
      throw new BadRequestException('Saldo inicial inválido.');
    }

    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.insert(WalletEntity, {
          id: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
          balance: wallet.balance.toJSON().amount,
          version: wallet.version,
          createdAt: wallet.createdAt,
          updatedAt: wallet.updatedAt,
        });

        if (wallet.balance.isZero()) {
          return;
        }

        const externalTransactionId = `opening:${wallet.id}`;
        const idempotencyKey = `internal:${externalTransactionId}`;

        const payloadHash = createHash('sha256')
          .update(
            JSON.stringify({
              kind: WagerTransactionKind.Opening,
              walletId: wallet.id,
              playerId: wallet.playerId,
              money: wallet.balance.toJSON(),
            }),
          )
          .digest('hex');

        const opening = WagerTransaction.create({
          id: randomUUID(),
          providerId: 'internal',
          externalTransactionId,
          idempotencyKey,
          payloadHash,
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: externalTransactionId,
          gameId: 'wallet-opening',
          kind: WagerTransactionKind.Opening,
          money: wallet.balance,
        });

        opening.markProcessed(undefined, new Date());

        await manager.insert(WagerTransactionEntity, {
          id: opening.id,
          providerId: opening.providerId,
          externalTransactionId: opening.externalTransactionId,
          idempotencyKey: opening.idempotencyKey,
          payloadHash: opening.payloadHash,
          walletId: opening.walletId,
          playerId: opening.playerId,
          roundId: opening.roundId,
          gameId: opening.gameId,
          kind: opening.kind,
          status: opening.status,
          amount: opening.money.toJSON().amount,
          currency: opening.money.currency,
          referenceExternalTransactionId: null,
          referenceTransactionId: null,
          failureCode: null,
          createdAt: opening.createdAt,
          processedAt: opening.processedAt ?? null,
          resultBalance: wallet.balance.toJSON().amount,
          resultCurrency: wallet.currency,
          correlationId: opening.id,
        });

        const ledgerEntry = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: opening.id,
          direction: LedgerDirection.Credit,
          money: wallet.balance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: wallet.balance,
        });

        await manager.insert(WalletLedgerEntryEntity, {
          id: ledgerEntry.id,
          walletId: ledgerEntry.walletId,
          transactionId: ledgerEntry.transactionId,
          direction: ledgerEntry.direction,
          amount: ledgerEntry.money.toJSON().amount,
          balanceBefore: ledgerEntry.balanceBefore.toJSON().amount,
          balanceAfter: ledgerEntry.balanceAfter.toJSON().amount,
          currency: ledgerEntry.money.currency,
          createdAt: ledgerEntry.createdAt,
        });

        const props = {
          aggregateId: wallet.id,
          correlationId: opening.id,
          occurredAt: new Date(),
        };
        const events = [
          WagerTransactionProcessed.create({
            ...props,
            eventId: randomUUID(),
            data: {
              transactionId: opening.id,
              walletId: wallet.id,
              providerId: opening.providerId,
              externalTransactionId: opening.externalTransactionId,
              kind: opening.kind,
              money: opening.money.toJSON(),
              balance: wallet.balance.toJSON(),
            },
          }),
          WalletBalanceChanged.create({
            ...props,
            eventId: randomUUID(),
            data: {
              walletId: wallet.id,
              transactionId: opening.id,
              direction: ledgerEntry.direction,
              money: ledgerEntry.money.toJSON(),
              balanceBefore: ledgerEntry.balanceBefore.toJSON(),
              balanceAfter: ledgerEntry.balanceAfter.toJSON(),
              walletVersion: wallet.version,
            },
          }),
        ];
        for (const event of events)
          await manager.insert(OutboxMessageEntity, {
            id: event.eventId,
            aggregateId: event.aggregateId,
            eventType: event.eventType,
            payload: event.toJSON(),
            occurredAt: event.occurredAt,
            attempts: 0,
            nextAttemptAt: null,
            publishedAt: null,
          });
      });
    } catch (error) {
      if (error instanceof QueryFailedError) {
        const databaseError = error.driverError as {
          code?: string;
          constraint?: string;
        };

        if (
          databaseError.code === '23505' &&
          databaseError.constraint === 'UQ_wallet_player_currency'
        ) {
          throw new ConflictException(
            'Já existe uma wallet para este jogador e esta moeda.',
          );
        }
      }

      throw error;
    }

    return this.toResponse(wallet);
  }

  async findById(id: string): Promise<WalletResponse> {
    const entity = await this.dataSource
      .getRepository(WalletEntity)
      .findOneBy({ id });

    if (!entity) {
      throw new NotFoundException('Wallet não encontrada.');
    }

    const wallet = Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.from({
        amount: entity.balance,
        currency: entity.currency,
      }),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });

    return this.toResponse(wallet);
  }

  async ledger(walletId: string, cursor?: string, limitInput?: string) {
    const limit = limitInput === undefined ? 50 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException('limit deve ser um inteiro entre 1 e 100.');
    await this.findById(walletId);
    let anchor: { createdAt: string; id: string; walletId: string } | undefined;
    if (cursor !== undefined) {
      try {
        anchor = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (
          !anchor ||
          anchor.walletId !== walletId ||
          typeof anchor.createdAt !== 'string' ||
          !Number.isFinite(Date.parse(anchor.createdAt)) ||
          typeof anchor.id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            anchor.id,
          )
        )
          throw new Error();
      } catch {
        throw new BadRequestException('Cursor inválido para esta wallet.');
      }
    }
    const rows = await this.dataSource.query(
      `SELECT *, created_at::text AS cursor_time FROM wallet_ledger_entries
      WHERE wallet_id = $1 ${anchor ? 'AND (created_at, id) > ($3::timestamptz, $4::uuid)' : ''}
      ORDER BY created_at, id LIMIT $2`,
      anchor
        ? [walletId, limit + 1, anchor.createdAt, anchor.id]
        : [walletId, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map((row: Record<string, any>) => ({
        id: row.id,
        walletId: row.wallet_id,
        transactionId: row.transaction_id,
        direction: row.direction,
        money: { amount: row.amount, currency: row.currency },
        balanceBefore: { amount: row.balance_before, currency: row.currency },
        balanceAfter: { amount: row.balance_after, currency: row.currency },
        createdAt: row.created_at,
      })),
      nextCursor:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify({
                walletId,
                createdAt: last.cursor_time,
                id: last.id,
              }),
            ).toString('base64url')
          : null,
    };
  }

  async reconcile(walletId: string) {
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const wallet = await manager.findOneBy(WalletEntity, { id: walletId });
      if (!wallet) throw new NotFoundException('Wallet não encontrada.');
      const [totals] = await manager.query(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20,2)::text AS balance,
        COUNT(*)::integer AS entries FROM wallet_ledger_entries WHERE wallet_id = $1`,
        [walletId],
      );
      // A soma pode ser negativa em dados corrompidos; Money.from só aceita entradas não negativas.
      const negative = totals.balance.startsWith('-');
      const magnitude = Money.from({
        amount: negative ? totals.balance.slice(1) : totals.balance,
        currency: wallet.currency,
      });
      const calculated = negative ? magnitude.negate() : magnitude;
      const stored = Money.from({
        amount: wallet.balance,
        currency: wallet.currency,
      });
      const difference = stored.subtract(calculated);
      const consistent = difference.isZero();
      if (!consistent) {
        metrics.increment('wager_reconciliation_mismatches_total');
        this.logger.warn(
          JSON.stringify({
            event: 'ReconciliationMismatch',
            walletId,
            checkedEntries: totals.entries,
          }),
        );
      }
      return {
        walletId,
        storedBalance: stored.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: totals.entries,
      };
    });
  }

  private parseInitialBalance(value: unknown): Money {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BadRequestException(
        'initialBalance deve conter amount e currency.',
      );
    }

    const input = value as Record<string, unknown>;

    if (
      typeof input.amount !== 'string' ||
      typeof input.currency !== 'string'
    ) {
      throw new BadRequestException('amount e currency devem ser strings.');
    }

    try {
      return Money.from({
        amount: input.amount,
        currency: input.currency,
      });
    } catch {
      throw new BadRequestException('Saldo inicial inválido.');
    }
  }

  private toResponse(wallet: Wallet): WalletResponse {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
