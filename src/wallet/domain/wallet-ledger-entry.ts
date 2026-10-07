import { Money } from './money';
import { LedgerDirection } from './ledger-direction';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new Error('O valor do lançamento deve ser maior que zero.');
    }

    if (
      props.balanceBefore.isNegative() ||
      props.balanceAfter.isNegative()
    ) {
      throw new Error('O saldo da carteira não pode ser negativo.');
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(),
    );

    if (!entry.isBalanced()) {
      throw new Error('Os saldos do lançamento não fecham a conta.');
    }

    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    if (this.direction === LedgerDirection.Credit) {
      return this.balanceBefore.add(this.money).equals(this.balanceAfter);
    }

    if (this.direction === LedgerDirection.Debit) {
      return this.balanceBefore.subtract(this.money).equals(this.balanceAfter);
    }

    throw new Error(`Direção de lançamento inválida: ${this.direction}`);
  }
}