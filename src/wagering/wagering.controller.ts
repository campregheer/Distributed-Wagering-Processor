import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
} from '@nestjs/common';

import type { SubmitTransactionDto } from './dto/submit-transaction.dto';
import { WageringService } from './wagering.service';

@Controller('wagering')
export class WageringController {
  constructor(private readonly wageringService: WageringService) {}

  @Post('transactions')
  submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: SubmitTransactionDto,
  ) {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('Idempotency-Key é obrigatório.');
    }

    return this.wageringService.submitTransaction(
      body,
      idempotencyKey,
    );
  }
}
