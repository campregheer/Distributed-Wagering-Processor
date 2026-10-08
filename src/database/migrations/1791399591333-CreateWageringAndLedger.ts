import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWageringAndLedger1791399591333 implements MigrationInterface {
  name = 'CreateWageringAndLedger1791399591333';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "wager_transactions" (
        "id" uuid NOT NULL,
        "provider_id" character varying(100) NOT NULL,
        "external_transaction_id" character varying(150) NOT NULL,
        "idempotency_key" character varying(255) NOT NULL,
        "payload_hash" character varying(255) NOT NULL,
        "wallet_id" uuid NOT NULL,
        "player_id" uuid NOT NULL,
        "round_id" character varying(255) NOT NULL,
        "game_id" character varying(255) NOT NULL,
        "kind" character varying(16) NOT NULL,
        "status" character varying(24) NOT NULL,
        "amount" numeric(20,2) NOT NULL,
        "currency" character varying(3) NOT NULL,
        "reference_external_transaction_id" character varying(255),
        "reference_transaction_id" uuid,
        "failure_code" character varying(64),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "processed_at" TIMESTAMP WITH TIME ZONE,

        CONSTRAINT "PK_wager_transactions_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_wager_transaction_provider_external_transaction"
          UNIQUE ("provider_id", "external_transaction_id"),
        CONSTRAINT "UQ_wager_transaction_idempotency_key"
          UNIQUE ("idempotency_key"),
        CONSTRAINT "CHK_wager_transaction_amount_nonnegative"
          CHECK ("amount" >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "wallet_ledger_entries" (
        "id" uuid NOT NULL,
        "wallet_id" uuid NOT NULL,
        "transaction_id" uuid NOT NULL,
        "direction" character varying(6) NOT NULL,
        "amount" numeric(20,2) NOT NULL,
        "balance_before" numeric(20,2) NOT NULL,
        "balance_after" numeric(20,2) NOT NULL,
        "currency" character varying(3) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL,

        CONSTRAINT "PK_wallet_ledger_entries_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_wallet_ledger_entry_wallet_transaction"
          UNIQUE ("wallet_id", "transaction_id"),
        CONSTRAINT "CHK_wallet_ledger_entry_amount_positive"
          CHECK ("amount" > 0),
        CONSTRAINT "CHK_wallet_ledger_entry_balance_before_nonnegative"
          CHECK ("balance_before" >= 0),
        CONSTRAINT "CHK_wallet_ledger_entry_balance_after_nonnegative"
          CHECK ("balance_after" >= 0),
        CONSTRAINT "CHK_wallet_ledger_entry_direction"
          CHECK ("direction" IN ('CREDIT', 'DEBIT')),
        CONSTRAINT "CHK_wallet_ledger_entry_arithmetic"
          CHECK (
            ("direction" = 'CREDIT'
              AND "balance_after" = "balance_before" + "amount")
            OR
            ("direction" = 'DEBIT'
              AND "balance_after" = "balance_before" - "amount")
          )
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "wager_transactions"
      ADD CONSTRAINT "FK_wager_transaction_wallet"
      FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id")
    `);

    await queryRunner.query(`
      ALTER TABLE "wager_transactions"
      ADD CONSTRAINT "FK_wager_transaction_reference"
      FOREIGN KEY ("reference_transaction_id")
      REFERENCES "wager_transactions"("id")
    `);

    await queryRunner.query(`
      ALTER TABLE "wallet_ledger_entries"
      ADD CONSTRAINT "FK_wallet_ledger_entry_wallet"
      FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id")
    `);

    await queryRunner.query(`
      ALTER TABLE "wallet_ledger_entries"
      ADD CONSTRAINT "FK_wallet_ledger_entry_transaction"
      FOREIGN KEY ("transaction_id")
      REFERENCES "wager_transactions"("id")
    `);

    await queryRunner.query(`
      CREATE FUNCTION prevent_wallet_ledger_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries é imutável';
        RETURN NULL;
      END;
      $$
    `);

    await queryRunner.query(`
      CREATE TRIGGER "TRG_wallet_ledger_immutable"
      BEFORE UPDATE OR DELETE OR TRUNCATE
      ON "wallet_ledger_entries"
      FOR EACH STATEMENT
      EXECUTE FUNCTION prevent_wallet_ledger_mutation()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "wallet_ledger_entries"`);
    await queryRunner.query(`DROP FUNCTION prevent_wallet_ledger_mutation()`);
    await queryRunner.query(`DROP TABLE "wager_transactions"`);
  }
}
