import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';

import { Money } from './domain/money';
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
  constructor(private readonly dataSource: DataSource) {}

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

  private parseInitialBalance(value: unknown): Money {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value)
    ) {
      throw new BadRequestException(
        'initialBalance deve conter amount e currency.',
      );
    }

    const input = value as Record<string, unknown>;

    if (
      typeof input.amount !== 'string' ||
      typeof input.currency !== 'string'
    ) {
      throw new BadRequestException(
        'amount e currency devem ser strings.',
      );
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