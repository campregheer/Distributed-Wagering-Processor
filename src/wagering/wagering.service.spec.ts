import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { HttpStatus } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { SubmitTransactionDto } from './dto/submit-transaction.dto';
import { WageringService } from './wagering.service';

describe('WageringService: validação inicial de submissão', () => {
  let service: WageringService;
  const transaction = jest.fn();
  const validBody: SubmitTransactionDto = {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };

  beforeEach(() => {
    transaction.mockClear();
    service = new WageringService({ transaction } as unknown as DataSource);
  });

  afterEach(() => {
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 123, {}, [], '', 'INVALID', 'bet', ' BET '])(
    'rejeita kind ausente ou inválido: %j',
    async (kind) => {
      const body = { ...validBody, kind } as unknown as SubmitTransactionDto;
      await expect(
        service.submitTransaction(body, 'key'),
      ).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
        message: 'kind deve ser BET, WIN, LOSS, REFUND ou ROLLBACK.',
      });
    },
  );

  it('proíbe a submissão externa de OPENING', async () => {
    const body = { ...validBody, kind: 'OPENING' };
    await expect(service.submitTransaction(body, 'key')).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      message: 'kind deve ser BET, WIN, LOSS, REFUND ou ROLLBACK.',
    });
  });

  it.each(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'])(
    'valida o tipo público %s com money válido',
    (kind) => {
      const body = {
        ...validBody,
        kind,
        ...(kind === 'REFUND' || kind === 'ROLLBACK'
          ? { referenceExternalTransactionId: 'bet-original' }
          : {}),
      };
      expect(String(service.validateSubmission(body, 'key').kind)).toBe(kind);
    },
  );

  it.each([
    undefined,
    null,
    [],
    '25.00',
    {},
    { amount: '25.00' },
    { amount: 25, currency: 'BRL' },
    { amount: '25.00', currency: 123 },
  ])('rejeita money estruturalmente inválido: %j', async (money) => {
    const body = { ...validBody, money } as unknown as SubmitTransactionDto;
    await expect(service.submitTransaction(body, 'key')).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it.each([
    'providerId',
    'externalTransactionId',
    'roundId',
    'gameId',
    'playerId',
    'walletId',
  ] as const)(
    'rejeita identificador obrigatório ausente: %s',
    async (field) => {
      const body = {
        ...validBody,
        [field]: undefined,
      } as unknown as SubmitTransactionDto;
      await expect(
        service.submitTransaction(body, 'key'),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    },
  );

  it.each(['', '   ', 'x'.repeat(256)])(
    'rejeita idempotency key inválida',
    async (key) => {
      await expect(
        service.submitTransaction(validBody, key),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    },
  );

  it.each(['REFUND', 'ROLLBACK'])('exige referência para %s', async (kind) => {
    await expect(
      service.submitTransaction({ ...validBody, kind }, 'key'),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
  });

  it.each([null, '', '   ', 123])(
    'rejeita referência fornecida inválida: %j',
    async (referenceExternalTransactionId) => {
      const body = {
        ...validBody,
        referenceExternalTransactionId,
      } as unknown as SubmitTransactionDto;
      await expect(
        service.submitTransaction(body, 'key'),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    },
  );

  it.each(['-1.00', 'NaN', 'Infinity', '1e2', '', '1.001', '1', '1.0'])(
    'rejeita amount inválido: %s',
    async (amount) => {
      const body = { ...validBody, money: { amount, currency: 'BRL' } };
      await expect(
        service.submitTransaction(body, 'key'),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    },
  );

  it('rejeita moeda com formato inválido', async () => {
    const body = { ...validBody, money: { amount: '25.00', currency: 'brl' } };
    await expect(service.submitTransaction(body, 'key')).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it('rejeita BET de zero conforme a interpretação adotada', async () => {
    const body = { ...validBody, money: { amount: '0.00', currency: 'BRL' } };
    await expect(service.submitTransaction(body, 'key')).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      message: 'O valor da aposta deve ser maior que zero.',
    });
  });

  it.each(['0.01', '25.00'])('valida BET positiva de %s', (amount) => {
    const body = { ...validBody, money: { amount, currency: 'BRL' } };
    expect(service.validateSubmission(body, 'key').money.toJSON().amount).toBe(
      amount,
    );
  });

  it('não estende a regra BET positiva a LOSS', () => {
    const body = {
      ...validBody,
      kind: 'LOSS',
      money: { amount: '0.00', currency: 'BRL' },
    };
    expect(service.validateSubmission(body, 'key').money.isZero()).toBe(true);
  });
  it('rejeita WIN de zero conforme a interpretação adotada', async () => {
    const body = {
      ...validBody,
      kind: 'WIN',
      money: { amount: '0.00', currency: 'BRL' },
    };
    await expect(service.submitTransaction(body, 'key')).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      message: 'O valor do prêmio deve ser maior que zero.',
    });
  });
  it.each(['0.01', '25.00'])('valida WIN positiva de %s', (amount) => {
    const body = {
      ...validBody,
      kind: 'WIN',
      money: { amount, currency: 'BRL' },
    };
    expect(service.validateSubmission(body, 'key').money.toJSON().amount).toBe(
      amount,
    );
  });
});

describe('WageringService: conflito de idempotência', () => {
  it('mesma chave com payload divergente retorna conflito antes de movimentar saldo', async () => {
    const wallet = {
      id: '0192f291-27dd-7d3f-8071-5f8685deef37',
      balance: '100.00',
      currency: 'BRL',
    };
    const builder = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ raw: [] }),
    };
    const manager = {
      findOne: jest.fn().mockResolvedValue(wallet),
      createQueryBuilder: () => builder,
      find: jest
        .fn()
        .mockResolvedValue([
          { idempotencyKey: 'key', payloadHash: 'hash-of-original-payload' },
        ]),
      update: jest.fn(),
      insert: jest.fn(),
    };
    const db = {
      transaction: async (work: (m: typeof manager) => Promise<unknown>) =>
        work(manager),
    };
    const service = new WageringService(db as unknown as DataSource);
    await expect(
      service.submitTransaction(
        {
          providerId: 'a',
          externalTransactionId: 'tx',
          playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
          walletId: wallet.id,
          roundId: 'r',
          gameId: 'g',
          kind: 'BET',
          money: { amount: '26.00', currency: 'BRL' },
        },
        'key',
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
  });
});
