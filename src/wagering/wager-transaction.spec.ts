import { describe, expect, it } from 'bun:test';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  FailureCode,
  InvalidTransactionStateError,
  WagerTransactionStatus as Status,
} from './wager-transaction';
import { Money } from '../wallet/domain/money';
import { LedgerDirection } from '../wallet/domain/ledger-direction';

describe('WagerTransaction: regras de domínio', () => {
  const props = {
    id: 'transaction',
    providerId: 'provider',
    externalTransactionId: 'external',
    idempotencyKey: 'key',
    payloadHash: 'hash',
    walletId: 'wallet',
    playerId: 'player',
    roundId: 'round',
    gameId: 'game',
    kind: Kind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    createdAt: new Date(),
  };
  const create = (kind: Kind, referenceExternalTransactionId?: string) =>
    WagerTransaction.create({ ...props, kind, referenceExternalTransactionId });
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
      expect(() => transaction.markPendingReference()).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => transaction.markProcessed(undefined, new Date())).toThrow(
        InvalidTransactionStateError,
      );
      expect(() =>
        transaction.reject(FailureCode.INSUFFICIENT_FUNDS),
      ).toThrow();
      expect(() =>
        transaction.fail(FailureCode.PERMANENT_INFRASTRUCTURE_FAILURE),
      ).toThrow();
    },
  );
  it('compara UUIDs equivalentes sem distinguir maiúsculas', () => {
    const state = {
      ...props,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      kind: Kind.Bet,
      referenceExternalTransactionId: undefined,
    };
    const bet = WagerTransaction.create(state);
    bet.markProcessed(undefined, new Date());
    const refund = WagerTransaction.create({
      ...state,
      kind: Kind.Refund,
      referenceExternalTransactionId: 'external',
      walletId: state.walletId.toUpperCase(),
      playerId: state.playerId.toUpperCase(),
    });
    expect(refund.referenceFailureCode(bet)).toBeUndefined();
  });
  it.each(['providerId', 'playerId', 'walletId', 'roundId'] as const)(
    'rejeita referência com contexto divergente em %s',
    (field) => {
      const ref = create(Kind.Bet);
      ref.markProcessed(undefined, new Date());
      const other = WagerTransaction.rehydrate({
        ...props,
        money: ref.money,
        status: Status.Processed,
        [field]: 'other',
      });
      expect(create(Kind.Refund, 'external').referenceFailureCode(other)).toBe(
        FailureCode.REFERENCE_MISMATCH,
      );
    },
  );
  it('rejeita referência com moeda divergente', () => {
    const other = WagerTransaction.rehydrate({
      ...props,
      status: Status.Processed,
      money: Money.from({ amount: '25.00', currency: 'USD' }),
    });
    expect(create(Kind.Refund, 'external').referenceFailureCode(other)).toBe(
      FailureCode.REFERENCE_MISMATCH,
    );
  });
  it('rejeita reversão parcial', () => {
    const other = WagerTransaction.rehydrate({
      ...props,
      status: Status.Processed,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
    });
    expect(create(Kind.Refund, 'external').referenceFailureCode(other)).toBe(
      FailureCode.REVERSAL_AMOUNT_MISMATCH,
    );
  });
  it.each([Kind.Opening, Kind.Loss])(
    'ROLLBACK não pode referenciar %s',
    (kind) => {
      const ref = create(kind);
      ref.markProcessed(undefined, new Date());
      expect(create(Kind.Rollback, 'external').referenceFailureCode(ref)).toBe(
        FailureCode.INVALID_REFERENCE_KIND,
      );
    },
  );
  it.each([Status.Rejected, Status.Failed])(
    'referência %s não pode ser revertida',
    (status) => {
      const ref = create(Kind.Bet);
      if (status === Status.Rejected)
        ref.reject(FailureCode.INSUFFICIENT_FUNDS);
      else ref.fail(FailureCode.PERMANENT_INFRASTRUCTURE_FAILURE);
      expect(create(Kind.Refund, 'external').referenceFailureCode(ref)).toBe(
        FailureCode.REFERENCE_NOT_PROCESSED,
      );
    },
  );
});
