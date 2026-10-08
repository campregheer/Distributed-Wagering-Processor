import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
  }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new Error('O saldo inicial não pode ser negativo.');
    }

    const now = new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // Método para reconstruir o estado da carteira a partir de um estado persistido
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new Error('Moedas diferentes não podem ser movimentadas.');
    }
  }

  debit(amount: Money): { balanceBefore: Money; balanceAfter: Money } {
    this.assertSameCurrency(amount);
    if (!amount.isPositive()) {
      throw new Error('O valor de débito deve ser maior que zero.');
    }

    if (this._balance.isLessThan(amount)) {
      throw new Error('Saldo insuficiente para o débito.');
    }

    const balanceBefore = this._balance;
    this._balance = this._balance.subtract(amount);

    this._version++;
    this._updatedAt = new Date();

    return { balanceBefore, balanceAfter: this._balance };
  }

  credit(amount: Money): { balanceBefore: Money; balanceAfter: Money } {
    this.assertSameCurrency(amount);
    if (!amount.isPositive()) {
      throw new Error('O valor de crédito deve ser maior que zero.');
    }

    const balanceBefore = this._balance;
    this._balance = this._balance.add(amount);

    this._version++;
    this._updatedAt = new Date();

    return { balanceBefore, balanceAfter: this._balance };
  }
}
