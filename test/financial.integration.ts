import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { AppDataSource } from '../src/database/data-source';
import { WageringService } from '../src/wagering/wagering.service';
import { WalletService } from '../src/wallet/wallet.service';
import type { SubmitTransactionDto } from '../src/wagering/dto/submit-transaction.dto';
import { startWorker } from './process-helper';

describe('Processamento financeiro em PostgreSQL real', () => {
  const wagering = new WageringService(AppDataSource);
  const wallets = new WalletService(AppDataSource);

  beforeAll(async () => {
    Logger.overrideLogger(false);
    if (!process.env.DB_NAME?.startsWith('jungle_schema_test_'))
      throw new Error('Banco de teste isolado obrigatório.');
    await AppDataSource.initialize();
    await AppDataSource.runMigrations();
  });
  afterAll(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  });

  async function fixture(amount = '100.00') {
    const wallet = await wallets.createWallet({
      playerId: randomUUID(),
      initialBalance: { amount, currency: 'BRL' },
    });
    const body: SubmitTransactionDto = {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    return { wallet, body };
  }

  async function countLedger(walletId: string, direction?: string) {
    const [row] = await AppDataSource.query(
      `SELECT count(*)::integer AS count FROM wallet_ledger_entries WHERE wallet_id = $1 ${direction ? 'AND direction = $2' : ''}`,
      direction ? [walletId, direction] : [walletId],
    );
    return row.count;
  }

  it('processa BET, WIN e LOSS e preserva saldo original no replay', async () => {
    const { wallet, body } = await fixture();
    const bet = await wagering.submitTransaction(
      body,
      body.externalTransactionId,
    );
    expect(bet).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    const winBody = {
      ...body,
      kind: 'WIN',
      externalTransactionId: randomUUID(),
      referenceExternalTransactionId: body.externalTransactionId,
    };
    const win = await wagering.submitTransaction(
      winBody,
      winBody.externalTransactionId,
    );
    expect(win.balance.amount).toBe('100.00');
    const lossBody = {
      ...body,
      kind: 'LOSS',
      externalTransactionId: randomUUID(),
      money: { amount: '0.00', currency: 'BRL' },
    };
    await wagering.submitTransaction(lossBody, lossBody.externalTransactionId);
    expect((await wallets.findById(wallet.id)).version).toBe(3);
    expect(await countLedger(wallet.id)).toBe(3);
    expect(
      await wagering.submitTransaction(body, body.externalTransactionId),
    ).toEqual({ ...bet, idempotentReplay: true });
    expect((await wallets.reconcile(wallet.id)).consistent).toBe(true);
  });

  it('mesma aposta 50 vezes em paralelo gera um único débito e dois eventos', async () => {
    const { wallet, body } = await fixture();
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        wagering.submitTransaction(body, body.externalTransactionId),
      ),
    );
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(
      1,
    );
    expect(await countLedger(wallet.id, 'DEBIT')).toBe(1);
    const [events] = await AppDataSource.query(
      `SELECT count(*)::integer AS count FROM outbox_messages WHERE payload->'data'->>'transactionId' = $1`,
      [results[0].transactionId],
    );
    expect(events.count).toBe(2);
    expect((await wallets.reconcile(wallet.id)).consistent).toBe(true);
  });

  it('duas BETs de 80 sobre 100: uma processada, outra rejeitada, saldo 20', async () => {
    const { wallet, body } = await fixture();
    const bets = [0, 1].map(() => ({
      ...body,
      externalTransactionId: randomUUID(),
      money: { amount: '80.00', currency: 'BRL' },
    }));
    const results = await Promise.all(
      bets.map((bet) =>
        wagering.submitTransaction(bet, bet.externalTransactionId),
      ),
    );
    expect(
      results.filter((result) => result.status === 'PROCESSED'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'REJECTED')?.failureCode,
    ).toBe('INSUFFICIENT_FUNDS');
    expect((await wallets.findById(wallet.id)).balance.amount).toBe('20.00');
    expect(await countLedger(wallet.id, 'DEBIT')).toBe(1);
    expect((await wallets.reconcile(wallet.id)).consistent).toBe(true);
  });

  it('rejeita payload divergente e mudança de chave para a mesma operação externa', async () => {
    const { body } = await fixture();
    await wagering.submitTransaction(body, body.externalTransactionId);
    await expect(
      wagering.submitTransaction(
        { ...body, money: { amount: '26.00', currency: 'BRL' } },
        body.externalTransactionId,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      wagering.submitTransaction(body, randomUUID()),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('REFUND reverte BET uma vez; ROLLBACK de REFUND debita', async () => {
    const { wallet, body } = await fixture();
    await wagering.submitTransaction(body, body.externalTransactionId);
    const refund = {
      ...body,
      kind: 'REFUND',
      externalTransactionId: randomUUID(),
      referenceExternalTransactionId: body.externalTransactionId,
    };
    expect(
      (await wagering.submitTransaction(refund, refund.externalTransactionId))
        .balance.amount,
    ).toBe('100.00');
    const duplicate = { ...refund, externalTransactionId: randomUUID() };
    expect(
      (
        await wagering.submitTransaction(
          duplicate,
          duplicate.externalTransactionId,
        )
      ).failureCode,
    ).toBe('ALREADY_REVERSED');
    const rollback = {
      ...body,
      kind: 'ROLLBACK',
      externalTransactionId: randomUUID(),
      referenceExternalTransactionId: refund.externalTransactionId,
    };
    expect(
      (
        await wagering.submitTransaction(
          rollback,
          rollback.externalTransactionId,
        )
      ).balance.amount,
    ).toBe('75.00');
    expect((await wallets.reconcile(wallet.id)).consistent).toBe(true);
  });

  it('ROLLBACK de WIN sem saldo rejeita com código próprio', async () => {
    const { wallet, body } = await fixture('0.00');
    const win = { ...body, kind: 'WIN' };
    await wagering.submitTransaction(win, win.externalTransactionId);
    const bet = { ...body, externalTransactionId: randomUUID() };
    await wagering.submitTransaction(bet, bet.externalTransactionId);
    const rollback = {
      ...body,
      kind: 'ROLLBACK',
      externalTransactionId: randomUUID(),
      referenceExternalTransactionId: win.externalTransactionId,
    };
    expect(
      (
        await wagering.submitTransaction(
          rollback,
          rollback.externalTransactionId,
        )
      ).failureCode,
    ).toBe('REVERSAL_WOULD_OVERDRAW');
    expect(await countLedger(wallet.id)).toBe(2);
    expect((await wallets.reconcile(wallet.id)).consistent).toBe(true);
  });

  it('referência ainda ausente persiste pendência sem movimentação', async () => {
    const { wallet, body } = await fixture();
    const refund = {
      ...body,
      kind: 'REFUND',
      referenceExternalTransactionId: 'not-arrived',
    };
    expect(
      String(
        (await wagering.submitTransaction(refund, refund.externalTransactionId))
          .status,
      ),
    ).toBe('PENDING_REFERENCE');
    expect(await countLedger(wallet.id)).toBe(1);
    expect((await wallets.findById(wallet.id)).version).toBe(1);
  });

  it('reprocessa REFUND que chegou antes da referência, sem duplicar crédito', async () => {
    const { wallet, body } = await fixture();
    const refund = {
      ...body,
      kind: 'REFUND',
      externalTransactionId: randomUUID(),
      referenceExternalTransactionId: body.externalTransactionId,
    };
    const pending = await wagering.submitTransaction(
      refund,
      refund.externalTransactionId,
    );
    await wagering.submitTransaction(body, body.externalTransactionId);
    await Promise.all([
      wagering.reprocessReference(
        pending.transactionId,
        new Date(Date.now() + 5000),
      ),
      wagering.reprocessReference(
        pending.transactionId,
        new Date(Date.now() + 5000),
      ),
    ]);
    expect(
      (await wagering.findById(pending.transactionId)).balance.amount,
    ).toBe('100.00');
    expect(await countLedger(wallet.id, 'CREDIT')).toBe(2);
    expect((await wallets.reconcile(wallet.id)).consistent).toBe(true);
  });

  it('esgota referências inexistentes com rejeição auditável e evento', async () => {
    const { body } = await fixture();
    const pending = await wagering.submitTransaction(
      {
        ...body,
        kind: 'REFUND',
        referenceExternalTransactionId: 'never-arrives',
      },
      body.externalTransactionId,
    );
    await AppDataSource.query(
      'UPDATE wager_transactions SET reference_attempts = 10, reference_next_attempt_at = NULL WHERE id = $1',
      [pending.transactionId],
    );
    await wagering.reprocessReference(pending.transactionId);
    expect((await wagering.findById(pending.transactionId)).failureCode).toBe(
      'REFERENCE_NOT_FOUND',
    );
    const [event] = await AppDataSource.query(
      `SELECT count(*)::integer AS count FROM outbox_messages WHERE event_type = 'WagerTransactionRejected' AND payload->'data'->>'transactionId' = $1`,
      [pending.transactionId],
    );
    expect(event.count).toBe(1);
  });

  it('três processos disputam a mesma wallet e wallets distintas seguem corretas', async () => {
    const { wallet, body } = await fixture();
    const workers = await Promise.all(
      Array.from({ length: 3 }, () => startWorker()),
    );
    try {
      workers.forEach((worker) => {
        const bet = {
          ...body,
          externalTransactionId: randomUUID(),
          money: { amount: '80.00', currency: 'BRL' },
        };
        worker.send({ body: bet, key: bet.externalTransactionId });
      });
      const results = await Promise.all(workers.map((worker) => worker.result));
      expect(
        results.filter((result) => result.status === 'PROCESSED'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'REJECTED'),
      ).toHaveLength(2);
      expect((await wallets.reconcile(wallet.id)).storedBalance.amount).toBe(
        '20.00',
      );
      const distinct = await Promise.all([fixture(), fixture(), fixture()]);
      await Promise.all(
        distinct.map(({ body: bet }) =>
          wagering.submitTransaction(bet, bet.externalTransactionId),
        ),
      );
      for (const { wallet: other } of distinct)
        expect((await wallets.reconcile(other.id)).consistent).toBe(true);
    } finally {
      workers.forEach((worker) => worker.child.kill());
    }
  }, 20000);

  it('rejeita moeda divergente e retorna moeda da wallet inclusive no replay', async () => {
    const { body } = await fixture();
    const invalid = { ...body, money: { amount: '25.00', currency: 'USD' } };
    const result = await wagering.submitTransaction(
      invalid,
      invalid.externalTransactionId,
    );
    expect(result).toMatchObject({
      status: 'REJECTED',
      failureCode: 'CURRENCY_MISMATCH',
      balance: { currency: 'BRL', amount: '100.00' },
    });
    expect(
      await wagering.submitTransaction(invalid, invalid.externalTransactionId),
    ).toEqual({ ...result, idempotentReplay: true });
  });

  it('paginação de ledger não repete lançamentos e rejeita cursor de outra wallet', async () => {
    const { wallet, body } = await fixture();
    await wagering.submitTransaction(body, body.externalTransactionId);
    const first = await wallets.ledger(wallet.id, undefined, '1');
    expect(first.entries).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await wallets.ledger(wallet.id, first.nextCursor!, '1');
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0].id).not.toBe(first.entries[0].id);
    expect(second.nextCursor).toBeNull();
    const another = await fixture();
    await expect(
      wallets.ledger(another.wallet.id, first.nextCursor!, '1'),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('inbox persistente permite redelivery sem duplicar efeitos', async () => {
    const { wallet, body } = await fixture();
    const context = {
      inbox: {
        consumerName: 'wager',
        messageId: randomUUID(),
        payloadHash: 'hash',
      },
    };
    await wagering.submitTransaction(body, body.externalTransactionId, context);
    expect(
      (
        await wagering.submitTransaction(
          body,
          body.externalTransactionId,
          context,
        )
      ).idempotentReplay,
    ).toBe(true);
    expect(await countLedger(wallet.id, 'DEBIT')).toBe(1);
    await expect(
      wagering.submitTransaction(body, body.externalTransactionId, {
        inbox: { ...context.inbox, payloadHash: 'different' },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('falha ao gravar outbox reverte transação, saldo, ledger e inbox', async () => {
    const { wallet, body } = await fixture();
    await AppDataSource.query(`CREATE FUNCTION fail_test_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.aggregate_id = '${wallet.id}'::uuid THEN RAISE EXCEPTION 'test outbox failure'; END IF; RETURN NEW; END $$`);
    await AppDataSource.query(
      'CREATE TRIGGER fail_test_outbox BEFORE INSERT ON outbox_messages FOR EACH ROW EXECUTE FUNCTION fail_test_outbox()',
    );
    const messageId = randomUUID();
    try {
      await expect(
        wagering.submitTransaction(body, body.externalTransactionId, {
          inbox: { messageId, consumerName: 'wager', payloadHash: 'hash' },
        }),
      ).rejects.toThrow('test outbox failure');
      expect((await wallets.findById(wallet.id)).balance.amount).toBe('100.00');
      expect(await countLedger(wallet.id, 'DEBIT')).toBe(0);
      const [row] = await AppDataSource.query(
        `SELECT (SELECT count(*) FROM wager_transactions WHERE external_transaction_id = $1)::integer AS transactions,
        (SELECT count(*) FROM inbox_messages WHERE message_id = $2)::integer AS inbox`,
        [body.externalTransactionId, messageId],
      );
      expect(row).toEqual({ transactions: 0, inbox: 0 });
    } finally {
      await AppDataSource.query(
        'DROP TRIGGER fail_test_outbox ON outbox_messages',
      );
      await AppDataSource.query('DROP FUNCTION fail_test_outbox()');
    }
  });
});
