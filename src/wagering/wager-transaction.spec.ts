import { describe, expect, it } from 'bun:test';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  FailureCode,
  WagerTransactionStatus as Status,
} from './wager-transaction';
import { Money } from '../wallet/domain/money';
import { LedgerDirection } from '../wallet/domain/ledger-direction';

describe('WagerTransaction: regras de domínio', () => {
  const create = (kind: Kind, referenceExternalTransactionId?: string) =>
    WagerTransaction.create({
      id: 'transaction',
      providerId: 'provider',
      externalTransactionId: 'external',
      idempotencyKey: 'key',
      payloadHash: 'hash',
      walletId: 'wallet',
      playerId: 'player',
      roundId: 'round',
      gameId: 'game',
      kind,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      referenceExternalTransactionId,
    });
  it.each([Kind.Refund, Kind.Rollback])('exige referência para %s', (kind) => {
    expect(() => create(kind)).toThrow();
  });
  it.each([Kind.Bet, Kind.Win, Kind.Loss])('define efeito de %s', (kind) => {
    const transaction = create(kind);
    expect(transaction.affectsBalance()).toBe(kind !== Kind.Loss);
    if (kind === Kind.Loss)
      expect(() => transaction.ledgerDirectionFor()).toThrow();
    else
      expect(transaction.ledgerDirectionFor()).toBe(
        kind === Kind.Bet ? LedgerDirection.Debit : LedgerDirection.Credit,
      );
  });
  it('rollback inverte BET e WIN', () => {
    const transaction = create(Kind.Rollback, 'external');
    expect(transaction.ledgerDirectionFor(create(Kind.Bet))).toBe(
      LedgerDirection.Credit,
    );
    expect(transaction.ledgerDirectionFor(create(Kind.Win))).toBe(
      LedgerDirection.Debit,
    );
  });
  it('REFUND só referencia BET processada', () => {
    const transaction = create(Kind.Refund, 'external');
    expect(transaction.referenceFailureCode(create(Kind.Bet))).toBe(
      FailureCode.REFERENCE_NOT_PROCESSED,
    );
    const win = create(Kind.Win);
    win.markProcessed(undefined, new Date());
    expect(transaction.referenceFailureCode(win)).toBe(
      FailureCode.INVALID_REFERENCE_KIND,
    );
    const bet = create(Kind.Bet);
    bet.markProcessed(undefined, new Date());
    expect(transaction.referenceFailureCode(bet)).toBeUndefined();
  });
  it.each([Status.Processed, Status.Rejected, Status.Failed])(
    'estado terminal %s não admite transições',
    (status) => {
      const transaction = create(Kind.Bet);
      if (status === Status.Processed)
        transaction.markProcessed(undefined, new Date());
      if (status === Status.Rejected)
        transaction.reject(FailureCode.INSUFFICIENT_FUNDS);
      if (status === Status.Failed)
        transaction.fail(FailureCode.PERMANENT_INFRASTRUCTURE_FAILURE);
      expect(() => transaction.markProcessed(undefined, new Date())).toThrow();
      expect(() =>
        transaction.reject(FailureCode.INSUFFICIENT_FUNDS),
      ).toThrow();
      expect(() =>
        transaction.fail(FailureCode.PERMANENT_INFRASTRUCTURE_FAILURE),
      ).toThrow();
    },
  );
});
