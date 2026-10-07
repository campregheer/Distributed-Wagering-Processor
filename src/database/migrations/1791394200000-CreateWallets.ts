import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWallets1791394200000 implements MigrationInterface {
  name = 'CreateWallets1791394200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "wallets" (
        "id" uuid NOT NULL,
        "player_id" uuid NOT NULL,
        "currency" varchar(3) NOT NULL,
        "balance" numeric(20, 2) NOT NULL,
        "version" integer NOT NULL,
        "created_at" timestamptz NOT NULL,
        "updated_at" timestamptz NOT NULL,
        CONSTRAINT "PK_wallets_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_wallet_player_currency" UNIQUE ("player_id", "currency"),
        CONSTRAINT "CHK_wallet_balance_nonnegative" CHECK ("balance" >= 0),
        CONSTRAINT "CHK_wallet_version_positive" CHECK ("version" >= 1)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "wallets"');
  }
}
