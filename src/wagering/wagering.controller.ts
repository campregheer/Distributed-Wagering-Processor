import { Inject } from '@nestjs/common';
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';

import type { SubmitTransactionDto } from './dto/submit-transaction.dto';
import { WageringService } from './wagering.service';
import { ProviderAuthGuard } from '../auth/provider-auth.guard';
import type { Response } from 'express';

@Controller('wagering')
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(WageringService) private readonly wageringService: WageringService,
  ) {}

  @Post('transactions')
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: SubmitTransactionDto,
    @Res({ passthrough: true }) response?: Response,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('Idempotency-Key é obrigatório.');
    }

    if (
      correlationId !== undefined &&
      (!correlationId.trim() || Array.from(correlationId).length > 255)
    ) {
      throw new BadRequestException(
        'X-Correlation-Id deve ser não vazio e ter até 255 caracteres.',
      );
    }
    const result = await this.wageringService.submitTransaction(
      body,
      idempotencyKey,
      { correlationId },
    );
    response?.status(
      result.status === 'PENDING_REFERENCE' || result.status === 'PENDING'
        ? 202
        : result.status === 'REJECTED'
          ? 422
          : result.status === 'FAILED'
            ? 500
            : 200,
    );
    return result;
  }

  @Get('transactions/:transactionId')
  findById(@Param('transactionId', ParseUUIDPipe) id: string) {
    return this.wageringService.findById(id);
  }
}
