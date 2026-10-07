import { Check, Column, Entity, PrimaryColumn, Unique } from "typeorm";



@Unique('UQ_wager_transaction_idempotency_key', ['idempotencyKey'])
@Unique('UQ_wager_transaction_provider_external_transaction', ['providerId', 'externalTransactionId'])
@Check('CHK_wager_transaction_amount_nonnegative', '"amount" >= 0')
@Check('CHK_wager_transaction_result_balance_nonnegative', '"result_balance" >= 0')
@Entity('wager_transactions')
export class WagerTransactionEntity {

    @PrimaryColumn({ type: 'uuid' })
    id!: string;

    @Column({ name: 'provider_id', type: 'varchar', length: 100 })
    providerId!: string;

    @Column({ name: 'external_transaction_id', type: 'varchar', length: 150 })
    externalTransactionId!: string;

    @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
    idempotencyKey!: string;

    @Column({ name: 'payload_hash', type: 'varchar', length: 255 })
    payloadHash!: string;

    @Column({ name: 'wallet_id', type: 'uuid' })
    walletId!: string;

    @Column({ name: 'player_id', type: 'uuid' })
    playerId!: string;

    @Column({ name: 'round_id', type: 'varchar', length: 255 })
    roundId!: string;

    @Column({ name: 'game_id', type: 'varchar', length: 255 })
    gameId!: string;

    @Column({ name: 'kind', type: 'varchar', length: 16 })
    kind!: string;

    @Column({ name: 'status', type: 'varchar', length: 24 })
    status!: string;

    @Column({ type: 'numeric', precision: 20, scale: 2 })
    amount!: string;

    @Column({ type: 'varchar', length: 3 })
    currency!: string;

    @Column({ name: 'result_balance', type: 'numeric', precision: 20, scale: 2, nullable: true })
    resultBalance!: string | null;

    @Column({ name: 'reference_external_transaction_id', type: 'varchar', length: 255, nullable: true })
    referenceExternalTransactionId!: string | null;

    @Column({ name: 'reference_transaction_id', type: 'uuid', nullable: true })
    referenceTransactionId!: string | null;

    @Column({ name: 'failure_code', type: 'varchar', length: 64, nullable: true })
    failureCode!: string | null;

    @Column({ name: 'created_at', type: 'timestamptz' })
    createdAt!: Date;

    @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
    processedAt!: Date | null;  

}