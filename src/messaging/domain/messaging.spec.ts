import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { InboxMessage } from './inbox-message';
import { OutboxMessage } from './outbox-message';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  WalletBalanceChanged,
} from '../../wagering/events/wagering.events';
import {
  FailureCode,
  WagerTransactionKind,
} from '../../wagering/wager-transaction';
import { LedgerDirection } from '../../wallet/domain/ledger-direction';

const money = { amount: '25.00', currency: 'BRL' };
const props = {
  eventId: randomUUID(),
  aggregateId: randomUUID(),
  correlationId: 'request-123',
  occurredAt: new Date('2026-10-07T12:00:00Z'),
  data: {
    transactionId: randomUUID(),
    walletId: randomUUID(),
    providerId: 'provider-a',
    externalTransactionId: 'bet-123',
    kind: WagerTransactionKind.Bet,
    money,
  },
};

describe('Envelope de integração', () => {
  it.each([
    WagerTransactionProcessed.create({
      ...props,
      data: { ...props.data, balance: money },
    }),
    WagerTransactionRejected.create({
      ...props,
      data: { ...props.data, failureCode: FailureCode.INSUFFICIENT_FUNDS },
    }),
    WagerTransactionPendingReference.create({
      ...props,
      data: { ...props.data, referenceExternalTransactionId: 'bet-original' },
    }),
    WalletBalanceChanged.create({
      ...props,
      data: {
        walletId: props.data.walletId,
        transactionId: props.data.transactionId,
        direction: LedgerDirection.Debit,
        money,
        balanceBefore: { amount: '50.00', currency: 'BRL' },
        balanceAfter: money,
        walletVersion: 2,
      },
    }),
  ])('serializa evento concreto e dinheiro como JSON estável', (event) => {
    const json = JSON.parse(JSON.stringify(event.toJSON()));
    expect(json).toMatchObject({
      eventId: props.eventId,
      aggregateId: props.aggregateId,
      correlationId: props.correlationId,
      occurredAt: '2026-10-07T12:00:00.000Z',
      version: 1,
      eventType: event.eventType,
      data: { money },
    });
  });

  it('copia o payload de entrada para evitar mudanças externas', () => {
    const data = { ...props.data, money: { ...money }, balance: { ...money } };
    const event = WagerTransactionProcessed.create({ ...props, data });
    data.money.amount = '99.00';
    expect(event.toJSON().data.money.amount).toBe('25.00');
  });
});

describe('Inbox', () => {
  it('nasce sem processamento e registra a conclusão', () => {
    const inbox = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager',
      payloadHash: 'hash',
    });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(props.occurredAt);
    expect(inbox.processedAt).toEqual(props.occurredAt);
    expect(() => inbox.markProcessed(new Date())).toThrow();
  });
});

describe('Outbox', () => {
  it('mantém envelope e controla publicação', () => {
    const event = WagerTransactionProcessed.create({
      ...props,
      data: { ...props.data, balance: money },
    });
    const outbox = OutboxMessage.enqueue(event);
    expect(outbox.payload).toEqual(event.toJSON());
    expect(outbox.isDue(props.occurredAt)).toBe(true);
    outbox.markPublished(props.occurredAt);
    expect(outbox.isDue(new Date())).toBe(false);
    expect(() => outbox.scheduleRetry(new Date())).toThrow();
  });

  it('reagenda com backoff exponencial limitado a cinco minutos', () => {
    const event = WagerTransactionProcessed.create({
      ...props,
      data: { ...props.data, balance: money },
    });
    const outbox = OutboxMessage.enqueue(event);
    outbox.scheduleRetry(props.occurredAt);
    expect(outbox.nextAttemptAt?.getTime()).toBe(
      props.occurredAt.getTime() + 1000,
    );
    expect(outbox.isDue(props.occurredAt)).toBe(false);
    outbox.scheduleRetry(props.occurredAt);
    expect(outbox.nextAttemptAt?.getTime()).toBe(
      props.occurredAt.getTime() + 2000,
    );
    for (let i = 0; i < 20; i++) outbox.scheduleRetry(props.occurredAt);
    expect(outbox.nextAttemptAt?.getTime()).toBe(
      props.occurredAt.getTime() + 300000,
    );
  });
});
