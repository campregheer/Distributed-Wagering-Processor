import { HttpStatus } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { SubmitTransactionDto } from './dto/submit-transaction.dto';
import { WageringService } from './wagering.service';

describe('WageringService: validação monetária inicial', () => {
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

  it.each(['0.01', '25.00'])(
    'mantém 501 para BET positiva de %s',
    async (amount) => {
      const body = { ...validBody, money: { amount, currency: 'BRL' } };
      await expect(
        service.submitTransaction(body, 'key'),
      ).rejects.toMatchObject({
        status: HttpStatus.NOT_IMPLEMENTED,
        message: 'Processamento de transações ainda não implementado.',
      });
    },
  );

  it('não estende a regra BET positiva a LOSS', async () => {
    const body = {
      ...validBody,
      kind: 'LOSS',
      money: { amount: '0.00', currency: 'BRL' },
    };
    await expect(service.submitTransaction(body, 'key')).rejects.toMatchObject({
      status: HttpStatus.NOT_IMPLEMENTED,
    });
  });
});
