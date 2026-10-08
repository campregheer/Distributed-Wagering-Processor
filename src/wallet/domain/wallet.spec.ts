import { describe, expect, it } from 'bun:test';
import { Wallet } from './wallet';
import { Money } from './money';

describe('Wallet: invariantes locais', () => {
  const money = (amount: string) => Money.from({ amount, currency: 'BRL' });
  const open = () =>
    Wallet.open({
      id: 'wallet',
      playerId: 'player',
      initialBalance: money('100.00'),
    });
  it('inicia em version 1 e incrementa quando o saldo muda', () => {
    const wallet = open();
    expect(wallet.version).toBe(1);
    expect(wallet.debit(money('80.00')).balanceAfter.toJSON().amount).toBe(
      '20.00',
    );
    expect(wallet.version).toBe(2);
    wallet.credit(money('5.00'));
    expect(wallet.version).toBe(3);
  });
  it('débito insuficiente não altera saldo nem versão', () => {
    const wallet = open();
    expect(() => wallet.debit(money('101.00'))).toThrow();
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
  it('não aceita movimentação de outra moeda', () => {
    expect(() =>
      open().credit(Money.from({ amount: '1.00', currency: 'USD' })),
    ).toThrow();
  });
});
