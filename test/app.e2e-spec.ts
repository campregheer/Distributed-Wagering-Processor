import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AppDataSource } from '../src/database/data-source';

describe('HTTP completo com PostgreSQL e SQS reais', () => {
  let app: INestApplication;
  beforeAll(async () => {
    if (!process.env.DB_NAME?.startsWith('jungle_schema_test_'))
      throw new Error('Banco isolado obrigatório.');
    process.env.WORKERS_ENABLED = 'false';
    Logger.overrideLogger(false);
    await AppDataSource.initialize();
    await AppDataSource.runMigrations();
    await AppDataSource.destroy();
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  it('cria wallet, processa aposta, consulta, pagina, reconcilia e faz replay', async () => {
    const wallet = (
      await request(app.getHttpServer())
        .post('/wallets')
        .send({
          playerId: randomUUID(),
          initialBalance: { amount: '100.00', currency: 'BRL' },
        })
        .expect(201)
    ).body;
    const body = {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round',
      gameId: 'game',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const key = randomUUID();
    const result = (
      await request(app.getHttpServer())
        .post('/wagering/transactions')
        .set('Idempotency-Key', key)
        .send(body)
        .expect(200)
    ).body;
    expect(result.balance.amount).toBe('75.00');
    const replay = (
      await request(app.getHttpServer())
        .post('/wagering/transactions')
        .set('Idempotency-Key', key)
        .send(body)
        .expect(200)
    ).body;
    expect(replay).toEqual({ ...result, idempotentReplay: true });
    await request(app.getHttpServer())
      .get(`/wagering/transactions/${result.transactionId}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(
        `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
      )
      .expect(200);
    const ledger = (
      await request(app.getHttpServer())
        .get(`/wallets/${wallet.id}/ledger?limit=1`)
        .expect(200)
    ).body;
    expect(ledger.nextCursor).toBeTruthy();
    const reconciliation = (
      await request(app.getHttpServer())
        .post(`/wallets/${wallet.id}/reconciliation`)
        .expect(200)
    ).body;
    expect(reconciliation.consistent).toBe(true);
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', key)
      .send({ ...body, gameId: 'different' })
      .expect(409);
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .send(body)
      .expect(400);
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', randomUUID())
      .send({
        ...body,
        externalTransactionId: randomUUID(),
        money: { amount: '80.00', currency: 'BRL' },
      })
      .expect(422);
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('Idempotency-Key', randomUUID())
      .send({
        ...body,
        externalTransactionId: randomUUID(),
        kind: 'REFUND',
        referenceExternalTransactionId: 'missing',
      })
      .expect(202);
  });

  it('health checks públicos e métricas estão disponíveis', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
    await request(app.getHttpServer()).get('/health/ready').expect(200);
    const result = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);
    expect(result.text).toContain('wager_transactions_total');
  });
});
