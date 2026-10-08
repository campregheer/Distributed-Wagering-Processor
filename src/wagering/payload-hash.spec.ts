import { describe, expect, it } from 'bun:test';
import { transactionPayloadHash } from './payload-hash';
import type { SubmitTransactionDto } from './dto/submit-transaction.dto';

describe('Hash canônico de negócio', () => {
  const body: SubmitTransactionDto = {
    providerId: 'a',
    externalTransactionId: 'tx',
    playerId: 'player',
    walletId: 'wallet',
    roundId: 'round',
    gameId: 'game',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };
  it('ignora ordem de chaves, inclusive em money', () => {
    const { money: ignored, ...fields } = body;
    void ignored;
    expect(transactionPayloadHash(body)).toBe(
      transactionPayloadHash({
        money: { currency: 'BRL', amount: '25.00' },
        ...fields,
      }),
    );
  });
  it('ignora metadados de transporte e campos fora do contrato de negócio', () => {
    expect(transactionPayloadHash(body)).toBe(
      transactionPayloadHash({
        ...body,
        correlationId: 'other',
        idempotencyKey: 'other',
      } as SubmitTransactionDto),
    );
  });
  it('detecta mudança de valor ou referência', () => {
    expect(transactionPayloadHash(body)).not.toBe(
      transactionPayloadHash({
        ...body,
        money: { amount: '26.00', currency: 'BRL' },
      }),
    );
    expect(transactionPayloadHash(body)).not.toBe(
      transactionPayloadHash({
        ...body,
        referenceExternalTransactionId: 'bet-original',
      }),
    );
  });
});
