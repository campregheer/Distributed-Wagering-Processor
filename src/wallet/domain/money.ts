import Decimal from 'decimal.js';

export interface MoneyProps {
  // Propriedades do valor monetário
  amount: string;
  currency: string;
}

export class MoneyDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyDomainError';
  }
}

// Limite escolhido para manter as operações dentro de uma precisão controlada.
const MoneyDecimal = Decimal.clone({ precision: 40 });
const MAX_ABSOLUTE_VALUE = new MoneyDecimal('1000000000000000000');
const SUPPORTED_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    if (!value.isFinite() || value.decimalPlaces() > 2) {
      throw new MoneyDomainError('Valor monetário inválido.');
    }

    if (value.abs().greaterThanOrEqualTo(MAX_ABSOLUTE_VALUE)) {
      throw new MoneyDomainError('Valor monetário acima do limite permitido.');
    }
  }

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;

    if (typeof amount !== 'string' || !/^\d+\.\d{2}$/.test(amount)) {
      throw new MoneyDomainError(
        'O valor deve ser uma string não negativa com duas casas decimais.',
      );
    }

    if (
      typeof currency !== 'string' ||
      !/^[A-Z]{3}$/.test(currency) ||
      !SUPPORTED_CURRENCIES.has(currency)
    ) {
      throw new MoneyDomainError(
        'A moeda deve ser um código ISO-4217 suportado, com três letras maiúsculas.',
      );
    }

    return new Money(new MoneyDecimal(amount), currency);
  }

  // Método para criar o zero na moeda especifica
  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    if (this.isZero()) {
      return Money.zero(this.currency);
    }

    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return !this.isZero() && this.value.isPositive();
  }

  isNegative(): boolean {
    return !this.isZero() && this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyDomainError(
        `Não é possível operar ${this.currency} com ${other.currency}.`,
      );
    }
  }
}
