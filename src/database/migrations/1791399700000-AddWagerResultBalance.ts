import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWagerResultBalance1791399700000
  implements MigrationInterface
{
  name = 'AddWagerResultBalance1791399700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "wager_transactions"
      ADD COLUMN "result_balance" numeric(20,2) NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "wager_transactions"
      ADD CONSTRAINT "CHK_wager_transaction_result_balance_nonnegative"
      CHECK ("result_balance" >= 0)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "wager_transactions"
      DROP CONSTRAINT "CHK_wager_transaction_result_balance_nonnegative"
    `);

    await queryRunner.query(`
      ALTER TABLE "wager_transactions"
      DROP COLUMN "result_balance"
    `);
  }
}