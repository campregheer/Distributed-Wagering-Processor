import { beforeEach, describe, expect, it, jest } from 'bun:test';
import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { WalletService } from './wallet.service';
import { WalletEntity } from './infrastructure/persistence/wallet.entity';

describe('WalletService', () => {
  let service: WalletService;

  const insert = jest.fn();
  const transaction = jest.fn(
    async (work: (manager: { insert: typeof insert }) => Promise<void>) =>
      work({ insert }),
  );

  beforeEach(() => {
    insert.mockReset();
    transaction.mockClear();
    service = new WalletService({ transaction } as unknown as DataSource);
  });

  it('rejeita saldo inicial inválido antes de acessar o banco', async () => {
    await expect(
      service.createWallet({
        playerId: 'player-id',
        initialBalance: { amount: '-1.00', currency: 'BRL' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('abre wallet zerada com version 1 sem OPENING ou ledger', async () => {
    const result = await service.createWallet({
      playerId: 'player-id',
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    expect(result).toMatchObject({
      playerId: 'player-id',
      balance: { amount: '0.00', currency: 'BRL' },
      version: 1,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(
      WalletEntity,
      expect.objectContaining({ balance: '0.00', version: 1 }),
    );
  });
});
