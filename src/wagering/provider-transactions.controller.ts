import { Inject } from '@nestjs/common';
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ProviderAuthGuard } from '../auth/provider-auth.guard';
import { WageringService } from './wagering.service';

@Controller('providers/:providerId/wagering/transactions')
@UseGuards(ProviderAuthGuard)
export class ProviderTransactionsController {
  constructor(
    @Inject(WageringService) private readonly service: WageringService,
  ) {}
  @Get(':externalTransactionId')
  find(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.service.findByExternalId(providerId, externalTransactionId);
  }
}
