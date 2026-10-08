import { describe, expect, it } from 'bun:test';
import { Money, MoneyDomainError } from './money';

describe('Money', () => {
  const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
  it('soma e subtrai sem erro binário e sem alterar as instâncias', () => {
    const first = brl('0.10');
    expect(first.add(brl('0.20')).toJSON().amount).toBe('0.30');
    expect(first.toJSON().amount).toBe('0.10');
    expect(brl('1.00').subtract(brl('0.10')).toJSON().amount).toBe('0.90');
  });
  it('permite negativos internos e serializa escala fixa, inclusive zero', () => {
    expect(brl('1.00').negate().toJSON().amount).toBe('-1.00');
    expect(brl('0.00').negate().toJSON().amount).toBe('0.00');
  });
  it('rejeita código de moeda inexistente', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'ZZZ' })).toThrow(
      MoneyDomainError,
    );
  });
  it.each(['add', 'subtract', 'equals', 'isLessThan'] as const)(
    'rejeita conflito de moeda em %s',
    (operation) => {
      expect(() =>
        brl('1.00')[operation](Money.from({ amount: '1.00', currency: 'USD' })),
      ).toThrow(MoneyDomainError);
    },
  );
  it('preserva exatamente o maior valor permitido e rejeita overflow sem arredondar', () => {
    const max = brl('999999999999999999.99');
    expect(max.toJSON().amount).toBe('999999999999999999.99');
    expect(() => max.add(brl('0.01'))).toThrow(MoneyDomainError);
    expect(() => brl('1.005')).toThrow(MoneyDomainError);
  });
});
