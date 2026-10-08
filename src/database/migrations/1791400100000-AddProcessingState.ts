import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProcessingState1791400100000 implements MigrationInterface {
  name = 'AddProcessingState1791400100000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE wager_transactions
      ADD COLUMN result_currency varchar(3),
      ADD COLUMN correlation_id varchar(255),
      ADD COLUMN reference_attempts integer NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
      ADD COLUMN reference_next_attempt_at timestamptz,
      ADD CONSTRAINT CHK_wager_kind CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
      ADD CONSTRAINT CHK_wager_status CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
      ADD CONSTRAINT CHK_processed_reversal_reference CHECK (status <> 'PROCESSED' OR kind NOT IN ('REFUND','ROLLBACK') OR reference_transaction_id IS NOT NULL)`);
    await q.query(`UPDATE wager_transactions AS wager
      SET result_balance = ledger.balance_after
      FROM wallet_ledger_entries AS ledger
      WHERE ledger.transaction_id = wager.id AND ledger.wallet_id = wager.wallet_id
        AND wager.status = 'PROCESSED' AND wager.result_balance IS NULL`);
    await q.query(
      `UPDATE wager_transactions SET result_currency = currency WHERE result_balance IS NOT NULL`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE wager_transactions
      DROP CONSTRAINT CHK_processed_reversal_reference,
      DROP CONSTRAINT CHK_wager_status, DROP CONSTRAINT CHK_wager_kind,
      DROP COLUMN reference_next_attempt_at, DROP COLUMN reference_attempts,
      DROP COLUMN correlation_id, DROP COLUMN result_currency`);
  }
}
