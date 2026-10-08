import { assertWalletLedger } from './assert-wallet-ledger';
import {
  afterEach,
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  jest,
} from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { ServiceUnavailableException, Logger } from '@nestjs/common';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { AppDataSource } from '../src/database/data-source';
import { SqsGateway } from '../src/messaging/sqs.gateway';
import { MessagingWorker } from '../src/messaging/messaging.worker';
import { WageringService } from '../src/wagering/wagering.service';
import { WalletService } from '../src/wallet/wallet.service';
import { metrics } from '../src/observability/metrics';
import { startWorker } from './process-helper';

describe('PostgreSQL e SQS reais: entrega, falhas e recuperação', () => {
  const prefix = `test-${randomUUID()}-`;
  const queues = [
    'wager-transactions.fifo',
    'wager-transactions-dlq.fifo',
    'wager-events.fifo',
  ];
  const sqs = new SqsGateway();
  const wagering = new WageringService(AppDataSource);
  const worker = new MessagingWorker(AppDataSource, sqs, wagering);
  const wallets = new WalletService(AppDataSource);

  beforeAll(async () => {
    if (!process.env.DB_NAME?.startsWith('jungle_schema_test_'))
      throw new Error('Banco isolado obrigatório.');
    Logger.overrideLogger(false);
    process.env.SQS_QUEUE_PREFIX = prefix;
    await AppDataSource.initialize();
    await AppDataSource.runMigrations();
    for (const name of queues)
      await sqs.client.send(
        new CreateQueueCommand({
          QueueName: prefix + name,
          Attributes: { FifoQueue: 'true' },
        }),
      );
  });
  afterEach(async () => {
    if (AppDataSource.isInitialized) await assertWalletLedger(AppDataSource);
  });
  afterAll(async () => {
    for (const name of queues) {
      try {
        await sqs.client.send(
          new DeleteQueueCommand({ QueueUrl: await sqs.url(name) }),
        );
      } catch {
        /* não mascara falha original */
      }
    }
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
    sqs.client.destroy();
    delete process.env.SQS_QUEUE_PREFIX;
  });

  async function fixture() {
    const wallet = await wallets.createWallet({
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const externalTransactionId = randomUUID();
    const envelope = {
      messageId: randomUUID(),
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId,
        idempotencyKey: externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round',
        gameId: 'game',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      },
    };
    return { wallet, envelope };
  }

  it('consome fila real e confirma após commit, com inbox e ledger', async () => {
    const { wallet, envelope } = await fixture();
    await sqs.publish(queues[0], envelope, wallet.id, envelope.messageId);
    await worker.consumeOnce();
    expect((await wallets.findById(wallet.id)).balance.amount).toBe('75.00');
    expect((await wallets.reconcile(wallet.id)).consistent).toBe(true);
    const [inbox] = await AppDataSource.query(
      'SELECT processed_at FROM inbox_messages WHERE message_id = $1',
      [envelope.messageId],
    );
    expect(inbox.processed_at).toBeTruthy();
    expect(await sqs.receive(queues[0], 0)).toHaveLength(0);
  });

  it('dois publishers selecionam registros diferentes da mesma outbox', async () => {
    const { wallet, envelope } = await fixture();
    await wagering.submitTransaction(
      envelope.data,
      envelope.data.idempotencyKey,
    );
    const before = await AppDataSource.query(
      'SELECT id FROM outbox_messages WHERE published_at IS NOT NULL',
    );
    const second = new MessagingWorker(AppDataSource, sqs, wagering);
    expect(
      await Promise.all([worker.publishOnce(), second.publishOnce()]),
    ).toEqual([true, true]);
    const after = await AppDataSource.query(
      'SELECT id FROM outbox_messages WHERE published_at IS NOT NULL',
    );
    expect(after.length - before.length).toBe(2);
    expect((await wallets.reconcile(wallet.id)).consistent).toBe(true);
  });

  it('falha de publicação agenda retry e outra instância publica o mesmo eventId', async () => {
    await fixture();
    const [pending] = await AppDataSource.query(
      'SELECT id FROM outbox_messages WHERE published_at IS NULL ORDER BY occurred_at, id LIMIT 1',
    );
    const failure = jest
      .spyOn(sqs, 'publish')
      .mockRejectedValueOnce(new Error('publication fault injected'));
    try {
      await worker.publishOnce();
    } finally {
      failure.mockRestore();
    }
    const [failed] = await AppDataSource.query(
      'SELECT attempts, next_attempt_at, published_at FROM outbox_messages WHERE id = $1',
      [pending.id],
    );
    expect(failed.attempts).toBe(1);
    expect(failed.next_attempt_at).toBeTruthy();
    expect(failed.published_at).toBeNull();
    await AppDataSource.query(
      'UPDATE outbox_messages SET next_attempt_at = NULL WHERE id = $1',
      [pending.id],
    );
    await new MessagingWorker(AppDataSource, sqs, wagering).publishOnce();
    const [published] = await AppDataSource.query(
      'SELECT published_at FROM outbox_messages WHERE id = $1',
      [pending.id],
    );
    expect(published.published_at).toBeTruthy();
  });

  it('falha transitória mantém mensagem para retry; nova entrega processa uma vez', async () => {
    const { wallet, envelope } = await fixture();
    await sqs.publish(queues[0], envelope, wallet.id, envelope.messageId);
    const [message] = await sqs.receive(queues[0], 0);
    expect(message).toBeDefined();
    const failure = jest
      .spyOn(wagering, 'submitTransaction')
      .mockRejectedValueOnce(new ServiceUnavailableException());
    try {
      await worker.handleMessage(message);
    } finally {
      failure.mockRestore();
    }
    const attributes = await sqs.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: await sqs.url(queues[0]),
        AttributeNames: ['ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    expect(
      Number(attributes.Attributes?.ApproximateNumberOfMessagesNotVisible),
    ).toBeGreaterThan(0);
    await sqs.retry(queues[0], message.ReceiptHandle!, 0);
    await worker.consumeOnce();
    expect((await wallets.findById(wallet.id)).balance.amount).toBe('75.00');
  });

  it('payload inválido vai à DLQ real sem efeito financeiro', async () => {
    const { wallet, envelope } = await fixture();
    envelope.data.kind = 'OPENING';
    await sqs.publish(queues[0], envelope, wallet.id, envelope.messageId);
    await worker.consumeOnce();
    const [dead] = await sqs.receive(queues[1], 0);
    expect(JSON.parse(dead.Body!).originalBody).toBe(JSON.stringify(envelope));
    await sqs.ack(queues[1], dead.ReceiptHandle!);
    expect((await wallets.findById(wallet.id)).balance.amount).toBe('100.00');
  });

  it.each([
    [null],
    [[]],
    ['texto'],
    [123],
    [{ type: 'WagerTransactionRequested', data: [] }],
  ])(
    'envelope estruturalmente inválido vai à DLQ na primeira entrega: %j',
    async (payload) => {
      const id = randomUUID();
      await sqs.publish(queues[0], payload, id, id);
      await worker.consumeOnce();
      const [dead] = await sqs.receive(queues[1], 0);
      expect(dead).toBeDefined();
      expect(JSON.parse(dead.Body!).originalBody).toBe(JSON.stringify(payload));
      await sqs.ack(queues[1], dead.ReceiptHandle!);
      expect(await sqs.receive(queues[0], 0)).toHaveLength(0);
    },
  );

  it('limite de cinco tentativas envia erro persistente à DLQ', async () => {
    const { wallet, envelope } = await fixture();
    await sqs.publish(queues[0], envelope, wallet.id, envelope.messageId);
    const failure = jest
      .spyOn(wagering, 'submitTransaction')
      .mockRejectedValue(new ServiceUnavailableException());
    try {
      for (let i = 0; i < 5; i++) {
        const [message] = await sqs.receive(queues[0], 0);
        await worker.handleMessage(message);
        if (i < 4) await sqs.retry(queues[0], message.ReceiptHandle!, 0);
      }
    } finally {
      failure.mockRestore();
    }
    const [dead] = await sqs.receive(queues[1], 0);
    expect(dead).toBeDefined();
    await sqs.ack(queues[1], dead.ReceiptHandle!);
    const [failed] = await AppDataSource.query(
      'SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = $1',
      [envelope.data.externalTransactionId],
    );
    expect(failed).toEqual({
      status: 'FAILED',
      failure_code: 'PERMANENT_INFRASTRUCTURE_FAILURE',
    });
  });

  it('worker morto depois do commit e antes do ack não duplica débito na redelivery', async () => {
    const { wallet, envelope } = await fixture();
    await sqs.publish(queues[0], envelope, wallet.id, envelope.messageId);
    const [message] = await sqs.receive(queues[0], 0);
    const processWorker = await startWorker();
    try {
      processWorker.send({ envelope, crashAfterCommit: true });
      await processWorker.result;
      const exited = new Promise<void>((resolve) =>
        processWorker.child.once('exit', () => resolve()),
      );
      processWorker.child.kill('SIGKILL');
      await exited;
      await sqs.retry(queues[0], message.ReceiptHandle!, 0);
      await worker.consumeOnce();
      const [count] = await AppDataSource.query(
        "SELECT count(*)::integer AS count FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'",
        [wallet.id],
      );
      expect(count.count).toBe(1);
      expect((await wallets.reconcile(wallet.id)).consistent).toBe(true);
    } finally {
      processWorker.child.kill();
    }
  }, 20000);

  it('reinício recupera eventos confirmados ainda não publicados', async () => {
    const { wallet, envelope } = await fixture();
    await wagering.submitTransaction(
      envelope.data,
      envelope.data.idempotencyKey,
    );
    await AppDataSource.destroy();
    await AppDataSource.initialize();
    const restarted = new MessagingWorker(
      AppDataSource,
      sqs,
      new WageringService(AppDataSource),
    );
    while (await restarted.publishOnce()) {
      /* drena outbox persistida */
    }
    const [count] = await AppDataSource.query(
      'SELECT count(*)::integer AS count FROM outbox_messages WHERE aggregate_id = $1 AND published_at IS NULL',
      [wallet.id],
    );
    expect(count.count).toBe(0);
    expect((await wallets.reconcile(wallet.id)).consistent).toBe(true);
  });

  it('aplicação compilada em Bun processa SQS e encerra com SIGTERM', async () => {
    const port = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Porta indisponível.');
        server.close(() => resolve(address.port));
      });
    });
    const app = spawn('bun', ['dist/main.js'], {
      env: { ...process.env, PORT: String(port), WORKERS_ENABLED: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errors = '';
    app.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    // Drena logs do processo para não bloquear o pipe; não imprime payloads.
    app.stdout.on('data', () => {});
    const exited = new Promise<number | null>((resolve) =>
      app.once('exit', (code) => resolve(code)),
    );
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          ready = (await fetch(`http://127.0.0.1:${port}/health/live`)).ok;
        } catch {
          /* bootstrap ainda em andamento */
        }
        if (ready) break;
        if (app.exitCode !== null) throw new Error(errors);
        await delay(50);
      }
      expect(ready).toBe(true);
      const { wallet, envelope } = await fixture();
      await sqs.publish(queues[0], envelope, wallet.id, envelope.messageId);
      let processed = false;
      for (let i = 0; i < 100; i++) {
        processed =
          (await wallets.findById(wallet.id)).balance.amount === '75.00';
        if (processed) break;
        await delay(50);
      }
      expect(processed).toBe(true);
      app.kill('SIGTERM');
      await exited;
      expect(errors).toBe('');
      expect((await wallets.reconcile(wallet.id)).consistent).toBe(true);
    } finally {
      app.kill('SIGKILL');
    }
  }, 20000);
  it('crash após publicar preserva eventId e consumidor persistente aplica duplicata uma vez', async () => {
    // Isola os eventos antigos antes de provocar o crash no próximo registro.
    while (await worker.publishOnce()) {
      /* drena outbox */
    }
    for (;;) {
      const messages = await sqs.receive(queues[2], 0);
      if (!messages.length) break;
      for (const message of messages)
        await sqs.ack(queues[2], message.ReceiptHandle!);
    }
    await fixture();
    const publisher = await startWorker();
    const consumerName = `event-test-${randomUUID()}`;
    await AppDataSource.query(
      `CREATE TABLE test_event_effects (consumer_name text PRIMARY KEY, applications integer NOT NULL)`,
    );
    await AppDataSource.query('INSERT INTO test_event_effects VALUES ($1, 0)', [
      consumerName,
    ]);
    try {
      publisher.send({ crashAfterPublish: true });
      const sent = await publisher.result;
      const exited = new Promise<void>((resolve) =>
        publisher.child.once('exit', () => resolve()),
      );
      publisher.child.kill('SIGKILL');
      await exited;
      const [unconfirmed] = await AppDataSource.query(
        'SELECT published_at FROM outbox_messages WHERE id = $1',
        [sent.eventId],
      );
      expect(unconfirmed.published_at).toBeNull();
      const [first] = await sqs.receive(queues[2], 0);
      expect(first).toBeDefined();
      const envelope = JSON.parse(first.Body!);
      expect(envelope.eventId).toBe(sent.eventId);
      // Consumidor demonstrativo: inbox e efeito confirmado no mesmo SQL; ack depois.
      const consume = async (body: string, receipt: string) => {
        const event = JSON.parse(body);
        await AppDataSource.transaction(async (manager) => {
          const inserted = await manager.query(
            `INSERT INTO inbox_messages
            (consumer_name, message_id, payload_hash, received_at, processed_at)
            VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING RETURNING message_id`,
            [
              consumerName,
              event.eventId,
              createHash('sha256').update(body).digest('hex'),
            ],
          );
          if (inserted.length)
            await manager.query(
              'UPDATE test_event_effects SET applications = applications + 1 WHERE consumer_name = $1',
              [consumerName],
            );
        });
        await sqs.ack(queues[2], receipt);
      };
      await consume(first.Body!, first.ReceiptHandle!);
      // Outra instância retoma o registro; a identidade permanece a mesma.
      await new MessagingWorker(AppDataSource, sqs, wagering).publishOnce();
      const [confirmed] = await AppDataSource.query(
        'SELECT published_at FROM outbox_messages WHERE id = $1',
        [sent.eventId],
      );
      expect(confirmed.published_at).toBeTruthy();
      await AppDataSource.destroy();
      await AppDataSource.initialize();
      // Força uma cópia real com dedup de transporte diferente: FIFO não garante este teste.
      await sqs.publish(
        queues[2],
        envelope,
        envelope.aggregateId,
        randomUUID(),
      );
      const [duplicate] = await sqs.receive(queues[2], 0);
      expect(JSON.parse(duplicate.Body!).eventId).toBe(sent.eventId);
      await consume(duplicate.Body!, duplicate.ReceiptHandle!);
      const [effect] = await AppDataSource.query(
        'SELECT applications FROM test_event_effects WHERE consumer_name = $1',
        [consumerName],
      );
      expect(effect.applications).toBe(1);
      const [inbox] = await AppDataSource.query(
        'SELECT count(*)::integer AS count FROM inbox_messages WHERE consumer_name = $1',
        [consumerName],
      );
      expect(inbox.count).toBe(1);
    } finally {
      publisher.child.kill('SIGKILL');
      await AppDataSource.query('DROP TABLE test_event_effects');
    }
  }, 20000);
  it('gauge da DLQ detecta redrive nativo sem depender do contador manual', async () => {
    const source = 'native-redrive-test.fifo';
    const dlq = await sqs.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: await sqs.url(queues[1]),
        AttributeNames: ['QueueArn'],
      }),
    );
    await sqs.client.send(
      new CreateQueueCommand({
        QueueName: prefix + source,
        Attributes: {
          FifoQueue: 'true',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlq.Attributes!.QueueArn,
            maxReceiveCount: '2',
          }),
        },
      }),
    );
    const id = randomUUID();
    try {
      const before = metrics.render().match(/wager_dlq_total (\d+)/)?.[1];
      await sqs.publish(source, { nativeRedrive: id }, id, id);
      for (let attempt = 0; attempt < 2; attempt++) {
        const [message] = await sqs.receive(source, 0);
        expect(message).toBeDefined();
        await sqs.retry(source, message.ReceiptHandle!, 0);
      }
      expect(await sqs.receive(source, 0)).toHaveLength(0);
      const [dead] = await sqs.receive(queues[1], 0);
      expect(JSON.parse(dead.Body!).nativeRedrive).toBe(id);
      await worker.referencesOnce();
      expect(
        Number(metrics.render().match(/wager_dlq_messages (\d+)/)?.[1]),
      ).toBeGreaterThan(0);
      expect(metrics.render().match(/wager_dlq_total (\d+)/)?.[1]).toBe(before);
      await sqs.ack(queues[1], dead.ReceiptHandle!);
      await worker.referencesOnce();
      expect(metrics.render()).toContain('wager_dlq_messages 0');
    } finally {
      await sqs.client.send(
        new DeleteQueueCommand({ QueueUrl: await sqs.url(source) }),
      );
    }
  });
});
