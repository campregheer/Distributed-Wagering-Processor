import { beforeEach, describe, expect, it, jest } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { WageringController } from './wagering.controller';
import { WageringService } from './wagering.service';
import { BadRequestException } from '@nestjs/common';
import type { SubmitTransactionDto } from './dto/submit-transaction.dto';

describe('WageringController', () => {
  let controller: WageringController;
  const submitTransaction = jest.fn();

  beforeEach(async () => {
    submitTransaction.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WageringController],
      providers: [
        { provide: WageringService, useValue: { submitTransaction } },
      ],
    }).compile();

    controller = module.get<WageringController>(WageringController);
  });

  it.each([undefined, '', '   '])(
    'exige Idempotency-Key no HTTP',
    async (key) => {
      await expect(
        controller.submitTransaction(key, {} as SubmitTransactionDto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(submitTransaction).not.toHaveBeenCalled();
    },
  );

  it('encaminha body e a chave original ao service', async () => {
    const body = { kind: 'BET' } as SubmitTransactionDto;
    await controller.submitTransaction('provider-a:tx-1', body);
    expect(submitTransaction).toHaveBeenCalledWith(body, 'provider-a:tx-1');
  });
});
