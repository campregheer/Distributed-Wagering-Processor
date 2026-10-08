import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateInboxOutbox1791400000000 implements MigrationInterface {
  name = 'CreateInboxOutbox1791400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE inbox_messages (
        consumer_name varchar(100) NOT NULL,
        message_id varchar(255) NOT NULL,
        payload_hash varchar(64) NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        aggregate_id uuid NOT NULL,
        event_type varchar(100) NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz,
        published_at timestamptz
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IDX_outbox_pending ON outbox_messages (next_attempt_at, occurred_at, id) WHERE published_at IS NULL`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX UQ_processed_reversal
      ON wager_transactions (reference_transaction_id, kind)
      WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')
    `);
    await queryRunner.query(
      `CREATE INDEX IDX_pending_reference ON wager_transactions (created_at, id) WHERE status = 'PENDING_REFERENCE'`,
    );
    await queryRunner.query(
      `CREATE INDEX IDX_wallet_ledger_cursor ON wallet_ledger_entries (wallet_id, created_at, id)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IDX_wallet_ledger_cursor');
    await queryRunner.query('DROP INDEX IDX_pending_reference');
    await queryRunner.query('DROP INDEX UQ_processed_reversal');
    await queryRunner.query('DROP TABLE outbox_messages');
    await queryRunner.query('DROP TABLE inbox_messages');
  }
}
