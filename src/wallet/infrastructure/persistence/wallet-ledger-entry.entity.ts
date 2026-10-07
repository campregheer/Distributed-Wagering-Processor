import { Check, Column, Entity, PrimaryColumn, Unique } from "typeorm";


@Unique('UQ_wallet_ledger_entry_wallet_transaction', ['walletId', 'transactionId'])
@Check('CHK_wallet_ledger_entry_amount_positive', '"amount" > 0')
@Check('CHK_wallet_ledger_entry_balance_before_nonnegative', '"balance_before" >= 0')
@Check('CHK_wallet_ledger_entry_balance_after_nonnegative', '"balance_after" >= 0')
@Entity('wallet_ledger_entries')
export class WalletLedgerEntryEntity {
    @PrimaryColumn({ type: 'uuid' })
    id!: string;

    @Column({ name: 'wallet_id', type: 'uuid' })
    walletId!: string;

    @Column({ name: 'transaction_id', type: 'uuid' })
    transactionId!: string;

    @Column({ type: 'varchar', length: 6 })
    direction!: string;
    
    @Column({ type: 'numeric', precision: 20, scale: 2 })
    amount!: string;

    @Column({name: 'balance_before', type: 'numeric', precision: 20, scale: 2 })
    balanceBefore!: string;

    @Column({name: 'balance_after', type: 'numeric', precision: 20, scale: 2 })
    balanceAfter!: string;

    @Column({ type: 'varchar', length: 3 })
    currency!: string;

    @Column({ name: 'created_at', type: 'timestamptz' })
    createdAt!: Date;

}