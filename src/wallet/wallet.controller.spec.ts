import { beforeEach, describe, expect, it, jest } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

describe('WalletController', () => {
  let controller: WalletController;
  const createWallet = jest.fn();
  const findById = jest.fn();

  beforeEach(async () => {
    createWallet.mockReset();
    findById.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WalletController],
      providers: [
        { provide: WalletService, useValue: { createWallet, findById } },
      ],
    }).compile();

    controller = module.get<WalletController>(WalletController);
  });

  it('encaminha criação ao service', async () => {
    const balance = { amount: '100.00', currency: 'BRL' };
    await controller.createWallet('player-id', balance);
    expect(createWallet).toHaveBeenCalledWith({
      playerId: 'player-id',
      initialBalance: balance,
    });
  });

  it('encaminha consulta ao service', async () => {
    await controller.getWallet('wallet-id');
    expect(findById).toHaveBeenCalledWith('wallet-id');
  });
});
