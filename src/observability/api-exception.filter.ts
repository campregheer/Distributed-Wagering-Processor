import { Catch, HttpException, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { metrics } from './metrics';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const code =
      (error as { code?: string; driverError?: { code?: string } })?.driverError
        ?.code ?? (error as { code?: string })?.code;
    const transient =
      [
        '40001',
        '40P01',
        '55P03',
        '57P01',
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
      ].includes(code ?? '') || code?.startsWith('08');
    const status =
      error instanceof HttpException
        ? error.getStatus()
        : transient
          ? 503
          : 500;
    if (transient && ['40001', '40P01', '55P03'].includes(code ?? ''))
      metrics.increment('wager_lock_conflicts_total');
    const body = request.body as Record<string, unknown> | undefined;
    this.logger.warn({
      event: 'HttpError',
      status,
      correlationId: request.headers['x-correlation-id'],
      walletId: typeof body?.walletId === 'string' ? body.walletId : undefined,
      providerId:
        typeof body?.providerId === 'string' ? body.providerId : undefined,
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    const payload =
      error instanceof HttpException
        ? error.getResponse()
        : {
            statusCode: status,
            message: transient
              ? 'Infraestrutura temporariamente indisponível.'
              : 'Erro interno.',
          };
    response
      .status(status)
      .json(
        typeof payload === 'string'
          ? { statusCode: status, message: payload }
          : payload,
      );
  }
}
