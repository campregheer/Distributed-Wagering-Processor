import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { SubmitTransactionDto } from './dto/submit-transaction.dto';
import { Money, MoneyDomainError } from '../wallet/domain/money';
import { WagerTransactionKind } from './wager-transaction';

@Injectable()
export class WageringService {
  constructor(private readonly dataSource: DataSource) {}

  async submitTransaction(
    body: SubmitTransactionDto,
    idempotencyKey: string,
  ): Promise<never> {
    void this.dataSource;
    void idempotencyKey;

    const money = this.parseMoney(body?.money);

    if (body.kind === WagerTransactionKind.Bet && !money.isPositive()) {
      throw new BadRequestException(
        'O valor da aposta deve ser maior que zero.',
      );
    }

    throw new HttpException(
      'Processamento de transações ainda não implementado.',
      HttpStatus.NOT_IMPLEMENTED,
    );
  }

  private parseMoney(value: unknown): Money {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BadRequestException('money deve conter amount e currency.');
    }

    const input = value as Record<string, unknown>;

    if (
      typeof input.amount !== 'string' ||
      typeof input.currency !== 'string'
    ) {
      throw new BadRequestException('amount e currency devem ser strings.');
    }

    try {
      return Money.from({ amount: input.amount, currency: input.currency });
    } catch (error) {
      if (error instanceof MoneyDomainError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
