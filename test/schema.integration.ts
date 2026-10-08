import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AppDataSource } from '../src/database/data-source';

describe('Migrations e constraints em PostgreSQL real', () => {
  const walletId = randomUUID();
  const transactionId = randomUUID();

  beforeAll(async () => {
    if (!process.env.DB_NAME?.startsWith('jungle_schema_test_')) {
      throw new Error('Execute somente em banco isolado jungle_schema_test_*.');
    }
    await AppDataSource.initialize();
    await AppDataSource.runMigrations();
    await AppDataSource.query(
      `INSERT INTO wallets VALUES ($1, $2, 'BRL', 100.00, 1, now(), now())`,
      [walletId, randomUUID()],
    );
    await AppDataSource.query(
      `
      INSERT INTO wager_transactions
      (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, status, amount, currency, created_at)
      SELECT $1, 'provider-a', 'bet-1', 'key-1', 'hash', id, player_id,
             'round-1', 'game-1', 'BET', 'PROCESSED', 25.00, 'BRL', now()
      FROM wallets WHERE id = $2`,
      [transactionId, walletId],
    );
  });

  afterAll(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  });

  it('deduplica inbox por consumerName + messageId', async () => {
    const insert = (consumer: string) =>
      AppDataSource.query(
        `INSERT INTO inbox_messages VALUES ($1, 'msg-1', 'hash', now(), NULL)`,
        [consumer],
      );
    await insert('consumer-a');
    await expect(insert('consumer-a')).rejects.toMatchObject({
      driverError: { code: '23505' },
    });
    await expect(insert('consumer-b')).resolves.toBeDefined();
  });

  it('impede segunda reversão processada pelo mesmo tipo, permitindo auditoria de rejeição', async () => {
    const insert = (kind: string, status: string) => {
      const id = randomUUID();
      return AppDataSource.query(
        `
        INSERT INTO wager_transactions
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, status, amount, currency,
         reference_transaction_id, created_at)
        SELECT $1::uuid, 'provider-a', $1::text, $1::text, 'hash', id, player_id,
               'round-1', 'game-1', $3, $4, 25.00, 'BRL', $2, now()
        FROM wallets WHERE id = $5`,
        [id, transactionId, kind, status, walletId],
      );
    };
    await insert('REFUND', 'PROCESSED');
    await expect(insert('REFUND', 'PROCESSED')).rejects.toMatchObject({
      driverError: { code: '23505' },
    });
    await expect(insert('REFUND', 'REJECTED')).resolves.toBeDefined();
    await expect(insert('ROLLBACK', 'PROCESSED')).resolves.toBeDefined();
  });

  it('rejeita saldo negativo no schema', async () => {
    await expect(
      AppDataSource.query('UPDATE wallets SET balance = -1 WHERE id = $1', [
        walletId,
      ]),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
  });

  it('protege aritmética e imutabilidade do ledger', async () => {
    const id = randomUUID();
    await expect(
      AppDataSource.query(
        `
      INSERT INTO wallet_ledger_entries VALUES ($1, $2, $3, 'DEBIT', 25.00, 100.00, 90.00, 'BRL', now())`,
        [id, walletId, transactionId],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
    await AppDataSource.query(
      `
      INSERT INTO wallet_ledger_entries VALUES ($1, $2, $3, 'DEBIT', 25.00, 100.00, 75.00, 'BRL', now())`,
      [id, walletId, transactionId],
    );
    await expect(
      AppDataSource.query(
        'UPDATE wallet_ledger_entries SET amount = 10 WHERE id = $1',
        [id],
      ),
    ).rejects.toThrow('imutável');
    await expect(
      AppDataSource.query('DELETE FROM wallet_ledger_entries WHERE id = $1', [
        id,
      ]),
    ).rejects.toThrow('imutável');
    await expect(
      AppDataSource.query('TRUNCATE wallet_ledger_entries'),
    ).rejects.toThrow('imutável');
  });

  it('persiste envelope JSON e rejeita tentativas negativas de outbox', async () => {
    await AppDataSource.query(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
      VALUES ($1, $2, 'WagerTransactionProcessed', $3, now())`,
      [
        randomUUID(),
        walletId,
        { data: { money: { amount: '25.00', currency: 'BRL' } } },
      ],
    );
    const [row] = await AppDataSource.query(
      'SELECT payload FROM outbox_messages',
    );
    expect(row.payload.data.money.amount).toBe('25.00');
    await expect(
      AppDataSource.query('UPDATE outbox_messages SET attempts = -1'),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
  });

  it('upgrade reconstrói resultado histórico a partir do ledger existente', async () => {
    await AppDataSource.undoLastMigration();
    await AppDataSource.runMigrations();
    const [row] = await AppDataSource.query(
      'SELECT result_balance, result_currency FROM wager_transactions WHERE id = $1',
      [transactionId],
    );
    expect(row).toEqual({ result_balance: '75.00', result_currency: 'BRL' });
  });

  it('reverte todas as migrations e reaplica em ordem', async () => {
    for (let i = 0; i < AppDataSource.migrations.length; i++)
      await AppDataSource.undoLastMigration();
    const [row] = await AppDataSource.query(
      "SELECT to_regclass('wallets') AS wallets, to_regclass('outbox_messages') AS outbox",
    );
    expect(row).toEqual({ wallets: null, outbox: null });
    expect(await AppDataSource.runMigrations()).toHaveLength(
      AppDataSource.migrations.length,
    );
  });
});
